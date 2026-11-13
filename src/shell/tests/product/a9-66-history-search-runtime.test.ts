/// <reference path="./better-sqlite3.d.ts" />
/**
 * A9-66 F-008 through the stable product entry (Runtime.searchHistory): the
 * search must interleave with the real event loop and return exactly the
 * pages of the legacy single-statement search. A variant that routes the same
 * entry to the legacy synchronous method (see run-variant-sandbox.sh
 * `sync-search`) fails the interleaving assertion for the business reason,
 * not for a missing API.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';

const { createA9AgentRuntime } = require('../../product/a9-agent-runtime');
const { visibleHistoryText } = require('../../product/a9-history');
const PREFIX = 'a9-66-67-hist-';
const roots: string[] = [];
afterEach(() => { for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
afterAll(() => { expect(fs.readdirSync(os.tmpdir()).filter(name => name.startsWith(PREFIX))).toEqual([]); });

function seed(dataRoot: string, sessionId: string, rounds: number): void {
  const db = new Database(path.join(dataRoot, 'a9-state.db'));
  try {
    const task = db.prepare('INSERT INTO a9_tasks (task_id, session_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)');
    const turn = db.prepare('INSERT INTO a9_turns (turn_id, task_id, session_id, status, outcome_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const event = db.prepare('INSERT INTO a9_events (session_id, turn_id, kind, event_type, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)');
    const checkpoint = db.prepare('INSERT INTO a9_checkpoints (turn_id, session_id, created_at, payload_json) VALUES (?, ?, ?, ?)');
    db.exec('BEGIN');
    try {
      for (let n = 0; n < rounds; n += 1) {
        // Equal timestamps in groups exercise the (createdAt, source, id) cursor order.
        const at = `2026-11-01T00:${String(Math.floor(n / 100) % 60).padStart(2, '0')}:00.000Z`;
        const taskId = `t-${n}`, turnId = `u-${n}`;
        const text = n % 5 === 0 ? `needle 中文 ${n}` : `filler ${n}`;
        task.run(taskId, sessionId, 'completed', at, at);
        turn.run(turnId, taskId, sessionId, 'completed', '{}', at, at);
        event.run(sessionId, null, 'model', 'conversation.request', JSON.stringify({ taskId, requestPrompt: text }), at);
        event.run(sessionId, turnId, 'tool', 'tool_output', JSON.stringify({ taskId, text: `tool ${text}` }), at);
        checkpoint.run(turnId, sessionId, at, JSON.stringify({ outcome: 'completed', finalMessage: `reply ${text}` }));
      }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  } finally { db.close(); }
}

it('Runtime.searchHistory interleaves with the event loop and equals the legacy pages', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), PREFIX));
  roots.push(root);
  const workspaceRoot = path.join(root, 'ws');
  const dataRoot = path.join(root, 'data');
  fs.mkdirSync(workspaceRoot);
  fs.mkdirSync(dataRoot);
  const open = (file: string, options?: { readonly?: boolean }) => new Database(file, options?.readonly ? { readonly: true } : {});
  const first = createA9AgentRuntime({ workspaceRoot, dataRoot, ownerId: 'hist-a', openDatabase: open });
  const sessionId = first.getSnapshot({ conversationPage: true }).activeConversationId;
  await first.shutdown();
  seed(dataRoot, sessionId, 2500);

  const runtime = createA9AgentRuntime({ workspaceRoot, dataRoot, ownerId: 'hist-b', openDatabase: open });
  try {
    let ticks = 0;
    let running = true;
    const tick = () => { if (running) { ticks += 1; setImmediate(tick); } };
    setImmediate(tick);
    const pages: any[] = [];
    let before: any;
    try {
      for (let i = 0; i < 2; i += 1) {
        const page: any = await runtime.searchHistory({ query: 'needle', limit: 25, ...(before ? { before } : {}) });
        expect(page.ok).toBe(true);
        pages.push(page);
        before = page.nextBefore;
      }
    } finally { running = false; }
    // Legacy oracle: the single-statement search over all retained history.
    const { A9PersistenceManager } = require('../../../state/dist');
    const outcome = A9PersistenceManager.open({ databasePath: path.join(dataRoot, 'a9-state.db'), dataRoot, openDatabase: open });
    try {
      const workspace = (outcome.manager.db.prepare('SELECT workspace_path AS w FROM a9_sessions WHERE session_id = ?').get(sessionId) as any).w;
      const project = (json: string, type: string) => visibleHistoryText(json, type, (value: string) => value);
      const legacy1 = outcome.manager.searchRetainedHistory(workspace, { query: 'needle', limit: 25 }, project);
      const legacy2 = outcome.manager.searchRetainedHistory(workspace, { query: 'needle', limit: 25, before: legacy1.nextBefore }, project);
      const keys = (page: any) => page.results.map((row: any) => [row.createdAt, row.source, row.id, row.snippet]);
      expect(keys(pages[0])).toEqual(keys(legacy1));
      expect(keys(pages[1])).toEqual(keys(legacy2));
      expect(pages[0].results.length).toBe(25);
    } finally { outcome.manager.db.close(); }
    // 2500 rounds x 3 retained rows scanned in bounded windows: the loop must have run many times.
    expect(ticks).toBeGreaterThan(40);
  } finally { await runtime.shutdown(); }
}, 60_000);
