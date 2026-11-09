/// <reference path="./better-sqlite3.d.ts" />
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import { A9PersistenceManager, A9_SCHEMA_VERSION } from '../src/a9-persistence';

describe('A9-55 workdir State transaction', () => {
  let root: string, manager: A9PersistenceManager;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'w7ca-a9-55-state-'));
    const outcome = A9PersistenceManager.open({ databasePath: path.join(root, 'state.db'), dataRoot: root,
      openDatabase: (file, flags) => new Database(file, flags) as any });
    if (outcome.status !== 'ready') throw new Error(outcome.status);
    manager = outcome.manager;
    manager.createConversation('source', '/source');
    manager.setWorkspaceMode('/source', 'read_only');
    manager.saveSession('source', '/source', { workdir: { version: 1, origin: 'auto', createdAt: null }, keep: 'yes' });
  });
  afterEach(() => { try { manager?.db.close(); } finally { fs.rmSync(root, { recursive: true, force: true }); } });

  it('requires closed runtimes and rewrites three paths without changing schema or task identity', () => {
    manager.upsertTask('task', 'source', 'completed');
    manager.acquireWorkspaceLock('/source', 'test');
    expect(() => manager.changeWorkdir('source', '/source', '/target', true)).toThrow(expect.objectContaining({ code: 'A9_WORKSPACE_LOCKED' }));
    manager.releaseWorkspaceLock('/source', 'test');
    manager.changeWorkdir('source', '/source', '/target', true);
    for (const table of ['a9_workspaces', 'a9_sessions', 'a9_workspace_conversation_state']) expect((manager.db.prepare(`SELECT workspace_path FROM ${table}`).get() as any).workspace_path).toBe('/target');
    expect((manager.db.prepare('SELECT session_id FROM a9_tasks').get() as any).session_id).toBe('source');
    expect((manager.db.prepare('SELECT schema_version FROM a9_meta').get() as any).schema_version).toBe(A9_SCHEMA_VERSION);
    expect(manager.getConversationMetadata('source')).toMatchObject({ keep: 'yes', workdir: { origin: 'auto' } });
  });

  it('moves only the linked conversation and updates both active pointers without losing metadata', () => {
    manager.createConversation('remaining', '/source'); manager.createConversation('existing', '/target');
    manager.changeWorkdir('source', '/source', '/target', false);
    expect(manager.getActiveConversationId('/source')).toBe('remaining');
    expect(manager.getActiveConversationId('/target')).toBe('source');
    expect(manager.listConversations('/target')).toHaveLength(2);
    expect(manager.getConversationMetadata('source')).toMatchObject({ keep: 'yes', workdir: { version: 1, origin: 'linked', createdAt: null } });
  });
});
