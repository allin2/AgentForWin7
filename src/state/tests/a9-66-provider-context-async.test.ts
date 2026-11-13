/// <reference path="./better-sqlite3.d.ts" />
/**
 * A9-66 F-007: the bounded cooperative context scan must reproduce the
 * synchronous oracle (listConversationFacts + buildPersistedTextContext)
 * exactly: messages and all statistics, across generations, ties, legacy and
 * partial rounds, continuation turns, budget overflow, retries and merged
 * checkpoints. It must also be bounded (no statement returns more than the
 * batch), interleave with the event loop, honour cancellation and report a
 * closed database with stable codes.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import { A9PersistenceManager } from '../src';
const { buildPersistedTextContext, buildPersistedTextContextFromSummary } = require('../../shell/product/a9-agent-runtime');
const PREFIX = 'a9-66-67-state-ctx-';
const residuals = () => fs.readdirSync(os.tmpdir()).filter(name => name.startsWith(PREFIX)).sort();
let beforeResiduals: string[];
let root: string | undefined;
let manager: A9PersistenceManager | undefined;
const statementLog: Array<{ sql: string; rows: number }> = [];
beforeAll(() => { beforeResiduals = residuals(); });
afterAll(() => { expect(residuals()).toEqual(beforeResiduals); });
afterEach(() => {
  try { if (manager && (manager.db as any).open) manager.db.close(); } finally {
    if (root) fs.rmSync(root, { recursive: true, force: true });
    manager = undefined; root = undefined; statementLog.length = 0;
  }
});

/** Real SQLite; the wrapper only OBSERVES how many rows each .all() returns. */
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
              const rows = member.apply(inner, args);
              statementLog.push({ sql, rows: rows.length });
              return rows;
            };
          },
        });
      };
    },
  });
}

function open(): A9PersistenceManager {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), PREFIX)));
  const outcome = A9PersistenceManager.open({ databasePath: path.join(root, 'a9.db'), dataRoot: root, openDatabase: observedDatabase });
  if (outcome.status !== 'ready') throw new Error(outcome.status);
  manager = outcome.manager;
  return manager;
}

const turnTimes = (store: A9PersistenceManager, rewrite: (id: string, n: number) => string) => {
  const rows = store.db.prepare('SELECT turn_id FROM a9_checkpoints ORDER BY rowid').all() as any[];
  rows.forEach((row, n) => store.db.prepare('UPDATE a9_checkpoints SET created_at = ? WHERE turn_id = ?').run(rewrite(row.turn_id, n), row.turn_id));
};

function richFixture(store: A9PersistenceManager) {
  const a = store.ensureActiveConversation(path.join(root!, 'ws 中文'), 'legacy-a', 'conv-a');
  const b = store.ensureActiveConversation(path.join(root!, 'other'), 'legacy-b', 'conv-b');
  const s = a.sessionId;
  store.db.transaction(() => {
    for (let n = 0; n < 45; n += 1) {
      const taskId = `task-${n}`, turnId = `turn-${n}`;
      store.upsertTask(taskId, s, n % 9 === 0 ? 'interrupted' : 'completed');
      store.upsertTurn(turnId, taskId, s, 'completed', n % 11 === 0 ? { continuation: { turnId, taskId } } : {});
      // Retried request: the LAST request event per task wins.
      if (n % 5 === 0) store.recordModelEvent(s, null, 'conversation.request', { taskId, requestPrompt: `early draft ${n}` });
      if (n % 13 !== 0) store.recordModelEvent(s, null, 'conversation.request', { taskId, requestPrompt: `请求 ${n} 😀 ${'x'.repeat(n % 4 === 0 ? 2500 : 20)}` });
      // Interrupted-continuation request events are excluded from facts.
      if (n % 17 === 0) store.recordModelEvent(s, null, 'conversation.request', { taskId, requestPrompt: 'excluded', interruptedTurnId: 'whatever' });
      const generation = n < 8 ? undefined : n < 30 ? 1 : 2;
      store.saveCheckpoint({ turnId, sessionId: s, payload: {
        requestPrompt: n % 13 === 0 ? `from checkpoint ${n}` : undefined,
        finalMessage: n % 6 === 0 ? '' : `答复 ${n} 😀 ${'y'.repeat(n === 44 ? 31000 : n % 4 === 0 ? 3000 : 30)}`,
        outcome: 'completed',
        ...(generation === undefined ? {} : { providerContextGeneration: generation }),
      } });
      // A second checkpoint of the same task replaces the first (merged fact).
      if (n % 7 === 0) store.saveCheckpoint({ turnId: `${turnId}-b`, sessionId: s, payload: { finalMessage: `second ${n}`, providerContextGeneration: generation ?? 0 } });
    }
    // Legacy checkpoint without a task/turn row.
    store.saveCheckpoint({ turnId: 'turn-legacy', sessionId: s, payload: { requestPrompt: 'legacy ask', finalMessage: 'legacy answer' } });
    // Request without any reply, and a request-only fact.
    store.upsertTask('task-open', s, 'active');
    store.recordModelEvent(s, null, 'conversation.request', { taskId: 'task-open', requestPrompt: 'still running' });
    // Another conversation never leaks in.
    store.upsertTask('task-other', b.sessionId, 'completed');
    store.recordModelEvent(b.sessionId, null, 'conversation.request', { taskId: 'task-other', requestPrompt: 'other conversation' });
    store.saveCheckpoint({ turnId: 'turn-other', sessionId: b.sessionId, payload: { finalMessage: 'other answer' } });
  })();
  return s;
}

describe('A9-66 F-007 bounded Provider-context scan equals the synchronous oracle', () => {
  it.each([
    ['distinct timestamps', (_id: string, n: number) => `2026-11-01T00:00:${String(n % 60).padStart(2, '0')}.${String(n).padStart(3, '0')}Z`],
    ['all identical timestamps (tie order = first insertion)', () => '2026-11-01T00:00:00.000Z'],
    ['groups of equal timestamps', (_id: string, n: number) => `2026-11-01T00:00:0${Math.floor(n / 9) % 10}.000Z`],
    ['reverse timestamps', (_id: string, n: number) => `2026-11-01T01:00:00.${String(999 - n).padStart(3, '0')}Z`],
  ])('%s: messages and stats match for every generation and batch size', async (_name, stamp) => {
    const store = open();
    const session = richFixture(store);
    turnTimes(store, stamp);
    const oracleFacts = store.listConversationFacts(session);
    expect(oracleFacts.length).toBeGreaterThan(40);
    for (const generation of [0, 1, 2, 3]) {
      const oracle = buildPersistedTextContext(oracleFacts, generation);
      for (const batchRows of [1, 2, 7, 256]) {
        const summary = await store.scanConversationFactsAsync(session, { providerContextGeneration: generation, batchRows });
        expect(buildPersistedTextContextFromSummary(summary)).toEqual(oracle);
        expect(summary.visibleRounds).toBe(oracleFacts.length);
      }
    }
  });

  it('keeps the budget semantics: an over-budget newest round stops the selection exactly like the oracle', async () => {
    const store = open();
    const session = richFixture(store);
    const oracle = buildPersistedTextContext(store.listConversationFacts(session), 2);
    const summary = await store.scanConversationFactsAsync(session, { providerContextGeneration: 2, batchRows: 5 });
    const built = buildPersistedTextContextFromSummary(summary);
    expect(built).toEqual(oracle);
    expect(built.stats.omittedRounds).toBeGreaterThan(0);
  });

  it('an empty conversation gives the oracle result too', async () => {
    const store = open();
    const record = store.ensureActiveConversation(path.join(root!, 'empty'), 'legacy-e', 'conv-e');
    const summary = await store.scanConversationFactsAsync(record.sessionId, { providerContextGeneration: 0 });
    expect(buildPersistedTextContextFromSummary(summary)).toEqual(buildPersistedTextContext(store.listConversationFacts(record.sessionId), 0));
  });
});

describe('A9-66 F-007 bounded reads, event-loop interleaving, cancellation', () => {
  function bigHistory(store: A9PersistenceManager, rounds: number): string {
    const record = store.ensureActiveConversation(path.join(root!, 'big'), 'legacy-big', 'conv-big');
    const s = record.sessionId;
    store.db.transaction(() => {
      for (let n = 0; n < rounds; n += 1) {
        const taskId = `t-${n}`, turnId = `u-${n}`;
        store.upsertTask(taskId, s, 'completed');
        store.upsertTurn(turnId, taskId, s, 'completed');
        store.recordModelEvent(s, null, 'conversation.request', { taskId, requestPrompt: `ask ${n}` });
        for (let k = 0; k < 3; k += 1) store.recordModelEvent(s, turnId, 'tool_output', { taskId, text: `noise ${n}.${k}` });
        store.saveCheckpoint({ turnId, sessionId: s, payload: { finalMessage: `answer ${n}`, providerContextGeneration: 0 } });
      }
    })();
    return s;
  }

  it('reads in bounded statements and lets the event loop run between them', async () => {
    const store = open();
    const session = bigHistory(store, 3000);
    statementLog.length = 0;
    let ticks = 0;
    let running = true;
    const tick = () => { if (running) { ticks += 1; setImmediate(tick); } };
    setImmediate(tick);
    let summary;
    try { summary = await store.scanConversationFactsAsync(session, { providerContextGeneration: 0, batchRows: 128 }); } finally { running = false; }
    const factStatements = statementLog.filter(entry => /a9_events|a9_checkpoints/.test(entry.sql));
    expect(Math.max(...factStatements.map(entry => entry.rows))).toBeLessThanOrEqual(128);
    expect(factStatements.length).toBeGreaterThan(40);
    expect(ticks).toBeGreaterThanOrEqual(factStatements.length - 1);
    expect(buildPersistedTextContextFromSummary(summary)).toEqual(buildPersistedTextContext(store.listConversationFacts(session), 0));
  });

  it('the synchronous oracle runs as ONE unbounded statement per table (the behaviour the product no longer uses)', () => {
    const store = open();
    const session = bigHistory(store, 1500);
    statementLog.length = 0;
    store.listConversationFacts(session);
    expect(Math.max(...statementLog.map(entry => entry.rows))).toBeGreaterThanOrEqual(1500);
  });

  it('sparse event IDs progress by existing rows, including non-request events', async () => {
    const store = open();
    const session = bigHistory(store, 3);
    store.db.prepare('UPDATE a9_events SET id = id + 1000000000 WHERE id > 4').run();
    const oracle = buildPersistedTextContext(store.listConversationFacts(session), 0);
    statementLog.length = 0;
    const signal = { aborted: false };
    let turns = 0, running = true;
    let handle: NodeJS.Immediate;
    const tick = () => {
      if (!running) return;
      if (++turns >= 100) { signal.aborted = true; return; }
      handle = setImmediate(tick);
    };
    handle = setImmediate(tick);
    try {
      const summary = await store.scanConversationFactsAsync(session, { providerContextGeneration: 0, batchRows: 2, signal });
      expect(buildPersistedTextContextFromSummary(summary)).toEqual(oracle);
      expect(signal.aborted).toBe(false);
      expect(statementLog.filter(entry => /FROM a9_events/.test(entry.sql)).length).toBeLessThanOrEqual(7);
    } finally { running = false; clearImmediate(handle!); }
  });

  it('retains references instead of all history prompt/reply payloads during the merge', async () => {
    const store = open();
    const session = bigHistory(store, 400);
    const text = 'virtual historical payload '.repeat(200);
    store.db.prepare("UPDATE a9_events SET payload_json=json_set(payload_json, '$.requestPrompt', ?) WHERE event_type='conversation.request'").run(text);
    store.db.prepare("UPDATE a9_checkpoints SET payload_json=json_set(payload_json, '$.finalMessage', ?)").run(text);
    const oracle = buildPersistedTextContext(store.listConversationFacts(session), 0);
    const sizes = new WeakMap<object, { total: number; entries: Record<string, number> }>();
    let peak = 0, observed = 0;
    const original = Map.prototype.set;
    const observer = jest.spyOn(Map.prototype, 'set').mockImplementation(function(this: Map<any, any>, key: any, value: any) {
      if (value && typeof value === 'object' && typeof value.taskId === 'string' && 'createdAt' in value) {
        observed += 1;
        const record = sizes.get(this) || { total: 0, entries: Object.create(null) };
        const length = (typeof value.requestPrompt === 'string' ? value.requestPrompt.length : 0)
          + (typeof value.finalMessage === 'string' ? value.finalMessage.length : 0);
        record.total += length - (record.entries[key] || 0);
        record.entries[key] = length;
        sizes.set(this, record);
        peak = Math.max(peak, record.total);
      }
      return original.call(this, key, value);
    });
    let summary;
    try { summary = await store.scanConversationFactsAsync(session, { providerContextGeneration: 0, batchRows: 32 }); }
    finally { observer.mockRestore(); }
    expect(buildPersistedTextContextFromSummary(summary)).toEqual(oracle);
    expect(observed).toBeGreaterThanOrEqual(800);
    expect(peak).toBeLessThanOrEqual(20 * text.length * 2);
  });

  it('a cancelled scan rejects with a stable code and leaves nothing behind', async () => {
    const store = open();
    const session = bigHistory(store, 800);
    const signal = { aborted: false };
    let seen = 0;
    const pending = store.scanConversationFactsAsync(session, { providerContextGeneration: 0, batchRows: 16, signal });
    const watcher = setInterval(() => { seen += 1; if (seen >= 2) signal.aborted = true; }, 1);
    try { await expect(pending).rejects.toMatchObject({ code: 'A9_CONTEXT_RESTORE_CANCELLED' }); }
    finally { clearInterval(watcher); }
  });

  it('a database closed during the scan fails with A9_CONTEXT_RESTORE_INTERRUPTED', async () => {
    const store = open();
    const session = bigHistory(store, 800);
    const pending = store.scanConversationFactsAsync(session, { providerContextGeneration: 0, batchRows: 16 });
    setImmediate(() => store.db.close());
    await expect(pending).rejects.toMatchObject({ code: 'A9_CONTEXT_RESTORE_INTERRUPTED' });
  });

  it('rejects an invalid batch size', async () => {
    const store = open();
    const record = store.ensureActiveConversation(path.join(root!, 'x'), 'legacy-x', 'conv-x');
    await expect(store.scanConversationFactsAsync(record.sessionId, { providerContextGeneration: 0, batchRows: 0 })).rejects.toBeTruthy();
  });
});
