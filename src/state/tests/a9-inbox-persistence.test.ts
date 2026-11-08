/// <reference path="./better-sqlite3.d.ts" />
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import { A9PersistenceManager, SqliteDatabase } from '../src';

const t1 = '2026-10-01T00:00:00.000Z', t2 = '2026-10-02T00:00:00.000Z', t3 = '2026-10-03T00:00:00.000Z';
const empty = { version: 1, settledAt: null, activeSince: null, lastVisitedAt: null };
describe('A9-54 persisted inbox', () => {
  let root: string, manager: A9PersistenceManager;
  const open = () => {
    const outcome = A9PersistenceManager.open({ dataRoot: root, databasePath: path.join(root, 'state.db'),
      openDatabase: (file, options) => new Database(file, options) as unknown as SqliteDatabase });
    if (outcome.status !== 'ready') throw new Error(outcome.status);
    return outcome.manager;
  };
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'w7ca-a9-54-state-'));
    manager = open(); manager.createConversation('s', root);
  });
  afterEach(() => { try { manager?.db.close(); } finally { fs.rmSync(root, { recursive: true, force: true }); } });

  it('merges timestamps and preserves metadata, unknown inbox keys and updated_at', () => {
    manager.mergeConversationMetadata('s', { provider: 'keep', inbox: { ...empty, future: 'keep' } });
    manager.db.prepare('UPDATE a9_sessions SET updated_at = ? WHERE session_id = ?').run(t1, 's');
    manager.mergeConversationInbox('s', root, { settledAt: t2 });
    manager.mergeConversationInbox('s', root, { lastVisitedAt: t3 });
    expect(manager.getConversationMetadata('s')).toEqual({ provider: 'keep', inbox: { ...empty, settledAt: t2, lastVisitedAt: t3, future: 'keep' } });
    expect(manager.listConversations(root)[0].updatedAt).toBe(t1);
    manager.mergeConversationInbox('s', root, { settledAt: null, activeSince: t3 });
    expect(manager.getConversationInbox('s')).toEqual({ ...empty, activeSince: t3, lastVisitedAt: t3 });
    expect(manager.listConversations(root)[0].updatedAt).toBe(t1);
  });

  it('saveSession merges existing metadata and retains inbox on the legacy migration update', () => {
    manager.mergeConversationInbox('s', root, { settledAt: t2 });
    manager.mergeConversationMetadata('s', { keep: 1, replace: 'old' });
    manager.saveSession('s', root, { replace: 'new', migratedFromWorkspaceSession: true });
    expect(manager.getConversationMetadata('s')).toEqual({ keep: 1, replace: 'new', migratedFromWorkspaceSession: true, inbox: { ...empty, settledAt: t2 } });
  });

  it.each(['{bad', '{}', '{"inbox":null}', '{"inbox":[]}', '{"inbox":{"version":2}}',
    '{"keep":1,"inbox":{"version":1,"settledAt":"bad","lastVisitedAt":"2026-10-03T00:00:00.000Z"}}'])('reads malformed or missing inbox as null without rewriting (%s)', json => {
    manager.db.prepare('UPDATE a9_sessions SET metadata_json = ? WHERE session_id = ?').run(json, 's');
    expect(manager.getConversationInbox('s')).toEqual(empty);
    expect(manager.db.prepare('SELECT metadata_json FROM a9_sessions WHERE session_id = ?').get('s')).toEqual({ metadata_json: json });
    if (json.includes('"keep"')) {
      manager.mergeConversationInbox('s', root, { activeSince: t2 });
      expect(manager.getConversationMetadata('s').keep).toBe(1);
    }
  });

  it('rejects archived and foreign workspace writes without changing metadata', () => {
    manager.mergeConversationInbox('s', root, { settledAt: t2 });
    const before = manager.getConversationMetadata('s');
    expect(() => manager.mergeConversationInbox('s', path.join(root, 'other'), { lastVisitedAt: t3 })).toThrow('A9_CONVERSATION_WORKSPACE_MISMATCH');
    manager.archiveConversation('s', 'fallback');
    for (const patch of [{ settledAt: t3 }, { settledAt: null, activeSince: t3 }, { lastVisitedAt: t3 }]) {
      expect(() => manager.mergeConversationInbox('s', root, patch)).toThrow('A9_CONVERSATION_ARCHIVED');
    }
    expect(manager.getConversationMetadata('s')).toEqual(before);
  });

  it('selects successful completion and latest activity, and retains all values after reopening the database', () => {
    const createdAt = manager.listConversations(root)[0].createdAt;
    expect(manager.getConversationInboxSummary('s')).toEqual({ settledAt: null, lastVisitedAt: null, lastCompletedAt: null, lastActivityAt: createdAt });
    manager.upsertRun('success', 'turn', 's', 'completed');
    manager.db.prepare('UPDATE a9_runs SET created_at = ?, updated_at = ?').run(t1, t2);
    manager.upsertRun('failure', 'turn2', 's', 'failed');
    manager.db.prepare('UPDATE a9_runs SET created_at = ?, updated_at = ? WHERE run_id = ?').run(t2, t3, 'failure');
    manager.mergeConversationInbox('s', root, { settledAt: t3, lastVisitedAt: t2 });
    const before = manager.getConversationInboxSummary('s');
    expect(before).toEqual({ settledAt: t3, lastVisitedAt: t2, lastCompletedAt: t2, lastActivityAt: t3 });
    manager.db.close(); manager = open();
    expect(manager.getConversationInboxSummary('s')).toEqual(before);
    manager.mergeConversationInbox('s', root, { activeSince: '2026-10-04T00:00:00.000Z' });
    expect(manager.getConversationInboxSummary('s').lastActivityAt).toBe('2026-10-04T00:00:00.000Z');
    manager.mergeConversationInbox('s', root, { lastVisitedAt: '2026-10-05T00:00:00.000Z' });
    expect(manager.getConversationInboxSummary('s').lastActivityAt).toBe('2026-10-05T00:00:00.000Z');
  });

  it('uses approval and question appearance times rather than a later approval decision', () => {
    manager.recordApproval({ approvalId: 'approval', sessionId: 's', toolName: 'delete', binding: {}, decision: 'denied' });
    manager.db.prepare('UPDATE a9_approvals SET created_at = ?').run('2026-10-06T00:00:00.000Z');
    manager.recordToolEvent('s', null, 'approval_required', {});
    manager.db.prepare('UPDATE a9_events SET created_at = ?').run(t2);
    expect(manager.getConversationInboxSummary('s').lastActivityAt).toBe(t2);
    manager.recordToolEvent('s', null, 'question_pending', { questionId: 'question', revision: 1 });
    manager.db.prepare("UPDATE a9_events SET created_at = ? WHERE event_type = 'question_pending'").run(t3);
    expect(manager.getConversationInboxSummary('s').lastActivityAt).toBe(t3);
    manager.db.prepare("UPDATE a9_approvals SET decision = 'pending', created_at = ?").run('2026-10-04T00:00:00.000Z');
    expect(manager.getConversationInboxSummary('s').lastActivityAt).toBe('2026-10-04T00:00:00.000Z');
  });
});
