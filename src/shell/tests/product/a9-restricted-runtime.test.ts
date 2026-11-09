/// <reference path="./better-sqlite3.d.ts" />
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';

const { createA9AgentRuntime } = require('../../product/a9-agent-runtime');
const { createA9ProductRequestHandler, A9_IPC_SCHEMA_VERSION } = require('../../product/a9-product-ipc');

const actions = [
  ['a9.conversation.query', { conversationId: 'conversation' }],
  ['a9.managed.dismissRecovered', { conversationId: 'conversation', handleId: 'handle', recoveryRevision: 'a'.repeat(64) }],
  ['a9.workspace.read', { path: '中文 file.txt', startLine: 1, maxLines: 10 }],
  ['a9.image.preview', { conversationId: 'conversation', reference: 'b'.repeat(40) }],
] as const;

describe.each([
  ['electron_sqlite_unavailable', 'ELECTRON_SQLITE_UNAVAILABLE', 'ELECTRON_SQLITE_UNAVAILABLE'],
  ['diagnostics', 'A9_DIAGNOSTICS_MODE', 'A9_PERSISTENCE_DIAGNOSTICS'],
  ['schema_refused', 'A9_DIAGNOSTICS_MODE', 'A9_SCHEMA_REFUSED'],
])('A9-49 restricted runtime: %s', (status, refusalCode, diagnosticCode) => {
  let root: string | undefined;
  let ready: any;
  let restricted: any;
  let handler: any;
  let initialSnapshot: any;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'a9-49-restricted-'));
    const workspaceRoot = path.join(root, '中文 workspace');
    fs.mkdirSync(workspaceRoot);
    fs.writeFileSync(path.join(workspaceRoot, '中文 file.txt'), 'must stay unchanged', 'utf8');
    const openDatabase = (file: string, options?: { readonly?: boolean }) =>
      new Database(file, options?.readonly ? { readonly: true } : {});
    ready = createA9AgentRuntime({ workspaceRoot, dataRoot: path.join(root, 'ready'), openDatabase });
    expect(ready.status).toBe('ready');
    const dataRoot = path.join(root, 'restricted');
    if (status !== 'electron_sqlite_unavailable') {
      fs.mkdirSync(dataRoot);
      const databasePath = path.join(dataRoot, 'a9-state.db');
      if (status === 'diagnostics') {
        fs.writeFileSync(databasePath, 'invalid SQLite bytes', 'utf8');
      } else {
        const db = new Database(databasePath);
        try {
          db.exec('CREATE TABLE a9_meta (id INTEGER PRIMARY KEY, schema_version INTEGER); INSERT INTO a9_meta VALUES (1, 999)');
        } finally { db.close(); }
      }
    }
    restricted = createA9AgentRuntime({ workspaceRoot, dataRoot, openDatabase,
      ...(status === 'electron_sqlite_unavailable' ? { electronSqliteRoot: path.join(root, 'missing-sqlite') } : {}),
    });
    initialSnapshot = restricted.getSnapshot();
    expect(initialSnapshot).toMatchObject({ status, diagnostics: { code: diagnosticCode } });
    expect(initialSnapshot.diagnostics.detail).toEqual(expect.any(String));
    handler = createA9ProductRequestHandler({ getA9Runtime: () => restricted, isValidRendererSender: () => true });
  });

  afterAll(async () => {
    try { await restricted?.shutdown(); }
    finally {
      try { await ready?.shutdown(); }
      finally { if (root) fs.rmSync(root, { recursive: true, force: true }); }
    }
  });

  it('implements every public ready method and keeps task execution refused', async () => {
    const readyMethods = Object.keys(ready).filter((key) => typeof ready[key] === 'function');
    const restrictedMethods = Object.keys(restricted).filter((key) => typeof restricted[key] === 'function');
    expect(restrictedMethods.sort()).toEqual(readyMethods.sort());
    expect(await handler({}, { schemaVersion: A9_IPC_SCHEMA_VERSION, action: 'a9.turn.submit', payload: { prompt: 'do work' } }))
      .toMatchObject({ ok: false, error: { code: refusalCode } });
  });

  it('returns no workdir identity and refuses workdir creation and browsing', async () => {
    expect(restricted.getWorkdirInfo()).toEqual({});
    expect(restricted.getWorkdirConversationId()).toBeNull();
    expect(() => restricted.ensureWorkdir()).toThrow(expect.objectContaining({ code: refusalCode }));
    expect(await restricted.listWorkspaceDirectory('.')).toEqual({ ok: false, error: { code: refusalCode } });
  });

  it.each(actions)('returns its original refusal through the real %s handler', async (action, payload) => {
    expect(await handler({}, { schemaVersion: A9_IPC_SCHEMA_VERSION, action, payload }))
      .toEqual({ ok: false, error: { code: refusalCode } });
    const snapshot = await handler({}, { schemaVersion: A9_IPC_SCHEMA_VERSION, action: 'a9.snapshot.get', payload: {} });
    expect(snapshot).toEqual({ ok: true, snapshot: initialSnapshot });
    expect(fs.readFileSync(path.join(root!, '中文 workspace', '中文 file.txt'), 'utf8')).toBe('must stay unchanged');
  });
});
