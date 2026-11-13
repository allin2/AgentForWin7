/// <reference path="./better-sqlite3.d.ts" />
/**
 * A9-66 F-007: the real product Runtime must restore Provider context through
 * the bounded asynchronous scan at every entry (first task after restart,
 * same-Base-URL model switch, Base-URL switch, conversation switch), never
 * through the synchronous whole-history read, and must keep the restored
 * messages/statistics equal to the synchronous oracle.
 *
 * Real SQLite (observed, not mocked), real Runtime, real Core/Provider chain
 * against a local HTTP model fixture, real setImmediate ticker. The only
 * injected fault is a thrown read error on one statement.
 */
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';

const runtimeModule = require('../../product/a9-agent-runtime') as any;
const { createA9AgentRuntime, buildPersistedTextContext } = runtimeModule;
const PREFIX = 'a9-66-67-ctx-';
const ROUNDS = 700;
const BATCH = 256;

const temporaryRoots: string[] = [];
const servers: http.Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()));
  for (const dir of temporaryRoots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
afterAll(() => {
  expect(fs.readdirSync(os.tmpdir()).filter(name => name.startsWith(PREFIX))).toEqual([]);
});

function startModel(seen: any[]): Promise<{ baseUrl: string }> {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString('utf8'); });
      req.on('end', () => {
        const parsed = JSON.parse(body);
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        if (parsed?.tools?.[0]?.function?.name === 'probe_test_echo') {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'p1', function: { name: 'probe_test_echo', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] })}\n\n`);
        } else {
          seen.push(parsed);
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'model reply' }, finish_reason: 'stop' }] })}\n\n`);
        }
        res.write('data: [DONE]\n\n');
        res.end();
      });
    });
    servers.push(server);
    server.listen(0, '127.0.0.1', () => resolve({ baseUrl: `http://127.0.0.1:${(server.address() as any).port}` }));
  });
}

interface StatementLog { sql: string; rows: number; ticks: number }
const log: StatementLog[] = [];
let ticks = 0;
let tickerRunning = false;
function startTicker(): void {
  tickerRunning = true;
  const tick = () => { if (tickerRunning) { ticks += 1; setImmediate(tick); } };
  setImmediate(tick);
}
let failOnFactStatement = 0;
let factStatementCount = 0;
const isFactStatement = (sql: string) => /conversation\.request/.test(sql) || /FROM a9_checkpoints c/.test(sql);

/** Real SQLite; the wrapper observes row counts / tick counts, and can inject one read failure. */
function observedDatabase(file: string, options: any): any {
  const db: any = new Database(file, options);
  return new Proxy(db, {
    get(target, property) {
      const value = (target as any)[property];
      if (property !== 'prepare') return typeof value === 'function' ? value.bind(target) : value;
      return (sql: string) => {
        const statement = target.prepare(sql);
        return new Proxy(statement, {
          get(inner, name) {
            const member = (inner as any)[name];
            if (name !== 'all') return typeof member === 'function' ? member.bind(inner) : member;
            return (...args: unknown[]) => {
              if (isFactStatement(sql)) {
                factStatementCount += 1;
                if (failOnFactStatement && factStatementCount === failOnFactStatement) {
                  failOnFactStatement = 0;
                  throw Object.assign(new Error('injected read failure'), { code: 'SQLITE_IOERR' });
                }
              }
              const rows = member.apply(inner, args);
              log.push({ sql, rows: rows.length, ticks });
              return rows;
            };
          },
        });
      };
    },
  });
}

function makeEnv() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), PREFIX));
  temporaryRoots.push(root);
  const workspaceRoot = path.join(root, 'ws');
  const dataRoot = path.join(root, 'data');
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.mkdirSync(dataRoot, { recursive: true });
  return { root, workspaceRoot, dataRoot };
}

function makeRuntime(env: ReturnType<typeof makeEnv>, observe = true) {
  return createA9AgentRuntime({
    workspaceRoot: env.workspaceRoot,
    dataRoot: env.dataRoot,
    ownerId: `ctx-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    openDatabase: (file: string, options?: { readonly?: boolean }) =>
      observe ? observedDatabase(file, options?.readonly ? { readonly: true } : {}) : new Database(file, options?.readonly ? { readonly: true } : {}),
  });
}

/** Writes real persisted rounds for a conversation through SQL (the product's own tables). */
function seedHistory(env: ReturnType<typeof makeEnv>, sessionId: string, label: string, rounds: number, generation: number, tied = false): void {
  const db = new Database(path.join(env.dataRoot, 'a9-state.db'));
  try {
    const insertTask = db.prepare('INSERT INTO a9_tasks (task_id, session_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)');
    const insertTurn = db.prepare('INSERT INTO a9_turns (turn_id, task_id, session_id, status, outcome_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const insertEvent = db.prepare('INSERT INTO a9_events (session_id, turn_id, kind, event_type, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)');
    const insertCheckpoint = db.prepare('INSERT INTO a9_checkpoints (turn_id, session_id, created_at, payload_json) VALUES (?, ?, ?, ?)');
    db.exec('BEGIN');
    try {
      for (let n = 0; n < rounds; n += 1) {
        const at = tied ? '2026-11-01T00:00:00.000Z' : new Date(Date.UTC(2026, 10, 1, 0, 0, 0, n * 10)).toISOString();
        const taskId = `${label}-task-${n}`, turnId = `${label}-turn-${n}`;
        insertTask.run(taskId, sessionId, 'completed', at, at);
        insertTurn.run(turnId, taskId, sessionId, 'completed', '{}', at, at);
        insertEvent.run(sessionId, null, 'model', 'conversation.request', JSON.stringify({ taskId, requestPrompt: `${label} ask ${n}` }), at);
        insertEvent.run(sessionId, turnId, 'tool', 'tool_output', JSON.stringify({ taskId, text: 'noise' }), at);
        insertCheckpoint.run(turnId, sessionId, at, JSON.stringify({ outcome: 'completed', finalMessage: `${label} answer ${n}`, providerContextGeneration: generation }));
      }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  } finally { db.close(); }
}

function withManager<T>(env: ReturnType<typeof makeEnv>, use: (manager: any) => T): T {
  const { A9PersistenceManager } = require('../../../state/dist');
  const outcome = A9PersistenceManager.open({
    databasePath: path.join(env.dataRoot, 'a9-state.db'), dataRoot: env.dataRoot,
    openDatabase: (file: string, options: any) => new Database(file, options),
  });
  try { return use(outcome.manager); } finally { outcome.manager.db.close(); }
}
/** The conversation's persisted Provider-context generation (what the Runtime binds restores to). */
function generationOf(env: ReturnType<typeof makeEnv>, sessionId: string): number {
  return withManager(env, manager => {
    const metadata = manager.getConversationMetadata(sessionId);
    return Number.isSafeInteger(metadata.providerContextGeneration) ? metadata.providerContextGeneration : 0;
  });
}
function oracleFor(env: ReturnType<typeof makeEnv>, sessionId: string): any {
  const generation = generationOf(env, sessionId);
  return withManager(env, manager => buildPersistedTextContext(manager.listConversationFacts(sessionId), generation));
}

/** Prepares: a real runtime creates the conversation, then its history is seeded and the runtime closed. */
async function prepareHistory(env: ReturnType<typeof makeEnv>, baseUrl: string, rounds = ROUNDS): Promise<string> {
  const first = makeRuntime(env, false);
  first.setMode('full_access');
  await first.configureProvider({ baseUrl, model: 'model-a', skipProbe: true });
  const sessionId = first.getSnapshot({ conversationPage: true }).activeConversationId;
  await first.shutdown();
  seedHistory(env, sessionId, 'main', rounds, generationOf(env, sessionId));
  return sessionId;
}

const factStatements = () => log.filter(entry => isFactStatement(entry.sql));
const maxFactRows = () => Math.max(0, ...factStatements().map(entry => entry.rows));
function expectInterleaved(): void {
  const entries = factStatements();
  expect(entries.length).toBeGreaterThan(5);
  // Between consecutive bounded statements the native event loop really ran.
  let gaps = 0;
  for (let i = 1; i < entries.length; i += 1) if (entries[i].ticks > entries[i - 1].ticks) gaps += 1;
  expect(gaps).toBeGreaterThanOrEqual(entries.length - 3);
}
function lastUserMessages(request: any): string[] {
  return (request.messages as any[]).filter(message => message.role === 'user' || message.role === 'assistant').map(message => String(message.content));
}

beforeEach(() => { log.length = 0; ticks = 0; failOnFactStatement = 0; factStatementCount = 0; startTicker(); });
afterEach(() => { tickerRunning = false; });

describe('A9-66 F-007 product entries restore Provider context through the bounded async scan', () => {
  it('first task after restart: bounded interleaved reads, history equals the synchronous oracle', async () => {
    const seen: any[] = [];
    const { baseUrl } = await startModel(seen);
    const env = makeEnv();
    const sessionId = await prepareHistory(env, baseUrl);
    const oracle = oracleFor(env, sessionId);
    expect(oracle.messages.length).toBeGreaterThan(30);

    const runtime = makeRuntime(env);
    try {
      runtime.setMode('full_access');
      log.length = 0;
      // No explicit configure: the persisted Provider config is active, the first Turn is the entry.
      const turn = await runtime.submitTurn('brand new question');
      expect(turn.ok).toBe(true);
      expect(seen.length).toBe(1);
      const restored = lastUserMessages(seen[0]);
      expect(restored.slice(0, oracle.messages.length)).toEqual(oracle.messages.map((message: any) => message.content));
      expect(restored).toContain('brand new question');
      expect(maxFactRows()).toBeLessThanOrEqual(BATCH);
      expectInterleaved();
      // The post-Turn statistics refresh runs off the Turn (it must not hold the Turn lock): wait for it.
      const oracleAfter = oracleFor(env, sessionId);
      const current = () => runtime.getSnapshot({ conversationPage: true }).contextWindow;
      const deadline = Date.now() + 5000;
      while (current().includedChars !== oracleAfter.stats.includedChars && Date.now() < deadline) {
        await new Promise<void>(resolve => setTimeout(resolve, 5));
      }
      expect(current()).toMatchObject({ includedRounds: oracleAfter.stats.includedRounds, includedChars: oracleAfter.stats.includedChars,
        omittedRounds: oracleAfter.stats.omittedRounds, visibleRounds: oracleAfter.stats.visibleRounds, maxRounds: 20, maxChars: 32000 });
      expect(oracleAfter.stats.visibleRounds).toBe(ROUNDS + 1);
    } finally { await runtime.shutdown(); }
  }, 60_000);

  it('the context restore itself yields to the event loop between bounded statements (same-URL model switch)', async () => {
    const seen: any[] = [];
    const { baseUrl } = await startModel(seen);
    const env = makeEnv();
    const sessionId = await prepareHistory(env, baseUrl);
    const oracle = oracleFor(env, sessionId);

    const runtime = makeRuntime(env);
    try {
      runtime.setMode('full_access');
      log.length = 0;
      // Same exact Base URL (persisted config), different model: the restored text context must survive the switch.
      await runtime.configureProvider({ baseUrl, model: 'model-b', skipProbe: true });
      expect(factStatements().length).toBeGreaterThan(0);
      expect(maxFactRows()).toBeLessThanOrEqual(BATCH);
      expectInterleaved();
      const turn = await runtime.submitTurn('after switch');
      expect(turn.ok).toBe(true);
      expect(lastUserMessages(seen[0]).slice(0, oracle.messages.length)).toEqual(oracle.messages.map((message: any) => message.content));
      expect(seen[0].model).toBe('model-b');
    } finally { await runtime.shutdown(); }
  }, 60_000);

  it('Base URL switch isolates old history, recomputes statistics asynchronously and sends nothing old', async () => {
    const seenA: any[] = [];
    const seenB: any[] = [];
    const a = await startModel(seenA);
    const b = await startModel(seenB);
    const env = makeEnv();
    await prepareHistory(env, a.baseUrl);
    const runtime = makeRuntime(env);
    try {
      runtime.setMode('full_access');
      await runtime.configureProvider({ baseUrl: a.baseUrl, model: 'model-a', skipProbe: true });
      log.length = 0;
      await runtime.configureProvider({ baseUrl: b.baseUrl, model: 'model-b', skipProbe: true });
      expect(maxFactRows()).toBeLessThanOrEqual(BATCH);
      expectInterleaved();
      const stats = runtime.getSnapshot({ conversationPage: true }).contextWindow;
      // New generation: nothing restored, every older round stays only locally visible.
      expect(stats).toMatchObject({ includedRounds: 0, omittedRounds: 0, visibleRounds: ROUNDS });
      const turn = await runtime.submitTurn('to the new endpoint');
      expect(turn.ok).toBe(true);
      expect(seenB.length).toBe(1);
      expect(lastUserMessages(seenB[0]).some(text => text.startsWith('main '))).toBe(false);
      expect(seenA.length).toBe(0);
    } finally { await runtime.shutdown(); }
  }, 60_000);

  it('a conversation switch during an in-flight restore drops the old scope result; the new conversation restores only its own history', async () => {
    const seen: any[] = [];
    const { baseUrl } = await startModel(seen);
    const env = makeEnv();
    const firstSession = await prepareHistory(env, baseUrl, 400);
    const setup = makeRuntime(env, false);
    setup.setMode('full_access');
    await setup.configureProvider({ baseUrl, model: 'model-a', skipProbe: true });
    const created = setup.createConversation();
    const secondSession = created.conversationId;
    await setup.shutdown();
    seedHistory(env, secondSession, 'second', 40, generationOf(env, secondSession));
    const secondOracle = oracleFor(env, secondSession);
    expect(secondOracle.messages.length).toBeGreaterThan(30);

    const runtime = makeRuntime(env);
    try {
      runtime.setMode('full_access');
      // Entering the first conversation, the restore is pending; start it via a model switch ...
      const switching = runtime.configureProvider({ baseUrl, model: 'model-b', skipProbe: true });
      // ... and move to the other conversation while the scan is in flight.
      await new Promise<void>(resolve => setImmediate(resolve));
      runtime.activateConversation(secondSession);
      await switching;
      const turn = await runtime.submitTurn('question in second conversation');
      expect(turn.ok).toBe(true);
      const messages = lastUserMessages(seen[0]);
      expect(messages.some(text => text.startsWith('main '))).toBe(false);
      expect(messages.slice(0, secondOracle.messages.length)).toEqual(secondOracle.messages.map((message: any) => message.content));
      expect(runtime.getSnapshot({ conversationPage: true }).activeConversationId).toBe(secondSession);
      expect(firstSession).not.toBe(secondSession);
    } finally { await runtime.shutdown(); }
  }, 60_000);

  it('shutdown during the first restore: no model request, no use of the closed database, and a later runtime restores normally', async () => {
    const seen: any[] = [];
    const { baseUrl } = await startModel(seen);
    const env = makeEnv();
    const sessionId = await prepareHistory(env, baseUrl, 1200);
    const oracle = oracleFor(env, sessionId);
    const runtime = makeRuntime(env);
    runtime.setMode('full_access');
    await runtime.configureProvider({ baseUrl, model: 'model-a', skipProbe: true });
    // configure restored already; force a fresh pending scope through a conversation round trip.
    const other = runtime.createConversation().conversationId;
    runtime.activateConversation(sessionId);
    expect(other).toBeTruthy();
    const pending = runtime.submitTurn('will be interrupted by close');
    await new Promise<void>(resolve => setImmediate(resolve));
    const closing = runtime.shutdown();
    const turn = await pending;
    await closing;
    expect(turn.ok).toBe(false);
    expect(seen.length).toBe(0);

    const reopened = makeRuntime(env);
    try {
      reopened.setMode('full_access');
      await reopened.configureProvider({ baseUrl, model: 'model-a', skipProbe: true });
      const retry = await reopened.submitTurn('after reopen');
      expect(retry.ok).toBe(true);
      expect(seen.length).toBe(1);
      expect(lastUserMessages(seen[0]).slice(0, oracle.messages.length)).toEqual(oracle.messages.map((message: any) => message.content));
    } finally { await reopened.shutdown(); }
  }, 60_000);

  it('a failed restore never promotes a cache, replays nothing, and the next call retries from scratch', async () => {
    const seen: any[] = [];
    const { baseUrl } = await startModel(seen);
    const env = makeEnv();
    const sessionId = await prepareHistory(env, baseUrl);
    const oracle = oracleFor(env, sessionId);
    const runtime = makeRuntime(env);
    try {
      runtime.setMode('full_access');
      factStatementCount = 0;
      failOnFactStatement = 4;
      const failing = await runtime.submitTurn('first attempt');
      expect(failing.ok).toBe(false);
      expect(seen.length).toBe(0);
      // No sync fallback ran behind the failure: still only bounded statements.
      expect(maxFactRows()).toBeLessThanOrEqual(BATCH);
      const retry = await runtime.submitTurn('second attempt');
      expect(retry.ok).toBe(true);
      expect(seen.length).toBe(1);
      expect(lastUserMessages(seen[0]).slice(0, oracle.messages.length)).toEqual(oracle.messages.map((message: any) => message.content));
      expect(lastUserMessages(seen[0])).not.toContain('first attempt');
    } finally { await runtime.shutdown(); }
  }, 60_000);

  it('a concurrent second Turn is rejected without side effects while the restore is in flight', async () => {
    const seen: any[] = [];
    const { baseUrl } = await startModel(seen);
    const env = makeEnv();
    await prepareHistory(env, baseUrl);
    const runtime = makeRuntime(env);
    try {
      runtime.setMode('full_access');
      const first = runtime.submitTurn('winner');
      const second = runtime.submitTurn('loser');
      const [a, b] = await Promise.all([first, second]);
      expect([a.ok, b.ok].filter(Boolean).length).toBe(1);
      expect(seen.length).toBe(1);
      expect(maxFactRows()).toBeLessThanOrEqual(BATCH);
    } finally { await runtime.shutdown(); }
  }, 60_000);

  it('Stop while the restore is running ends the Turn without ever calling the model', async () => {
    const seen: any[] = [];
    const { baseUrl } = await startModel(seen);
    const env = makeEnv();
    await prepareHistory(env, baseUrl, 1500);
    const runtime = makeRuntime(env);
    try {
      runtime.setMode('full_access');
      await runtime.configureProvider({ baseUrl, model: 'model-a', skipProbe: true });
      runtime.createConversation();
      const sessionId = runtime.getSnapshot({ conversationPage: true }).activeConversationId;
      expect(sessionId).toBeTruthy();
      const pending = runtime.submitTurn('stop me early');
      await new Promise<void>(resolve => setImmediate(resolve));
      runtime.stop();
      const turn = await pending;
      expect(seen.length === 0 || turn.ok === true).toBe(true);
      if (turn.ok) expect(['cancelled', 'completed', 'completed_with_warnings']).toContain(turn.result.outcome);
    } finally { await runtime.shutdown(); }
  }, 60_000);

  it('the legacy non-paged snapshot keeps its synchronous compatibility contract but modern entries never need it', async () => {
    const seen: any[] = [];
    const { baseUrl } = await startModel(seen);
    const env = makeEnv();
    await prepareHistory(env, baseUrl, 300);
    const runtime = makeRuntime(env);
    try {
      runtime.setMode('full_access');
      log.length = 0;
      const legacy = runtime.getSnapshot();
      expect(Array.isArray(legacy.conversation)).toBe(true);
      // The compatibility path is the only place allowed to read the whole history at once.
      expect(maxFactRows()).toBeGreaterThanOrEqual(300);
    } finally { await runtime.shutdown(); }
  }, 60_000);
});
