// The repository pins better-sqlite3 without a package-level declaration.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Database = require('better-sqlite3') as any;
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { A9PersistenceManager } from '../src/a9-persistence';

function tempRoot(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'a9-63-state-')); }

describe('A9-63 state fail-loud diagnostics', () => {
  it('keeps a WAL failure on the ready path while exposing actual journal mode', () => {
    const root = tempRoot();
    const dbPath = path.join(root, 'state.db');
    let db: any;
    try {
      const outcome = A9PersistenceManager.open({
        databasePath: dbPath,
        dataRoot: root,
        openDatabase: (file) => {
          db = new Database(file);
          const pragma = db.pragma.bind(db);
          db.pragma = (source: string, options?: unknown) => source === 'journal_mode = WAL' ? 'delete' : pragma(source, options);
          return db;
        },
      });
      expect(outcome.status).toBe('ready');
      if (outcome.status === 'ready') expect(outcome.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'A9_SQLITE_WAL_UNAVAILABLE', detail: expect.stringContaining('delete') }),
      ]));
    } finally {
      try { db?.close(); } catch (_err) { /* closed by test */ }
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns a stable probe diagnostic when the real SQLite A8 probe fails', () => {
    const root = tempRoot();
    const dbPath = path.join(root, 'state.db');
    let db: any;
    try {
      const outcome = A9PersistenceManager.open({
        databasePath: dbPath,
        dataRoot: root,
        openDatabase: (file) => {
          db = new Database(file);
          const prepare = db.prepare.bind(db);
          db.prepare = (sql: string) => sql.includes("name='a8_workspaces'")
            ? (() => { throw new Error('database is locked'); })()
            : prepare(sql);
          return db;
        },
      });
      expect(outcome.status).toBe('diagnostics');
      if (outcome.status === 'diagnostics') expect(outcome.error).toContain('A9_SQLITE_PROBE_FAILED');
    } finally {
      try { db?.close(); } catch (_err) { /* closed by test */ }
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('counts corrupt JSON and records the first table and row without content', () => {
    const root = tempRoot();
    const dbPath = path.join(root, 'state.db');
    try {
      const outcome = A9PersistenceManager.open({ databasePath: dbPath, dataRoot: root, openDatabase: (file) => new Database(file) as any });
      expect(outcome.status).toBe('ready');
      if (outcome.status !== 'ready') return;
      const manager = outcome.manager;
      manager.createConversation('sess-63', '/workspace');
      const event = manager.recordModelEvent('sess-63', null, 'conversation.request', { requestPrompt: 'test' });
      (manager.db as any).prepare('UPDATE a9_events SET payload_json = ? WHERE id = ?').run('{bad', event.eventId);
      expect(manager.listSessionEvents('sess-63')).toHaveLength(1);
      expect(manager.getDiagnostics()).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'A9_PERSISTED_JSON_INVALID', count: 1, table: 'a9_events', rowId: String(event.eventId) }),
      ]));
      expect(JSON.stringify(manager.getDiagnostics())).not.toContain('{bad');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
