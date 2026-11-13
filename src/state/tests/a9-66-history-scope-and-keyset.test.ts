/// <reference path="./better-sqlite3.d.ts" />
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as assert from 'assert/strict';
import Database from 'better-sqlite3';
import { A9PersistenceManager } from '../src';
const { visibleHistoryText } = require('../../shell/product/a9-history');

type Projector = (payload: string, type: string) => string;
type Fixture = {
  store: A9PersistenceManager;
  db: any;
  spaces: Record<string, { workspace: string; conversationId: string }>;
  seed(count: number): void;
  projector(key: string): Projector;
};
const prefix = 'a9-66-history-state-';
const residuals = () => fs.readdirSync(os.tmpdir()).filter(n => n.startsWith(prefix)).sort();
let originalResiduals: string[];
beforeAll(() => { originalResiduals = residuals(); });
afterAll(() => { expect(residuals()).toEqual(originalResiduals); });

async function withFixture(body: (fixture: Fixture) => Promise<void>): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  let db: any;
  try {
    const opened = A9PersistenceManager.open({
      databasePath: path.join(root, 'a9.db'), dataRoot: root,
      openDatabase(filename: string, options: any) {
        db = new Database(filename, options);
        return db;
      },
    });
    if (opened.status !== 'ready') throw new Error(opened.status);
    const store = opened.manager;
    const spaces: Fixture['spaces'] = {};
    for (const key of ['A', 'B']) {
      const workspace = path.join(root, key);
      fs.mkdirSync(workspace);
      const conv = store.ensureActiveConversation(workspace, `legacy-${key}`, `conv-${key}`);
      spaces[key] = { workspace, conversationId: conv.sessionId };
    }
    const seed = (count: number) => db.transaction(() => {
      for (let i = 0; i < count; i += 1) for (const key of ['A', 'B']) {
        const session = spaces[key].conversationId;
        const taskId = `task-${key}-${i}`, turnId = `turn-${key}-${i}`;
        const prompt = `needle PRIVATE_${key}_MARKER ${i}`;
        store.upsertTask(taskId, session, 'completed');
        store.upsertTurn(turnId, taskId, session, 'completed');
        store.recordModelEvent(session, null, 'conversation.request', { taskId, requestPrompt: prompt });
        store.saveCheckpoint({ turnId, sessionId: session, payload: {
          requestPrompt: prompt, finalMessage: `reply ${prompt}`,
        } });
      }
    })();
    const projector = (key: string): Projector => (payload, type) => visibleHistoryText(
      payload, type, (text: string) => text.split(`PRIVATE_${key}_MARKER`).join(`[REDACTED-${key}]`),
    );
    await body({ store, db, spaces, seed, projector });
  } finally {
    if (db?.open) db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe('A9-66 F-008 history projection and existing-key windows', () => {
  test('an async search keeps its own redaction after a synchronous search', () => withFixture(async f => {
    f.seed(3);
    const input = { query: 'needle', limit: 50 };
    const expected = f.store.searchRetainedHistory(f.spaces.A.workspace, input, f.projector('A'));
    const pending = f.store.searchRetainedHistoryAsync(f.spaces.A.workspace, input, f.projector('A'), { batchRows: 1 });
    f.store.searchRetainedHistory(f.spaces.B.workspace, input, f.projector('B'));
    const actual = await pending;
    expect(actual).toEqual(expected);
    expect(JSON.stringify(actual)).not.toContain('PRIVATE_A_MARKER');
  }));

  test('two async projectors remain isolated from a synchronous source lookup', () => withFixture(async f => {
    f.seed(4);
    const input = { query: 'needle', limit: 50 };
    const expectedA = f.store.searchRetainedHistory(f.spaces.A.workspace, input, f.projector('A'));
    const expectedB = f.store.searchRetainedHistory(f.spaces.B.workspace, input, f.projector('B'));
    const a = f.store.searchRetainedHistoryAsync(f.spaces.A.workspace, input, f.projector('A'), { batchRows: 2 });
    const b = f.store.searchRetainedHistoryAsync(f.spaces.B.workspace, input, f.projector('B'), { batchRows: 2 });
    const row = f.db.prepare('SELECT id FROM a9_events WHERE session_id=? ORDER BY id LIMIT 1')
      .get(f.spaces.B.conversationId);
    f.store.locateRetainedHistory(f.spaces.B.workspace, {
      conversationId: f.spaces.B.conversationId, source: 'event', id: String(row.id), query: 'needle',
    }, f.projector('B'));
    expect(await Promise.all([a, b])).toEqual([expectedA, expectedB]);
  }));

  test('sparse event and checkpoint IDs do not cause empty numeric scans', () => withFixture(async f => {
    f.seed(1);
    f.db.prepare('UPDATE a9_events SET id=1000000000 WHERE id=1').run();
    f.db.prepare('UPDATE a9_checkpoints SET rowid=1000000000 WHERE turn_id=?').run('turn-A-0');
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM a9_events').get().n).toBe(2);
    const input = { query: 'needle', limit: 50 };
    const expected = f.store.searchRetainedHistory(f.spaces.A.workspace, input, f.projector('A'));
    const controller = new AbortController();
    let turns = 0, running = true;
    let handle: NodeJS.Immediate;
    const tick = () => {
      if (!running) return;
      if (++turns >= 20) { controller.abort(); return; }
      handle = setImmediate(tick);
    };
    handle = setImmediate(tick);
    try {
      const actual = await f.store.searchRetainedHistoryAsync(f.spaces.A.workspace, input, f.projector('A'), {
        batchRows: 8, signal: controller.signal,
      });
      expect(actual).toEqual(expected);
      expect(controller.signal.aborted).toBe(false);
    } finally {
      running = false;
      clearImmediate(handle!);
    }
  }));

  test('all dense pages equal the legacy oracle, with cancellation and zero search writes', () => withFixture(async f => {
    f.seed(42);
    f.db.prepare("UPDATE a9_events SET created_at='2026-11-01T00:00:01.000Z'").run();
    f.db.prepare("UPDATE a9_checkpoints SET created_at='2026-11-01T00:00:01.000Z'").run();
    const beforeWrites = f.db.prepare('SELECT total_changes() AS n').get();
    const input = { query: 'needle', limit: 7 };
    const pages = async (search: (before?: any) => any): Promise<any[]> => {
      const result: any[] = [];
      let before: any;
      do {
        const page = await search(before);
        result.push(page);
        before = page.nextBefore;
      } while (before);
      return result;
    };
    const expected = await pages(before => f.store.searchRetainedHistory(f.spaces.A.workspace, {
      ...input, ...(before ? { before } : {}),
    }, f.projector('A')));
    const actual = await pages(before => f.store.searchRetainedHistoryAsync(f.spaces.A.workspace, {
      ...input, ...(before ? { before } : {}),
    }, f.projector('A'), { batchRows: 16 }));
    expect(actual).toEqual(expected);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(f.store.searchRetainedHistoryAsync(f.spaces.A.workspace, { query: 'needle' },
      f.projector('A'), { signal: controller.signal }), (error: any) => error.code === 'A9_HISTORY_SEARCH_CANCELLED');
    expect(f.db.prepare('SELECT total_changes() AS n').get()).toEqual(beforeWrites);
  }));
});
