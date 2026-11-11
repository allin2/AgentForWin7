/// <reference path="./better-sqlite3.d.ts" />
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import { A9PersistenceManager } from '../src';
const { visibleHistoryText } = require('../../shell/product/a9-history');
const { validateHistoryInput } = require('../../shell/product/a9-history');
const PREFIX = 'win7-a958-state-';
const residuals = () => fs.readdirSync(os.tmpdir()).filter(name => name.startsWith(PREFIX)).sort();
let beforeResiduals: string[], root: string | undefined, manager: A9PersistenceManager | undefined;
beforeAll(() => { beforeResiduals = residuals(); });
afterAll(() => { expect(residuals()).toEqual(beforeResiduals); });
afterEach(() => { try { manager?.db.close(); } finally { if (root) fs.rmSync(root, { recursive: true, force: true }); manager = undefined; root = undefined; } });
function setup() {
  root = fs.mkdtempSync(path.join(os.tmpdir(), PREFIX));
  root = fs.realpathSync(root);
  const outcome = A9PersistenceManager.open({ databasePath: path.join(root, 'a9.db'), dataRoot: root,
    openDatabase: (file: string, options: any) => new Database(file, options) });
  if (outcome.status !== 'ready') throw new Error(outcome.status);
  manager = outcome.manager;
  // SQL joins exercise the actual persisted workspace ownership.
  const a = manager.ensureActiveConversation(path.join(root, '中文 workspace'), 'legacy-a', 'conv-a');
  const b = manager.ensureActiveConversation(path.join(root, 'other workspace'), 'legacy-b', 'conv-b');
  return { store: manager, a: a.sessionId, b: b.sessionId, workspace: a.workspacePath };
}
const redact = (value: string) => value.replace(/SECRET_VALUE/g, '***redacted***').replace(/password=[^\s]+/g, 'password=***redacted***');
const project = (json: string, type: string) => visibleHistoryText(json, type, redact);
function seed(store: A9PersistenceManager, session: string, n: number, text: string) {
  const taskId = `task-${session}-${n}`, turnId = `turn-${session}-${n}`;
  store.upsertTask(taskId, session, 'completed'); store.upsertTurn(turnId, taskId, session, 'completed');
  store.recordModelEvent(session, null, 'conversation.request', { taskId, requestPrompt: text });
  store.saveCheckpoint({ turnId, sessionId: session, payload: { requestPrompt: text, finalMessage: `答复 ${text}` } });
  return { taskId, turnId };
}
it('queries all retained rows with bounded literal SQL pages, stable ties and no writes', () => {
  const f = setup(), literal = `中文 空格 % _ ' \\`;
  for (let n = 0; n < 155; n++) seed(f.store, f.a, n, literal);
  seed(f.store, f.b, 1, literal);
  f.store.db.prepare('UPDATE a9_events SET created_at=?').run('2026-11-01T00:00:00.000Z');
  f.store.db.prepare('UPDATE a9_checkpoints SET created_at=?').run('2026-11-01T00:00:00.000Z');
  const writes = f.store.db.prepare('SELECT total_changes() AS n').get();
  const ids = new Set<string>(); let before: any;
  for (let page = 0; page < 40; page++) {
    const result = f.store.searchRetainedHistory(f.workspace, { query: literal, limit: 13, ...(before ? { before } : {}) }, project);
    expect(result.results.length).toBeLessThanOrEqual(13);
    for (const item of result.results) {
      expect(item.conversationId).toBe(f.a); expect(item.snippet).toContain(literal); expect(item.snippet.length).toBeLessThanOrEqual(420);
      const key = `${item.source}:${item.id}`; expect(ids.has(key)).toBe(false); ids.add(key);
    }
    if (!result.hasMore) break;
    before = result.nextBefore;
  }
  expect(ids.size).toBe(310);
  expect(f.store.db.prepare('SELECT total_changes() AS n').get()).toEqual(writes);
});
it('filters fields and secrets before matching; preserves retained prompts after event cleanup', () => {
  const f = setup(); const turn = seed(f.store, f.a, 1, 'kept prompt SECRET_VALUE');
  f.store.recordToolEvent(f.a, turn.turnId, 'tool_start', { data: { args: { command: 'echo 中文 %_', apiKey: 'HIDDEN_FIELD' } } });
  f.store.recordToolEvent(f.a, turn.turnId, 'tool_end', { data: { toolName: 'shell', result: JSON.stringify({ error: { message: '报错 password=ABC' } }), shell: { stdout: '可见输出', stderr: '错误' }, config: 'HIDDEN_CONFIG' } });
  for (const query of ['SECRET_VALUE', 'HIDDEN_FIELD', 'HIDDEN_CONFIG', 'ABC']) expect(f.store.searchRetainedHistory(f.workspace, { query }, project).results).toEqual([]);
  for (const query of ['echo 中文 %_', '可见输出', '报错']) expect(f.store.searchRetainedHistory(f.workspace, { query }, project).results).toHaveLength(1);
  f.store.db.prepare("DELETE FROM a9_events WHERE event_type='conversation.request'").run();
  const result = f.store.searchRetainedHistory(f.workspace, { query: 'kept prompt' }, project);
  expect(result.results).toHaveLength(1);
  expect(result.results[0]).toMatchObject({ source: 'checkpoint', id: turn.turnId });
});
it('locates the exact deep source in one bounded read and refuses other workspace identities', () => {
  const f = setup(); const turn = seed(f.store, f.a, 1, 'deep prompt');
  f.store.saveCheckpoint({ turnId: turn.turnId, sessionId: f.a, payload: { finalMessage: 'x'.repeat(50000) + '深处命中' + 'y'.repeat(50000) } });
  const factsSpy = jest.spyOn(f.store, 'listConversationFactPage');
  const writes = f.store.db.prepare('SELECT total_changes() AS n').get();
  const result = f.store.locateRetainedHistory(f.workspace, { conversationId: f.a, source: 'checkpoint', id: turn.turnId, query: '深处命中' }, project);
  expect(result.text).toContain('深处命中'); expect(result.text.length).toBeLessThanOrEqual(24000); expect(result.textOffset).toBeGreaterThan(49000);
  expect(factsSpy).not.toHaveBeenCalled();
  expect(f.store.locateRetainedHistory('other workspace', { conversationId: f.a, source: 'checkpoint', id: turn.turnId }, project)).toBeNull();
  expect(f.store.db.prepare('SELECT total_changes() AS n').get()).toEqual(writes);
});

it('pages legacy SQLite timestamp rows through the production input validator without normalizing cursor bytes', () => {
  const f = setup();
  for (let n = 0; n < 12; n++) seed(f.store, f.a, n, 'legacy cursor needle');
  f.store.db.prepare('UPDATE a9_events SET created_at=?').run('2026-11-01 00:00:00');
  f.store.db.prepare('UPDATE a9_checkpoints SET created_at=?').run('2026-11-01 00:00:00.123');
  const seen = new Set<string>();
  let before: any;
  do {
    const input = { query: 'legacy cursor needle', limit: 3, ...(before ? { before } : {}) };
    validateHistoryInput('search', input);
    const page = f.store.searchRetainedHistory(f.workspace, input, project);
    for (const row of page.results) {
      const key = row.source + ':' + row.id;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
    before = page.nextBefore;
  } while (before);
  expect(seen.size).toBe(24);
  for (const createdAt of ['2026-11-01', '2026-02-30 00:00:00', '2026-11-01 25:00:00', '2026-11-01 00:00:00; DROP TABLE x']) {
    expect(() => validateHistoryInput('search', { query: 'x', before: { createdAt, source: 'event', id: '1' } })).toThrow('A9_PAYLOAD_INVALID');
  }
});
