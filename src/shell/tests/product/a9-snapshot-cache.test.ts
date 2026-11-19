/// <reference path="./better-sqlite3.d.ts" />
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';

const { createA9AgentRuntime, openA9RuntimePersistence } = require('../../product/a9-agent-runtime');

describe('A9 getSnapshot hot-path cache, invalidation, and managed process sync', () => {
  let root: string;
  let workspaceRoot: string;
  let dataRoot: string;
  const databases: any[] = [];
  const runtimes: any[] = [];

  const openDatabase = (file: string, options?: { readonly?: boolean }) => {
    const db = new Database(file, options?.readonly ? { readonly: true } : {});
    databases.push(db);
    return db;
  };

  function createRuntime(options: { safeStorage?: any; vaultPlatform?: string; openPersistence?: (cfg: any, factory: any) => any } = {}) {
    let persistence: any;
    const runtime = createA9AgentRuntime({
      workspaceRoot,
      dataRoot,
      ownerId: `snap-cache-${process.pid}`,
      openDatabase,
      ...(options.safeStorage ? { safeStorage: options.safeStorage } : {}),
      ...(options.vaultPlatform ? { vaultPlatform: options.vaultPlatform } : {}),
      openPersistence: (cfg: any, factory: any) => {
        if (options.openPersistence) return options.openPersistence(cfg, factory);
        const outcome = factory(cfg);
        persistence = outcome.manager;
        return outcome;
      },
    });
    runtimes.push(runtime);
    return { runtime, persistence };
  }

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'w7ca-a9-snap-cache-')));
    workspaceRoot = path.join(root, 'ws');
    dataRoot = path.join(root, 'data');
    fs.mkdirSync(workspaceRoot);
    fs.mkdirSync(dataRoot);
  });

  afterEach(async () => {
    while (runtimes.length) {
      const rt = runtimes.pop();
      try { await rt.shutdown(); } catch (_err) { /* best-effort cleanup */ }
    }
    while (databases.length) {
      const db = databases.pop();
      try { if (db.open) db.close(); } catch (_err) { /* best-effort cleanup */ }
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('hits cache on repeated getSnapshot calls without DB writes and shields cached entries from caller mutation', () => {
    const { runtime, persistence } = createRuntime();
    const initialSnap = runtime.getSnapshot({ conversationPage: true });
    const sessionId = initialSnap.activeConversationId;
    persistence.upsertTask('t1', sessionId, 'completed');
    persistence.upsertTurn('u1', 't1', sessionId, 'completed');
    persistence.saveCheckpoint({ turnId: 'u1', sessionId, payload: { requestPrompt: 'hi', finalMessage: 'ok' } });

    const checkpointsSpy = jest.spyOn(persistence, 'listRecentCheckpoints');
    const conversationsSpy = jest.spyOn(persistence, 'listConversations');
    const inboxBatchSpy = jest.spyOn(persistence, 'listConversationInboxSummaries');
    const managedSpy = jest.spyOn(persistence, 'listManagedProcesses');
    const ownershipBatchSpy = jest.spyOn(persistence, 'listManagedOwnerships');

    const first = runtime.getSnapshot({ conversationPage: true });
    expect(checkpointsSpy).toHaveBeenCalledTimes(1);
    expect(conversationsSpy).toHaveBeenCalledTimes(1);
    expect(inboxBatchSpy).toHaveBeenCalledTimes(1);
    expect(managedSpy).toHaveBeenCalledTimes(0);
    expect(ownershipBatchSpy).toHaveBeenCalledTimes(0);

    const changesBefore = persistence.db.prepare('SELECT total_changes() AS n').get().n;
    for (let i = 0; i < 5; i += 1) {
      const cached = runtime.getSnapshot({ conversationPage: true });
      expect(cached.checkpoints).toEqual(first.checkpoints);
      expect(cached.checkpointsTotal).toBe(first.checkpointsTotal);
      expect(cached.conversations).toEqual(first.conversations);
      expect(cached.managedProcesses).toEqual(first.managedProcesses);
    }
    expect(persistence.db.prepare('SELECT total_changes() AS n').get().n).toBe(changesBefore);
    expect(checkpointsSpy).toHaveBeenCalledTimes(1);
    expect(conversationsSpy).toHaveBeenCalledTimes(1);
    expect(inboxBatchSpy).toHaveBeenCalledTimes(1);
    expect(managedSpy).toHaveBeenCalledTimes(0);

    // Mutating returned snapshot structures must not poison cached copies.
    first.checkpoints[0].turnId = 'mutated';
    first.checkpoints.push({ turnId: 'extra', createdAt: '2099-01-01T00:00:00.000Z' });
    first.conversations[0].title = 'mutated-title';
    const next = runtime.getSnapshot({ conversationPage: true });
    expect(next.checkpoints).toHaveLength(1);
    expect(next.checkpoints[0].turnId).toBe('u1');
    expect(next.conversations[0].title).not.toBe('mutated-title');

    // bypassCache: true forces a fresh query even with unchanged DB version.
    runtime.getSnapshot({ conversationPage: true, bypassCache: true });
    expect(checkpointsSpy).toHaveBeenCalledTimes(2);
    expect(conversationsSpy).toHaveBeenCalledTimes(2);
    expect(inboxBatchSpy).toHaveBeenCalledTimes(2);
    expect(managedSpy).toHaveBeenCalledTimes(1);
  });

  test('invalidates immediately on checkpoint write, conversation update, inbox merge, direct SQL, cross-connection write, and memory draft', () => {
    // Run without safeStorage so composer draft stays in memory (does NOT increment total_changes()).
    const { runtime, persistence } = createRuntime();
    const s1 = runtime.getSnapshot({ conversationPage: true }).activeConversationId;

    // 1) Direct persistence checkpoint write
    persistence.upsertTask('t-cp', s1, 'completed');
    persistence.upsertTurn('u-cp', 't-cp', s1, 'completed');
    persistence.saveCheckpoint({ turnId: 'u-cp', sessionId: s1, payload: { finalMessage: 'saved' } });
    const afterCheckpoint = runtime.getSnapshot({ conversationPage: true });
    expect(afterCheckpoint.checkpoints.map((c: any) => c.turnId)).toEqual(['u-cp']);
    expect(afterCheckpoint.checkpointsTotal).toBe(1);

    // 2) Conversation update via runtime (create + rename)
    const created = runtime.createConversation();
    const s2 = created.conversationId;
    runtime.renameConversation(s2, '新功能设计');
    const afterConv = runtime.getSnapshot({ conversationPage: true });
    expect(afterConv.activeConversationId).toBe(s2);
    expect(afterConv.checkpoints).toEqual([]);
    expect(afterConv.conversations.find((c: any) => c.sessionId === s2)?.title).toBe('新功能设计');

    // 3) Inbox merge directly via persistence
    const settleTs = '2026-11-10T01:02:03.000Z';
    persistence.mergeConversationInbox(s1, fs.realpathSync(workspaceRoot), { settledAt: settleTs });
    const afterInbox = runtime.getSnapshot({ conversationPage: true });
    expect(afterInbox.conversations.find((c: any) => c.sessionId === s1)?.settledAt).toBe(settleTs);

    // 4) Memory-only composer draft change must reflect live in both draft and conversations[].hasDraft
    const changesBeforeDraft = persistence.db.prepare('SELECT total_changes() AS n').get().n;
    const savedDraft = runtime.saveDraft('unsent memory draft');
    expect(savedDraft.ok).toBe(true);
    expect(savedDraft.persistence).toBe('memory');
    expect(persistence.db.prepare('SELECT total_changes() AS n').get().n).toBe(changesBeforeDraft);
    const afterDraft = runtime.getSnapshot({ conversationPage: true });
    expect(afterDraft.draft.text).toBe('unsent memory draft');
    expect(afterDraft.conversations.find((c: any) => c.sessionId === s2)?.hasDraft).toBe(true);
    expect(afterDraft.conversations.find((c: any) => c.sessionId === s1)?.hasDraft).toBe(false);

    // 5) Direct SQL mutation on persistence.db
    persistence.db.prepare('UPDATE a9_sessions SET title = ? WHERE session_id = ?').run('SQL直改标题', s1);
    const afterDirectSql = runtime.getSnapshot({ conversationPage: true });
    expect(afterDirectSql.conversations.find((c: any) => c.sessionId === s1)?.title).toBe('SQL直改标题');

    // 6) Cross-connection SQL write detected via PRAGMA data_version
    const external = openDatabase(path.join(dataRoot, 'a9-state.db'));
    external.prepare('UPDATE a9_sessions SET title = ? WHERE session_id = ?').run('跨连接标题', s1);
    const afterCrossConn = runtime.getSnapshot({ conversationPage: true });
    expect(afterCrossConn.conversations.find((c: any) => c.sessionId === s1)?.title).toBe('跨连接标题');
  });

  test('managed process fast-path skips DB when no live processes exist and re-syncs when a running process exists without bumping total_changes', () => {
    const { runtime, persistence } = createRuntime();
    const s1 = runtime.getSnapshot({ conversationPage: true }).activeConversationId;
    persistence.upsertTask('tm', s1, 'active');
    persistence.upsertTurn('um', 'tm', s1, 'active');

    // Seed an exited historical process fact: should use fast-path cache after first sync.
    persistence.recordManagedOwnership(
      { handleId: 'h-exited', workspacePath: workspaceRoot, pid: 101, command: 'echo done', cwd: workspaceRoot, startedAt: '2026-10-01T00:00:00.000Z', lastProbeStatus: 'exited', cleanupRequired: false },
      { schemaVersion: 1, owner: { workspace: fs.realpathSync(workspaceRoot), conversationId: s1, taskId: 'tm', turnId: 'um', toolCallId: 'cm1' }, requestId: 'req-exit', ownershipState: 'owned' },
    );

    const managedSpy = jest.spyOn(persistence, 'listManagedProcesses');
    const first = runtime.getSnapshot({ conversationPage: true });
    expect(first.managedProcesses).toHaveLength(1);
    expect(first.managedProcesses[0]).toMatchObject({ handleId: 'h-exited', lastProbeStatus: 'exited' });
    expect(managedSpy).toHaveBeenCalledTimes(1);

    // Exited-only + empty background manager -> hits fast path on second call.
    runtime.getSnapshot({ conversationPage: true });
    expect(managedSpy).toHaveBeenCalledTimes(1);

    // Add a live 'running' process directly in persistence -> cache detects total_changes() + live status.
    persistence.recordManagedOwnership(
      { handleId: 'h-live', workspacePath: workspaceRoot, pid: 202, command: 'node server.js', cwd: workspaceRoot, startedAt: '2026-10-01T00:01:00.000Z', lastProbeStatus: 'running', cleanupRequired: true },
      { schemaVersion: 1, owner: { workspace: fs.realpathSync(workspaceRoot), conversationId: s1, taskId: 'tm', turnId: 'um', toolCallId: 'cm2' }, requestId: 'req-live', ownershipState: 'owned' },
    );
    const withLive = runtime.getSnapshot({ conversationPage: true });
    expect(withLive.managedProcesses.find((p: any) => p.handleId === 'h-live')?.lastProbeStatus).toBe('running');
    expect(managedSpy).toHaveBeenCalledTimes(2);

    // While a live 'running' handle exists, fast path MUST NOT suppress re-sync.
    const changesBeforeLive = persistence.db.prepare('SELECT total_changes() AS n').get().n;
    runtime.getSnapshot({ conversationPage: true });
    expect(managedSpy).toHaveBeenCalledTimes(3);
    expect(persistence.db.prepare('SELECT total_changes() AS n').get().n).toBe(changesBeforeLive);
  });

  test('does not publish an uncommitted or concurrently invalidated projection to the cache', () => {
    const { runtime, persistence } = createRuntime();
    const first = runtime.getSnapshot();
    const id = first.activeConversationId;
    const title = first.conversations[0].title;
    persistence.db.exec('BEGIN');
    try {
      persistence.renameConversation(id, 'uncommitted', workspaceRoot);
      expect(runtime.getSnapshot().conversations[0].title).toBe('uncommitted');
    } finally {
      persistence.db.exec('ROLLBACK');
    }
    expect(runtime.getSnapshot().conversations[0].title).toBe(title);
    const fact = { handleId: 'raced', workspacePath: workspaceRoot, command: 'test', cwd: workspaceRoot,
      startedAt: '2026-10-01T00:00:00.000Z', lastProbeStatus: 'exited' };
    persistence.recordManagedProcess(fact);
    const other = openDatabase(path.join(dataRoot, 'a9-state.db'));
    const read = persistence.listManagedProcesses.bind(persistence);
    jest.spyOn(persistence, 'listManagedProcesses').mockImplementationOnce((...args: unknown[]) => {
      const facts = read(...args);
      other.prepare("UPDATE a9_managed_processes SET last_probe_status = 'stopped' WHERE handle_id = ?").run(fact.handleId);
      return facts;
    });
    expect(runtime.getSnapshot().managedProcesses[0].lastProbeStatus).toBe('exited');
    expect(runtime.getSnapshot().managedProcesses[0].lastProbeStatus).toBe('stopped');
  });

  test('keeps cached projections across persisted tool output and other workspace writes', () => {
    const { runtime, persistence } = createRuntime();
    const id = runtime.getSnapshot().activeConversationId;
    persistence.upsertTask('task', id, 'active');
    persistence.upsertTurn('turn', 'task', id, 'active');
    const otherWorkspace = path.join(root, 'other');
    persistence.createConversation('other-session', otherWorkspace);
    for (let i = 0; i < 5; i++) persistence.createConversation('unopened-' + i, workspaceRoot);
    persistence.setConversationDraftCiphertext('unopened-0', 'opaque-ciphertext');
    expect(runtime.getSnapshot().conversations.find((item: any) => item.sessionId === 'unopened-0').hasDraft).toBe(true);
    const spies = ['listRecentCheckpoints', 'listConversations', 'listConversationInboxSummaries', 'listManagedProcesses',
      'getConversationDraftCiphertext'].map(method => jest.spyOn(persistence, method));
    for (let seq = 1; seq <= 3; seq++) {
      persistence.recordToolEvent(id, 'turn', 'tool_output', { data: {
        schemaVersion: 1, conversationId: id, turnId: 'turn', taskId: 'task', toolCallId: 'call',
        requestId: 'req', stream: 'stdout', text: 'frame', outputSeq: seq,
        sourceSeqThrough: seq, rawBytesRead: seq * 5, truncated: false,
      } });
      persistence.renameConversation('other-session', 'remote-title-' + seq, otherWorkspace);
      expect(runtime.getSnapshot().conversations.find((item: any) => item.sessionId === 'unopened-0').hasDraft).toBe(true);
    }
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    persistence.setConversationDraftCiphertext('unopened-0', null);
    expect(runtime.getSnapshot().conversations.find((item: any) => item.sessionId === 'unopened-0').hasDraft).toBe(false);
  });

  test.each([{ schemaVersion: 2 }, { schemaVersion: 1, owner: {} }])(
    'blocks cleanup and exit for a corrupt startup ownership record (%p)', async (invalid) => {
    const first = createRuntime();
    const id = first.runtime.getSnapshot().activeConversationId;
    await first.runtime.shutdown();
    first.persistence.upsertTask('corrupt-task', id, 'completed');
    first.persistence.upsertTurn('corrupt-turn', 'corrupt-task', id, 'completed');
    first.persistence.recordManagedProcess({
      handleId: 'corrupt', workspacePath: workspaceRoot, pid: 999991, command: 'test', cwd: workspaceRoot,
      startedAt: '2026-10-01T00:00:00.000Z', lastProbeStatus: 'running',
    });
    first.persistence.recordToolEvent(id, 'corrupt-turn', 'managed_process_ownership', { handleId: 'corrupt', ...invalid });
    const warning = jest.spyOn(process, 'emitWarning').mockImplementation(() => {});
    try {
      const reopened = createRuntime();
      expect(reopened.runtime.getWorkdirConversationId()).toBe(id);
      expect(reopened.runtime.getSnapshot()).toMatchObject({
        status: 'ready',
        managedProcesses: [expect.objectContaining({ handleId: 'corrupt', cleanupRequired: true, canDismissRecovered: false })],
        conversationControls: { canSwitch: false },
      });
      expect(reopened.runtime.canLeaveWorkspace().allowed).toBe(false);
      expect(await reopened.runtime.stop()).toMatchObject({ ok: false, error: { code: 'A9_MANAGED_PROCESS_CLEANUP_UNCONFIRMED' } });
      expect(await reopened.runtime.shutdown()).toMatchObject({ stopped: [], unresolved: [expect.any(String)] });
      expect(reopened.persistence.db.prepare('SELECT owner_id FROM a9_workspace_locks').get()).toBeDefined();
      expect(reopened.persistence.getDiagnostics()).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'A9_MANAGED_HANDLE_ADOPT_FAILED' }),
      ]));
      expect(() => reopened.persistence.getManagedOwnership('corrupt')).toThrow(
        invalid.schemaVersion === 1 ? 'A9_MANAGED_OWNERSHIP_UNCONFIRMED' : 'A9_MANAGED_OWNERSHIP_CORRUPT',
      );
    } finally {
      warning.mockRestore();
    }
  });

  test('isolates late ownership corruption during snapshot synchronization and blocks dispatch', async () => {
    const first = createRuntime();
    const id = first.runtime.getSnapshot().activeConversationId;
    await first.runtime.shutdown();
    first.persistence.upsertTask('task', id, 'active');
    first.persistence.upsertTurn('turn', 'task', id, 'active');
    first.persistence.recordManagedOwnership({
      handleId: 'recovered', workspacePath: workspaceRoot, pid: 999991, command: 'test', cwd: workspaceRoot,
      startedAt: '2026-10-01T00:00:00.000Z', lastProbeStatus: 'cleanup_required',
    }, { schemaVersion: 1, owner: { workspace: workspaceRoot, conversationId: id, taskId: 'task',
      turnId: 'turn', toolCallId: 'call' }, requestId: 'req', ownershipState: 'owned' });
    const reopened = createRuntime();
    expect(reopened.runtime.getSnapshot().managedProcesses[0]).toHaveProperty('owner');
    reopened.persistence.recordToolEvent(id, 'turn', 'managed_process_ownership', { handleId: 'recovered', schemaVersion: 2 });
    const warning = jest.spyOn(process, 'emitWarning').mockImplementation(() => {});
    try {
      const snapshot = reopened.runtime.getSnapshot();
      expect(snapshot.status).toBe('ready');
      expect(snapshot.managedProcesses[0]).toMatchObject({ cleanupRequired: true, canDismissRecovered: false });
      expect(snapshot.managedProcesses[0]).not.toHaveProperty('owner');
      expect(await reopened.runtime.submitTurn('blocked')).toMatchObject({ ok: false });
      expect(await reopened.runtime.shutdown({ stopManaged: false })).toEqual({
        stopped: [], leftToSystem: [], unresolved: [expect.any(String)],
      });
    } finally {
      warning.mockRestore();
    }
  });

  test('keeps nested disposition data isolated across cached snapshots', async () => {
    // A real A9-34 dismissal: only a verified disposition is projected (ADR-0343).
    const first = createRuntime();
    const id = first.runtime.getSnapshot().activeConversationId;
    await first.runtime.shutdown();
    first.persistence.upsertTask('dt', id, 'completed');
    first.persistence.upsertTurn('du', 'dt', id, 'completed');
    first.persistence.recordManagedOwnership({ handleId: 'dismissed', workspacePath: workspaceRoot, pid: 987654301, command: 'test',
      cwd: workspaceRoot, startedAt: '2026-10-01T00:00:00.000Z', lastProbeStatus: 'exited', cleanupRequired: true },
    { schemaVersion: 1, owner: { workspace: fs.realpathSync(workspaceRoot), conversationId: id, taskId: 'dt', turnId: 'du',
      toolCallId: 'call-d' }, requestId: 'req-d', ownershipState: 'owned' });
    const { runtime } = createRuntime();
    const card = runtime.getSnapshot().managedProcesses[0];
    expect(runtime.dismissRecovered({ conversationId: id, handleId: 'dismissed', recoveryRevision: card.recoveryRevision })).toMatchObject({ ok: true });
    const projected = runtime.getSnapshot().managedProcesses[0];
    projected.disposition.pidProbe.status = 'changed';
    expect(runtime.getSnapshot().managedProcesses[0].disposition.pidProbe.status).toBe('absent');
  });

  test('rebinding the session of a damaged disposition record invalidates the cached snapshot like the final lock criterion', async () => {
    const first = createRuntime();
    const id = first.runtime.getSnapshot().activeConversationId;
    await first.runtime.shutdown();
    first.persistence.upsertTask('dt', id, 'completed');
    first.persistence.upsertTurn('du', 'dt', id, 'completed');
    first.persistence.recordManagedOwnership({ handleId: 'dismissed', workspacePath: workspaceRoot, pid: 987654302, command: 'test',
      cwd: workspaceRoot, startedAt: '2026-10-01T00:00:00.000Z', lastProbeStatus: 'exited', cleanupRequired: true },
    { schemaVersion: 1, owner: { workspace: fs.realpathSync(workspaceRoot), conversationId: id, taskId: 'dt', turnId: 'du',
      toolCallId: 'call-d' }, requestId: 'req-d', ownershipState: 'owned' });
    const { runtime, persistence } = createRuntime();
    const card = runtime.getSnapshot().managedProcesses[0];
    expect(runtime.dismissRecovered({ conversationId: id, handleId: 'dismissed', recoveryRevision: card.recoveryRevision })).toMatchObject({ ok: true });
    const localWorkspace = persistence.db.prepare('SELECT workspace_path FROM a9_sessions WHERE session_id = ?').get(id).workspace_path;
    const otherRoot = path.join(root, 'other-ws'); fs.mkdirSync(otherRoot);
    persistence.db.prepare(`INSERT INTO a9_sessions (session_id, workspace_path, created_at, updated_at, last_activated_at)
      VALUES ('foreign-session', ?, '2026-11-19', '2026-11-19', '2026-11-19')`).run(otherRoot);
    persistence.db.prepare(`INSERT INTO a9_events (session_id, turn_id, kind, event_type, payload_json, created_at)
      VALUES ('foreign-session', NULL, 'tool', 'managed_process_disposition', '{"no":"handle"}', '2026-11-19')`).run();
    const warning = jest.spyOn(process, 'emitWarning').mockImplementation(() => {});
    try {
      // Warm the cache: the foreign damaged record does not affect this workspace.
      expect(runtime.getSnapshot().conversationControls.canSwitch).toBe(true);
      const managedSpy = jest.spyOn(persistence, 'listManagedProcesses');
      expect(runtime.getSnapshot().conversationControls.canSwitch).toBe(true);
      // An ordinary tool event of that session keeps the cached managed projection.
      persistence.recordToolEvent('foreign-session', null, 'mode.set', { mode: 'read_only', workspace: otherRoot });
      expect(runtime.getSnapshot().conversationControls.canSwitch).toBe(true);
      expect(managedSpy).not.toHaveBeenCalled();
      // Same connection: the damaged record's session now belongs to this workspace.
      persistence.db.prepare("UPDATE a9_sessions SET workspace_path = ? WHERE session_id = 'foreign-session'").run(localWorkspace);
      expect(runtime.getSnapshot().conversationControls.canSwitch).toBe(false);
      expect(runtime.getSnapshot({ bypassCache: true }).conversationControls.canSwitch).toBe(false);
      expect(runtime.canLeaveWorkspace().allowed).toBe(false);
    } finally { warning.mockRestore(); }
  });

  test('bypasses cache and falls back cleanly for partial mock persistence without .db', () => {
    let title = 'mock-v1';
    const mockPersistence = {
      listConversations: jest.fn(() => [{
        sessionId: 'mock-s1',
        workspacePath: workspaceRoot,
        title,
        titleSource: 'auto',
        state: 'active',
        activity: 'idle',
        createdAt: '2026-11-01T00:00:00.000Z',
        updatedAt: '2026-11-01T00:00:00.000Z',
        lastActivatedAt: '2026-11-01T00:00:00.000Z',
      }]),
      ensureActiveConversation: jest.fn(() => ({
        sessionId: 'mock-s1', workspacePath: workspaceRoot, title, titleSource: 'auto', state: 'active',
        activity: 'idle', createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z',
        lastActivatedAt: '2026-11-01T00:00:00.000Z',
      })),
      getWorkspaceMode: jest.fn(() => undefined),
      acquireWorkspaceLock: jest.fn(() => ({ acquired: true, holder: 'mock' })),
      releaseWorkspaceLock: jest.fn(),
      getConversationMetadata: jest.fn(() => ({})),
      getConversationDraftCiphertext: jest.fn(() => null),
      getConversationInboxSummary: jest.fn(() => ({
        settledAt: null, lastVisitedAt: null, lastCompletedAt: null, lastActivityAt: '2026-11-01T00:00:00.000Z',
      })),
      listRecentCheckpoints: jest.fn(() => ({ checkpoints: [], total: 0 })),
      listConversationFactPage: jest.fn(() => ({ facts: [], hasMore: false, nextBefore: null })),
      listInterruptions: jest.fn(() => []),
      listManagedProcesses: jest.fn(() => [{
        handleId: 'mh1', pid: 10, command: 'echo ok', cwd: workspaceRoot,
        startedAt: '2026-11-01T00:00:00.000Z', lastProbeStatus: 'exited', pidReusePossible: false, cleanupRequired: false,
      }]),
      getManagedOwnership: jest.fn(() => undefined),
      getPendingQuestion: jest.fn(() => null),
      getDiagnostics: jest.fn(() => []),
    };
    const { runtime } = createRuntime({
      openPersistence: () => ({ status: 'ready', manager: mockPersistence, importedA8Workspaces: 0 }),
    });
    jest.clearAllMocks();

    expect(runtime.getSnapshot({ conversationPage: true }).conversations[0].title).toBe('mock-v1');
    title = 'mock-v2';
    expect(runtime.getSnapshot({ conversationPage: true }).conversations[0].title).toBe('mock-v2');
    expect(mockPersistence.listConversations).toHaveBeenCalledTimes(2);
    expect(mockPersistence.getConversationInboxSummary).toHaveBeenCalledTimes(2);
    expect(mockPersistence.listRecentCheckpoints).toHaveBeenCalledTimes(2);
    expect(mockPersistence.listManagedProcesses).toHaveBeenCalledTimes(2);
    expect(mockPersistence.getManagedOwnership).toHaveBeenCalledTimes(2);
  });

  test('same-connection origin edits invalidate cached terminal managed projections while tool output keeps them', () => {
    const { runtime, persistence } = createRuntime();
    const id = runtime.getSnapshot().activeConversationId;
    const workspace = fs.realpathSync(workspaceRoot);
    persistence.upsertTask('rt', id, 'active');
    persistence.upsertTurn('ru', 'rt', id, 'active');
    const fact = { handleId: 'h-released', workspacePath: workspaceRoot, pid: 303, command: 'serve', cwd: workspaceRoot,
      startedAt: '2026-10-01T00:00:00.000Z', lastProbeStatus: 'running' };
    const ownership = { schemaVersion: 1, owner: { workspace, conversationId: id, taskId: 'rt', turnId: 'ru', toolCallId: 'rc' },
      requestId: 'req-rel', ownershipState: 'owned' };
    persistence.recordManagedOwnership(fact, ownership);
    persistence.recordManagedOwnership(fact, { ...ownership, ownershipState: 'release_intent', releaseId: 'rel' });
    persistence.recordManagedOwnership({ ...fact, lastProbeStatus: 'released', cleanupRequired: false },
      { ...ownership, ownershipState: 'released', releaseId: 'rel' });
    persistence.recordManagedOwnership({ ...fact, handleId: 'h-exited', lastProbeStatus: 'exited', cleanupRequired: false },
      { ...ownership, requestId: 'req-exit' });
    const item = (handleId: string) => runtime.getSnapshot().managedProcesses.find((entry: any) => entry.handleId === handleId);
    expect(item('h-released')).toMatchObject({ cleanupRequired: false, ownershipState: 'released' });
    const managedSpy = jest.spyOn(persistence, 'listManagedProcesses');
    const warning = jest.spyOn(process, 'emitWarning').mockImplementation(() => {});
    try {
      for (let seq = 1; seq <= 3; seq++) {
        persistence.recordToolEvent(id, 'ru', 'tool_output', { data: {
          schemaVersion: 1, conversationId: id, turnId: 'ru', taskId: 'rt', toolCallId: 'rc', requestId: 'req',
          stream: 'stdout', text: 'frame', outputSeq: seq, sourceSeqThrough: seq, rawBytesRead: seq, truncated: false,
        } });
        persistence.upsertTurn('ru', 'rt', id, 'active');
        expect(item('h-released')).toMatchObject({ cleanupRequired: false });
      }
      expect(managedSpy).not.toHaveBeenCalled();
      // Deleting the ownership task makes the release unprovable; the cache must not mask it.
      persistence.db.prepare("DELETE FROM a9_tasks WHERE task_id = 'rt'").run();
      expect(item('h-released')).toMatchObject({ cleanupRequired: true });
      expect(managedSpy).toHaveBeenCalledTimes(1);
      persistence.db.prepare("INSERT INTO a9_tasks (task_id, session_id, status, created_at, updated_at) VALUES ('rt', ?, 'active', 'x', 'x')").run(id);
      // Deleting the turn removes the verified origin of every ownership event.
      persistence.db.prepare("DELETE FROM a9_turns WHERE turn_id = 'ru'").run();
      expect(item('h-exited')).not.toHaveProperty('owner');
      expect(managedSpy).toHaveBeenCalledTimes(2);
    } finally { warning.mockRestore(); }
  });

  test('reuses persistent facts for terminal in-memory handles and reads ownership once for three recoverable cards', async () => {
    const first = createRuntime();
    const id = first.runtime.getSnapshot().activeConversationId;
    await first.runtime.shutdown();
    first.persistence.upsertTask('rt', id, 'completed');
    first.persistence.upsertTurn('ru', 'rt', id, 'completed');
    // Legacy PID fact with a dead PID: adopted as a terminal in-memory handle.
    first.persistence.recordManagedProcess({ handleId: 'legacy-exited', workspacePath: workspaceRoot, pid: 987654310, command: 'old',
      cwd: workspaceRoot, startedAt: '2026-10-01T00:00:00.000Z', lastProbeStatus: 'running' });
    const restart = createRuntime();
    const terminalSpy = jest.spyOn(restart.persistence, 'listManagedProcesses');
    expect(restart.runtime.getSnapshot().managedProcesses).toEqual([
      expect.objectContaining({ handleId: 'legacy-exited', lastProbeStatus: 'exited', cleanupRequired: false })]);
    restart.runtime.getSnapshot(); restart.runtime.getSnapshot();
    expect(terminalSpy).toHaveBeenCalledTimes(1);
    await restart.runtime.shutdown();

    for (const n of [1, 2, 3]) {
      restart.persistence.recordManagedOwnership({ handleId: `rec-${n}`, workspacePath: workspaceRoot, pid: 987654320 + n,
        command: 'serve', cwd: workspaceRoot, startedAt: '2026-10-01T00:00:00.000Z', lastProbeStatus: 'exited', cleanupRequired: true },
      { schemaVersion: 1, owner: { workspace: fs.realpathSync(workspaceRoot), conversationId: id, taskId: 'rt', turnId: 'ru',
        toolCallId: `call-${n}` }, requestId: `req-${n}`, ownershipState: 'owned' });
    }
    const reopened = createRuntime();
    const prepare = jest.spyOn(reopened.persistence.db, 'prepare');
    const cards = reopened.runtime.getSnapshot().managedProcesses.filter((item: any) => item.handleId.startsWith('rec-'));
    expect(prepare.mock.calls.filter(([sql]: any) => /managed_process_ownership/.test(sql))).toHaveLength(1);
    prepare.mockRestore();
    expect(cards).toHaveLength(3);
    for (const card of cards) {
      expect(card).toMatchObject({ canDismissRecovered: true, cleanupRequired: true });
      expect(card.recoveryRevision).toBe(reopened.persistence.getManagedProcessRecoveryIdentity(card.handleId).recoveryRevision);
    }
    // Commit still re-validates atomically: a drifted row rejects the batch-derived card.
    reopened.persistence.db.prepare("UPDATE a9_managed_processes SET started_at = 'drift' WHERE handle_id = 'rec-1'").run();
    expect(reopened.runtime.dismissRecovered({ conversationId: id, handleId: 'rec-1', recoveryRevision: cards[0].recoveryRevision }))
      .toMatchObject({ ok: false, error: { code: 'A9_MANAGED_RECOVERY_STALE' } });
    expect(reopened.runtime.dismissRecovered({ conversationId: id, handleId: 'rec-2', recoveryRevision: cards[1].recoveryRevision }))
      .toMatchObject({ ok: true });
  });

  test('DPAPI draft updates metadata and snapshot hasDraft coherently across multiple conversations', () => {
    const fakeSafeStorage = {
      isEncryptionAvailable: () => true,
      encryptString: (text: string) => Buffer.from(text, 'utf8'),
      decryptString: (buf: Buffer) => buf.toString('utf8'),
    };
    const { runtime } = createRuntime({ safeStorage: fakeSafeStorage, vaultPlatform: 'win32' });
    const s1 = runtime.getSnapshot({ conversationPage: true }).activeConversationId;
    const s2 = runtime.createConversation().conversationId;

    const draftRes = runtime.saveDraft('dpapi draft');
    expect(draftRes).toEqual({ ok: true, persistence: 'dpapi' });
    const snap = runtime.getSnapshot({ conversationPage: true });
    expect(snap.draft).toEqual({ text: 'dpapi draft', persistence: 'dpapi' });
    expect(snap.conversations.find((c: any) => c.sessionId === s2)?.hasDraft).toBe(true);
    expect(snap.conversations.find((c: any) => c.sessionId === s1)?.hasDraft).toBe(false);

    // Ensure openA9RuntimePersistence helper still loads cleanly
    expect(typeof openA9RuntimePersistence).toBe('function');
  });

  test('active/recovered BackgroundProcessManager handles use batch ownership lookup and never bump total_changes when unchanged', async () => {
    const first = createRuntime();
    const s1 = first.runtime.getSnapshot({ conversationPage: true }).activeConversationId;
    first.persistence.upsertTask('t-bg', s1, 'active');
    first.persistence.upsertTurn('u-bg', 't-bg', s1, 'active');
    first.persistence.recordManagedOwnership(
      { handleId: 'h-rec-1', workspacePath: workspaceRoot, pid: 999991, command: 'node a.js', cwd: workspaceRoot, startedAt: '2026-10-01T00:00:00.000Z', lastProbeStatus: 'running', cleanupRequired: true },
      { schemaVersion: 1, owner: { workspace: fs.realpathSync(workspaceRoot), conversationId: s1, taskId: 't-bg', turnId: 'u-bg', toolCallId: 'c1' }, requestId: 'req-1', ownershipState: 'owned' },
    );
    first.persistence.recordManagedOwnership(
      { handleId: 'h-rec-2', workspacePath: workspaceRoot, pid: 999992, command: 'node b.js', cwd: workspaceRoot, startedAt: '2026-10-01T00:01:00.000Z', lastProbeStatus: 'running', cleanupRequired: true },
      { schemaVersion: 1, owner: { workspace: fs.realpathSync(workspaceRoot), conversationId: s1, taskId: 't-bg', turnId: 'u-bg', toolCallId: 'c2' }, requestId: 'req-2', ownershipState: 'owned' },
    );
    await first.runtime.shutdown();

    const reopened = createRuntime();
    const ownershipBatchSpy = jest.spyOn(reopened.persistence, 'listManagedOwnerships');
    const ownershipWriteSpy = jest.spyOn(reopened.persistence, 'recordManagedOwnership');
    const checkpointsSpy = jest.spyOn(reopened.persistence, 'listRecentCheckpoints');
    const conversationsSpy = jest.spyOn(reopened.persistence, 'listConversations');

    const snap1 = reopened.runtime.getSnapshot({ conversationPage: true });
    expect(snap1.managedProcesses).toHaveLength(2);
    expect(ownershipBatchSpy).toHaveBeenCalledTimes(1);
    expect(checkpointsSpy).toHaveBeenCalledTimes(1);
    expect(conversationsSpy).toHaveBeenCalledTimes(1);
    ownershipWriteSpy.mockClear();

    const changesBeforeSnap2 = reopened.persistence.db.prepare('SELECT total_changes() AS n').get().n;
    const snap2 = reopened.runtime.getSnapshot({ conversationPage: true });
    expect(snap2.managedProcesses).toHaveLength(2);
    expect(reopened.persistence.db.prepare('SELECT total_changes() AS n').get().n).toBe(changesBeforeSnap2);
    expect(ownershipWriteSpy).not.toHaveBeenCalled();
    expect(ownershipBatchSpy).toHaveBeenCalledTimes(2);
    expect(checkpointsSpy).toHaveBeenCalledTimes(1);
    expect(conversationsSpy).toHaveBeenCalledTimes(1);
  });
});
