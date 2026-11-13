/// <reference path="./better-sqlite3.d.ts" />
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
const { createA9AgentRuntime, buildPersistedTextContext } = require('../../product/a9-agent-runtime');

// Real compiled State, Runtime, Core and SQLite. Only the external model is
// in-process SURROGATE; these tests make no HTTP/transport claim.
const roots: string[] = [];
const runtimes: any[] = [];
const databases: any[] = [];
afterEach(async () => {
  try { for (const runtime of runtimes.splice(0)) await runtime.shutdown(); }
  finally {
    for (const db of databases.splice(0)) if (db.open) db.close();
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  }
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a9-66-ready-'));
  roots.push(root);
  const workspaceRoot = path.join(root, 'workspace'), dataRoot = path.join(root, 'data');
  fs.mkdirSync(workspaceRoot);
  const requests: any[] = [];
  function open() {
    let store: any;
    const runtime = createA9AgentRuntime({ workspaceRoot, dataRoot, ownerId: `ready-${Math.random()}`,
      openDatabase: (file: string, options: any) => { const db = new Database(file, options); databases.push(db); return db; },
      openPersistence: (config: any, create: any) => { const outcome = create(config); store = outcome.manager; return outcome; },
      wrapProvider: () => ({ sendStreamRequest: async (request: any) => {
        requests.push(JSON.parse(JSON.stringify(request)));
        return { id: 'virtual-reply', content: 'virtual model reply', finishReason: 'stop' };
      } }),
    });
    runtimes.push(runtime);
    runtime.setMode('full_access');
    const facts = store.listConversationFacts.bind(store);
    const sync = jest.spyOn(store, 'listConversationFacts').mockImplementation(() => { throw new Error('UNEXPECTED_SYNC_HISTORY'); });
    const scan = jest.spyOn(store, 'scanConversationFactsAsync');
    const session = () => runtime.getSnapshot({ conversationPage: true }).activeConversationId;
    const oracle = (id = session()) => buildPersistedTextContext(facts(id), store.getConversationMetadata(id).providerContextGeneration ?? 0);
    const seed = (id = session(), label = 'old', count = 700) => store.db.transaction(() => {
      const generation = store.getConversationMetadata(id).providerContextGeneration ?? 0;
      for (let n = 0; n < count; n += 1) {
        const taskId = `${label}-task-${n}`, turnId = `${label}-turn-${n}`;
        store.upsertTask(taskId, id, 'completed'); store.upsertTurn(turnId, taskId, id, 'completed');
        store.recordModelEvent(id, null, 'conversation.request', { taskId, requestPrompt: `${label} ask ${n}` });
        store.saveCheckpoint({ turnId, sessionId: id, payload: { finalMessage: `${label} reply ${n}`, providerContextGeneration: generation } });
      }
    })();
    return { runtime, store, sync, scan, session, seed, oracle };
  }
  const configure = (runtime: any, baseUrl = 'https://virtual.invalid/a', model = 'model-a') =>
    runtime.configureProvider({ baseUrl, model, skipProbe: true });
  async function prepared() {
    const first = open();
    await configure(first.runtime);
    first.seed();
    const oracle = first.oracle(), session = first.session();
    await first.runtime.shutdown();
    const next = open();
    return { ...next, expected: oracle, originalSession: session };
  }
  return { open, requests, configure, prepared, workspaceRoot, dataRoot, root };
}
const messages = (request: any) => request.messages.filter((m: any) => m.role === 'user' || m.role === 'assistant');
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

it('first submit and same-URL model switch await the compiled async consumer and preserve complete oracle messages', async () => {
  const f = fixture(), a = await f.prepared();
  // A retained event ID gap must not turn first-submit preparation into a
  // billion empty numeric windows.
  a.store.db.prepare('UPDATE a9_events SET id=id+1000000000 WHERE id>1').run();
  expect((await a.runtime.submitTurn('initial question')).ok).toBe(true);
  expect(messages(f.requests[0]).slice(0, a.expected.messages.length)).toEqual(a.expected.messages);
  await f.configure(a.runtime, undefined, 'model-b');
  expect((await a.runtime.submitTurn('after model switch')).ok).toBe(true);
  expect(messages(f.requests[1]).slice(0, a.expected.messages.length)).toEqual(a.expected.messages);
  expect(a.scan).toHaveBeenCalled(); expect(a.sync).not.toHaveBeenCalled();
});

it('same-URL reconfiguration before the first submit restores asynchronously', async () => {
  const f = fixture(), a = await f.prepared();
  let beats = 0, running = true;
  let handle: NodeJS.Immediate;
  const heartbeat = () => { if (running) { beats += 1; handle = setImmediate(heartbeat); } };
  handle = setImmediate(heartbeat);
  try { await f.configure(a.runtime, undefined, 'model-b'); }
  finally { running = false; clearImmediate(handle!); }
  expect(beats).toBeGreaterThan(5);
  expect(a.scan).toHaveBeenCalledTimes(1);
  expect((await a.runtime.submitTurn('question')).ok).toBe(true);
  expect(messages(f.requests[0]).slice(0, a.expected.messages.length)).toEqual(a.expected.messages);
  expect(a.sync).not.toHaveBeenCalled();
});

it('BaseURL change uses the new generation and keeps exact old-history visibility statistics', async () => {
  const f = fixture(), a = await f.prepared();
  await f.configure(a.runtime, 'https://virtual.invalid/b');
  expect(a.runtime.getSnapshot({ conversationPage: true }).contextWindow).toMatchObject(a.oracle().stats);
  expect((await a.runtime.submitTurn('new endpoint')).ok).toBe(true);
  expect(messages(f.requests[0])).toEqual([{ role: 'user', content: 'new endpoint' }]);
  expect(a.scan).toHaveBeenCalled(); expect(a.sync).not.toHaveBeenCalled();
});

it('an actual conversation switch during preparation discards the cancelled old scope and restores the new one', async () => {
  const f = fixture(), a = await f.prepared();
  const second = a.runtime.createConversation().conversationId;
  a.seed(second, 'second', 40);
  const expected = a.oracle(second);
  a.runtime.activateConversation(a.originalSession);
  const configuring = f.configure(a.runtime, undefined, 'model-b');
  await tick();
  a.runtime.activateConversation(second);
  await expect(configuring).resolves.toMatchObject({ ok: true });
  expect((await a.runtime.submitTurn('new conversation')).ok).toBe(true);
  expect(messages(f.requests[0]).slice(0, expected.messages.length)).toEqual(expected.messages);
  expect(a.sync).not.toHaveBeenCalled();
});

it.each(['stop', 'close'])('%s during preparation ends before any model request and a new runtime can retry', async action => {
  const f = fixture(), a = await f.prepared();
  const pending = a.runtime.submitTurn('cancel before model');
  await tick();
  if (action === 'stop') a.runtime.stop();
  else await a.runtime.shutdown();
  const stopped = await pending;
  if (action === 'stop') {
    expect(stopped.ok).toBe(true);
    expect(stopped.result.outcome).toBe('cancelled');
    expect(stopped.result.toolCallsExecuted).toBe(0);
    expect(a.store.db.prepare('SELECT status FROM a9_tasks ORDER BY rowid DESC LIMIT 1').get().status).toBe('cancelled');
  } else expect(stopped.ok).toBe(false);
  expect(f.requests).toEqual([]);
  await a.runtime.shutdown();
  const b = f.open();
  const expected = b.oracle();
  expect((await b.runtime.submitTurn('retry')).ok).toBe(true);
  expect(messages(f.requests[0]).slice(0, expected.messages.length)).toEqual(expected.messages);
  expect(a.sync).not.toHaveBeenCalled(); expect(b.sync).not.toHaveBeenCalled();
});

it('concurrent submits share preparation without admitting a second request', async () => {
  const f = fixture(), a = await f.prepared();
  const results = await Promise.all([a.runtime.submitTurn('winner'), a.runtime.submitTurn('loser')]);
  expect(results.filter(result => result.ok)).toHaveLength(1);
  expect(f.requests).toHaveLength(1);
  expect(a.sync).not.toHaveBeenCalled();
});

it('failed preparation never promotes a cache and retries without replay', async () => {
  const f = fixture(), a = await f.prepared();
  a.scan.mockRejectedValueOnce(Object.assign(new Error('virtual read fault'), { code: 'SQLITE_IOERR' }));
  expect((await a.runtime.submitTurn('failed attempt')).ok).toBe(false);
  expect(f.requests).toEqual([]);
  expect((await a.runtime.submitTurn('retry')).ok).toBe(true);
  expect(messages(f.requests[0]).slice(0, a.expected.messages.length)).toEqual(a.expected.messages);
  expect(messages(f.requests[0]).some((m: any) => m.content === 'failed attempt')).toBe(false);
  expect(a.sync).not.toHaveBeenCalled();
});

it('awaiting shutdown releases A before reopening while B keeps its own mode, lock and checkpoints', async () => {
  const f = fixture(), a = await f.prepared();
  expect((await a.runtime.submitTurn('task in A')).ok).toBe(true);
  await a.runtime.shutdown();
  const wsB = path.join(f.root, 'workspace-b'); fs.mkdirSync(wsB);
  const b = createA9AgentRuntime({ workspaceRoot: wsB, dataRoot: f.dataRoot, ownerId: 'B',
    openDatabase: (file: string, options: any) => { const db = new Database(file, options); databases.push(db); return db; } });
  runtimes.push(b);
  const snapB = b.getSnapshot({ conversationPage: true });
  expect(snapB.mode).toBe('needs_selection');
  expect(snapB.checkpoints).toEqual([]);
  expect(snapB.workspaceRoot).toBe(wsB);
  const a2 = f.open(), snapA = a2.runtime.getSnapshot({ conversationPage: true });
  expect(snapA.mode).toBe('full_access');
  expect(snapA.checkpoints.length).toBeGreaterThanOrEqual(1);
  expect(snapA.workspaceRoot).toBe(f.workspaceRoot);
  b.setMode('read_only');
  expect(b.getSnapshot({ conversationPage: true }).lock.held).toBe(true);
  expect(a2.runtime.getSnapshot({ conversationPage: true }).lock.held).toBe(true);
});

it('a cancellation checkpoint failure blocks further dispatch with a structured audit failure', async () => {
  const f = fixture(), a = await f.prepared();
  const pending = a.runtime.submitTurn('stop before model');
  await tick();
  const save = jest.spyOn(a.store, 'saveCheckpoint').mockImplementationOnce(() => {
    throw Object.assign(new Error('virtual checkpoint write fault'), { code: 'SQLITE_IOERR' });
  });
  a.runtime.stop();
  const stopped = await pending;
  expect(stopped.ok).toBe(false);
  expect(stopped.error.code).toBe('A9_AUDIT_PERSISTENCE_FAILED');
  expect(stopped.result.auditIncomplete.failedEvent).toBe('context_restore_cancelled');
  save.mockRestore();
  expect((await a.runtime.submitTurn('must remain blocked')).error.code).toBe('A9_AUDIT_PERSISTENCE_FAILED');
  expect(f.requests).toEqual([]);
});
