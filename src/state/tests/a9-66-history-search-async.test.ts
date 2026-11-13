/// <reference path="./better-sqlite3.d.ts" />
/**
 * A9-66 F-008: the cooperative history search must return exactly the same
 * pages as the legacy single-statement search over ALL retained history,
 * interleave with the event loop between bounded SQL windows, honour
 * cancellation and fail with a stable code if the database closes.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import { A9PersistenceManager } from '../src';
const { visibleHistoryText } = require('../../shell/product/a9-history');
const PREFIX = 'a9-66-67-state-';
const residuals = () => fs.readdirSync(os.tmpdir()).filter(name => name.startsWith(PREFIX)).sort();
let beforeResiduals: string[], root: string | undefined, manager: A9PersistenceManager | undefined;
beforeAll(() => { beforeResiduals = residuals(); });
afterAll(() => { expect(residuals()).toEqual(beforeResiduals); });
afterEach(() => {
  try { if (manager && (manager.db as any).open) manager.db.close(); } finally {
    if (root) fs.rmSync(root, { recursive: true, force: true });
    manager = undefined; root = undefined;
  }
});
const project = (json: string, type: string) => visibleHistoryText(json, type, (value: string) => value);

function setup(rows: number) {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), PREFIX)));
  const outcome = A9PersistenceManager.open({ databasePath: path.join(root, 'a9.db'), dataRoot: root,
    openDatabase: (file: string, options: any) => new Database(file, options) });
  if (outcome.status !== 'ready') throw new Error(outcome.status);
  manager = outcome.manager;
  const a = manager.ensureActiveConversation(path.join(root, '中文 workspace'), 'legacy-a', 'conv-a');
  const b = manager.ensureActiveConversation(path.join(root, 'other workspace'), 'legacy-b', 'conv-b');
  const store = manager;
  store.db.transaction(() => {
    for (let n = 0; n < rows; n += 1) {
      for (const session of [a.sessionId, b.sessionId]) {
        const taskId = `task-${session}-${n}`, turnId = `turn-${session}-${n}`;
        const text = n % 7 === 0 ? `needle 多字节 ${n}` : `filler ${n}`;
        store.upsertTask(taskId, session, 'completed'); store.upsertTurn(turnId, taskId, session, 'completed');
        store.recordModelEvent(session, null, 'conversation.request', { taskId, requestPrompt: text });
        store.saveCheckpoint({ turnId, sessionId: session, payload: { requestPrompt: text, finalMessage: `答复 ${text}` } });
      }
    }
  })();
  // Ties on createdAt exercise the (createdAt, source, id) cursor order.
  store.db.prepare("UPDATE a9_events SET created_at = '2026-11-01T00:00:0' || (id % 3) || '.000Z'").run();
  store.db.prepare("UPDATE a9_checkpoints SET created_at = '2026-11-01T00:00:01.000Z'").run();
  return { store, workspace: a.workspacePath };
}

async function allPages(search: (before?: any) => Promise<any> | any): Promise<any[]> {
  const pages: any[] = [];
  let before: any;
  do {
    const page = await search(before);
    pages.push(page);
    before = page.nextBefore;
  } while (before);
  return pages;
}

it('returns the identical complete page sequence as the legacy search while yielding between SQL windows', async () => {
  const f = setup(1500);
  const writes = f.store.db.prepare('SELECT total_changes() AS n').get();
  const legacy = await allPages((before) => f.store.searchRetainedHistory(f.workspace,
    { query: 'needle 多字节', limit: 50, ...(before ? { before } : {}) }, project));
  let ticks = 0, running = true;
  const tick = () => { if (!running) return; ticks += 1; setImmediate(tick); };
  setImmediate(tick);
  const started = Date.now();
  let cooperative: any[];
  try {
    cooperative = await allPages((before) => (f.store as any).searchRetainedHistoryAsync(f.workspace,
      { query: 'needle 多字节', limit: 50, ...(before ? { before } : {}) }, project));
  } finally {
    running = false;
  }
  const elapsed = Date.now() - started;
  expect(cooperative).toEqual(legacy);
  const total = legacy.reduce((sum, page) => sum + page.results.length, 0);
  // Every 7th of 1500 rows matches as request event and as checkpoint reply.
  expect(total).toBe(2 * Math.ceil(1500 / 7));
  expect(ticks).toBeGreaterThan(legacy.length * 4);
  expect(f.store.db.prepare('SELECT total_changes() AS n').get()).toEqual(writes);
  process.stdout.write(`[a9-66-evidence] history rows=${1500 * 2 * 2} pages=${legacy.length} matches=${total} ticks=${ticks} ms=${elapsed}\n`);
});

it('honours cancellation and a database closed between windows with stable codes', async () => {
  const f = setup(600);
  const signal = { aborted: false };
  const pending = (f.store as any).searchRetainedHistoryAsync(f.workspace, { query: 'needle' }, project, { batchRows: 16, signal });
  setImmediate(() => { signal.aborted = true; });
  await expect(pending).rejects.toMatchObject({ code: 'A9_HISTORY_SEARCH_CANCELLED' });
  const closing = (f.store as any).searchRetainedHistoryAsync(f.workspace, { query: 'needle' }, project, { batchRows: 16 });
  setImmediate(() => f.store.db.close());
  await expect(closing).rejects.toMatchObject({ code: 'A9_HISTORY_SEARCH_INTERRUPTED' });
});
