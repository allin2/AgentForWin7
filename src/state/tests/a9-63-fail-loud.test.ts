// The repository pins better-sqlite3 without a package-level declaration.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Database = require('better-sqlite3') as any;
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { A9PersistenceManager } from '../src/a9-persistence';

function tempRoot(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'a9-63-state-')); }

describe('A9-63 state fail-loud diagnostics', () => {
  it('preserves the original strict A8 schema error without a probe code', () => {
    const root = tempRoot();
    const a8Path = path.join(root, 'a8.db');
    const db = new Database(a8Path);
    try {
      db.exec('CREATE TABLE a8_workspaces (workspace_id TEXT PRIMARY KEY)');
      db.close();
      const outcome = A9PersistenceManager.open({
        databasePath: path.join(root, 'state.db'), dataRoot: root, a8DatabasePath: a8Path,
        openDatabase: (file, options) => new Database(file, options),
      });
      expect(outcome.status).toBe('diagnostics');
      if (outcome.status !== 'diagnostics') throw new Error('Expected schema diagnostics');
      expect(outcome.error).toBe('A8 workspace schema mismatch; missing columns: schema_version, canonical_path, comparison_key, display_name, created_at, last_opened_at, archived_at');
      expect(outcome.error).not.toContain('A9_SQLITE_PROBE_FAILED');
    } finally {
      if (db.open) db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps corrupt row diagnostics and real row identities in each manager', () => {
    const root = tempRoot();
    const databases: any[] = [];
    try {
      const managers = ['first', 'second'].map((name) => {
        const outcome = A9PersistenceManager.open({
          databasePath: path.join(root, `${name}.db`), dataRoot: root,
          openDatabase: (file) => { const db = new Database(file); databases.push(db); return db; },
        });
        if (outcome.status !== 'ready') throw new Error('Expected ready database');
        outcome.manager.createConversation(name, '/workspace');
        outcome.manager.db.prepare('UPDATE a9_sessions SET metadata_json = ? WHERE session_id = ?').run('{private-corrupt', name);
        return outcome.manager;
      });
      managers.forEach((manager, index) => {
        expect(manager.getConversationMetadata(index === 0 ? 'first' : 'second')).toEqual({});
      });
      managers.forEach((manager, index) => {
        expect(manager.getDiagnostics()).toEqual([
          expect.objectContaining({ code: 'A9_PERSISTED_JSON_INVALID', count: 1, table: 'a9_sessions', rowId: index === 0 ? 'first' : 'second' }),
        ]);
        expect(JSON.stringify(manager.getDiagnostics())).not.toContain('{private-corrupt');
      });
    } finally {
      databases.forEach((db) => { if (db.open) db.close(); });
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps diagnostic buffers isolated during reentrant reads of real corrupt rows', () => {
    const root = tempRoot();
    const databases: any[] = [];
    try {
      const managers = ['outer', 'inner'].map((name) => {
        const outcome = A9PersistenceManager.open({
          databasePath: path.join(root, `${name}.db`), dataRoot: root,
          openDatabase: (file) => { const db = new Database(file); databases.push(db); return db; },
        });
        if (outcome.status !== 'ready') throw new Error('Expected ready database');
        const manager = outcome.manager;
        manager.createConversation(name, '/workspace');
        const event = manager.recordModelEvent(name, null, 'conversation.request', { requestPrompt: 'test' });
        manager.db.prepare('UPDATE a9_events SET payload_json = ? WHERE id = ?').run('{bad', event.eventId);
        return { manager, eventId: event.eventId };
      });
      // SQLite returns real rows; a payload accessor triggers another manager at
      // the exact boundary between selecting the location and parsing the row.
      const db = managers[0].manager.db;
      const prepare = db.prepare.bind(db);
      db.prepare = ((sql: string) => {
        const statement = prepare(sql);
        if (!sql.includes('SELECT id, turn_id, kind, event_type, payload_json')) return statement;
        return { ...statement, all: (...args: any[]) => (statement.all(...args) as any[]).map((row) => {
          const payload = row.payload_json;
          return { ...row, get payload_json() { managers[1].manager.listSessionEvents('inner'); return payload; } };
        }) };
      }) as typeof db.prepare;
      expect(managers[0].manager.listSessionEvents('outer')).toHaveLength(1);
      for (const { manager, eventId } of managers) {
        expect(manager.getDiagnostics()).toEqual([
          expect.objectContaining({ code: 'A9_PERSISTED_JSON_INVALID', count: 1, table: 'a9_events', rowId: String(eventId) }),
        ]);
      }
    } finally {
      databases.forEach((db) => { if (db.open) db.close(); });
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

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
