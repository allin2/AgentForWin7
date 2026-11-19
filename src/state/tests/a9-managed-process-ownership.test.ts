/// <reference path="./better-sqlite3.d.ts" />
import Database from 'better-sqlite3';
import * as path from 'path';
import { A9PersistenceManager } from '../src/a9-persistence';
function testPlatform(value: NodeJS.Platform) {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...original, value });
  return { restore: () => Object.defineProperty(process, 'platform', original) };
}
function setup(workspace = '/w') {
  const open = A9PersistenceManager.open({ databasePath: ':memory:', dataRoot: '/memory', openDatabase: () => new Database(':memory:') as any });
  if (open.status !== 'ready') throw new Error(open.status); const p = open.manager;
  p.createConversation('c', workspace); p.upsertTask('task', 'c', 'active'); p.upsertTurn('turn', 'task', 'c', 'active');
  const fact = { handleId: 'h', workspacePath: workspace, command: 'safe', cwd: workspace, startedAt: '2026-10-03', lastProbeStatus: 'running', cleanupRequired: true, pid: 345 };
  const ownership = { schemaVersion: 1 as const, owner: { workspace, conversationId: 'c', taskId: 'task', turnId: 'turn', toolCallId: 'call' }, requestId: 'request', ownershipState: 'owned' as const };
  return { p, fact, ownership };
}
it('persists owner plus fact atomically and freezes origin across a completed turn', () => {
  const { p, fact, ownership } = setup(); try {
    p.recordManagedOwnership(fact, ownership);
    expect(p.listManagedProcesses('/w')[0]).toMatchObject({ lastProbeStatus: 'running', cleanupRequired: true });
    p.upsertTurn('turn', 'task', 'c', 'completed');
    p.recordManagedOwnership({ ...fact, lastProbeStatus: 'exited', cleanupRequired: false }, ownership);
    expect(p.getManagedOwnership('h')).toEqual(ownership);
    expect(p.listSessionEvents('c').filter((e) => e.eventType === 'managed_process_ownership')).toHaveLength(1);
    expect(() => p.recordManagedOwnership(fact, { ...ownership, requestId: 'replacement' })).toThrow('OWNER_IMMUTABLE');
    expect(p.listManagedProcesses('/w')[0].lastProbeStatus).toBe('exited');
  } finally { p.db.close(); }
});

// These are controlled Windows path tests on the local host, not target-machine evidence.
it.each([
  'C:\\Users\\A9 Builder\\中文 空格%#\\Project',
  'c:/Users/A9 Builder/中文 空格%#/other/../Project/',
  '\\\\Server\\Share\\中文 空格%#\\Project',
  'C:\\Users\\Ä Builder\\Project',
])('persists Windows display paths against canonical session ownership (%s)', (display) => {
  const platform = testPlatform('win32');
  const canonical = path.win32.resolve(display.replace(/\//g, '\\')).toLowerCase();
  const { p, fact, ownership } = setup(canonical);
  try {
    p.recordManagedOwnership({ ...fact, workspacePath: display }, ownership);
    expect(p.getManagedOwnership('h')).toEqual(ownership);
    expect(p.listManagedProcesses(display)).toHaveLength(1);
    expect(p.listManagedProcesses(canonical)).toHaveLength(1);
    expect(p.listManagedProcesses(canonical + '-other')).toEqual([]);
    expect(p.db.prepare('SELECT workspace_path FROM a9_managed_processes').get()).toEqual({ workspace_path: display });
    p.recordManagedOwnership({ ...fact, workspacePath: display, lastProbeStatus: 'exited', cleanupRequired: false }, ownership);
    expect(p.listSessionEvents('c')).toHaveLength(1);
    expect(p.listManagedProcesses(canonical)[0].lastProbeStatus).toBe('exited');
  } finally { p.db.close(); platform.restore(); }
});

it('finds legacy Windows process facts under an equivalent path without rewriting rows', () => {
  const platform = testPlatform('win32');
  const { p, fact } = setup('c:\\users\\a9 builder\\project');
  try {
    const display = 'C:/Users/A9 Builder/Project/';
    p.recordManagedProcess({ ...fact, workspacePath: display, lastProbeStatus: 'running_unknown', cleanupRequired: true });
    p.recordManagedProcess({ ...fact, handleId: 'other', workspacePath: 'C:\\Users\\A9 Builder\\Other' });
    expect(p.listManagedProcesses('c:\\users\\a9 builder\\project')).toEqual([
      expect.objectContaining({ handleId: 'h', cleanupRequired: true }),
    ]);
    expect(p.db.prepare('SELECT workspace_path FROM a9_managed_processes WHERE handle_id=?').get('h')).toEqual({ workspace_path: display });
  } finally { p.db.close(); platform.restore(); }
});

it.each(['workspace', 'owner-workspace', 'conversation', 'task', 'turn', 'archived'])('rejects Windows wrong ownership atomically (%s)', (bad) => {
  const platform = testPlatform('win32');
  const canonical = 'c:\\users\\a9 builder\\project';
  const { p, fact, ownership } = setup(canonical);
  try {
    const owner = { ...ownership.owner };
    if (bad === 'owner-workspace') owner.workspace += '-other';
    if (bad === 'conversation') owner.conversationId = 'other';
    if (bad === 'task') owner.taskId = 'other';
    if (bad === 'turn') owner.turnId = 'other';
    if (bad === 'archived') p.db.prepare("UPDATE a9_sessions SET state='archived' WHERE session_id='c'").run();
    const display = 'C:\\Users\\A9 Builder\\Project' + (bad === 'workspace' ? '-other' : '');
    expect(() => p.recordManagedOwnership({ ...fact, workspacePath: display }, { ...ownership, owner })).toThrow('OWNER_MISMATCH');
    expect(p.db.prepare('SELECT count(*) AS n FROM a9_managed_processes').get()).toEqual({ n: 0 });
    expect(p.countEvents()).toBe(0);
  } finally { p.db.close(); platform.restore(); }
});

it('keeps POSIX case-sensitive for shared conversation and managed-process ownership checks', () => {
  const platform = testPlatform('linux');
  const { p, fact, ownership } = setup('/w');
  try {
    expect(() => p.renameConversation('c', 'wrong workspace', '/W')).toThrow('WORKSPACE_MISMATCH');
    expect(() => p.recordManagedOwnership({ ...fact, workspacePath: '/W' }, ownership)).toThrow('OWNER_MISMATCH');
    expect(p.listConversations('/w')[0].title).toBe('新对话');
    p.db.prepare("UPDATE a9_sessions SET state='archived' WHERE session_id='c'").run();
    expect(() => p.restoreConversation('c', '/W')).toThrow('WORKSPACE_MISMATCH');
    expect(p.listConversations('/w')[0].state).toBe('archived');
    expect(p.restoreConversation('c', '/w').state).toBe('active');
    expect(p.countEvents()).toBe(0);
  } finally { p.db.close(); platform.restore(); }
});
it('requires prior release intent and retains unknown without declaring released', () => {
  const { p, fact, ownership } = setup(); try {
    p.recordManagedOwnership(fact, ownership);
    expect(() => p.recordManagedOwnership(fact, { ...ownership, ownershipState: 'released', releaseId: 'r' })).toThrow('INTENT_MISSING');
    p.recordManagedOwnership(fact, { ...ownership, ownershipState: 'release_intent', releaseId: 'r' });
    p.recordManagedOwnership(fact, { ...ownership, ownershipState: 'release_unknown', releaseId: 'r' });
    expect(p.getManagedOwnership('h')?.ownershipState).toBe('release_unknown');
    expect(p.listManagedProcesses('/w')[0].cleanupRequired).toBe(true);
  } finally { p.db.close(); }
});
it('rejects wrong turn/conversation/workspace without changing the fact table', () => {
  const { p, fact, ownership } = setup(); try {
    for (const owner of [{ ...ownership.owner, turnId: 'other' }, { ...ownership.owner, conversationId: 'other' }]) {
      expect(() => p.recordManagedOwnership(fact, { ...ownership, owner })).toThrow('OWNER_MISMATCH');
    }
    expect(() => p.recordManagedOwnership({ ...fact, workspacePath: '/other' }, ownership)).toThrow('OWNER_MISMATCH');
    expect(p.listManagedProcesses('/w')).toEqual([]); expect(p.countEvents()).toBe(0);
  } finally { p.db.close(); }
});
it('release facts are terminal and repeat writes do not duplicate events', () => {
  const { p, fact, ownership } = setup(); try {
    p.recordManagedOwnership(fact, ownership);
    p.recordManagedOwnership(fact, { ...ownership, ownershipState: 'release_intent', releaseId: 'r' });
    const released = { ...ownership, ownershipState: 'released' as const, releaseId: 'r' };
    expect(() => p.recordManagedOwnership({ ...fact, lastProbeStatus: 'released', cleanupRequired: false },
      { ...released, releaseId: 'different' })).toThrow('A9_MANAGED_RELEASE_ID_MISMATCH');
    expect(() => p.recordManagedOwnership(fact, released)).toThrow('A9_MANAGED_OWNERSHIP_UNCONFIRMED');
    p.recordManagedOwnership({ ...fact, lastProbeStatus: 'released', cleanupRequired: false }, released);
    p.recordManagedOwnership({ ...fact, lastProbeStatus: 'released', cleanupRequired: false }, released);
    expect(p.listSessionEvents('c')).toHaveLength(3);
    expect(() => p.recordManagedOwnership(fact, ownership)).toThrow('RELEASE_TERMINAL');
    p.db.prepare("UPDATE a9_managed_processes SET cwd = '/changed', pid_reuse_possible = 1 WHERE handle_id = ?").run(fact.handleId);
    expect(() => p.recordManagedOwnership({ ...fact, lastProbeStatus: 'released', cleanupRequired: false }, released))
      .toThrow('A9_MANAGED_OWNERSHIP_UNCONFIRMED');
    expect(p.db.prepare('SELECT cwd, pid_reuse_possible FROM a9_managed_processes').get()).toEqual({
      cwd: '/changed', pid_reuse_possible: 1,
    });
    p.db.prepare(`DELETE FROM a9_events WHERE json_extract(payload_json, '$.ownershipState') = 'release_intent'`).run();
    p.db.prepare("UPDATE a9_managed_processes SET last_probe_status = 'cleanup_required' WHERE handle_id = ?").run(fact.handleId);
    const terminal = { ...fact, lastProbeStatus: 'released', cleanupRequired: false };
    for (const mode of ['reconcile', 'update'] as const) {
      expect(() => p.recordManagedOwnership(terminal, released, { mode })).toThrow('A9_MANAGED_OWNERSHIP_UNCONFIRMED');
    }
    expect(p.db.prepare('SELECT last_probe_status FROM a9_managed_processes').get()).toEqual({ last_probe_status: 'cleanup_required' });
  } finally { p.db.close(); }
});

function dispositionSetup() {
  const { p, fact, ownership } = setup();
  p.acquireWorkspaceLock('/w', 'window');
  p.recordManagedOwnership({ ...fact, lastProbeStatus: 'exited' }, { ...ownership, recoveryStatus: 'exited' });
  const current = p.getManagedProcessRecoveryIdentity('h');
  const input = { workspace: '/w', conversationId: 'c', lockOwnerId: 'window', handleId: 'h', recoveryRevision: current.recoveryRevision,
    identity: { owner: current.owner, requestId: current.requestId, pid: current.pid, startedAt: current.startedAt },
    pidProbe: { pid: current.pid, status: 'absent', checkedAt: new Date().toISOString() } };
  return { p, input, fact, ownership };
}
it('A9-34 commits disposition and event together with stable revision and idempotent result', () => {
  const { p, input } = dispositionSetup();
  try {
    const signature = p.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' ORDER BY name").all();
    expect(p.getManagedProcessRecoveryIdentity('h').recoveryRevision).toBe(input.recoveryRevision);
    const result = p.dismissRecoveredManagedProcess(input);
    expect(result).toMatchObject({ schemaVersion: 1, disposition: 'user_attested_after_restart', handleId: 'h', requestId: 'request', recoveryRevision: input.recoveryRevision,
      owner: input.identity.owner, pidProbe: { status: 'absent', pid: 345 } });
    expect(p.listManagedProcesses('/w')[0]).toMatchObject({ lastProbeStatus: 'user_dismissed', cleanupRequired: false });
    expect(p.getManagedOwnership('h')?.ownershipState).toBe('owned');
    const events = p.listSessionEvents('c').filter((event) => event.eventType === 'managed_process_disposition');
    expect(events).toEqual([expect.objectContaining({ kind: 'tool', turnId: 'turn', payload: expect.objectContaining({ disposition: 'user_attested_after_restart' }) })]);
    expect(p.dismissRecoveredManagedProcess({ ...input, identity: undefined, pidProbe: undefined })).toEqual(result);
    expect(p.listSessionEvents('c').filter((event) => event.eventType === 'managed_process_disposition')).toHaveLength(1);
    expect(() => p.dismissRecoveredManagedProcess({ ...input, recoveryRevision: 'b'.repeat(64) })).toThrow('RECOVERY_STALE');
    expect(p.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' ORDER BY name").all()).toEqual(signature);
  } finally { p.db.close(); }
});
it.each(['revision', 'fact-drift', 'wrong-workspace', 'wrong-conversation', 'lock', 'unknown', 'owner-missing', 'owner-incomplete', 'request-missing', 'archived',
  'origin-missing', 'origin-workspace', 'fact-workspace', 'release_intent', 'release_unknown', 'released', 'not-cleanup',
  'memory-owner', 'memory-request', 'memory-pid', 'memory-start', 'pid-invalid', 'probe-alive', 'probe-unknown', 'probe-pid', 'probe-time'])('A9-34 rejects atomic qualification: %s', (bad) => {
  const { p, input } = dispositionSetup();
  try {
    if (bad === 'revision') input.recoveryRevision = 'b'.repeat(64);
    if (bad === 'fact-drift') p.db.prepare("UPDATE a9_managed_processes SET started_at='changed'").run();
    if (bad === 'wrong-workspace') { input.workspace = '/other'; p.acquireWorkspaceLock('/other', 'window'); }
    if (bad === 'wrong-conversation') input.conversationId = 'other';
    if (bad === 'lock') p.db.prepare("UPDATE a9_workspace_locks SET owner_id='other'").run();
    if (bad === 'unknown') input.handleId = 'unknown';
    if (bad === 'owner-missing') p.db.prepare("DELETE FROM a9_events WHERE event_type='managed_process_ownership'").run();
    if (['owner-incomplete', 'request-missing', 'origin-missing', 'release_intent', 'release_unknown', 'released'].includes(bad)) {
      const record = p.getManagedOwnership('h')!;
      if (bad === 'owner-incomplete') record.owner.toolCallId = '';
      else if (bad === 'request-missing') record.requestId = '';
      else if (bad === 'origin-missing') record.owner.turnId = 'missing';
      else record.ownershipState = bad as any;
      p.db.prepare("UPDATE a9_events SET payload_json=? WHERE event_type='managed_process_ownership'").run(JSON.stringify({ handleId: 'h', ...record }));
    }
    if (bad === 'archived') p.db.prepare("UPDATE a9_sessions SET state='archived'").run();
    if (bad === 'origin-workspace') p.db.prepare("UPDATE a9_sessions SET workspace_path='/other'").run();
    if (bad === 'fact-workspace') p.db.prepare("UPDATE a9_managed_processes SET workspace_path='/other'").run();
    if (bad === 'not-cleanup') {
      p.db.prepare("UPDATE a9_managed_processes SET last_probe_status='exited'").run();
      input.recoveryRevision = p.getManagedProcessRecoveryIdentity('h').recoveryRevision;
    }
    if (bad === 'memory-pid') input.identity.pid++;
    if (bad === 'memory-owner') input.identity.owner = { ...input.identity.owner, toolCallId: 'other' };
    if (bad === 'memory-request') input.identity.requestId = 'other';
    if (bad === 'memory-start') input.identity.startedAt = 'other';
    if (bad === 'pid-invalid') {
      p.db.prepare('UPDATE a9_managed_processes SET pid=-1').run();
      input.identity.pid = input.pidProbe.pid = -1;
      input.recoveryRevision = p.getManagedProcessRecoveryIdentity('h').recoveryRevision;
    }
    if (bad === 'probe-alive') input.pidProbe.status = 'alive';
    if (bad === 'probe-unknown') input.pidProbe.status = 'unknown';
    if (bad === 'probe-pid') input.pidProbe.pid++;
    if (bad === 'probe-time') input.pidProbe.checkedAt = 'invalid';
    const before = p.db.prepare('SELECT * FROM a9_managed_processes').all(), count = p.countEvents();
    const code = bad === 'lock' ? 'A9_WORKSPACE_LOCKED'
      : bad === 'unknown' ? 'A9_MANAGED_HANDLE_UNKNOWN'
      : ['wrong-workspace', 'wrong-conversation', 'archived', 'origin-missing', 'origin-workspace', 'fact-workspace'].includes(bad) ? 'A9_MANAGED_HANDLE_WRONG_OWNER'
      : ['owner-missing', 'owner-incomplete', 'request-missing', 'release_intent', 'release_unknown', 'released'].includes(bad) ? 'A9_MANAGED_OWNERSHIP_UNCONFIRMED'
      : bad === 'not-cleanup' ? 'A9_MANAGED_NOT_RECOVERED_CLEANUP'
      : bad.startsWith('probe-') || bad === 'pid-invalid' ? 'A9_MANAGED_PID_PROBE_UNKNOWN' : 'A9_MANAGED_RECOVERY_STALE';
    expect(() => p.dismissRecoveredManagedProcess(input)).toThrow(code);
    expect(p.db.prepare('SELECT * FROM a9_managed_processes').all()).toEqual(before);
    expect(p.countEvents()).toBe(count);
  } finally { p.db.close(); }
});
it.each(['event', 'update'])('A9-34 rolls back fact and required audit on %s failure', (where) => {
  const { p, input } = dispositionSetup();
  try {
    p.db.prepare(where === 'event'
      ? "CREATE TRIGGER fail_disposition AFTER INSERT ON a9_events WHEN NEW.event_type='managed_process_disposition' BEGIN SELECT RAISE(FAIL,'disposition audit failed'); END"
      : "CREATE TRIGGER fail_disposition AFTER UPDATE ON a9_managed_processes WHEN NEW.last_probe_status='user_dismissed' BEGIN SELECT RAISE(FAIL,'disposition update failed'); END").run();
    const count = p.countEvents();
    expect(() => p.dismissRecoveredManagedProcess(input)).toThrow('disposition');
    expect(p.listManagedProcesses('/w')[0]).toMatchObject({ lastProbeStatus: 'cleanup_required', cleanupRequired: true });
    expect(p.countEvents()).toBe(count); expect(p.getManagedProcessDisposition('h')).toBeUndefined();
  } finally { p.db.close(); }
});

it.each(['owner', 'request', 'pid', 'start', 'state'])('A9-34 idempotent retry rejects changed persisted identity: %s', (changed) => {
  const { p, input } = dispositionSetup();
  try {
    p.dismissRecoveredManagedProcess(input);
    if (changed === 'owner' || changed === 'request') {
      const record = p.getManagedOwnership('h')!;
      if (changed === 'owner') record.owner.toolCallId = 'changed';
      else record.requestId = 'changed';
      p.db.prepare("UPDATE a9_events SET payload_json=? WHERE event_type='managed_process_ownership'").run(JSON.stringify({ handleId: 'h', ...record }));
    }
    if (changed === 'pid') p.db.prepare('UPDATE a9_managed_processes SET pid=346').run();
    if (changed === 'start') p.db.prepare("UPDATE a9_managed_processes SET started_at='changed'").run();
    if (changed === 'state') p.db.prepare("UPDATE a9_managed_processes SET last_probe_status='cleanup_required'").run();
    const count = p.countEvents();
    expect(() => p.dismissRecoveredManagedProcess(input)).toThrow('A9_MANAGED_RECOVERY_STALE');
    expect(p.countEvents()).toBe(count);
  } finally { p.db.close(); }
});

it('recordManagedProcess skips redundant writes when all columns match and persists any field change', () => {
  const { p, fact, ownership } = setup();
  try {
    const changes = () => Number((p.db.prepare('SELECT total_changes() AS n').get() as any).n);
    const base = changes();
    p.recordManagedProcess(fact);
    expect(changes()).toBe(base + 1);
    for (let i = 0; i < 5; i += 1) {
      p.recordManagedProcess({ ...fact });
      expect(changes()).toBe(base + 1);
    }

    p.recordManagedProcess({ ...fact, pid: 999 });
    expect(changes()).toBe(base + 2);
    expect(p.listManagedProcesses('/w')[0].pid).toBe(999);

    p.recordManagedProcess({ ...fact, pid: 999, lastProbeStatus: 'exited', cleanupRequired: false });
    expect(changes()).toBe(base + 3);
    expect(p.listManagedProcesses('/w')[0]).toMatchObject({ lastProbeStatus: 'exited', cleanupRequired: false });

    p.recordManagedProcess({ ...fact, pid: 999, lastProbeStatus: 'exited', cleanupRequired: true });
    expect(changes()).toBe(base + 4);
    expect(p.listManagedProcesses('/w')[0]).toMatchObject({ lastProbeStatus: 'cleanup_required', cleanupRequired: true });

    p.recordManagedProcess({ ...fact, pid: 999, lastProbeStatus: 'exited', cleanupRequired: true, pidReusePossible: true });
    expect(changes()).toBe(base + 5);
    expect(p.listManagedProcesses('/w')[0].pidReusePossible).toBe(true);

    // recordManagedOwnership with unchanged fact & ownership does not bump total_changes() or append events.
    const ownedFact = { ...fact, pid: 1000, lastProbeStatus: 'running', cleanupRequired: true };
    p.recordManagedOwnership(ownedFact, ownership);
    const afterOwnership = changes();
    p.recordManagedOwnership(ownedFact, ownership);
    expect(changes()).toBe(afterOwnership);
    expect(p.listSessionEvents('c').filter((e) => e.eventType === 'managed_process_ownership')).toHaveLength(1);
    expect(() => p.recordManagedOwnership(ownedFact, { ...ownership, requestId: 'other' })).toThrow('A9_MANAGED_OWNER_IMMUTABLE');
  } finally { p.db.close(); }
});

it('batch ownership lookup matches getManagedOwnership and avoids N+1 queries in listManagedProcesses', () => {
  const { p, fact, ownership } = setup();
  try {
    p.recordManagedOwnership({ ...fact, handleId: 'h1', lastProbeStatus: 'running' }, { ...ownership, requestId: 'req-1' });
    p.recordManagedOwnership({ ...fact, handleId: 'h2', lastProbeStatus: 'starting' }, { ...ownership, requestId: 'req-2' });
    p.recordManagedOwnership({ ...fact, handleId: 'h3', lastProbeStatus: 'exited', cleanupRequired: false }, { ...ownership, requestId: 'req-3' });
    p.recordManagedOwnership({ ...fact, handleId: 'h2', lastProbeStatus: 'running', cleanupRequired: false }, { ...ownership, requestId: 'req-2', ownershipState: 'release_intent', releaseId: 'rel-2' });

    const byIds = p.listManagedOwnerships(['h1', 'h2', 'h3', 'missing']);
    expect(byIds.size).toBe(3);
    expect(byIds.get('h1')).toEqual(p.getManagedOwnership('h1'));
    expect(byIds.get('h2')).toEqual(p.getManagedOwnership('h2'));
    expect(byIds.get('h3')).toEqual(p.getManagedOwnership('h3'));

    const prepareSpy = jest.spyOn(p.db, 'prepare');
    const listed = p.listManagedProcesses('/w');
    const ownershipQueries = prepareSpy.mock.calls.filter(([sql]) => /managed_process_ownership/.test(sql));
    expect(ownershipQueries).toHaveLength(1);
    expect(listed.find((item) => item.handleId === 'h1')?.cleanupRequired).toBe(true);
    expect(listed.find((item) => item.handleId === 'h2')?.cleanupRequired).toBe(true);
    expect(listed.find((item) => item.handleId === 'h3')?.cleanupRequired).toBe(false);
    prepareSpy.mockRestore();
  } finally { p.db.close(); }
});

it('rejects corrupt newer ownership in single and batch reads while retaining newer valid siblings', () => {
  const { p, fact, ownership } = setup();
  try {
    p.recordManagedOwnership({ ...fact, handleId: 'older' }, ownership);
    p.db.prepare(`INSERT INTO a9_events (session_id, turn_id, kind, event_type, payload_json, created_at)
      VALUES ('c', 'turn', 'tool', 'managed_process_ownership', '{invalid', '2026-10-01')`).run();
    p.recordToolEvent('c', 'turn', 'managed_process_ownership', { ...ownership, handleId: 'newer' });
    expect(() => p.getManagedOwnership('older')).toThrow('A9_MANAGED_OWNERSHIP_CORRUPT');
    expect(() => p.listManagedOwnerships(['older', 'newer'])).toThrow('A9_MANAGED_OWNERSHIP_CORRUPT');
    const onError = jest.fn();
    expect(p.listManagedOwnerships(['older', 'newer'], onError)).toEqual(new Map([['newer', ownership]]));
    expect(onError).toHaveBeenCalledWith('older', expect.objectContaining({ code: 'A9_MANAGED_OWNERSHIP_CORRUPT' }));
  } finally { p.db.close(); }
});

it('isolates malformed ownership by verified event origin and keeps unknown provenance fail-closed', () => {
  const { p, fact, ownership } = setup();
  try {
    p.createConversation('other', '/other');
    p.upsertTask('other-task', 'other', 'active');
    p.upsertTurn('other-turn', 'other-task', 'other', 'active');
    const other = { ...ownership, owner: { ...ownership.owner, workspace: '/other', conversationId: 'other',
      taskId: 'other-task', turnId: 'other-turn' } };
    const otherFact = { ...fact, handleId: 'other-h', workspacePath: '/other' };
    p.recordManagedOwnership(fact, ownership);
    p.recordManagedOwnership(otherFact, other);
    const damaged = p.db.prepare(`INSERT INTO a9_events (session_id, turn_id, kind, event_type, payload_json, created_at)
      VALUES (?, ?, 'tool', 'managed_process_ownership', '{invalid', '2026-10-01')`);
    damaged.run('c', 'turn');
    expect(() => p.getManagedOwnership(fact.handleId)).toThrow('A9_MANAGED_OWNERSHIP_CORRUPT');
    expect(p.getManagedOwnership(otherFact.handleId)).toEqual(other);
    expect(p.listManagedProcesses('/other')[0].cleanupRequired).toBe(true);
    p.recordManagedOwnership({ ...otherFact, handleId: 'new-h' }, other);
    p.recordToolEvent('c', 'turn', 'managed_process_ownership', { schemaVersion: 2, handleId: otherFact.handleId });
    expect(p.getManagedOwnership(otherFact.handleId)).toEqual(other);
    expect(p.listManagedProcesses('/other').every(item => item.cleanupRequired)).toBe(true);
    damaged.run('c', 'other-turn');
    expect(p.getManagedOwnership(otherFact.handleId)).toEqual(other);
    damaged.run('unknown-session', 'other-turn');
    expect(() => p.getManagedOwnership(otherFact.handleId)).toThrow('A9_MANAGED_OWNERSHIP_CORRUPT');
  } finally { p.db.close(); }
});

it('cannot recreate a lost ownership event through reconciliation', () => {
  const { p, fact, ownership } = setup();
  try {
    p.recordManagedOwnership(fact, ownership);
    p.recordManagedOwnership(fact, { ...ownership, ownershipState: 'release_intent', releaseId: 'intent' });
    expect(() => p.recordManagedOwnership(fact, ownership, { mode: 'reconcile' }))
      .toThrow('A9_MANAGED_OWNERSHIP_UNCONFIRMED');
    expect(p.getManagedOwnership(fact.handleId)?.ownershipState).toBe('release_intent');
    p.db.prepare("DELETE FROM a9_events WHERE event_type = 'managed_process_ownership'").run();
    expect(() => p.recordManagedOwnership(fact, ownership, { mode: 'reconcile' }))
      .toThrow('A9_MANAGED_OWNERSHIP_UNCONFIRMED');
    expect(p.getManagedOwnership(fact.handleId)).toBeUndefined();
  } finally { p.db.close(); }
});

it('rejects a non-string ownership handle in its source scope', () => {
  const { p, fact, ownership } = setup();
  try {
    p.recordManagedOwnership(fact, ownership);
    p.recordToolEvent('c', 'turn', 'managed_process_ownership', { ...ownership, handleId: { value: fact.handleId } });
    expect(() => p.getManagedOwnership(fact.handleId)).toThrow('A9_MANAGED_OWNERSHIP_CORRUPT');
  } finally { p.db.close(); }
});

// Round 13 (P1): only a foreign claim naming another workspace is unrelated and ignored.
// A claim naming this workspace whose origin cannot be verified is damaged provenance.
it.each(['/other', '/w'] as const)('a foreign claim of a legacy handle with an unverified owning task (owner.workspace %s)', (claimed) => {
  const { p, fact, ownership } = setup();
  try {
    p.createConversation('other', '/other');
    p.upsertTask('other-task', 'other', 'active');
    p.upsertTurn('other-turn', 'other-task', 'other', 'active');
    p.recordManagedProcess({ ...fact, cleanupRequired: false });
    p.recordToolEvent('other', 'other-turn', 'managed_process_ownership', {
      ...ownership, handleId: fact.handleId, owner: { ...ownership.owner, workspace: claimed, conversationId: 'other', turnId: 'other-turn' },
    });
    if (claimed === '/other') {
      expect(p.getManagedOwnership(fact.handleId)).toBeUndefined();
      expect(p.listManagedProcesses('/w', { includeOwnership: 'recovery' })[0].cleanupRequired).toBe(false);
    } else {
      expect(() => p.getManagedOwnership(fact.handleId)).toThrow('A9_MANAGED_OWNER_MISMATCH');
      const errors: string[] = [];
      expect(p.listManagedProcesses('/w', { includeOwnership: 'recovery', onOwnershipError: (_h, e: any) => errors.push(e.code) })[0]
        .cleanupRequired).toBe(true);
      expect(errors).toEqual(['A9_MANAGED_OWNER_MISMATCH']);
    }
  } finally { p.db.close(); }
});

it('does not let a foreign session use a local turn to override valid local ownership', () => {
  const { p, fact, ownership } = setup();
  try {
    p.createConversation('other', '/other');
    p.recordManagedOwnership(fact, ownership);
    p.recordToolEvent('other', 'turn', 'managed_process_ownership', { handleId: fact.handleId, schemaVersion: 2 });
    expect(p.getManagedOwnership(fact.handleId)).toEqual(ownership);
  } finally { p.db.close(); }
});

it('keeps verified ownership drift visible despite a newer invalid foreign claim', () => {
  const { p, fact, ownership } = setup();
  try {
    p.recordManagedOwnership(fact, ownership);
    p.db.prepare("UPDATE a9_sessions SET workspace_path = '/other' WHERE session_id = 'c'").run();
    p.recordToolEvent('c', 'turn', 'managed_process_ownership', { handleId: fact.handleId, schemaVersion: 2 });
    expect(() => p.getManagedOwnership(fact.handleId)).toThrow('A9_MANAGED_HANDLE_WRONG_OWNER');
  } finally { p.db.close(); }
});

it.each([false, true])('only refreshes probe columns on startup with durable ownership=%s', (owned) => {
  const { p, fact, ownership } = setup();
  try {
    if (owned) p.recordManagedOwnership(fact, ownership);
    else p.recordManagedProcess(fact);
    const observed = { ...fact, command: 'redacted', cwd: '/redacted', lastProbeStatus: 'exited', pidReusePossible: true };
    const events = p.countEvents();
    if (owned) p.recordManagedOwnership(observed, { ...ownership, recoveryStatus: 'exited' }, { mode: 'reconcile' });
    else p.recordLegacyManagedRecoveryProbe(observed);
    expect(p.db.prepare('SELECT command, cwd, last_probe_status, pid_reuse_possible FROM a9_managed_processes').get()).toEqual({
      command: fact.command, cwd: fact.cwd, last_probe_status: 'cleanup_required', pid_reuse_possible: 1,
    });
    expect(p.countEvents()).toBe(events);
  } finally { p.db.close(); }
});

function recordRelease(p: A9PersistenceManager, fact: any, ownership: any) {
  p.recordManagedOwnership(fact, ownership);
  p.recordManagedOwnership(fact, { ...ownership, ownershipState: 'release_intent', releaseId: 'rel' });
  p.recordManagedOwnership({ ...fact, lastProbeStatus: 'released', cleanupRequired: false },
    { ...ownership, ownershipState: 'released', releaseId: 'rel' });
}

it.each([
  ['valid', '', true],
  ['archived session', "UPDATE a9_sessions SET state = 'archived'", true],
  ['all ownership events deleted', "DELETE FROM a9_events WHERE event_type = 'managed_process_ownership'", false],
  ['owner task differs from persistent task', `UPDATE a9_events SET payload_json = json_set(payload_json, '$.owner.taskId', 'other-task')
    WHERE event_type = 'managed_process_ownership'`, false],
  ['intent deleted', `DELETE FROM a9_events WHERE event_type = 'managed_process_ownership'
    AND json_extract(payload_json, '$.ownershipState') = 'release_intent'`, false],
  ['intent has another releaseId', `UPDATE a9_events SET payload_json = json_set(payload_json, '$.releaseId', 'other')
    WHERE json_extract(payload_json, '$.ownershipState') = 'release_intent'`, false],
  ['intent has another request', `UPDATE a9_events SET payload_json = json_set(payload_json, '$.requestId', 'other')
    WHERE json_extract(payload_json, '$.ownershipState') = 'release_intent'`, false],
] as const)('a released row ends cleanup only with a verified release chain: %s', (_name, mutation, releasable) => {
  const { p, fact, ownership } = setup();
  try {
    p.upsertTask('other-task', 'c', 'active');
    recordRelease(p, fact, ownership);
    if (mutation) p.db.exec(mutation);
    const errors: string[] = [];
    const [listed] = p.listManagedProcesses('/w', { includeOwnership: 'recovery', onOwnershipError: (_h, e: any) => errors.push(e.code) });
    expect(listed).toMatchObject({ lastProbeStatus: 'released', cleanupRequired: !releasable });
    expect(errors).toEqual(releasable ? [] : [expect.stringMatching(/^A9_MANAGED_/)]);
    if (!releasable) expect(() => p.listManagedProcesses('/w')).toThrow(/A9_MANAGED_/);
    expect(p.acquireWorkspaceLock('/w', 'me').acquired).toBe(true);
    expect(p.releaseWorkspaceLockIfManagedSettled('/w', 'me', '/w'))
      .toEqual(releasable ? { released: true, blockers: [] } : { released: false, blockers: ['h'] });
    expect(p.db.prepare('SELECT count(*) AS n FROM a9_workspace_locks').get()).toEqual({ n: releasable ? 0 : 1 });
  } finally { p.db.close(); }
});

it('final lock release re-reads a cleanup fact committed by another SQLite connection', () => {
  const fs = require('fs'); const os = require('os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a9-lock-final-'));
  const file = path.join(root, 'a9-state.db');
  const open = A9PersistenceManager.open({ databasePath: file, dataRoot: root, openDatabase: (f: string) => new Database(f) as any });
  if (open.status !== 'ready') throw new Error(open.status);
  const p = open.manager; const other = new Database(file);
  try {
    p.createConversation('c', '/w'); p.upsertTask('task', 'c', 'active'); p.upsertTurn('turn', 'task', 'c', 'active');
    const fact = { handleId: 'h', workspacePath: '/w', command: 'safe', cwd: '/w', startedAt: '2026-10-03', lastProbeStatus: 'running', pid: 345 };
    const ownership = { schemaVersion: 1 as const, owner: { workspace: '/w', conversationId: 'c', taskId: 'task', turnId: 'turn', toolCallId: 'call' },
      requestId: 'request', ownershipState: 'owned' as const };
    recordRelease(p, fact, ownership);
    expect(p.acquireWorkspaceLock('/w', 'me').acquired).toBe(true);
    other.prepare("UPDATE a9_managed_processes SET last_probe_status = 'cleanup_required' WHERE handle_id = 'h'").run();
    expect(p.releaseWorkspaceLockIfManagedSettled('/w', 'me', '/w')).toEqual({ released: false, blockers: ['h'] });
    other.prepare("UPDATE a9_managed_processes SET last_probe_status = 'released' WHERE handle_id = 'h'").run();
    other.prepare(`INSERT INTO a9_managed_processes (handle_id, workspace_path, pid, command, cwd, started_at, last_probe_status, pid_reuse_possible)
      VALUES ('legacy', '/w', 1, 'x', '/w', '2026-10-03', 'cleanup_required', 0)`).run();
    expect(p.releaseWorkspaceLockIfManagedSettled('/w', 'me', '/w')).toEqual({ released: false, blockers: ['legacy'] });
    other.prepare("DELETE FROM a9_managed_processes WHERE handle_id = 'legacy'").run();
    expect(p.releaseWorkspaceLockIfManagedSettled('/w', 'me', '/w')).toEqual({ released: true, blockers: [] });
    expect(other.prepare('SELECT count(*) AS n FROM a9_workspace_locks').get()).toEqual({ n: 0 });
    // Another owner's row is never deleted, and no blocker check is needed for it.
    other.prepare("INSERT INTO a9_workspace_locks VALUES ('/w', 'other-owner', '2026-10-03', '2026-10-03')").run();
    expect(p.releaseWorkspaceLockIfManagedSettled('/w', 'me', '/w')).toEqual({ released: true, blockers: [] });
    expect(other.prepare('SELECT owner_id FROM a9_workspace_locks').get()).toEqual({ owner_id: 'other-owner' });
  } finally { other.close(); p.db.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

// P1 (round 9): the final lock check never releases on a NULL/unknown status or on a
// terminal row whose ownership record is damaged, both committed by another connection.
it.each([
  ['a NULL status', 'UPDATE a9_managed_processes SET last_probe_status = NULL WHERE handle_id = ?'],
  ['an unknown status', "UPDATE a9_managed_processes SET last_probe_status = 'bogus' WHERE handle_id = ?"],
  ['stopped with a damaged ownership record', "UPDATE a9_managed_processes SET last_probe_status = 'stopped' WHERE handle_id = ?"],
] as const)('final lock release keeps the lock for %s committed by another SQLite connection', (name, update) => {
  const fs = require('fs'); const os = require('os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a9-lock-strict-'));
  const file = path.join(root, 'a9-state.db');
  const open = A9PersistenceManager.open({ databasePath: file, dataRoot: root, openDatabase: (f: string) => new Database(f) as any });
  if (open.status !== 'ready') throw new Error(open.status);
  const p = open.manager; const other = new Database(file);
  try {
    p.createConversation('c', '/w'); p.upsertTask('task', 'c', 'active'); p.upsertTurn('turn', 'task', 'c', 'active');
    const fact = { handleId: 'h', workspacePath: '/w', command: 'safe', cwd: '/w', startedAt: '2026-10-03', lastProbeStatus: 'running', pid: 345 };
    p.recordManagedOwnership(fact, { schemaVersion: 1 as const, owner: { workspace: '/w', conversationId: 'c', taskId: 'task', turnId: 'turn', toolCallId: 'call' },
      requestId: 'request', ownershipState: 'owned' as const });
    expect(p.acquireWorkspaceLock('/w', 'me').acquired).toBe(true);
    other.prepare(update).run('h');
    if (name === 'stopped with a damaged ownership record') {
      other.prepare(`UPDATE a9_events SET payload_json = json_remove(payload_json, '$.requestId')
        WHERE event_type = 'managed_process_ownership'`).run();
    }
    expect(p.releaseWorkspaceLockIfManagedSettled('/w', 'me', '/w')).toEqual({ released: false, blockers: ['h'] });
    expect(other.prepare('SELECT count(*) AS n FROM a9_workspace_locks').get()).toEqual({ n: 1 });
    expect(p.isManagedSettlementBlocker({ handleId: 'h', pid: 345, startedAt: '2026-10-03', lastProbeStatus: null, cleanupRequired: false })).toBe(true);
  } finally { other.close(); p.db.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

// P1 (round 10): an ordinary terminal status settles only when its ownership agrees.
// Another connection commits `exited` while the latest well-formed ownership says the
// release outcome is unknown or still pending: no ownership error is raised, yet the
// final lock transaction must keep the lock.
it.each(['release_unknown', 'release_intent'] as const)(
  'final lock release keeps the lock for exited with a %s ownership committed by another SQLite connection', (state) => {
    const fs = require('fs'); const os = require('os');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a9-lock-release-unknown-'));
    const file = path.join(root, 'a9-state.db');
    const open = A9PersistenceManager.open({ databasePath: file, dataRoot: root, openDatabase: (f: string) => new Database(f) as any });
    if (open.status !== 'ready') throw new Error(open.status);
    const p = open.manager; const other = new Database(file);
    try {
      p.createConversation('c', '/w'); p.upsertTask('task', 'c', 'active'); p.upsertTurn('turn', 'task', 'c', 'active');
      const fact = { handleId: 'h', workspacePath: '/w', command: 'safe', cwd: '/w', startedAt: '2026-10-03', lastProbeStatus: 'running', pid: 345 };
      const ownership = { schemaVersion: 1 as const, owner: { workspace: '/w', conversationId: 'c', taskId: 'task', turnId: 'turn', toolCallId: 'call' },
        requestId: 'request', ownershipState: 'owned' as const };
      p.recordManagedOwnership(fact, ownership);
      p.recordManagedOwnership({ ...fact, cleanupRequired: true }, { ...ownership, ownershipState: 'release_intent', releaseId: 'r' });
      if (state === 'release_unknown') {
        p.recordManagedOwnership({ ...fact, cleanupRequired: true }, { ...ownership, ownershipState: 'release_unknown', releaseId: 'r' });
      }
      expect(p.acquireWorkspaceLock('/w', 'me').acquired).toBe(true);
      other.prepare("UPDATE a9_managed_processes SET last_probe_status = 'exited' WHERE handle_id = 'h'").run();
      const errors: string[] = [];
      const [listed] = p.listManagedProcesses('/w', { includeOwnership: true, onOwnershipError: (_h, e: any) => errors.push(e.code) });
      // The ownership record itself is well-formed: only the settlement criterion can catch it.
      expect(errors).toEqual([]);
      expect(listed).toMatchObject({ lastProbeStatus: 'exited', cleanupRequired: false, ownership: { ownershipState: state } });
      expect(p.isManagedSettlementBlocker(listed)).toBe(true);
      // Round 12: the Runtime pre-check read ('recovery') loads the same terminal ownership,
      // so leave/new conversation/mode change see the conflict the final lock sees.
      const [recovered] = p.listManagedProcesses('/w', { includeOwnership: 'recovery', onOwnershipError: (_h, e: any) => errors.push(e.code) });
      expect(errors).toEqual([]);
      expect(recovered).toMatchObject({ lastProbeStatus: 'exited', ownership: { ownershipState: state } });
      expect(p.isManagedSettlementBlocker(recovered)).toBe(true);
      expect(p.releaseWorkspaceLockIfManagedSettled('/w', 'me', '/w')).toEqual({ released: false, blockers: ['h'] });
      expect(other.prepare('SELECT count(*) AS n FROM a9_workspace_locks').get()).toEqual({ n: 1 });
      // Status/ownership conflicts also block: released ownership needs a released status.
      expect(p.isManagedSettlementBlocker({ ...listed, ownership: { ...listed.ownership!, ownershipState: 'released' } })).toBe(true);
      expect(p.isManagedSettlementBlocker({ ...listed, lastProbeStatus: 'released' })).toBe(true);
      // Control: the same terminal status with an `owned` record still settles.
      expect(p.isManagedSettlementBlocker({ ...listed, ownership: { ...listed.ownership!, ownershipState: 'owned' } })).toBe(false);
    } finally { other.close(); p.db.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });

it('invalidates managed snapshot revisions on changed ownership origins only', () => {
  const { p, fact, ownership } = setup();
  try {
    p.createConversation('other', '/w'); p.upsertTask('other-task', 'other', 'active'); p.upsertTurn('other-turn', 'other-task', 'other', 'active');
    p.upsertTask('task-2', 'c', 'active'); p.upsertTurn('turn-2', 'task-2', 'c', 'active');
    p.recordManagedOwnership({ ...fact, lastProbeStatus: 'exited', cleanupRequired: false }, ownership);
    const managed = () => p.readSnapshotRevisions('/w', 'c', '/w')!.managed;
    const unchanged = (write: () => void) => { const before = managed(); write(); expect(managed()).toBe(before); };
    const changed = (write: () => void) => { const before = managed(); write(); expect(managed()).not.toBe(before); };
    // Hot-path writes that do not touch an ownership origin keep the cache.
    unchanged(() => p.recordToolEvent('c', 'turn', 'tool_output', { data: { schemaVersion: 1, conversationId: 'c', turnId: 'turn',
      taskId: 'task', toolCallId: 'call', requestId: 'req', stream: 'stdout', text: 'x', outputSeq: 1, sourceSeqThrough: 1,
      rawBytesRead: 1, truncated: false } }));
    unchanged(() => p.upsertTurn('turn', 'task', 'c', 'completed'));
    unchanged(() => p.upsertTask('task', 'c', 'completed'));
    unchanged(() => p.db.prepare("UPDATE a9_sessions SET title = 'renamed', updated_at = 'x' WHERE session_id = 'c'").run());
    unchanged(() => p.db.prepare("UPDATE a9_turns SET task_id = 'other-task' WHERE turn_id = 'other-turn'").run());
    unchanged(() => p.db.prepare("UPDATE a9_turns SET task_id = 'task-2' WHERE turn_id = 'turn-2'").run());
    unchanged(() => p.db.prepare("DELETE FROM a9_tasks WHERE task_id = 'other-task'").run());
    // Origin columns referenced by an ownership event invalidate old and new scopes.
    changed(() => p.db.prepare("UPDATE a9_turns SET task_id = 'task-2' WHERE turn_id = 'turn'").run());
    changed(() => p.db.prepare("UPDATE a9_turns SET task_id = 'task' WHERE turn_id = 'turn'").run());
    changed(() => p.db.prepare("UPDATE a9_tasks SET session_id = 'other' WHERE task_id = 'task'").run());
    changed(() => p.db.prepare("UPDATE a9_tasks SET session_id = 'c' WHERE task_id = 'task'").run());
    changed(() => p.db.prepare("UPDATE a9_sessions SET state = 'archived' WHERE session_id = 'c'").run());
    changed(() => p.db.prepare("UPDATE a9_sessions SET workspace_path = '/elsewhere' WHERE session_id = 'c'").run());
    changed(() => p.db.prepare("UPDATE a9_sessions SET workspace_path = '/w' WHERE session_id = 'c'").run());
    changed(() => p.db.prepare(`INSERT OR REPLACE INTO a9_turns (turn_id, task_id, session_id, status, outcome_json, created_at, updated_at)
      VALUES ('turn', 'task', 'c', 'completed', '{}', 'x', 'x')`).run());
    changed(() => p.db.prepare("DELETE FROM a9_turns WHERE turn_id = 'turn'").run());
    changed(() => p.db.prepare(`INSERT INTO a9_turns (turn_id, task_id, session_id, status, outcome_json, created_at, updated_at)
      VALUES ('turn', 'task', 'c', 'completed', '{}', 'x', 'x')`).run());
    changed(() => p.db.prepare("DELETE FROM a9_tasks WHERE task_id = 'task'").run());
    changed(() => p.db.prepare("INSERT INTO a9_tasks (task_id, session_id, status, created_at, updated_at) VALUES ('task', 'c', 'active', 'x', 'x')").run());
    p.db.exec('BEGIN');
    p.db.prepare("DELETE FROM a9_turns WHERE turn_id = 'turn'").run();
    expect(p.readSnapshotRevisions('/w', 'c', '/w')).toBeNull();
    p.db.exec('ROLLBACK');
    expect(p.getManagedOwnership('h')).toEqual(ownership);
  } finally { p.db.close(); }
});

it('derives recovery revisions for recovered cleanup facts from one batch ownership read', () => {
  const { p, fact, ownership } = setup();
  try {
    for (const handleId of ['h1', 'h2', 'h3']) {
      p.recordManagedOwnership({ ...fact, handleId, lastProbeStatus: 'exited', cleanupRequired: true }, { ...ownership, requestId: handleId });
    }
    p.recordManagedProcess({ ...fact, handleId: 'legacy', lastProbeStatus: 'exited', cleanupRequired: true });
    const prepare = jest.spyOn(p.db, 'prepare');
    const listed = p.listManagedProcesses('/w', { includeOwnership: true, includeRecoveryIdentity: true });
    expect(prepare.mock.calls.filter(([sql]) => /managed_process_ownership/.test(sql))).toHaveLength(1);
    prepare.mockRestore();
    for (const handleId of ['h1', 'h2', 'h3']) {
      expect(listed.find(item => item.handleId === handleId)?.recoveryIdentity)
        .toEqual({ recoveryRevision: p.getManagedProcessRecoveryIdentity(handleId).recoveryRevision });
    }
    expect(listed.find(item => item.handleId === 'legacy')?.recoveryIdentity).toEqual({ errorCode: 'A9_MANAGED_OWNERSHIP_UNCONFIRMED' });
    p.upsertTask('task', 'c', 'completed');
    p.db.prepare("UPDATE a9_sessions SET state = 'archived' WHERE session_id = 'c'").run();
    expect(p.listManagedProcesses('/w', { includeOwnership: true, includeRecoveryIdentity: true })
      .find(item => item.handleId === 'h1')?.recoveryIdentity).toEqual({ errorCode: 'A9_MANAGED_HANDLE_WRONG_OWNER' });
  } finally { p.db.close(); }
});

// ADR-0343 regressions: real in-memory SQLite, no mocked persistence.
function lockOutcome(p: A9PersistenceManager, handedOver?: Array<{ handleId: string; pid: number | null; startedAt: string }>) {
  expect(p.acquireWorkspaceLock('/w', 'me').acquired).toBe(true);
  return p.releaseWorkspaceLockIfManagedSettled('/w', 'me', '/w', handedOver ? { handedOver } : {});
}
const insertOwnershipEvent = (p: A9PersistenceManager, kind: string, session: string, turn: string, payload: unknown) =>
  p.db.prepare(`INSERT INTO a9_events (session_id, turn_id, kind, event_type, payload_json, created_at)
    VALUES (?, ?, ?, 'managed_process_ownership', ?, '2026-11-19')`).run(session, turn, kind, JSON.stringify(payload));

it.each(['model-kind receipt', 'other real task/turn pair'] as const)('a released row cannot borrow a substitute release chain: %s', (variant) => {
  const { p, fact, ownership } = setup();
  try {
    p.upsertTask('task-2', 'c', 'active'); p.upsertTurn('turn-2', 'task-2', 'c', 'active');
    p.recordManagedOwnership({ ...fact, lastProbeStatus: 'exited', cleanupRequired: false }, ownership);
    const owner = variant === 'model-kind receipt' ? ownership.owner : { ...ownership.owner, taskId: 'task-2', turnId: 'turn-2', toolCallId: 'call-2' };
    const kind = variant === 'model-kind receipt' ? 'model' : 'tool';
    const turn = owner.turnId;
    insertOwnershipEvent(p, kind, 'c', turn, { handleId: 'h', ...ownership, owner, ownershipState: 'release_intent', releaseId: 'rel' });
    insertOwnershipEvent(p, kind, 'c', turn, { handleId: 'h', ...ownership, owner, ownershipState: 'released', releaseId: 'rel' });
    p.db.prepare("UPDATE a9_managed_processes SET last_probe_status = 'released'").run();
    const errors: string[] = [];
    const [listed] = p.listManagedProcesses('/w', { includeOwnership: 'recovery', onOwnershipError: (_h, e: any) => errors.push(e.code) });
    expect(listed).toMatchObject({ lastProbeStatus: 'released', cleanupRequired: true });
    expect(errors).toEqual([expect.stringMatching(/^A9_MANAGED_/)]);
    expect(lockOutcome(p)).toEqual({ released: false, blockers: ['h'] });
    expect(p.db.prepare('SELECT count(*) AS n FROM a9_workspace_locks').get()).toEqual({ n: 1 });
    // The scoped latest read does not let arrival order replace the first owner either.
    if (variant === 'other real task/turn pair') expect(() => p.getManagedOwnership('h')).toThrow('A9_MANAGED_OWNERSHIP_UNCONFIRMED');
    else expect(p.getManagedOwnership('h')).toEqual(ownership);
  } finally { p.db.close(); }
});

it('a later owned record from another real turn cannot re-own an active fact', () => {
  const { p, fact, ownership } = setup();
  try {
    p.upsertTask('task-2', 'c', 'active'); p.upsertTurn('turn-2', 'task-2', 'c', 'active');
    p.recordManagedOwnership(fact, ownership);
    const owner = { ...ownership.owner, taskId: 'task-2', turnId: 'turn-2' };
    insertOwnershipEvent(p, 'tool', 'c', 'turn-2', { handleId: 'h', ...ownership, owner });
    const errors: string[] = [];
    expect(p.listManagedProcesses('/w', { includeOwnership: 'recovery', onOwnershipError: (_h, e: any) => errors.push(e.code) })[0]
      .cleanupRequired).toBe(true);
    expect(errors).toEqual(['A9_MANAGED_OWNERSHIP_UNCONFIRMED']);
  } finally { p.db.close(); }
});

it.each(['status text only', 'model-kind disposition', 'other handle disposition', 'pid differs', 'revision differs', 'valid'] as const)(
  'a user_dismissed row settles only with its verified A9-34 disposition: %s', (variant) => {
    const { p, input } = dispositionSetup();
    try {
      if (variant === 'status text only') p.db.prepare("UPDATE a9_managed_processes SET last_probe_status = 'user_dismissed'").run();
      else {
        p.dismissRecoveredManagedProcess(input);
        if (variant === 'model-kind disposition') p.db.prepare("UPDATE a9_events SET kind = 'model' WHERE event_type = 'managed_process_disposition'").run();
        if (variant === 'other handle disposition') p.db.prepare(`UPDATE a9_events SET payload_json = json_set(payload_json, '$.handleId', 'other')
          WHERE event_type = 'managed_process_disposition'`).run();
        if (variant === 'pid differs') p.db.prepare('UPDATE a9_managed_processes SET pid = 346').run();
        if (variant === 'revision differs') p.db.prepare(`UPDATE a9_events SET payload_json = json_set(payload_json, '$.recoveryRevision', ?)
          WHERE event_type = 'managed_process_disposition'`).run('c'.repeat(64));
      }
      const errors: string[] = [];
      const [listed] = p.listManagedProcesses('/w', { includeOwnership: true, onOwnershipError: (_h, e: any) => errors.push(e.code) });
      const settled = variant === 'valid';
      expect(listed).toMatchObject({ lastProbeStatus: 'user_dismissed', cleanupRequired: !settled });
      expect(Boolean(listed.disposition)).toBe(settled);
      expect(errors).toEqual(settled ? [] : ['A9_MANAGED_DISPOSITION_UNCONFIRMED']);
      p.releaseWorkspaceLock('/w', 'window');
      expect(lockOutcome(p)).toEqual(settled ? { released: true, blockers: [] } : { released: false, blockers: ['h'] });
      // Retrying with the original revision stays idempotent only for the verified record.
      p.db.prepare('DELETE FROM a9_workspace_locks').run();
      p.acquireWorkspaceLock('/w', 'window');
      if (settled) expect(p.dismissRecoveredManagedProcess({ ...input, identity: undefined, pidProbe: undefined }).eventId).toBe(listed.disposition!.eventId);
      else expect(() => p.dismissRecoveredManagedProcess(input)).toThrow(/A9_MANAGED_(RECOVERY_STALE|NOT_RECOVERED_CLEANUP)/);
    } finally { p.db.close(); }
  });

it.each([false, true])('legitimate terminal history survives a registry relink/rename of its conversation (rename=%s)', (rename) => {
  const { p, fact, ownership } = setup();
  try {
    p.upsertTask('task-d', 'c', 'active'); p.upsertTurn('turn-d', 'task-d', 'c', 'active');
    recordRelease(p, { ...fact, cleanupRequired: false }, ownership);
    const dismissedOwnership = { ...ownership, requestId: 'request-d', owner: { ...ownership.owner, taskId: 'task-d', turnId: 'turn-d', toolCallId: 'call-d' } };
    p.recordManagedOwnership({ ...fact, handleId: 'd', lastProbeStatus: 'exited' }, { ...dismissedOwnership, recoveryStatus: 'exited' });
    p.recordManagedOwnership({ ...fact, handleId: 's', lastProbeStatus: 'stopped', cleanupRequired: false }, { ...ownership, requestId: 'request-s' });
    p.acquireWorkspaceLock('/w', 'window');
    const current = p.getManagedProcessRecoveryIdentity('d');
    p.dismissRecoveredManagedProcess({ workspace: '/w', conversationId: 'c', lockOwnerId: 'window', handleId: 'd', recoveryRevision: current.recoveryRevision,
      identity: { owner: current.owner, requestId: current.requestId, pid: current.pid, startedAt: current.startedAt },
      pidProbe: { pid: current.pid, status: 'absent', checkedAt: new Date().toISOString() } });
    p.releaseWorkspaceLock('/w', 'window');
    for (const [task, turn] of [['task', 'turn'], ['task-d', 'turn-d']]) { p.upsertTurn(turn, task, 'c', 'completed'); p.upsertTask(task, 'c', 'completed'); }
    p.changeWorkdir('c', '/w', '/w2', rename);
    expect(p.listConversations('/w2').map(item => item.sessionId)).toEqual(['c']);
    const errors: string[] = [];
    const listed = p.listManagedProcesses('/w', { includeOwnership: true, onOwnershipError: (h, e: any) => errors.push(`${h}:${e.code}`) });
    expect(errors).toEqual([]);
    expect(listed.map(item => [item.handleId, item.lastProbeStatus, item.cleanupRequired, item.ownership?.ownershipState]).sort()).toEqual([
      ['d', 'user_dismissed', false, 'owned'], ['h', 'released', false, 'released'], ['s', 'stopped', false, 'owned']]);
    expect(() => p.listManagedProcesses('/w')).not.toThrow();
    expect(lockOutcome(p)).toEqual({ released: true, blockers: [] });
  } finally { p.db.close(); }
});

it('retention keeps evidence of existing managed facts and purges ordinary expired events', () => {
  const { p, fact, ownership } = setup();
  try {
    p.upsertTask('task-d', 'c', 'active'); p.upsertTurn('turn-d', 'task-d', 'c', 'active');
    recordRelease(p, { ...fact, cleanupRequired: false }, ownership);
    const owner = { ...ownership.owner, taskId: 'task-d', turnId: 'turn-d', toolCallId: 'call-d' };
    p.recordManagedOwnership({ ...fact, handleId: 'd', lastProbeStatus: 'exited' }, { ...ownership, owner, requestId: 'request-d', recoveryStatus: 'exited' });
    p.recordManagedOwnership({ ...fact, handleId: 'gone', lastProbeStatus: 'stopped', cleanupRequired: false }, { ...ownership, requestId: 'request-g' });
    p.recordModelEvent('c', 'turn', 'conversation.request', { schemaVersion: 1, taskId: 'task', requestPrompt: 'ordinary' });
    p.acquireWorkspaceLock('/w', 'window');
    const current = p.getManagedProcessRecoveryIdentity('d');
    const input = { workspace: '/w', conversationId: 'c', lockOwnerId: 'window', handleId: 'd', recoveryRevision: current.recoveryRevision,
      identity: { owner: current.owner, requestId: current.requestId, pid: current.pid, startedAt: current.startedAt },
      pidProbe: { pid: current.pid, status: 'absent', checkedAt: new Date().toISOString() } };
    const disposition = p.dismissRecoveredManagedProcess(input);
    p.db.prepare("DELETE FROM a9_managed_processes WHERE handle_id = 'gone'").run();
    const before = p.countEvents();
    expect(before).toBe(7);
    // owned, intent, released (h); owned (d); disposition (d) stay. 'gone' and the request purge.
    expect(p.enforceRetention(new Date(Date.now() + 91 * 24 * 60 * 60 * 1000))).toEqual({ purgedEvents: 2 });
    expect(p.countEvents()).toBe(5);
    const listed = p.listManagedProcesses('/w', { includeOwnership: true });
    expect(listed.map(item => [item.handleId, item.cleanupRequired]).sort()).toEqual([['d', false], ['h', false]]);
    expect(listed.find(item => item.handleId === 'd')?.disposition?.eventId).toBe(disposition.eventId);
    expect(p.dismissRecoveredManagedProcess({ ...input, identity: undefined, pidProbe: undefined }).eventId).toBe(disposition.eventId);
    p.releaseWorkspaceLock('/w', 'window');
    expect(lockOutcome(p)).toEqual({ released: true, blockers: [] });
  } finally { p.db.close(); }
});

it('final release blocks an unowned active fact unless this shutdown handed over that exact identity', () => {
  const { p, fact } = setup();
  try {
    p.recordManagedProcess({ ...fact, handleId: 'late', lastProbeStatus: 'running', cleanupRequired: false });
    expect(lockOutcome(p)).toEqual({ released: false, blockers: ['late'] });
    expect(lockOutcome(p, [{ handleId: 'late', pid: 999, startedAt: fact.startedAt }])).toEqual({ released: false, blockers: ['late'] });
    p.db.prepare("UPDATE a9_managed_processes SET last_probe_status = 'starting'").run();
    expect(lockOutcome(p)).toEqual({ released: false, blockers: ['late'] });
    p.db.prepare("UPDATE a9_managed_processes SET last_probe_status = 'running_unknown'").run();
    expect(lockOutcome(p, [{ handleId: 'late', pid: fact.pid, startedAt: fact.startedAt }])).toEqual({ released: false, blockers: ['late'] });
    p.db.prepare("UPDATE a9_managed_processes SET last_probe_status = 'running'").run();
    expect(lockOutcome(p, [{ handleId: 'late', pid: fact.pid, startedAt: fact.startedAt }])).toEqual({ released: true, blockers: [] });
    p.db.prepare("UPDATE a9_managed_processes SET last_probe_status = 'stopped'").run();
    expect(lockOutcome(p)).toEqual({ released: true, blockers: [] });
  } finally { p.db.close(); }
});

it('a lock DELETE ignored by SQLite is a retryable failure, not a release', () => {
  const { p } = setup();
  try {
    p.db.exec("CREATE TRIGGER keep_lock BEFORE DELETE ON a9_workspace_locks BEGIN SELECT RAISE(IGNORE); END");
    const refused = { released: false, blockers: [], reason: 'A9_WORKSPACE_LOCK_RELEASE_UNCONFIRMED' };
    expect(lockOutcome(p)).toEqual(refused);
    expect(p.releaseWorkspaceLock('/w', 'me')).toEqual(refused);
    expect(p.db.prepare('SELECT owner_id FROM a9_workspace_locks').get()).toEqual({ owner_id: 'me' });
    p.db.exec('DROP TRIGGER keep_lock');
    expect(p.releaseWorkspaceLockIfManagedSettled('/w', 'me', '/w')).toEqual({ released: true, blockers: [] });
    expect(lockOutcome(p)).toEqual({ released: true, blockers: [] });
    expect(p.acquireWorkspaceLock('/w', 'me').acquired).toBe(true);
    expect(p.releaseWorkspaceLock('/w', 'me')).toEqual({ released: true, blockers: [] });
    expect(p.db.prepare('SELECT count(*) AS n FROM a9_workspace_locks').get()).toEqual({ n: 0 });
  } finally { p.db.close(); }
});

// ADR-0344 regressions: real SQLite triggers, connections and Windows path spellings.
it.each([
  ['ownership event', "CREATE TRIGGER ignore_w BEFORE INSERT ON a9_events WHEN NEW.event_type='managed_process_ownership' BEGIN SELECT RAISE(IGNORE); END"],
  ['starting fact', "CREATE TRIGGER ignore_w BEFORE INSERT ON a9_managed_processes BEGIN SELECT RAISE(IGNORE); END"],
] as const)('a mandatory starting write ignored by SQLite (%s) fails and commits nothing', (_name, trigger) => {
  const { p, fact, ownership } = setup();
  try {
    p.db.exec(trigger);
    expect(() => p.recordManagedOwnership({ ...fact, lastProbeStatus: 'starting', cleanupRequired: true }, ownership, { mode: 'register' }))
      .toThrow('A9_PERSISTENCE_WRITE_UNCONFIRMED');
    expect(p.db.prepare('SELECT count(*) AS n FROM a9_managed_processes').get()).toEqual({ n: 0 });
    expect(p.countEvents()).toBe(0);
  } finally { p.db.close(); }
});

it('legitimate idempotent zero-row writes stay successful and distinct from ignored writes', () => {
  const { p, fact, ownership } = setup();
  try {
    p.recordManagedOwnership(fact, ownership);
    const events = p.countEvents();
    p.db.exec("CREATE TRIGGER ignore_all_events BEFORE INSERT ON a9_events BEGIN SELECT RAISE(IGNORE); END");
    p.db.exec("CREATE TRIGGER ignore_all_facts BEFORE UPDATE ON a9_managed_processes BEGIN SELECT RAISE(IGNORE); END");
    // Same fact and ownership: no write is needed, so nothing is ignored.
    p.recordManagedOwnership(fact, ownership);
    // Same recovery probe values: an UPDATE of zero rows is legitimate.
    const probe = { ...fact, cleanupRequired: false };
    p.recordManagedOwnership(probe, ownership, { mode: 'reconcile' });
    expect(p.countEvents()).toBe(events);
    // A real change whose UPDATE is ignored is a failed write.
    expect(() => p.recordManagedOwnership({ ...probe, pidReusePossible: true }, ownership, { mode: 'reconcile' }))
      .toThrow('A9_PERSISTENCE_WRITE_UNCONFIRMED');
    expect(p.db.prepare('SELECT pid_reuse_possible FROM a9_managed_processes').get()).toEqual({ pid_reuse_possible: 0 });
  } finally { p.db.close(); }
});

it.each([
  ['fact update', "CREATE TRIGGER ignore_w BEFORE UPDATE ON a9_managed_processes BEGIN SELECT RAISE(IGNORE); END"],
  ['disposition event', "CREATE TRIGGER ignore_w BEFORE INSERT ON a9_events WHEN NEW.event_type='managed_process_disposition' BEGIN SELECT RAISE(IGNORE); END"],
] as const)('A9-34 disposition with an ignored %s rolls back and never reports success', (_name, trigger) => {
  const { p, input } = dispositionSetup();
  try {
    p.db.exec(trigger);
    const before = p.db.prepare('SELECT * FROM a9_managed_processes').all(); const count = p.countEvents();
    expect(() => p.dismissRecoveredManagedProcess(input)).toThrow('A9_PERSISTENCE_WRITE_UNCONFIRMED');
    expect(p.db.prepare('SELECT * FROM a9_managed_processes').all()).toEqual(before);
    expect(p.countEvents()).toBe(count);
    expect(p.getManagedProcessDisposition('h')).toBeUndefined();
    p.db.exec('DROP TRIGGER ignore_w');
    expect(p.dismissRecoveredManagedProcess(input)).toMatchObject({ disposition: 'user_attested_after_restart' });
  } finally { p.db.close(); }
});

it('equivalent Windows spellings with different real sessions share one owned anchor', () => {
  const platform = testPlatform('win32');
  const { p, fact, ownership } = setup('c:\\work');
  try {
    p.createConversation('c2', 'C:/Work/'); p.upsertTask('task-2', 'c2', 'active'); p.upsertTurn('turn-2', 'task-2', 'c2', 'active');
    p.recordManagedOwnership(fact, ownership);
    const intruder = { ...ownership, requestId: 'request-2', owner: { ...ownership.owner, conversationId: 'c2', taskId: 'task-2', turnId: 'turn-2' } };
    insertOwnershipEvent(p, 'tool', 'c2', 'turn-2', { handleId: 'h', ...intruder });
    for (const scope of ['c:\\work', 'C:/Work/', undefined]) {
      expect(() => p.getManagedOwnership('h', scope)).toThrow('A9_MANAGED_OWNERSHIP_UNCONFIRMED');
    }
    const errors: string[] = [];
    expect(p.listManagedProcesses('C:\\WORK', { includeOwnership: 'recovery', onOwnershipError: (_h, e: any) => errors.push(e.code) })[0])
      .toMatchObject({ handleId: 'h', cleanupRequired: true });
    expect(errors).toEqual(['A9_MANAGED_OWNERSHIP_UNCONFIRMED']);
    // A later record restating the anchor cannot hide an intermediate re-owning record.
    insertOwnershipEvent(p, 'tool', 'c', 'turn', { handleId: 'h', ...ownership });
    expect(() => p.getManagedOwnership('h')).toThrow('A9_MANAGED_OWNERSHIP_UNCONFIRMED');
    // A real second handle owned only from the other spelling remains its own anchor.
    p.recordManagedOwnership({ ...fact, handleId: 'h2', workspacePath: 'C:/Work/' }, { ...intruder, owner: { ...intruder.owner, workspace: 'c:\\work' } });
    expect(p.getManagedOwnership('h2')).toMatchObject({ requestId: 'request-2' });
    expect(p.acquireWorkspaceLock('c:\\work', 'me').acquired).toBe(true);
    expect(p.releaseWorkspaceLockIfManagedSettled('c:\\work', 'me', 'C:/Work')).toEqual({ released: false, blockers: ['h', 'h2'] });
  } finally { p.db.close(); platform.restore(); }
});

it('a valid A9-34 disposition is unaffected by a foreign workspace damaged disposition event', () => {
  const { p, input } = dispositionSetup();
  try {
    p.createConversation('other', '/other'); p.upsertTask('other-task', 'other', 'active'); p.upsertTurn('other-turn', 'other-task', 'other', 'active');
    const disposition = p.dismissRecoveredManagedProcess(input);
    const damaged = p.db.prepare(`INSERT INTO a9_events (session_id, turn_id, kind, event_type, payload_json, created_at)
      VALUES (?, ?, ?, 'managed_process_disposition', '{invalid', '2026-11-19')`);
    damaged.run('other', 'other-turn', 'tool');
    damaged.run('c', 'turn', 'model');
    expect(p.getManagedProcessDisposition('h')?.eventId).toBe(disposition.eventId);
    const errors: string[] = [];
    expect(p.listManagedProcesses('/w', { includeOwnership: true, onOwnershipError: (_h, e: any) => errors.push(e.code) })[0])
      .toMatchObject({ lastProbeStatus: 'user_dismissed', cleanupRequired: false, disposition: expect.objectContaining({ eventId: disposition.eventId }) });
    expect(errors).toEqual([]);
    expect(p.dismissRecoveredManagedProcess({ ...input, identity: undefined, pidProbe: undefined }).eventId).toBe(disposition.eventId);
    p.releaseWorkspaceLock('/w', 'window');
    expect(lockOutcome(p)).toEqual({ released: true, blockers: [] });
    // Local damage (this workspace's session, or no known session) stays fail-closed.
    for (const session of ['c', 'unknown-session']) {
      const id = damaged.run(session, 'turn', 'tool').lastInsertRowid;
      expect(() => p.getManagedProcessDisposition('h')).toThrow('A9_MANAGED_DISPOSITION_UNCONFIRMED');
      expect(p.listManagedProcesses('/w', { includeOwnership: true, onOwnershipError: () => {} })[0].cleanupRequired).toBe(true);
      expect(lockOutcome(p)).toEqual({ released: false, blockers: ['h'] });
      p.db.prepare('DELETE FROM a9_events WHERE id = ?').run(id);
    }
  } finally { p.db.close(); }
});

it.each(['handleId only', 'forged full record'] as const)(
  'a foreign workspace disposition record naming the handle (%s) cannot shadow the legitimate A9-34 disposition', (variant) => {
    const { p, input } = dispositionSetup();
    try {
      p.createConversation('other', '/other'); p.upsertTask('other-task', 'other', 'active'); p.upsertTurn('other-turn', 'other-task', 'other', 'active');
      const disposition = p.dismissRecoveredManagedProcess(input);
      const forged = variant === 'handleId only' ? { handleId: 'h' } : { ...disposition, eventId: undefined, id: undefined };
      const named = p.db.prepare(`INSERT INTO a9_events (session_id, turn_id, kind, event_type, payload_json, created_at)
        VALUES (?, ?, 'tool', 'managed_process_disposition', ?, '2026-11-19')`);
      named.run('other', 'other-turn', JSON.stringify(forged));
      expect(p.getManagedProcessDisposition('h')?.eventId).toBe(disposition.eventId);
      const errors: string[] = [];
      expect(p.listManagedProcesses('/w', { includeOwnership: true, onOwnershipError: (_h, e: any) => errors.push(e.code) })[0])
        .toMatchObject({ lastProbeStatus: 'user_dismissed', cleanupRequired: false, disposition: expect.objectContaining({ eventId: disposition.eventId }) });
      expect(errors).toEqual([]);
      // The original request's idempotent retry still returns the same disposition.
      expect(p.dismissRecoveredManagedProcess({ ...input, identity: undefined, pidProbe: undefined }).eventId).toBe(disposition.eventId);
      p.releaseWorkspaceLock('/w', 'window');
      expect(lockOutcome(p)).toEqual({ released: true, blockers: [] });
      // The same record from this workspace's session or from no known session stays fail-closed.
      for (const session of ['c', 'unknown-session']) {
        const id = named.run(session, 'turn', JSON.stringify({ handleId: 'h' })).lastInsertRowid;
        expect(() => p.listManagedProcesses('/w', { includeOwnership: true })).toThrow('A9_MANAGED_DISPOSITION_UNCONFIRMED');
        expect(p.listManagedProcesses('/w', { includeOwnership: true, onOwnershipError: () => {} })[0].cleanupRequired).toBe(true);
        expect(lockOutcome(p)).toEqual({ released: false, blockers: ['h'] });
        p.db.prepare('DELETE FROM a9_events WHERE id = ?').run(id);
      }
    } finally { p.db.close(); }
  });

it.each(['handleId only', 'full record owned by the other workspace'] as const)(
  'an earlier foreign ownership event naming the handle (%s) is no anchor and cannot make its dispositions shadow the legitimate one', (variant) => {
    const { p, input, ownership } = dispositionSetup();
    try {
      p.createConversation('other', '/other'); p.upsertTask('other-task', 'other', 'active'); p.upsertTurn('other-turn', 'other-task', 'other', 'active');
      const foreignOwnership = variant === 'handleId only' ? { handleId: 'h' } : { handleId: 'h', ...ownership,
        owner: { ...ownership.owner, workspace: '/other', conversationId: 'other', taskId: 'other-task', turnId: 'other-turn' } };
      // Lower id than the legitimate anchor: it is the first record naming the handle.
      p.db.prepare(`INSERT INTO a9_events (id, session_id, turn_id, kind, event_type, payload_json, created_at)
        VALUES (-1, 'other', 'other-turn', 'tool', 'managed_process_ownership', ?, '2026-11-19')`).run(JSON.stringify(foreignOwnership));
      const disposition = p.dismissRecoveredManagedProcess(input);
      p.db.prepare(`INSERT INTO a9_events (session_id, turn_id, kind, event_type, payload_json, created_at)
        VALUES ('other', 'other-turn', 'tool', 'managed_process_disposition', ?, '2026-11-19')`)
        .run(JSON.stringify({ ...disposition, eventId: undefined, recoveryRevision: 'f'.repeat(64) }));
      expect(p.getManagedProcessDisposition('h')?.eventId).toBe(disposition.eventId);
      expect(p.dismissRecoveredManagedProcess({ ...input, identity: undefined, pidProbe: undefined }).eventId).toBe(disposition.eventId);
      expect(p.listManagedProcesses('/w', { includeOwnership: true })[0]).toMatchObject({ lastProbeStatus: 'user_dismissed', cleanupRequired: false });
      p.releaseWorkspaceLock('/w', 'window');
      expect(lockOutcome(p)).toEqual({ released: true, blockers: [] });
    } finally { p.db.close(); }
  });

it('a disposition session rebinding invalidates managed revisions while ordinary tool output keeps them', () => {
  const { p, input } = dispositionSetup();
  try {
    p.createConversation('other', '/other'); p.upsertTask('other-task', 'other', 'active'); p.upsertTurn('other-turn', 'other-task', 'other', 'active');
    p.createConversation('plain', '/other');
    p.dismissRecoveredManagedProcess(input);
    p.db.prepare(`INSERT INTO a9_events (session_id, turn_id, kind, event_type, payload_json, created_at)
      VALUES ('other', 'other-turn', 'tool', 'managed_process_disposition', '{invalid', '2026-11-19')`).run();
    const managed = () => p.readSnapshotRevisions('/w', 'c', '/w')!.managed;
    const unchanged = (write: () => void) => { const before = managed(); write(); expect(managed()).toBe(before); };
    const changed = (write: () => void) => { const before = managed(); write(); expect(managed()).not.toBe(before); };
    unchanged(() => p.recordToolEvent('other', 'other-turn', 'tool_output', { data: { schemaVersion: 1, conversationId: 'other',
      turnId: 'other-turn', taskId: 'other-task', toolCallId: 'call', requestId: 'req', stream: 'stdout', text: 'x', outputSeq: 1,
      sourceSeqThrough: 1, rawBytesRead: 1, truncated: false } }));
    unchanged(() => p.db.prepare("UPDATE a9_sessions SET workspace_path = '/w' WHERE session_id = 'plain'").run());
    expect(p.listManagedProcesses('/w', { includeOwnership: true })[0].cleanupRequired).toBe(false);
    changed(() => p.db.prepare("UPDATE a9_sessions SET workspace_path = '/w' WHERE session_id = 'other'").run());
    expect(p.listManagedProcesses('/w', { includeOwnership: true, onOwnershipError: () => {} })[0].cleanupRequired).toBe(true);
    changed(() => p.db.prepare("UPDATE a9_sessions SET workspace_path = '/other' WHERE session_id = 'other'").run());
    changed(() => p.db.prepare("DELETE FROM a9_sessions WHERE session_id = 'other'").run());
  } finally { p.db.close(); }
});

it.each(['active', 'released', 'user_dismissed'] as const)(
  'a non-tool ownership record without handleId is neither evidence nor damage (%s)', (kind) => {
    const fixture = kind === 'user_dismissed' ? dispositionSetup() : null;
    const { p, fact, ownership } = fixture ?? setup();
    try {
      if (kind === 'active') p.recordManagedOwnership(fact, ownership);
      if (kind === 'released') {
        p.recordManagedOwnership(fact, ownership);
        p.recordManagedOwnership(fact, { ...ownership, ownershipState: 'release_intent', releaseId: 'rel' });
        p.recordManagedOwnership({ ...fact, lastProbeStatus: 'released', cleanupRequired: false }, { ...ownership, ownershipState: 'released', releaseId: 'rel' });
      }
      if (kind === 'user_dismissed') p.dismissRecoveredManagedProcess(fixture!.input);
      const expected = p.getManagedOwnership('h');
      insertOwnershipEvent(p, 'model', 'c', 'turn', { schemaVersion: 1, owner: ownership.owner, requestId: 'request', ownershipState: 'owned' });
      expect(p.getManagedOwnership('h')).toEqual(expected);
      for (const mode of [true, 'recovery'] as const) {
        const errors: string[] = [];
        const [item] = p.listManagedProcesses('/w', { includeOwnership: mode, onOwnershipError: (_h, e: any) => errors.push(e.code) });
        expect(errors).toEqual([]);
        expect(item.ownership).toEqual(expected);
      }
      // A damaged tool record of the same session still fails closed.
      insertOwnershipEvent(p, 'tool', 'c', 'turn', { schemaVersion: 1 });
      expect(() => p.getManagedOwnership('h')).toThrow('A9_MANAGED_OWNERSHIP_CORRUPT');
    } finally { p.db.close(); }
  });

it('a recovered legacy terminal write settles only the adopted identity across SQLite connections', () => {
  const fs = require('fs'); const os = require('os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a9-settle-'));
  const file = path.join(root, 'a9-state.db');
  const open = A9PersistenceManager.open({ databasePath: file, dataRoot: root, openDatabase: (f: string) => new Database(f) as any });
  if (open.status !== 'ready') throw new Error(open.status);
  const p = open.manager; const other = new Database(file);
  try {
    p.createConversation('c', '/w');
    const adopted = { handleId: 'legacy', workspacePath: '/w', pid: 41, command: 'old', cwd: '/w', startedAt: '2026-11-18', lastProbeStatus: 'running' };
    p.recordManagedProcess(adopted);
    // Another connection replaces the same handle row with a new identity.
    other.prepare("UPDATE a9_managed_processes SET pid = 42, started_at = '2026-11-19' WHERE handle_id = 'legacy'").run();
    const terminal = { ...adopted, lastProbeStatus: 'exited', pidReusePossible: false };
    expect(() => p.settleRecoveredManagedProcess(terminal)).toThrow('A9_MANAGED_RECOVERY_STALE');
    expect(other.prepare('SELECT pid, started_at, last_probe_status FROM a9_managed_processes').get())
      .toEqual({ pid: 42, started_at: '2026-11-19', last_probe_status: 'running' });
    expect(p.isManagedSettlementBlocker(p.listManagedProcesses('/w')[0])).toBe(true);
    other.prepare("UPDATE a9_managed_processes SET pid = 41, started_at = '2026-11-18' WHERE handle_id = 'legacy'").run();
    expect(() => p.settleRecoveredManagedProcess({ ...terminal, lastProbeStatus: 'running' })).toThrow('A9_MANAGED_RECOVERY_STALE');
    other.exec("CREATE TRIGGER ignore_settle BEFORE UPDATE ON a9_managed_processes BEGIN SELECT RAISE(IGNORE); END");
    expect(() => p.settleRecoveredManagedProcess(terminal)).toThrow('A9_PERSISTENCE_WRITE_UNCONFIRMED');
    other.exec('DROP TRIGGER ignore_settle');
    p.settleRecoveredManagedProcess(terminal);
    p.settleRecoveredManagedProcess(terminal);
    expect(other.prepare('SELECT pid, last_probe_status FROM a9_managed_processes').get()).toEqual({ pid: 41, last_probe_status: 'exited' });
    expect(p.isManagedSettlementBlocker(p.listManagedProcesses('/w')[0])).toBe(false);
    // Round 10: the idempotent same-status path verifies ownership first. A damaged
    // ownership record committed by another connection fails closed, never succeeds.
    other.prepare(`INSERT INTO a9_events (session_id, turn_id, kind, event_type, payload_json, created_at)
      VALUES ('c', NULL, 'tool', 'managed_process_ownership', ?, '2026-11-19')`)
      .run(JSON.stringify({ handleId: 'legacy', schemaVersion: 2, ownershipState: 'owned' }));
    expect(() => p.settleRecoveredManagedProcess(terminal)).toThrow('A9_MANAGED_OWNERSHIP_CORRUPT');
    expect(other.prepare('SELECT pid, last_probe_status FROM a9_managed_processes').get()).toEqual({ pid: 41, last_probe_status: 'exited' });
  } finally { other.close(); p.db.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

// P1 (round 12): ownership is verified before the terminal UPDATE too, not only on the
// idempotent path. Another connection writes a valid `owned` record for the same identity
// while the row is still `running`: the legacy settle must not overwrite it with `exited`.
it('a recovered legacy settle never overwrites a running row another connection has owned', () => {
  const fs = require('fs'); const os = require('os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a9-settle-owned-'));
  const file = path.join(root, 'a9-state.db');
  const openManager = () => {
    const opened = A9PersistenceManager.open({ databasePath: file, dataRoot: root, openDatabase: (f: string) => new Database(f) as any });
    if (opened.status !== 'ready') throw new Error(opened.status);
    return opened.manager;
  };
  const p = openManager();
  let q: ReturnType<typeof openManager> | undefined;
  try {
    p.createConversation('c', '/w'); p.upsertTask('task', 'c', 'active'); p.upsertTurn('turn', 'task', 'c', 'active');
    const adopted = { handleId: 'legacy', workspacePath: '/w', pid: 41, command: 'old', cwd: '/w', startedAt: '2026-11-18', lastProbeStatus: 'running' };
    p.recordManagedProcess(adopted);
    q = openManager();
    const ownership = { schemaVersion: 1 as const, owner: { workspace: '/w', conversationId: 'c', taskId: 'task', turnId: 'turn', toolCallId: 'call' },
      requestId: 'request', ownershipState: 'owned' as const };
    q.recordManagedOwnership(adopted, ownership);
    expect(q.getManagedOwnership('legacy', '/w')).toEqual(ownership);
    const row = () => q!.db.prepare('SELECT pid, started_at, last_probe_status FROM a9_managed_processes').get();
    expect(row()).toEqual({ pid: 41, started_at: '2026-11-18', last_probe_status: 'running' });
    const terminal = { ...adopted, lastProbeStatus: 'exited', pidReusePossible: false };
    expect(() => p.settleRecoveredManagedProcess(terminal)).toThrow('A9_MANAGED_OWNERSHIP_UNCONFIRMED');
    expect(row()).toEqual({ pid: 41, started_at: '2026-11-18', last_probe_status: 'running' });
    const [listed] = p.listManagedProcesses('/w', { includeOwnership: true });
    expect(listed).toMatchObject({ lastProbeStatus: 'running', ownership: { ownershipState: 'owned' } });
    expect(p.isManagedSettlementBlocker(listed)).toBe(true);
    expect(p.acquireWorkspaceLock('/w', 'me').acquired).toBe(true);
    expect(p.releaseWorkspaceLockIfManagedSettled('/w', 'me', '/w')).toEqual({ released: false, blockers: ['legacy'] });
    expect(q.db.prepare('SELECT count(*) AS n FROM a9_workspace_locks').get()).toEqual({ n: 1 });
  } finally { q?.db.close(); p.db.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

// P1 (round 12): after a legitimate conversation rebinding the original ownership event
// stays in the old workspace while its session points elsewhere. When that original
// record is damaged (schemaVersion), the cross-workspace candidate check must report
// A9_MANAGED_OWNERSHIP_CORRUPT -- never swallow it and treat the handle as legacy.
it.each(['running', 'exited'] as const)(
  'a rebound conversation with a damaged original ownership record fails closed (fact %s)', (status) => {
    const { p, fact, ownership } = setup();
    try {
      const running = { ...fact, cleanupRequired: false };
      p.recordManagedOwnership(running, ownership);
      p.createConversation('other', '/other');
      p.db.prepare("UPDATE a9_sessions SET workspace_path = '/other' WHERE session_id = 'c'").run();
      p.db.prepare(`UPDATE a9_events SET payload_json = json_set(payload_json, '$.schemaVersion', 2)
        WHERE event_type = 'managed_process_ownership'`).run();
      if (status === 'exited') {
        p.db.prepare("UPDATE a9_managed_processes SET last_probe_status = 'exited', pid_reuse_possible = 0 WHERE handle_id = 'h'").run();
      }
      const row = () => p.db.prepare('SELECT pid, started_at, last_probe_status FROM a9_managed_processes').get();
      const before = row();
      expect(() => p.getManagedOwnership('h')).toThrow('A9_MANAGED_OWNERSHIP_CORRUPT');
      expect(() => p.getManagedOwnership('h', '/w')).toThrow('A9_MANAGED_OWNERSHIP_CORRUPT');
      const onError = jest.fn();
      expect(p.listManagedOwnerships(['h'], onError, '/w')).toEqual(new Map());
      expect(onError).toHaveBeenCalledWith('h', expect.objectContaining({ code: 'A9_MANAGED_OWNERSHIP_CORRUPT' }));
      // Pre-checks and the final lock transaction see the damage; a handover of the exact
      // identity cannot exempt it as a legacy handle.
      const errors = jest.fn();
      p.listManagedProcesses('/w', { includeOwnership: 'recovery', onOwnershipError: errors });
      expect(errors).toHaveBeenCalledWith('h', expect.objectContaining({ code: 'A9_MANAGED_OWNERSHIP_CORRUPT' }));
      expect(p.acquireWorkspaceLock('/w', 'me').acquired).toBe(true);
      expect(p.releaseWorkspaceLockIfManagedSettled('/w', 'me', '/w', {
        handedOver: [{ handleId: 'h', pid: fact.pid, startedAt: fact.startedAt }],
      })).toEqual({ released: false, blockers: ['h'] });
      // Neither the terminal UPDATE (running) nor the idempotent success (exited) applies.
      const terminal = { ...running, lastProbeStatus: 'exited', pidReusePossible: false };
      expect(() => p.settleRecoveredManagedProcess(terminal)).toThrow('A9_MANAGED_OWNERSHIP_CORRUPT');
      expect(row()).toEqual(before);
      expect(p.db.prepare('SELECT count(*) AS n FROM a9_workspace_locks').get()).toEqual({ n: 1 });
    } finally { p.db.close(); }
  });

// P1 (round 13): after a real `changeWorkdir` the conversation's session points to the new
// workspace while its ownership record still names the original one. Two trigger paths
// must stay fail-closed in the original workspace across two SQLite connections:
// (1) the record lost its handleId, (2) its owner task no longer exists, (3, round 14)
// the record is truncated JSON (no handleId readable, JSON.parse fails) yet still names /w,
// (4, round 15) the top-level handleId survives but the truncation falls inside the workspace
// path or before the workspace field: the record is this handle's damaged evidence.
it.each([
  ['missing handleId', "UPDATE a9_events SET payload_json = json_remove(payload_json, '$.handleId') WHERE event_type = 'managed_process_ownership'",
    'A9_MANAGED_OWNERSHIP_CORRUPT'],
  ['owner task rewritten', `UPDATE a9_events SET payload_json = json_set(payload_json, '$.owner.taskId', 'missing-task')
    WHERE event_type = 'managed_process_ownership'`, 'A9_MANAGED_OWNER_MISMATCH'],
  ['owner task row deleted', "DELETE FROM a9_tasks WHERE task_id = 'task'", 'A9_MANAGED_OWNER_MISMATCH'],
  ['truncated JSON (last brace lost)', `UPDATE a9_events SET payload_json = substr(payload_json, 1, length(payload_json) - 1)
    WHERE event_type = 'managed_process_ownership'`, 'A9_MANAGED_OWNERSHIP_CORRUPT'],
  ['truncated JSON (owner left open)', `UPDATE a9_events SET payload_json = '{"schemaVersion":1,"handleId":"' || json_extract(payload_json, '$.handleId')
    || '","owner":{"workspace":' || json_quote(json_extract(payload_json, '$.owner.workspace')) WHERE event_type = 'managed_process_ownership'`,
    'A9_MANAGED_OWNERSHIP_CORRUPT'],
  ['truncated JSON (inside workspace path)', `UPDATE a9_events SET payload_json = '{"schemaVersion":1,"handleId":"' || json_extract(payload_json, '$.handleId')
    || '","owner":{"workspace":' || substr(json_quote(json_extract(payload_json, '$.owner.workspace')), 1,
      length(json_quote(json_extract(payload_json, '$.owner.workspace'))) - 2) WHERE event_type = 'managed_process_ownership'`,
    'A9_MANAGED_OWNERSHIP_CORRUPT'],
  ['truncated JSON (before workspace field)', `UPDATE a9_events SET payload_json = '{"schemaVersion":1,"handleId":"' || json_extract(payload_json, '$.handleId')
    || '","owner":{' WHERE event_type = 'managed_process_ownership'`, 'A9_MANAGED_OWNERSHIP_CORRUPT'],
] as const)('a rebound conversation keeps its damaged original ownership fail-closed: %s', (_name, damage, code) => {
  const fs = require('fs'); const os = require('os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a9-rebound-'));
  const file = path.join(root, 'a9-state.db');
  const openManager = () => {
    const opened = A9PersistenceManager.open({ databasePath: file, dataRoot: root, openDatabase: (f: string) => new Database(f) as any });
    if (opened.status !== 'ready') throw new Error(opened.status);
    return opened.manager;
  };
  const p = openManager(); const other = new Database(file);
  try {
    p.createConversation('c', '/w'); p.upsertTask('task', 'c', 'active'); p.upsertTurn('turn', 'task', 'c', 'active');
    const fact = { handleId: 'h', workspacePath: '/w', pid: 345, command: 'safe', cwd: '/w', startedAt: '2026-11-19', lastProbeStatus: 'stopped' };
    const ownership = { schemaVersion: 1 as const, owner: { workspace: '/w', conversationId: 'c', taskId: 'task', turnId: 'turn', toolCallId: 'call' },
      requestId: 'request', ownershipState: 'owned' as const };
    p.recordManagedOwnership(fact, ownership);
    p.upsertTurn('turn', 'task', 'c', 'completed'); p.upsertTask('task', 'c', 'completed');
    p.changeWorkdir('c', '/w', '/w2', false);
    expect(p.listConversations('/w2').map(item => item.sessionId)).toEqual(['c']);
    // Another connection damages the original record and owns a running identity again.
    other.exec(damage);
    other.prepare("UPDATE a9_managed_processes SET last_probe_status = 'running' WHERE handle_id = 'h'").run();
    const row = () => other.prepare('SELECT pid, started_at, last_probe_status FROM a9_managed_processes').get();
    const before = row();
    expect(() => p.getManagedOwnership('h')).toThrow(code);
    expect(() => p.getManagedOwnership('h', '/w')).toThrow(code);
    const onError = jest.fn();
    expect(p.listManagedOwnerships(['h'], onError, '/w')).toEqual(new Map());
    expect(onError).toHaveBeenCalledWith('h', expect.objectContaining({ code }));
    const errors = jest.fn();
    const [listed] = p.listManagedProcesses('/w', { includeOwnership: 'recovery', onOwnershipError: errors });
    expect(errors).toHaveBeenCalledWith('h', expect.objectContaining({ code }));
    expect(listed).toMatchObject({ lastProbeStatus: 'running', cleanupRequired: true });
    expect(p.isManagedSettlementBlocker(listed)).toBe(true);
    // The legacy settle can neither write `exited` nor succeed; a handover cannot exempt it.
    expect(() => p.settleRecoveredManagedProcess({ ...fact, lastProbeStatus: 'exited', pidReusePossible: false })).toThrow(code);
    expect(row()).toEqual(before);
    expect(p.acquireWorkspaceLock('/w', 'me').acquired).toBe(true);
    const q = openManager();
    try {
      expect(q.releaseWorkspaceLockIfManagedSettled('/w', 'me', '/w', {
        handedOver: [{ handleId: 'h', pid: fact.pid, startedAt: fact.startedAt }],
      })).toEqual({ released: false, blockers: ['h'] });
    } finally { q.db.close(); }
    expect(other.prepare('SELECT count(*) AS n FROM a9_workspace_locks').get()).toEqual({ n: 1 });
    expect(row()).toEqual(before);
  } finally { other.close(); p.db.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

// P1 (round 16): the handle's history holds an older truncated ownership record followed by
// complete records (a later copy of the owned record, then the release chain for `released`).
// After a real `changeWorkdir` the stable-history fallback must not skip that older damage:
// the original workspace reports A9_MANAGED_OWNERSHIP_CORRUPT and the final lock check keeps
// the lock for both terminal statuses.
it.each([
  ['stopped', 'truncated JSON (last brace lost)', `substr(payload_json, 1, length(payload_json) - 1)`],
  ['stopped', 'truncated JSON (before workspace field)',
    `'{"schemaVersion":1,"handleId":"' || json_extract(payload_json, '$.handleId') || '","owner":{'`],
  ['released', 'truncated JSON (last brace lost)', `substr(payload_json, 1, length(payload_json) - 1)`],
  ['released', 'truncated JSON (before workspace field)',
    `'{"schemaVersion":1,"handleId":"' || json_extract(payload_json, '$.handleId') || '","owner":{'`],
  // Round 17 (P1): the cut falls right after the handleId characters, before its closing quote.
  ['stopped', 'truncated JSON (handleId closing quote lost)',
    `'{"schemaVersion":1,"handleId":"' || json_extract(payload_json, '$.handleId')`],
  ['released', 'truncated JSON (handleId closing quote lost)',
    `'{"schemaVersion":1,"handleId":"' || json_extract(payload_json, '$.handleId')`],
] as const)('an older truncated ownership record before complete records keeps a %s fact fail-closed after changeWorkdir (%s)',
  (status, _name, truncated) => {
    const fs = require('fs'); const os = require('os');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a9-older-damage-'));
    const file = path.join(root, 'a9-state.db');
    const openManager = () => {
      const opened = A9PersistenceManager.open({ databasePath: file, dataRoot: root, openDatabase: (f: string) => new Database(f) as any });
      if (opened.status !== 'ready') throw new Error(opened.status);
      return opened.manager;
    };
    const p = openManager(); const other = new Database(file);
    try {
      p.createConversation('c', '/w'); p.upsertTask('task', 'c', 'active'); p.upsertTurn('turn', 'task', 'c', 'active');
      const fact = { handleId: 'h', workspacePath: '/w', pid: 345, command: 'safe', cwd: '/w', startedAt: '2026-11-19', lastProbeStatus: 'running' };
      const ownership = { schemaVersion: 1 as const, owner: { workspace: '/w', conversationId: 'c', taskId: 'task', turnId: 'turn', toolCallId: 'call' },
        requestId: 'request', ownershipState: 'owned' as const };
      p.recordManagedOwnership(fact, ownership);
      // A later complete copy of the owned record: the history goes on past the damage.
      p.db.prepare(`INSERT INTO a9_events (session_id, turn_id, kind, event_type, payload_json, created_at)
        SELECT session_id, turn_id, kind, event_type, payload_json, created_at FROM a9_events
        WHERE event_type = 'managed_process_ownership'`).run();
      if (status === 'released') {
        p.recordManagedOwnership(fact, { ...ownership, ownershipState: 'release_intent', releaseId: 'rel' });
        p.recordManagedOwnership({ ...fact, lastProbeStatus: 'released' }, { ...ownership, ownershipState: 'released', releaseId: 'rel' });
      } else {
        p.recordManagedOwnership({ ...fact, lastProbeStatus: 'stopped' }, ownership);
      }
      p.upsertTurn('turn', 'task', 'c', 'completed'); p.upsertTask('task', 'c', 'completed');
      // Before the damage both statuses are settled in the original workspace.
      expect(p.listManagedProcesses('/w', { includeOwnership: true })[0]).toMatchObject({ lastProbeStatus: status, cleanupRequired: false });
      p.changeWorkdir('c', '/w', '/w2', false);
      expect(p.listConversations('/w2').map(item => item.sessionId)).toEqual(['c']);
      // Another connection truncates only the oldest ownership record of the handle.
      other.exec(`UPDATE a9_events SET payload_json = ${truncated} WHERE id = (SELECT min(id) FROM a9_events
        WHERE event_type = 'managed_process_ownership')`);
      const ownershipEvents = other.prepare(`SELECT json_valid(payload_json) AS valid FROM a9_events
        WHERE event_type = 'managed_process_ownership' ORDER BY id`).all() as Array<{ valid: number }>;
      expect(ownershipEvents.map(event => event.valid)).toEqual(status === 'released' ? [0, 1, 1, 1] : [0, 1]);
      const row = () => other.prepare('SELECT pid, started_at, last_probe_status FROM a9_managed_processes').get();
      const before = row();
      for (const includeOwnership of [true, 'recovery'] as const) {
        const errors = jest.fn();
        const [listed] = p.listManagedProcesses('/w', { includeOwnership, onOwnershipError: errors });
        expect(errors).toHaveBeenCalledWith('h', expect.objectContaining({ code: 'A9_MANAGED_OWNERSHIP_CORRUPT' }));
        expect(listed.ownership).toBeUndefined();
        expect(() => p.listManagedProcesses('/w', { includeOwnership })).toThrow('A9_MANAGED_OWNERSHIP_CORRUPT');
      }
      expect(p.acquireWorkspaceLock('/w', 'me').acquired).toBe(true);
      const q = openManager();
      try {
        expect(q.releaseWorkspaceLockIfManagedSettled('/w', 'me', '/w')).toEqual({ released: false, blockers: ['h'] });
        expect(q.releaseWorkspaceLockIfManagedSettled('/w', 'me', '/w', {
          handedOver: [{ handleId: 'h', pid: fact.pid, startedAt: fact.startedAt }],
        })).toEqual({ released: false, blockers: ['h'] });
      } finally { q.db.close(); }
      expect(other.prepare('SELECT count(*) AS n FROM a9_workspace_locks').get()).toEqual({ n: 1 });
      expect(row()).toEqual(before);
    } finally { other.close(); p.db.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });

// P1 (round 17): the original owner `c1` is rebound to another workspace and its oldest
// ownership record is truncated; another conversation `c2` of the original workspace then
// writes a complete `owned` record for the same handle. That later record of another session
// must not shadow c1's damaged history: the stopped fact reports A9_MANAGED_OWNERSHIP_CORRUPT
// and the final lock check keeps the lock.
// P1 (round 18): recordManagedOwnership deduplicates an unchanged `owned` record, so in the
// real flow c1 has exactly one ownership record; that single damaged record is covered too
// (no hand-inserted duplicate), next to the multi-record history.
// P1 (round 19): c1's only record cut before its handleId (or before the value's first
// character) names neither the handle nor the workspace; it still fails closed for stopped
// and exited facts, because c1 was rebound from the fact's workspace.
const shadowTruncations = [
  ['opening brace only', `'{'`],
  ['handleId key only', `'{"handleId":"'`],
  ['handleId closing quote lost', `'{"schemaVersion":1,"handleId":"' || json_extract(payload_json, '$.handleId')`],
  ['before workspace field', `'{"schemaVersion":1,"handleId":"' || json_extract(payload_json, '$.handleId') || '","owner":{'`],
  ['last brace lost', `substr(payload_json, 1, length(payload_json) - 1)`],
] as const;
it.each(shadowTruncations.flatMap(([name, truncated]) => (['stopped', 'exited'] as const).flatMap(status => [
  [`${status}, ${name}, single c1 record`, truncated, false, status],
  [`${status}, ${name}, duplicated c1 record`, truncated, true, status],
] as const)))('a complete owned record of another conversation does not shadow the older damaged history of a terminal fact (%s)',
  (_name, truncated, duplicated, status) => {
    const fs = require('fs'); const os = require('os');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a9-shadowed-damage-'));
    const file = path.join(root, 'a9-state.db');
    const openManager = () => {
      const opened = A9PersistenceManager.open({ databasePath: file, dataRoot: root, openDatabase: (f: string) => new Database(f) as any });
      if (opened.status !== 'ready') throw new Error(opened.status);
      return opened.manager;
    };
    const p = openManager(); const other = new Database(file);
    try {
      p.createConversation('c1', '/w'); p.upsertTask('task', 'c1', 'active'); p.upsertTurn('turn', 'task', 'c1', 'active');
      const fact = { handleId: 'h', workspacePath: '/w', pid: 345, command: 'safe', cwd: '/w', startedAt: '2026-11-19', lastProbeStatus: 'running' };
      const ownership = { schemaVersion: 1 as const, owner: { workspace: '/w', conversationId: 'c1', taskId: 'task', turnId: 'turn', toolCallId: 'call' },
        requestId: 'request', ownershipState: 'owned' as const };
      p.recordManagedOwnership(fact, ownership);
      if (duplicated) {
        p.db.prepare(`INSERT INTO a9_events (session_id, turn_id, kind, event_type, payload_json, created_at)
          SELECT session_id, turn_id, kind, event_type, payload_json, created_at FROM a9_events
          WHERE event_type = 'managed_process_ownership'`).run();
      }
      p.recordManagedOwnership({ ...fact, lastProbeStatus: status }, ownership);
      p.upsertTurn('turn', 'task', 'c1', 'completed'); p.upsertTask('task', 'c1', 'completed');
      expect(p.listManagedProcesses('/w', { includeOwnership: true })[0]).toMatchObject({ lastProbeStatus: status, cleanupRequired: false });
      p.changeWorkdir('c1', '/w', '/w2', false);
      expect(p.listConversations('/w2').map(item => item.sessionId)).toEqual(['c1']);
      // Another conversation of the original workspace writes a complete owned record of h.
      p.createConversation('c2', '/w'); p.upsertTask('task2', 'c2', 'completed'); p.upsertTurn('turn2', 'task2', 'c2', 'completed');
      p.recordToolEvent('c2', 'turn2', 'managed_process_ownership', { ...ownership, handleId: 'h',
        owner: { workspace: '/w', conversationId: 'c2', taskId: 'task2', turnId: 'turn2', toolCallId: 'call2' } });
      // Another connection truncates only c1's oldest ownership record.
      other.exec(`UPDATE a9_events SET payload_json = ${truncated} WHERE id = (SELECT min(id) FROM a9_events
        WHERE event_type = 'managed_process_ownership')`);
      const events = other.prepare(`SELECT session_id, json_valid(payload_json) AS valid FROM a9_events
        WHERE event_type = 'managed_process_ownership' ORDER BY id`).all();
      expect(events).toEqual([{ session_id: 'c1', valid: 0 }, ...(duplicated ? [{ session_id: 'c1', valid: 1 }] : []),
        { session_id: 'c2', valid: 1 }]);
      const row = () => other.prepare('SELECT pid, started_at, last_probe_status FROM a9_managed_processes').get();
      const before = row();
      const onError = jest.fn();
      expect(p.listManagedOwnerships(['h'], onError, '/w')).toEqual(new Map());
      expect(onError).toHaveBeenCalledWith('h', expect.objectContaining({ code: 'A9_MANAGED_OWNERSHIP_CORRUPT' }));
      for (const includeOwnership of [true, 'recovery'] as const) {
        const errors = jest.fn();
        const [listed] = p.listManagedProcesses('/w', { includeOwnership, onOwnershipError: errors });
        expect(errors).toHaveBeenCalledTimes(1);
        expect(errors).toHaveBeenCalledWith('h', expect.objectContaining({ code: 'A9_MANAGED_OWNERSHIP_CORRUPT' }));
        expect(listed.ownership).toBeUndefined();
        expect(() => p.listManagedProcesses('/w', { includeOwnership })).toThrow('A9_MANAGED_OWNERSHIP_CORRUPT');
      }
      expect(p.acquireWorkspaceLock('/w', 'me').acquired).toBe(true);
      const q = openManager();
      try {
        expect(q.releaseWorkspaceLockIfManagedSettled('/w', 'me', '/w')).toEqual({ released: false, blockers: ['h'] });
        expect(q.releaseWorkspaceLockIfManagedSettled('/w', 'me', '/w', {
          handedOver: [{ handleId: 'h', pid: fact.pid, startedAt: fact.startedAt }],
        })).toEqual({ released: false, blockers: ['h'] });
      } finally { q.db.close(); }
      expect(other.prepare('SELECT count(*) AS n FROM a9_workspace_locks').get()).toEqual({ n: 1 });
      expect(row()).toEqual(before);
    } finally { other.close(); p.db.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });

// P1 (round 20): workspace bindings are kept as ordered event-id segments
// (`workdir.workspaceHistory`), so an unattributable record is damage of the workspace its
// conversation was bound to when the record was written -- not of its current or last binding.
function openFileManager(prefix: string) {
  const fs = require('fs'); const os = require('os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const file = path.join(root, 'a9-state.db');
  const openManager = () => {
    const opened = A9PersistenceManager.open({ databasePath: file, dataRoot: root, openDatabase: (f: string) => new Database(f) as any });
    if (opened.status !== 'ready') throw new Error(opened.status);
    return opened.manager;
  };
  return { openManager, other: () => new Database(file), cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
const workspaceHistory = (p: A9PersistenceManager, sessionId: string) =>
  (p.getConversationMetadata(sessionId).workdir as { workspaceHistory?: unknown } | undefined)?.workspaceHistory;

// (1) c1 is rebound A -> B -> C (or renamed in place first, then rebound) and its only record of
// A is cut early; a later complete owned record of c2 in A never shadows that damage.
const rebindPaths = [
  ['A -> B -> C', (p: A9PersistenceManager) => {
    p.changeWorkdir('c1', '/w', '/w2', false); p.changeWorkdir('c1', '/w2', '/w3', false);
    return '/w3';
  }],
  ['rename A -> A2, then link A2 -> B', (p: A9PersistenceManager) => {
    p.changeWorkdir('c1', '/w', '/w-renamed', true); p.changeWorkdir('c1', '/w-renamed', '/w2', false);
    return '/w2';
  }],
  ['rename A -> A2 only', (p: A9PersistenceManager) => {
    p.changeWorkdir('c1', '/w', '/w-renamed', true);
    return '/w-renamed';
  }],
] as const;
it.each(rebindPaths.flatMap(([route, rebind]) => (['stopped', 'exited'] as const).flatMap(status =>
  ([['opening brace only', `'{'`], ['handleId key only', `'{"handleId":"'`]] as const).map(([name, truncated]) =>
    [`${route}, ${status}, ${name}`, rebind, status, truncated] as const))))(
  'round 20: repeated rebinds and renames keep the original workspace of a single early-truncated record (%s)',
  (_name, rebind, status, truncated) => {
    const env = openFileManager('a9-rebind-history-');
    const p = env.openManager(); const other = env.other();
    try {
      p.createConversation('c1', '/w'); p.upsertTask('task', 'c1', 'active'); p.upsertTurn('turn', 'task', 'c1', 'active');
      const fact = { handleId: 'h', workspacePath: '/w', pid: 345, command: 'safe', cwd: '/w', startedAt: '2026-11-19', lastProbeStatus: 'running' };
      const ownership = { schemaVersion: 1 as const, owner: { workspace: '/w', conversationId: 'c1', taskId: 'task', turnId: 'turn', toolCallId: 'call' },
        requestId: 'request', ownershipState: 'owned' as const };
      p.recordManagedOwnership(fact, ownership);
      p.recordManagedOwnership({ ...fact, lastProbeStatus: status }, ownership);
      p.upsertTurn('turn', 'task', 'c1', 'completed'); p.upsertTask('task', 'c1', 'completed');
      const original = (p.db.prepare("SELECT max(id) AS id FROM a9_events").get() as { id: number }).id;
      const current = rebind(p);
      expect(p.listConversations(current).map(item => item.sessionId)).toEqual(['c1']);
      // The first segment is A, bounded by the newest event at the first change.
      expect((workspaceHistory(p, 'c1') as any[])[0]).toMatchObject({ workspace: '/w', maxEventId: original });
      // Another conversation of the original workspace writes a complete owned record of h.
      p.createConversation('c2', '/w'); p.upsertTask('task2', 'c2', 'completed'); p.upsertTurn('turn2', 'task2', 'c2', 'completed');
      p.recordToolEvent('c2', 'turn2', 'managed_process_ownership', { ...ownership, handleId: 'h',
        owner: { workspace: '/w', conversationId: 'c2', taskId: 'task2', turnId: 'turn2', toolCallId: 'call2' } });
      other.exec(`UPDATE a9_events SET payload_json = ${truncated} WHERE id = (SELECT min(id) FROM a9_events
        WHERE event_type = 'managed_process_ownership')`);
      expect(other.prepare(`SELECT session_id, json_valid(payload_json) AS valid FROM a9_events
        WHERE event_type = 'managed_process_ownership' ORDER BY id`).all()).toEqual([{ session_id: 'c1', valid: 0 }, { session_id: 'c2', valid: 1 }]);
      const row = () => other.prepare('SELECT pid, started_at, last_probe_status FROM a9_managed_processes').get();
      const before = row();
      const onError = jest.fn();
      expect(p.listManagedOwnerships(['h'], onError, '/w')).toEqual(new Map());
      expect(onError).toHaveBeenCalledWith('h', expect.objectContaining({ code: 'A9_MANAGED_OWNERSHIP_CORRUPT' }));
      for (const includeOwnership of [true, 'recovery'] as const) {
        const errors = jest.fn();
        const [listed] = p.listManagedProcesses('/w', { includeOwnership, onOwnershipError: errors });
        expect(errors).toHaveBeenCalledTimes(1);
        expect(errors).toHaveBeenCalledWith('h', expect.objectContaining({ code: 'A9_MANAGED_OWNERSHIP_CORRUPT' }));
        expect(listed.ownership).toBeUndefined();
        expect(() => p.listManagedProcesses('/w', { includeOwnership })).toThrow('A9_MANAGED_OWNERSHIP_CORRUPT');
      }
      expect(p.acquireWorkspaceLock('/w', 'me').acquired).toBe(true);
      const q = env.openManager();
      try {
        expect(q.releaseWorkspaceLockIfManagedSettled('/w', 'me', '/w')).toEqual({ released: false, blockers: ['h'] });
      } finally { q.db.close(); }
      expect(other.prepare('SELECT count(*) AS n FROM a9_workspace_locks').get()).toEqual({ n: 1 });
      expect(row()).toEqual(before);
    } finally { other.close(); p.db.close(); env.cleanup(); }
  });

it('round 20: changeWorkdir records ordered segments across rebinds and renames', () => {
  const { p } = setup();
  try {
    p.upsertTurn('turn', 'task', 'c', 'completed'); p.upsertTask('task', 'c', 'completed');
    p.recordModelEvent('c', 'turn', 'note', { n: 1 });
    p.changeWorkdir('c', '/w', '/w2', false);
    p.recordModelEvent('c', 'turn', 'note', { n: 2 });
    p.changeWorkdir('c', '/w2', '/w2-renamed', true);
    p.recordModelEvent('c', 'turn', 'note', { n: 3 });
    p.changeWorkdir('c', '/w2-renamed', '/w3', false);
    expect(workspaceHistory(p, 'c')).toEqual([
      { workspace: '/w', maxEventId: 1 },
      { workspace: '/w2', renamedTo: '/w2-renamed', maxEventId: 2 },
      { workspace: '/w2-renamed', maxEventId: 3 },
    ]);
    expect(p.getConversationMetadata('c').workdir).toMatchObject({ origin: 'linked', previousWorkspace: '/w2-renamed' });
    // Renaming A2 later notes the new name on every segment that names it, also of moved-away conversations.
    p.createConversation('d', '/w2-renamed');
    p.mergeConversationMetadata('d', { workdir: { version: 1, origin: 'auto', createdAt: null } });
    p.changeWorkdir('d', '/w2-renamed', '/w2-final', true);
    expect(workspaceHistory(p, 'c')).toEqual([
      { workspace: '/w', maxEventId: 1 },
      { workspace: '/w2', renamedTo: '/w2-final', maxEventId: 2 },
      { workspace: '/w2-renamed', renamedTo: '/w2-final', maxEventId: 3 },
    ]);
    expect(p.getConversationMetadata('d').workdir).toEqual({ version: 1, origin: 'auto', createdAt: null,
      workspaceHistory: [{ workspace: '/w2-renamed', renamedTo: '/w2-final', maxEventId: 3 }] });
    // A damaged history of the conversation being rebound refuses the change instead of losing A.
    p.mergeConversationMetadata('c', { workdir: { version: 1, origin: 'linked', createdAt: null, workspaceHistory: [{ workspace: '/w' }] } });
    expect(() => p.changeWorkdir('c', '/w3', '/w4', false)).toThrow('A9_WORKDIR_HISTORY_CORRUPT');
    expect(p.listConversations('/w3').map(item => item.sessionId)).toEqual(['c']);
  } finally { p.db.close(); }
});

// (2) c1 is rebound A -> B and writes an ownership record of its new handle hB in B, which is
// truncated. A healthy handle hA of c2 in A is not blocked by that damage of B, whether hA's
// history is older or newer than it; hB itself stays fail-closed in B.
it.each((['stopped', 'exited', 'released'] as const).flatMap(status => (['before', 'after'] as const).flatMap(order =>
  ([['opening brace only', `'{'`], ['handleId key only', `'{"handleId":"'`]] as const).map(([name, truncated]) =>
    [`${status}, hA written ${order} the damage, ${name}`, status, order, truncated] as const))))(
  'round 20: a damaged record written in the new workspace never blocks a healthy handle of the old one (%s)',
  (_name, status, order, truncated) => {
    const env = openFileManager('a9-new-workspace-damage-');
    const p = env.openManager(); const other = env.other();
    try {
      p.createConversation('c1', '/w'); p.upsertTask('task1', 'c1', 'completed'); p.upsertTurn('turn1', 'task1', 'c1', 'completed');
      p.createConversation('c2', '/w');
      const healthy = () => {
        p.upsertTask('task2', 'c2', 'active'); p.upsertTurn('turn2', 'task2', 'c2', 'active');
        const fact = { handleId: 'hA', workspacePath: '/w', pid: 345, command: 'safe', cwd: '/w', startedAt: '2026-11-19', lastProbeStatus: 'running' };
        const ownership = { schemaVersion: 1 as const, owner: { workspace: '/w', conversationId: 'c2', taskId: 'task2', turnId: 'turn2', toolCallId: 'call2' },
          requestId: 'request-a', ownershipState: 'owned' as const };
        if (status === 'released') recordRelease(p, fact, ownership);
        else { p.recordManagedOwnership(fact, ownership); p.recordManagedOwnership({ ...fact, lastProbeStatus: status }, ownership); }
        p.upsertTurn('turn2', 'task2', 'c2', 'completed'); p.upsertTask('task2', 'c2', 'completed');
      };
      if (order === 'before') healthy();
      p.changeWorkdir('c1', '/w', '/w2', false);
      p.upsertTask('task1b', 'c1', 'active'); p.upsertTurn('turn1b', 'task1b', 'c1', 'active');
      const factB = { handleId: 'hB', workspacePath: '/w2', pid: 346, command: 'safe', cwd: '/w2', startedAt: '2026-11-19', lastProbeStatus: 'running' };
      const { eventId: damagedId } = p.recordToolEvent('c1', 'turn1b', 'managed_process_ownership', { handleId: 'hB', schemaVersion: 1,
        owner: { workspace: '/w2', conversationId: 'c1', taskId: 'task1b', turnId: 'turn1b', toolCallId: 'call1b' }, requestId: 'request-b', ownershipState: 'owned' });
      p.recordManagedProcess({ ...factB, cleanupRequired: true });
      p.upsertTurn('turn1b', 'task1b', 'c1', 'completed'); p.upsertTask('task1b', 'c1', 'completed');
      if (order === 'after') healthy();
      other.prepare(`UPDATE a9_events SET payload_json = ${truncated} WHERE id = ?`).run(damagedId);
      expect((other.prepare('SELECT json_valid(payload_json) AS valid FROM a9_events WHERE id = ?').get(damagedId) as any).valid).toBe(0);
      // The old workspace reads hA normally in every mode and releases its lock.
      for (const includeOwnership of [true, 'recovery'] as const) {
        const errors = jest.fn();
        const listed = p.listManagedProcesses('/w', { includeOwnership, onOwnershipError: errors });
        expect(errors).not.toHaveBeenCalled();
        expect(listed.map(item => [item.handleId, item.lastProbeStatus, item.cleanupRequired])).toEqual([['hA', status, false]]);
      }
      expect(() => p.listManagedProcesses('/w')).not.toThrow();
      expect(p.getManagedOwnership('hA', '/w')).toMatchObject({ owner: { conversationId: 'c2' } });
      expect(lockOutcome(p)).toEqual({ released: true, blockers: [] });
      // The damage stays damage of the workspace it was written in.
      const errorsB = jest.fn();
      const [listedB] = p.listManagedProcesses('/w2', { includeOwnership: 'recovery', onOwnershipError: errorsB });
      expect(errorsB).toHaveBeenCalledWith('hB', expect.objectContaining({ code: 'A9_MANAGED_OWNERSHIP_CORRUPT' }));
      expect(listedB).toMatchObject({ handleId: 'hB', cleanupRequired: true });
    } finally { other.close(); p.db.close(); env.cleanup(); }
  });

// P1 (round 21): (1) the same conversation c1 owns hA in A, is rebound elsewhere and writes a
// record of a new handle hB that is truncated with no readable handle. That anonymous record
// was written outside A, so it is never damage of hA's history in A (newer than it, of the
// anchor's own conversation): A reads hA normally and leaves. A record of the same kind
// written while c1 is still bound to A keeps A fail-closed (control).
const sameSessionRoutes = [
  ['A -> B', (p: A9PersistenceManager) => { p.changeWorkdir('c1', '/w', '/w2', false); }, 'outside'],
  ['A -> B -> C -> D', (p: A9PersistenceManager) => {
    p.changeWorkdir('c1', '/w', '/w2', false); p.changeWorkdir('c1', '/w2', '/w3', false); p.changeWorkdir('c1', '/w3', '/w4', false);
  }, 'outside'],
  ['A -> B, damage in B, then B -> A', (p: A9PersistenceManager) => { p.changeWorkdir('c1', '/w', '/w2', false); }, 'outside-then-back'],
  ['no rebind (control)', (_p: A9PersistenceManager) => undefined, 'inside'],
] as const;
it.each(sameSessionRoutes.flatMap(([route, rebind, where]) => (['stopped', 'released'] as const).flatMap(status =>
  ([['opening brace only', `'{'`], ['handleId key only', `'{"handleId":"'`]] as const).map(([name, truncated]) =>
    [`${route}, ${status}, ${name}`, rebind, where, status, truncated] as const))))(
  'round 21: a damaged record of the same conversation written in another workspace never blocks its handle of the old one (%s)',
  (_name, rebind, where, status, truncated) => {
    const env = openFileManager('a9-same-session-damage-');
    const p = env.openManager(); const other = env.other();
    try {
      p.createConversation('c1', '/w'); p.upsertTask('task1', 'c1', 'active'); p.upsertTurn('turn1', 'task1', 'c1', 'active');
      const fact = { handleId: 'hA', workspacePath: '/w', pid: 345, command: 'safe', cwd: '/w', startedAt: '2026-11-19', lastProbeStatus: 'running' };
      const ownership = { schemaVersion: 1 as const, owner: { workspace: '/w', conversationId: 'c1', taskId: 'task1', turnId: 'turn1', toolCallId: 'call1' },
        requestId: 'request-a', ownershipState: 'owned' as const };
      if (status === 'released') recordRelease(p, fact, ownership);
      else { p.recordManagedOwnership(fact, ownership); p.recordManagedOwnership({ ...fact, lastProbeStatus: status }, ownership); }
      p.upsertTurn('turn1', 'task1', 'c1', 'completed'); p.upsertTask('task1', 'c1', 'completed');
      rebind(p);
      const workspaceB = where === 'inside' ? '/w' : (p.listConversations('/w4').length ? '/w4' : '/w2');
      p.upsertTask('task1b', 'c1', 'active'); p.upsertTurn('turn1b', 'task1b', 'c1', 'active');
      const { eventId: damagedId } = p.recordToolEvent('c1', 'turn1b', 'managed_process_ownership', { handleId: 'hB', schemaVersion: 1,
        owner: { workspace: workspaceB, conversationId: 'c1', taskId: 'task1b', turnId: 'turn1b', toolCallId: 'call1b' }, requestId: 'request-b', ownershipState: 'owned' });
      p.recordManagedProcess({ handleId: 'hB', workspacePath: workspaceB, pid: 346, command: 'safe', cwd: workspaceB,
        startedAt: '2026-11-19', ...(where === 'outside-then-back'
          ? { lastProbeStatus: 'stopped', cleanupRequired: false } : { lastProbeStatus: 'running', cleanupRequired: true }) });
      p.upsertTurn('turn1b', 'task1b', 'c1', 'completed'); p.upsertTask('task1b', 'c1', 'completed');
      // Returning to A needs hB settled; later records of c1 in A would be A's again.
      if (where === 'outside-then-back') p.changeWorkdir('c1', '/w2', '/w', false);
      other.prepare(`UPDATE a9_events SET payload_json = ${truncated} WHERE id = ?`).run(damagedId);
      expect((other.prepare('SELECT json_valid(payload_json) AS valid FROM a9_events WHERE id = ?').get(damagedId) as any).valid).toBe(0);
      const ownershipState = status === 'released' ? 'released' : 'owned';
      for (const includeOwnership of [true, 'recovery'] as const) {
        const errors = jest.fn();
        const listed = p.listManagedProcesses('/w', { includeOwnership, onOwnershipError: errors }).filter(item => item.handleId === 'hA');
        if (where === 'inside') {
          expect(errors).toHaveBeenCalledWith('hA', expect.objectContaining({ code: 'A9_MANAGED_OWNERSHIP_CORRUPT' }));
          expect(listed[0].ownership).toBeUndefined();
        } else {
          expect(errors).not.toHaveBeenCalled();
          expect(listed.map(item => [item.lastProbeStatus, item.cleanupRequired, item.ownership?.ownershipState]))
            .toEqual([[status, false, ownershipState]]);
        }
      }
      if (where === 'inside') {
        expect(lockOutcome(p)).toEqual({ released: false, blockers: expect.arrayContaining(['hA']) });
        expect(other.prepare('SELECT count(*) AS n FROM a9_workspace_locks').get()).toEqual({ n: 1 });
        return;
      }
      expect(() => p.listManagedProcesses('/w', { includeOwnership: true })).not.toThrow();
      expect(lockOutcome(p)).toEqual({ released: true, blockers: [] });
      expect(other.prepare('SELECT count(*) AS n FROM a9_workspace_locks').get()).toEqual({ n: 0 });
      // The damage stays damage of the workspace it was written in.
      const errorsB = jest.fn();
      const [listedB] = p.listManagedProcesses(workspaceB, { includeOwnership: 'recovery', onOwnershipError: errorsB });
      expect(errorsB).toHaveBeenCalledWith('hB', expect.objectContaining({ code: 'A9_MANAGED_OWNERSHIP_CORRUPT' }));
      expect(listedB).toMatchObject({ handleId: 'hB', cleanupRequired: where !== 'outside-then-back' });
    } finally { other.close(); p.db.close(); env.cleanup(); }
  });

// P1 (round 21): (2) retention may delete the newest events, lowering MAX(id). Segment bounds
// follow the AUTOINCREMENT high-water mark and never fall below the previous segment, so later
// rebinds and renames keep a monotonic history instead of refusing with HISTORY_CORRUPT.
it.each([false, true])('round 21: segment bounds stay monotonic after retention purges the newest events (rename %s)', (rename) => {
  const env = openFileManager('a9-retention-bounds-');
  const p = env.openManager(); const other = env.other();
  try {
    p.createConversation('c1', '/w'); p.upsertTask('task', 'c1', 'completed'); p.upsertTurn('turn', 'task', 'c1', 'completed');
    const first = p.recordModelEvent('c1', 'turn', 'note', { n: 1 }).eventId;
    const removable = p.recordModelEvent('c1', null, 'removable', { n: 2 }).eventId;
    p.changeWorkdir('c1', '/w', '/w2', false);
    other.prepare('UPDATE a9_events SET created_at = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', removable);
    expect(p.enforceRetention().purgedEvents).toBe(1);
    expect((other.prepare('SELECT max(id) AS m FROM a9_events').get() as any).m).toBe(first);
    p.changeWorkdir('c1', '/w2', '/w3', rename);
    expect(() => p.changeWorkdir('c1', '/w3', '/w4', false)).not.toThrow();
    expect(p.listConversations('/w4').map(item => item.sessionId)).toEqual(['c1']);
    const bounds = (workspaceHistory(p, 'c1') as Array<{ maxEventId: number }>).map(entry => entry.maxEventId);
    expect(bounds).toEqual([removable, removable, removable]);
    // A new event lies above every bound, so it belongs to the current binding.
    const next = p.recordModelEvent('c1', 'turn', 'note', { n: 3 }).eventId;
    expect(next).toBeGreaterThan(removable);
    // Even a lowered sqlite_sequence (never done by DELETE) cannot pull a bound below the last segment.
    other.prepare("UPDATE sqlite_sequence SET seq = 1 WHERE name = 'a9_events'").run();
    other.prepare('DELETE FROM a9_events WHERE id > ?').run(first);
    p.changeWorkdir('c1', '/w4', '/w5', false);
    expect((workspaceHistory(p, 'c1') as Array<{ maxEventId: number }>).map(entry => entry.maxEventId))
      .toEqual([removable, removable, removable, removable]);
    expect(() => p.changeWorkdir('c1', '/w5', '/w6', false)).not.toThrow();
  } finally { other.close(); p.db.close(); env.cleanup(); }
});

// P1 (round 22): c1 owns hA in A and, still in A, records and stops hB. c1 is then rebound to B
// by a legacy build (`workdir.origin: 'linked'` without segments or previousWorkspace), or its
// session metadata is lost/damaged, and the record of hB written in A is truncated. Nothing proves
// that record was written outside A, so it stays damage of hA's history in A: the read fails
// closed (A9_MANAGED_OWNERSHIP_CORRUPT) and the lock is kept. Only well-formed segments proving
// the record was written elsewhere exclude it (round 21, above).
const legacyRebinds = [
  ['legacy linked metadata', JSON.stringify({ workdir: { version: 1, origin: 'linked', createdAt: null } })],
  ['metadata without workdir', '{}'],
  ['damaged metadata_json', '{'],
  ['empty workspaceHistory segments', JSON.stringify({ workdir: { version: 1, origin: 'linked', createdAt: null, workspaceHistory: [] } })],
] as const;
it.each(legacyRebinds.flatMap(([route, metadata]) => (['stopped', 'released'] as const).flatMap(status =>
  (['written in A, then rebound', 'written in B after the rebind'] as const).flatMap(where =>
    ([['opening brace only', `'{'`], ['handleId key only', `'{"handleId":"'`]] as const).map(([name, truncated]) =>
      [`${route}, ${status}, ${where}, ${name}`, metadata, status, where, truncated] as const)))))(
  'round 22: without segments proving otherwise, a damaged record of the anchor conversation stays damage of A (%s)',
  (_name, metadata, status, where, truncated) => {
    const env = openFileManager('a9-legacy-rebind-damage-');
    const p = env.openManager(); const other = env.other();
    try {
      p.createConversation('c1', '/w'); p.upsertTask('task1', 'c1', 'active'); p.upsertTurn('turn1', 'task1', 'c1', 'active');
      const fact = { handleId: 'hA', workspacePath: '/w', pid: 345, command: 'safe', cwd: '/w', startedAt: '2026-11-19', lastProbeStatus: 'running' };
      const ownership = { schemaVersion: 1 as const, owner: { workspace: '/w', conversationId: 'c1', taskId: 'task1', turnId: 'turn1', toolCallId: 'call1' },
        requestId: 'request-a', ownershipState: 'owned' as const };
      if (status === 'released') recordRelease(p, fact, ownership);
      else { p.recordManagedOwnership(fact, ownership); p.recordManagedOwnership({ ...fact, lastProbeStatus: status }, ownership); }
      p.upsertTurn('turn1', 'task1', 'c1', 'completed'); p.upsertTask('task1', 'c1', 'completed');
      const legacyRebind = () => other.prepare("UPDATE a9_sessions SET workspace_path = '/w2', metadata_json = ? WHERE session_id = 'c1'").run(metadata);
      if (where === 'written in B after the rebind') legacyRebind();
      const workspaceB = where === 'written in A, then rebound' ? '/w' : '/w2';
      p.upsertTask('task1b', 'c1', 'active'); p.upsertTurn('turn1b', 'task1b', 'c1', 'active');
      const factB = { handleId: 'hB', workspacePath: workspaceB, pid: 346, command: 'safe', cwd: workspaceB, startedAt: '2026-11-19', lastProbeStatus: 'running' };
      const ownershipB = { schemaVersion: 1 as const, owner: { workspace: workspaceB, conversationId: 'c1', taskId: 'task1b', turnId: 'turn1b', toolCallId: 'call1b' },
        requestId: 'request-b', ownershipState: 'owned' as const };
      p.recordManagedOwnership(factB, ownershipB);
      p.recordManagedOwnership({ ...factB, lastProbeStatus: 'stopped' }, ownershipB);
      p.upsertTurn('turn1b', 'task1b', 'c1', 'completed'); p.upsertTask('task1b', 'c1', 'completed');
      if (where === 'written in A, then rebound') legacyRebind();
      expect(p.listConversations('/w2').map(item => item.sessionId)).toEqual(['c1']);
      expect(workspaceHistory(p, 'c1') ?? []).toEqual([]);
      const damagedIds = (other.prepare(`SELECT id FROM a9_events WHERE event_type = 'managed_process_ownership'
        AND json_extract(payload_json, '$.handleId') = 'hB'`).all() as Array<{ id: number }>).map(item => item.id);
      expect(damagedIds.length).toBeGreaterThan(0);
      for (const id of damagedIds) other.prepare(`UPDATE a9_events SET payload_json = ${truncated} WHERE id = ?`).run(id);
      for (const includeOwnership of [true, 'recovery'] as const) {
        const errors = jest.fn();
        const listed = p.listManagedProcesses('/w', { includeOwnership, onOwnershipError: errors }).filter(item => item.handleId === 'hA');
        expect(errors).toHaveBeenCalledWith('hA', expect.objectContaining({ code: 'A9_MANAGED_OWNERSHIP_CORRUPT' }));
        expect(listed[0].ownership).toBeUndefined();
      }
      expect(lockOutcome(p)).toEqual({ released: false, blockers: expect.arrayContaining(['hA']) });
      expect(other.prepare('SELECT count(*) AS n FROM a9_workspace_locks').get()).toEqual({ n: 1 });
    } finally { other.close(); p.db.close(); env.cleanup(); }
  });

// P1 (round 23): (1) c1 settles hA and then hB in A. A legacy build rebinds c1 to B without
// segments (`origin: 'linked'`, a Round 19 scalar previousWorkspace, or damaged metadata), hB's
// records are truncated, and the current build rebinds c1 again B -> C. The first segment must not
// claim every earlier event was written in B: they are closed as an unknown prior segment, so A
// still reads hA's history as damaged (A9_MANAGED_OWNERSHIP_CORRUPT) and keeps its lock.
const legacyPriorMetadata = [
  ['legacy linked metadata', JSON.stringify({ workdir: { version: 1, origin: 'linked', createdAt: null } })],
  ['scalar previousWorkspace', JSON.stringify({ workdir: { version: 1, origin: 'linked', previousWorkspace: '/w', createdAt: null } })],
  ['damaged metadata_json', '{'],
] as const;
it.each(legacyPriorMetadata.flatMap(([route, metadata]) => (['stopped', 'released'] as const).flatMap(status =>
  ([['opening brace only', `'{'`], ['handleId key only', `'{"handleId":"'`]] as const).map(([name, truncated]) =>
    [`${route}, ${status}, ${name}`, metadata, status, truncated] as const))))(
  'round 23: a rebind after a legacy rebind keeps damage written in A before it as damage of A (%s)',
  (_name, metadata, status, truncated) => {
    const env = openFileManager('a9-legacy-then-rebind-');
    const p = env.openManager(); const other = env.other();
    try {
      p.createConversation('c1', '/w'); p.upsertTask('task1', 'c1', 'active'); p.upsertTurn('turn1', 'task1', 'c1', 'active');
      const fact = { handleId: 'hA', workspacePath: '/w', pid: 345, command: 'safe', cwd: '/w', startedAt: '2026-11-19', lastProbeStatus: 'running' };
      const ownership = { schemaVersion: 1 as const, owner: { workspace: '/w', conversationId: 'c1', taskId: 'task1', turnId: 'turn1', toolCallId: 'call1' },
        requestId: 'request-a', ownershipState: 'owned' as const };
      if (status === 'released') recordRelease(p, fact, ownership);
      else { p.recordManagedOwnership(fact, ownership); p.recordManagedOwnership({ ...fact, lastProbeStatus: status }, ownership); }
      p.upsertTurn('turn1', 'task1', 'c1', 'completed'); p.upsertTask('task1', 'c1', 'completed');
      p.upsertTask('task1b', 'c1', 'active'); p.upsertTurn('turn1b', 'task1b', 'c1', 'active');
      const factB = { handleId: 'hB', workspacePath: '/w', pid: 346, command: 'safe', cwd: '/w', startedAt: '2026-11-19', lastProbeStatus: 'running' };
      const ownershipB = { schemaVersion: 1 as const, owner: { workspace: '/w', conversationId: 'c1', taskId: 'task1b', turnId: 'turn1b', toolCallId: 'call1b' },
        requestId: 'request-b', ownershipState: 'owned' as const };
      p.recordManagedOwnership(factB, ownershipB);
      p.recordManagedOwnership({ ...factB, lastProbeStatus: 'stopped' }, ownershipB);
      p.upsertTurn('turn1b', 'task1b', 'c1', 'completed'); p.upsertTask('task1b', 'c1', 'completed');
      const bound = (other.prepare('SELECT max(id) AS id FROM a9_events').get() as { id: number }).id;
      // The legacy build's rebind to B.
      other.prepare("UPDATE a9_sessions SET workspace_path = '/w2', metadata_json = ? WHERE session_id = 'c1'").run(metadata);
      const damagedIds = (other.prepare(`SELECT id FROM a9_events WHERE event_type = 'managed_process_ownership'
        AND json_extract(payload_json, '$.handleId') = 'hB'`).all() as Array<{ id: number }>).map(item => item.id);
      expect(damagedIds.length).toBeGreaterThan(0);
      for (const id of damagedIds) other.prepare(`UPDATE a9_events SET payload_json = ${truncated} WHERE id = ?`).run(id);
      // The current build's rebind B -> C.
      p.changeWorkdir('c1', '/w2', '/w3', false);
      expect(p.listConversations('/w3').map(item => item.sessionId)).toEqual(['c1']);
      expect(workspaceHistory(p, 'c1')).toEqual([{ workspace: '#a9-unknown-prior', maxEventId: bound }, { workspace: '/w2', maxEventId: bound }]);
      for (const includeOwnership of [true, 'recovery'] as const) {
        const errors = jest.fn();
        const listed = p.listManagedProcesses('/w', { includeOwnership, onOwnershipError: errors }).filter(item => item.handleId === 'hA');
        expect(errors).toHaveBeenCalledWith('hA', expect.objectContaining({ code: 'A9_MANAGED_OWNERSHIP_CORRUPT' }));
        expect(listed[0].ownership).toBeUndefined();
      }
      expect(lockOutcome(p)).toEqual({ released: false, blockers: expect.arrayContaining(['hA']) });
      expect(other.prepare('SELECT count(*) AS n FROM a9_workspace_locks').get()).toEqual({ n: 1 });
      // Later rebinds and a fresh conversation are unaffected: only a session without segments gains the unknown segment.
      p.changeWorkdir('c1', '/w3', '/w4', false);
      expect((workspaceHistory(p, 'c1') as any[]).map(entry => entry.workspace)).toEqual(['#a9-unknown-prior', '/w2', '/w3']);
      p.createConversation('c2', '/w5'); p.changeWorkdir('c2', '/w5', '/w6', false);
      expect((workspaceHistory(p, 'c2') as any[]).map(entry => entry.workspace)).toEqual(['/w5']);
    } finally { other.close(); p.db.close(); env.cleanup(); }
  });

// P1 (round 23): (2) c1 stops hB in turn 1 and then hA in turn 2, both in A, and is rebound
// A -> B -> C. Its first segment is damaged and hB's records are truncated. An older malformed
// record of the anchor's own conversation and of another turn, not proven written outside A, is
// damage of hA's history: A fails closed and keeps its lock (also without any rebind).
it.each((['stopped', 'released'] as const).flatMap(status =>
  ([['opening brace only', `'{'`], ['handleId key only', `'{"handleId":"'`]] as const).flatMap(([name, truncated]) =>
    (['damaged first segment', 'intact segments (written in A)', 'no rebind'] as const).map(segments =>
      [`${status}, ${name}, ${segments}`, status, truncated, segments] as const))))(
  'round 23: an older damaged record of another turn of the anchor conversation stays damage of A (%s)',
  (_name, status, truncated, segments) => {
    const env = openFileManager('a9-older-turn-damage-');
    const p = env.openManager(); const other = env.other();
    try {
      p.createConversation('c1', '/w');
      p.upsertTask('task1', 'c1', 'active'); p.upsertTurn('turn1', 'task1', 'c1', 'active');
      const factB = { handleId: 'hB', workspacePath: '/w', pid: 346, command: 'safe', cwd: '/w', startedAt: '2026-11-19', lastProbeStatus: 'running' };
      const ownershipB = { schemaVersion: 1 as const, owner: { workspace: '/w', conversationId: 'c1', taskId: 'task1', turnId: 'turn1', toolCallId: 'call1' },
        requestId: 'request-b', ownershipState: 'owned' as const };
      p.recordManagedOwnership(factB, ownershipB);
      p.recordManagedOwnership({ ...factB, lastProbeStatus: 'stopped' }, ownershipB);
      p.upsertTurn('turn1', 'task1', 'c1', 'completed'); p.upsertTask('task1', 'c1', 'completed');
      p.upsertTask('task2', 'c1', 'active'); p.upsertTurn('turn2', 'task2', 'c1', 'active');
      const fact = { handleId: 'hA', workspacePath: '/w', pid: 345, command: 'safe', cwd: '/w', startedAt: '2026-11-19', lastProbeStatus: 'running' };
      const ownership = { schemaVersion: 1 as const, owner: { workspace: '/w', conversationId: 'c1', taskId: 'task2', turnId: 'turn2', toolCallId: 'call2' },
        requestId: 'request-a', ownershipState: 'owned' as const };
      if (status === 'released') recordRelease(p, fact, ownership);
      else { p.recordManagedOwnership(fact, ownership); p.recordManagedOwnership({ ...fact, lastProbeStatus: status }, ownership); }
      p.upsertTurn('turn2', 'task2', 'c1', 'completed'); p.upsertTask('task2', 'c1', 'completed');
      // Without a rebind the scoped read finds hA in A, so the stable history alone decides.
      if (segments !== 'no rebind') { p.changeWorkdir('c1', '/w', '/w2', false); p.changeWorkdir('c1', '/w2', '/w3', false); }
      if (segments === 'damaged first segment') {
        const history = workspaceHistory(p, 'c1') as Array<{ workspace: string; maxEventId: number }>;
        p.mergeConversationMetadata('c1', { workdir: { ...(p.getConversationMetadata('c1').workdir as object),
          workspaceHistory: [{ workspace: '/w' }, history[1]] } });
      }
      const damagedIds = (other.prepare(`SELECT id FROM a9_events WHERE event_type = 'managed_process_ownership'
        AND json_extract(payload_json, '$.handleId') = 'hB'`).all() as Array<{ id: number }>).map(item => item.id);
      const anchorId = (other.prepare(`SELECT min(id) AS id FROM a9_events WHERE event_type = 'managed_process_ownership'
        AND json_extract(payload_json, '$.handleId') = 'hA'`).get() as { id: number }).id;
      expect(Math.max(...damagedIds)).toBeLessThan(anchorId);
      for (const id of damagedIds) other.prepare(`UPDATE a9_events SET payload_json = ${truncated} WHERE id = ?`).run(id);
      for (const includeOwnership of [true, 'recovery'] as const) {
        const errors = jest.fn();
        const listed = p.listManagedProcesses('/w', { includeOwnership, onOwnershipError: errors }).filter(item => item.handleId === 'hA');
        expect(errors).toHaveBeenCalledWith('hA', expect.objectContaining({ code: 'A9_MANAGED_OWNERSHIP_CORRUPT' }));
        expect(listed[0].ownership).toBeUndefined();
      }
      expect(lockOutcome(p)).toEqual({ released: false, blockers: expect.arrayContaining(['hA']) });
      expect(other.prepare('SELECT count(*) AS n FROM a9_workspace_locks').get()).toEqual({ n: 1 });
    } finally { other.close(); p.db.close(); env.cleanup(); }
  });

// P1 (round 23): (3) c1 settles hA (`sh-aaa`) in A, is rebound to B and records hB (`sh-bbb`),
// whose record is cut to `{"handleId":"sh-`. That prefix names both handles, but segments prove
// the record was written in B: it is B's damage, never damage of hA. A reads hA normally, leaves
// and releases its lock; hB stays fail-closed in B. A record of the same kind written while c1
// is still bound to A keeps A fail-closed (control).
it.each((['stopped', 'released'] as const).flatMap(status => (['written in B', 'written in A (control)'] as const).map(where =>
  [`${status}, ${where}`, status, where] as const)))(
  'round 23: a handleId prefix salvaged from a record written in another workspace never blocks a handle of A (%s)',
  (_name, status, where) => {
    const env = openFileManager('a9-prefix-other-workspace-');
    const p = env.openManager(); const other = env.other();
    try {
      p.createConversation('c1', '/w'); p.upsertTask('task1', 'c1', 'active'); p.upsertTurn('turn1', 'task1', 'c1', 'active');
      const fact = { handleId: 'sh-aaa', workspacePath: '/w', pid: 345, command: 'safe', cwd: '/w', startedAt: '2026-11-19', lastProbeStatus: 'running' };
      const ownership = { schemaVersion: 1 as const, owner: { workspace: '/w', conversationId: 'c1', taskId: 'task1', turnId: 'turn1', toolCallId: 'call1' },
        requestId: 'request-a', ownershipState: 'owned' as const };
      if (status === 'released') recordRelease(p, fact, ownership);
      else { p.recordManagedOwnership(fact, ownership); p.recordManagedOwnership({ ...fact, lastProbeStatus: status }, ownership); }
      p.upsertTurn('turn1', 'task1', 'c1', 'completed'); p.upsertTask('task1', 'c1', 'completed');
      const workspaceB = where === 'written in B' ? '/w2' : '/w';
      if (where === 'written in B') p.changeWorkdir('c1', '/w', '/w2', false);
      p.upsertTask('task1b', 'c1', 'active'); p.upsertTurn('turn1b', 'task1b', 'c1', 'active');
      const { eventId: damagedId } = p.recordToolEvent('c1', 'turn1b', 'managed_process_ownership', { handleId: 'sh-bbb', schemaVersion: 1,
        owner: { workspace: workspaceB, conversationId: 'c1', taskId: 'task1b', turnId: 'turn1b', toolCallId: 'call1b' }, requestId: 'request-b', ownershipState: 'owned' });
      p.recordManagedProcess({ handleId: 'sh-bbb', workspacePath: workspaceB, pid: 346, command: 'safe', cwd: workspaceB,
        startedAt: '2026-11-19', lastProbeStatus: 'running', cleanupRequired: true });
      p.upsertTurn('turn1b', 'task1b', 'c1', 'completed'); p.upsertTask('task1b', 'c1', 'completed');
      other.prepare(`UPDATE a9_events SET payload_json = '{"handleId":"sh-' WHERE id = ?`).run(damagedId);
      const ownershipState = status === 'released' ? 'released' : 'owned';
      for (const includeOwnership of [true, 'recovery'] as const) {
        const errors = jest.fn();
        const listed = p.listManagedProcesses('/w', { includeOwnership, onOwnershipError: errors }).filter(item => item.handleId === 'sh-aaa');
        if (where === 'written in B') {
          expect(errors).not.toHaveBeenCalled();
          expect(listed.map(item => [item.lastProbeStatus, item.cleanupRequired, item.ownership?.ownershipState]))
            .toEqual([[status, false, ownershipState]]);
        } else {
          expect(errors).toHaveBeenCalledWith('sh-aaa', expect.objectContaining({ code: 'A9_MANAGED_OWNERSHIP_CORRUPT' }));
          expect(listed[0].ownership).toBeUndefined();
        }
      }
      if (where !== 'written in B') {
        expect(lockOutcome(p)).toEqual({ released: false, blockers: expect.arrayContaining(['sh-aaa']) });
        expect(other.prepare('SELECT count(*) AS n FROM a9_workspace_locks').get()).toEqual({ n: 1 });
        return;
      }
      expect(lockOutcome(p)).toEqual({ released: true, blockers: [] });
      expect(other.prepare('SELECT count(*) AS n FROM a9_workspace_locks').get()).toEqual({ n: 0 });
      const errorsB = jest.fn();
      const [listedB] = p.listManagedProcesses('/w2', { includeOwnership: 'recovery', onOwnershipError: errorsB });
      expect(errorsB).toHaveBeenCalledWith('sh-bbb', expect.objectContaining({ code: 'A9_MANAGED_OWNERSHIP_CORRUPT' }));
      expect(listedB).toMatchObject({ handleId: 'sh-bbb', cleanupRequired: true });
    } finally { other.close(); p.db.close(); env.cleanup(); }
  });
