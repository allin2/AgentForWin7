/// <reference path="./better-sqlite3.d.ts" />
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';

const { createA9AgentRuntime } = require('../../product/a9-agent-runtime');
const { createA9WorkspaceRegistry } = require('../../product/a9-workspace-registry');
const { createA9ProductRequestHandler } = require('../../product/a9-product-ipc');
const workspace = require('../../../workspace/dist');
const state = require('../../../state/dist');
const immediate = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

/** Real services and SQLite. Only readiness/validation scheduling is held by tests. */
function environment() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'a9-61-review-')));
  const a = path.join(root, 'A 中文'), b = path.join(root, 'B space');
  fs.mkdirSync(a); fs.mkdirSync(b);
  for (const directory of [a, b]) fs.mkdirSync(path.join(directory, '.git'));
  const services: any[] = [], databases: any[] = [], runtimes: any[] = [];
  let persistence: any;
  class ObservedWorkspace extends workspace.A9WorkspaceService {
    constructor(...args: any[]) { super(...args); services.push(this); }
  }
  const modules = {
    core: require('../../../core/dist'), gateway: require('../../../gateway/dist'), state,
    workspace: { ...workspace, A9WorkspaceService: ObservedWorkspace },
    runner: require('../../../runner/dist'), gitAdapter: require('../../../git-adapter/dist'),
  };
  const createRuntime = (workspaceRoot = a, host: any = {}) => {
    const open = host.openPersistence || ((_values: any, factory: any) => factory(_values));
    const runtime = createA9AgentRuntime({ ...host, modules, workspaceRoot, dataRoot: path.join(root, 'data'),
      ownerId: `a9-61-review-${process.pid}-${runtimes.length}`,
      openPersistence: (values: any, factory: any) => { const result = open(values, factory); persistence = result.manager; return result; },
      openDatabase: (file: string, options: any) => { const db = new Database(file, options); databases.push(db); return db; },
    });
    runtimes.push(runtime);
    return runtime;
  };
  const registry = createA9WorkspaceRegistry({ createRuntime });
  const handler = createA9ProductRequestHandler({ workspaceRegistry: registry, isValidRendererSender: () => true });
  const scope = () => { const entry = registry.getActive(); return { workspaceId: entry.workspaceId,
    conversationId: entry.runtime.getSnapshot().activeConversationId }; };
  return { root, a, b, services, databases, createRuntime, registry, scope,
    get persistence() { return persistence; },
    call: (action: string, payload: any, target = scope()) => handler({}, { schemaVersion: 9, action, payload, scope: target }),
    closeDatabases: () => { for (const db of databases) if (db.open) db.close(); },
    async close() {
      try { for (const runtime of runtimes) await runtime.shutdown(); }
      finally { for (const db of databases) if (db.open) db.close(); fs.rmSync(root, { recursive: true, force: true }); }
    },
  };
}

afterEach(() => jest.restoreAllMocks());

async function seedCrash(f: ReturnType<typeof environment>, includeContinuation = false) {
  const first = f.createRuntime(); const sessionId = first.getSnapshot().activeConversationId;
  await f.services[0].write('recover.txt', 'durable fact', { turnId: 'crash-turn' });
  f.persistence.upsertTask('crash-task', sessionId, 'active');
  f.persistence.upsertTurn('crash-turn', 'crash-task', sessionId, 'active');
  f.persistence.recordModelEvent(sessionId, null, 'conversation.request', {
    schemaVersion: 1, taskId: 'crash-task', requestPrompt: 'recover the durable fixture fact',
  });
  if (includeContinuation) {
    f.persistence.upsertTask('continue-task', sessionId, 'active');
    f.persistence.upsertTurn('continue-turn', 'continue-task', sessionId, 'active');
    f.persistence.recordModelEvent(sessionId, null, 'conversation.request', {
      schemaVersion: 1, taskId: 'continue-task', requestPrompt: 'continue the independently checkpointed task',
    });
    f.persistence.saveCheckpoint({ turnId: 'continue-turn', sessionId, payload: {} });
  }
  await first.shutdown(); f.closeDatabases();
  return sessionId;
}

function holdRecovery(gate: ReturnType<typeof deferred>) {
  const load = workspace.CheckpointManager.prototype.loadCheckpointAsync;
  jest.spyOn(workspace.CheckpointManager.prototype, 'loadCheckpointAsync').mockImplementation(function(this: any, id: any) {
    return id === 'crash-turn' ? gate.promise.then(() => load.call(this, id)) : load.call(this, id);
  });
}

describe('A9-61 review wait boundaries', () => {
  it('F1 revalidates real A/A1 scope after readiness before saving a draft into A2', async () => {
    const f = environment(); const gate = deferred();
    try {
      const runtime = f.registry.activate(f.a).runtime;
      await runtime.whenReady();
      const first = f.scope(); runtime.createConversation(); const second = f.scope();
      runtime.activateConversation(first.conversationId);
      runtime.whenReady = () => gate.promise;
      const switching = f.call('a9.conversation.activate', { conversationId: second.conversationId }, first);
      const saving = f.call('a9.draft.save', { text: 'A1-ONLY-DRAFT' }, first);
      gate.release();
      expect((await switching).ok).toBe(true);
      expect(await saving).toMatchObject({ ok: false, error: { code: 'A9_SCOPE_STALE' } });
      expect(runtime.getSnapshot().draft.text).toBe('');
    } finally { gate.release(); await f.close(); }
  });

  it('F2 finishes real recovery reconciliation before releasing the workspace lock', async () => {
    const f = environment(); const gate = deferred();
    let pendingShutdown: any;
    try {
      await seedCrash(f); holdRecovery(gate);
      const runtime = f.createRuntime();
      const order: string[] = [];
      const reconcile = f.persistence.reconcileInterruptedWorkspaceCheckpoints.bind(f.persistence);
      jest.spyOn(f.persistence, 'reconcileInterruptedWorkspaceCheckpoints').mockImplementation((...args: any[]) => {
        const result = reconcile(...args); order.push('reconcile'); return result;
      });
      const release = f.persistence.releaseWorkspaceLock.bind(f.persistence);
      jest.spyOn(f.persistence, 'releaseWorkspaceLock').mockImplementation((...args: any[]) => {
        order.push('release'); return release(...args);
      });
      pendingShutdown = runtime.shutdown();
      const heldDuringRecovery = runtime.getSnapshot().lock.held;
      gate.release(); await runtime.whenReady(); await pendingShutdown;
      expect(heldDuringRecovery).toBe(true);
      expect(order).toEqual(['reconcile', 'release']);
      expect(f.persistence.getCheckpoint('crash-turn').payload.recoveredFromWorkspaceManifest).toBe(true);
      expect(runtime.getSnapshot().checkpointRecoveryDiagnostics ?? null).toBeNull();
    } finally { gate.release(); if (pendingShutdown) await pendingShutdown; await f.close(); }
  });

  it('F1 rejects a stale current workspace while preserving both real drafts', async () => {
    const f = environment(); const gate = deferred();
    try {
      const runtime = f.registry.activate(f.a).runtime; const target = f.scope();
      runtime.whenReady = () => gate.promise;
      const saving = f.call('a9.draft.save', { text: 'A-ONLY' }, target);
      const other = f.registry.activate(f.b).runtime;
      gate.release();
      expect(await saving).toMatchObject({ ok: false, error: { code: 'A9_SCOPE_STALE' } });
      expect(runtime.getSnapshot().draft.text).toBe('');
      expect(other.getSnapshot().draft.text).toBe('');
    } finally { gate.release(); await f.close(); }
  });

  it('F1 dispatches a correct scope and serves Stop before held readiness settles', async () => {
    const f = environment(); const gate = deferred();
    try {
      const runtime = f.registry.activate(f.a).runtime;
      runtime.whenReady = () => gate.promise;
      const saving = f.call('a9.draft.save', { text: 'correct scope' });
      let stopped = false;
      const stop = f.call('a9.turn.stop', {}).then((result: any) => { stopped = true; return result; });
      await immediate();
      expect(stopped).toBe(true);
      expect(await stop).toMatchObject({ ok: false, error: { code: 'NO_ACTIVE_TURN_OR_MANAGED_PROCESS' } });
      expect(runtime.getSnapshot().draft.text).toBe('');
      gate.release(); expect((await saving).ok).toBe(true);
      expect(runtime.getSnapshot().draft.text).toBe('correct scope');
    } finally { gate.release(); await f.close(); }
  });

  it('F1 rejects a closed/replaced runtime even when persisted scope IDs match', async () => {
    const f = environment(); const gate = deferred();
    try {
      const runtime = f.registry.activate(f.a).runtime; const target = f.scope();
      runtime.whenReady = () => gate.promise;
      const saving = f.call('a9.draft.save', { text: 'old runtime only' }, target);
      await f.registry.close(target.workspaceId);
      const replacement = f.registry.activate(f.a).runtime;
      expect(f.scope()).toEqual(target); expect(replacement).not.toBe(runtime);
      gate.release();
      expect(await saving).toMatchObject({ ok: false, error: { code: 'A9_SCOPE_STALE' } });
      expect(replacement.getSnapshot().draft.text).toBe('');
    } finally { gate.release(); await f.close(); }
  });

  it('F1 rejects dispatch while global Provider identity is changing', async () => {
    const f = environment(); const ready = deferred(), provider = deferred();
    let configuring: Promise<any> | undefined;
    try {
      const runtime = f.registry.activate(f.a).runtime;
      runtime.whenReady = () => ready.promise;
      const saving = f.call('a9.draft.save', { text: 'blocked during provider change' });
      const configure = runtime.configureProvider;
      runtime.configureProvider = async (input: any) => { await provider.promise; return configure(input); };
      configuring = f.registry.configureProvider(runtime, { baseUrl: 'https://fixture.invalid', model: 'fixture', skipProbe: true });
      ready.release();
      expect(await saving).toMatchObject({ ok: false, error: { code: 'A9_APPLICATION_BUSY' } });
      expect(runtime.getSnapshot().draft.text).toBe('');
      provider.release(); await configuring;
    } finally { ready.release(); provider.release(); if (configuring) await configuring; await f.close(); }
  });

  it('F1 keeps unscoped snapshots readable during Provider configuration while rejecting mutations', async () => {
    const f = environment(); const provider = deferred();
    let configuring: Promise<any> | undefined;
    try {
      const entry = f.registry.activate(f.a), runtime = entry.runtime;
      await runtime.whenReady();
      const configure = runtime.configureProvider;
      runtime.configureProvider = async (input: any) => { await provider.promise; return configure(input); };
      configuring = f.registry.configureProvider(runtime, { baseUrl: 'https://fixture.invalid', model: 'fixture', skipProbe: true });
      const handler = createA9ProductRequestHandler({ workspaceRegistry: f.registry,
        getA9Runtime: async () => runtime, isValidRendererSender: () => true });
      const response = await handler({}, { schemaVersion: 9, action: 'a9.snapshot.get', payload: {} });
      expect(response).toMatchObject({ ok: true, snapshot: { status: 'ready', activeConversationId: f.scope().conversationId } });
      expect(await f.call('a9.draft.save', { text: 'must stay blocked' })).toMatchObject({ ok: false, error: { code: 'A9_APPLICATION_BUSY' } });
      expect(runtime.getSnapshot().draft.text).toBe('');
    } finally { provider.release(); if (configuring) await configuring; await f.close(); }
  });

  it('F1 preserves the inbox scope of an inactive conversation in a resident workspace', async () => {
    const f = environment(); const gate = deferred();
    try {
      const runtime = f.registry.activate(f.a).runtime; const first = f.scope();
      runtime.createConversation(); runtime.whenReady = () => gate.promise;
      const visiting = f.call('a9.conversation.visit', { conversationId: first.conversationId }, first);
      f.registry.activate(f.b); gate.release();
      expect(await visiting).toEqual({ ok: true, conversationId: first.conversationId });
      expect(f.persistence.getConversationMetadata(first.conversationId).inbox.lastVisitedAt).toEqual(expect.any(String));
    } finally { gate.release(); await f.close(); }
  });

  it('F2 preserves synchronous lock release for an immediate ordinary reopen', async () => {
    const f = environment();
    try {
      const first = f.createRuntime(); const closing = first.shutdown();
      expect(first.getSnapshot().lock.held).toBe(false);
      const reopened = f.createRuntime();
      expect(reopened.getSnapshot().lock.held).toBe(true);
      await closing;
      expect(reopened.getSnapshot().lock.held).toBe(true);
    } finally { await f.close(); }
  });

  it('F2 prevents a Turn and continuation waiting on recovery from starting after shutdown intent', async () => {
    const f = environment(); const gate = deferred();
    let closing: Promise<any> | undefined;
    try {
      await seedCrash(f, true); holdRecovery(gate);
      let requests = 0;
      const runtime = f.createRuntime(f.a, { wrapProvider: () => ({ sendStreamRequest: async () => {
        requests += 1; return { id: 'unexpected', content: 'must never run', finishReason: 'stop' };
      } }) });
      runtime.setMode('full_access');
      await runtime.configureProvider({ baseUrl: 'https://fixture.invalid', model: 'fixture', skipProbe: true });
      const fact = runtime.getSnapshot().recoveryTasks.find((item: any) => item.taskId === 'continue-task');
      const turn = runtime.submitTurn('must not create another task');
      const continuation = runtime.continueTask({ conversationId: fact.conversationId, taskId: fact.taskId,
        interruptedTurnId: fact.interruptedTurnId, recoveryRevision: fact.recoveryRevision });
      closing = runtime.shutdown(); gate.release();
      expect(await turn).toMatchObject({ ok: false, error: { code: 'A9_RUNTIME_SHUTDOWN' } });
      expect(await continuation).toMatchObject({ ok: false, error: { code: 'A9_RUNTIME_SHUTDOWN' } });
      await closing;
      expect(requests).toBe(0);
      expect(f.persistence.db.prepare('SELECT count(*) AS n FROM a9_tasks').get()).toEqual({ n: 2 });
      expect(runtime.getSnapshot().lock.held).toBe(false);
      f.closeDatabases(); await immediate(); // no pending recovery/caller writes after DB close
    } finally { gate.release(); if (closing) await closing; await f.close(); }
  });

  it('F2 makes registry close/reopen wait for source-owned recovery without writing into its sibling', async () => {
    const f = environment(); const gate = deferred();
    let closing: Promise<any> | undefined;
    try {
      const sessionId = await seedCrash(f); holdRecovery(gate);
      const entry = f.registry.activate(f.a); const runtime = entry.runtime;
      closing = f.registry.close(entry.workspaceId);
      const sibling = f.registry.activate(f.b).runtime;
      expect(() => f.registry.open(f.a)).toThrow(expect.objectContaining({ code: 'A9_APPLICATION_BUSY' }));
      expect(runtime.getSnapshot().lock.held).toBe(true);
      expect(sibling.getSnapshot().checkpoints).toEqual([]);
      gate.release(); await closing;
      expect(f.persistence.getCheckpoint('crash-turn').sessionId).toBe(sessionId);
      expect(sibling.getSnapshot().checkpoints).toEqual([]);
      const replacement = f.registry.activate(f.a).runtime;
      expect(replacement).not.toBe(runtime);
      expect(replacement.getSnapshot().lock.held).toBe(true);
      expect(replacement.getSnapshot().checkpoints).toEqual(expect.arrayContaining([expect.objectContaining({ turnId: 'crash-turn' })]));
    } finally { gate.release(); if (closing) await closing; await f.close(); }
  });

  it('F1 refuses an unregistered Runtime resumed after shutdown intent', async () => {
    const f = environment(); const gate = deferred();
    try {
      const runtime = f.createRuntime(); runtime.whenReady = () => gate.promise;
      const handler = createA9ProductRequestHandler({ getA9Runtime: () => runtime, isValidRendererSender: () => true });
      const saving = handler({}, { schemaVersion: 9, action: 'a9.draft.save', payload: { text: 'late draft' } });
      await immediate(); await runtime.shutdown(); gate.release();
      expect(await saving).toMatchObject({ ok: false, error: { code: 'A9_RUNTIME_SHUTDOWN' } });
      expect(runtime.getSnapshot().draft.text).toBe('');
    } finally { gate.release(); await f.close(); }
  });

  it('F2 waits for an admitted Undo caller and prevents post-shutdown file changes', async () => {
    const f = environment(); const gate = deferred(), entered = deferred();
    let closing: Promise<any> | undefined, undo: Promise<any> | undefined;
    try {
      const runtime = f.createRuntime();
      await f.services[0].write('note.txt', 'keep after shutdown', { turnId: 'undo-turn' });
      f.persistence.saveCheckpoint({ turnId: 'undo-turn', sessionId: runtime.getSnapshot().activeConversationId, payload: {} });
      const reconcile = f.services[0].reconcilePendingExternalBaseline.bind(f.services[0]);
      jest.spyOn(f.services[0], 'reconcilePendingExternalBaseline').mockImplementation(async (...args: any[]) => {
        entered.release(); await gate.promise; return reconcile(...args);
      });
      undo = runtime.undoTurn('undo-turn'); const outcome = undo!.then(() => null, error => error);
      await entered.promise; closing = runtime.shutdown();
      expect(runtime.getSnapshot().lock.held).toBe(true);
      gate.release(); expect(await outcome).toMatchObject({ code: 'A9_RUNTIME_SHUTDOWN' });
      await closing;
      expect(fs.readFileSync(path.join(f.a, 'note.txt'), 'utf8')).toBe('keep after shutdown');
      f.closeDatabases(); await immediate();
    } finally { gate.release(); if (undo) await undo.catch(() => {}); if (closing) await closing; await f.close(); }
  });

  it('F2 retains the existing unresolved shutdown deadline when an active model ignores cancellation', async () => {
    const f = environment(); const gate = deferred(), entered = deferred();
    let turn: Promise<any> | undefined;
    try {
      const runtime = f.createRuntime(f.a, { wrapProvider: () => ({ sendStreamRequest: async () => {
        entered.release(); await gate.promise; return { id: 'held', content: 'late', finishReason: 'stop' };
      } }) });
      runtime.setMode('full_access');
      await runtime.configureProvider({ baseUrl: 'https://fixture.invalid', model: 'fixture', skipProbe: true });
      turn = runtime.submitTurn('hold until released'); await entered.promise;
      // Deterministically cross the existing deadline without a 10-second wait.
      // No assertion depends on elapsed milliseconds.
      const now = Date.now(); let reads = 0;
      const clock = jest.spyOn(Date, 'now').mockImplementation(() => now + (reads++ === 0 ? 0 : 20_000));
      const cleanup = await runtime.shutdown(); clock.mockRestore();
      expect(cleanup.unresolved).toContain('active turn cleanup did not settle before the 10 second shutdown deadline');
      expect(runtime.getSnapshot().lock.held).toBe(true);
      gate.release(); await turn;
      expect((await runtime.shutdown()).unresolved).toEqual([]);
      expect(runtime.getSnapshot().lock.held).toBe(false);
    } finally { gate.release(); if (turn) await turn; await f.close(); }
  });

  it('F2 permits an explicit correct-scope continuation after recovery with zero automatic replay', async () => {
    const f = environment(); let requests = 0;
    try {
      await seedCrash(f);
      const runtime = f.createRuntime(f.a, { wrapProvider: () => ({ sendStreamRequest: async () => {
        requests += 1; return { id: 'continued', content: 'continued safely', finishReason: 'stop' };
      } }) });
      await runtime.whenReady();
      runtime.setMode('full_access');
      await runtime.configureProvider({ baseUrl: 'https://fixture.invalid', model: 'fixture', skipProbe: true });
      expect(requests).toBe(0);
      const fact = runtime.getSnapshot().recoveryTasks[0]; expect(fact).toMatchObject({ canContinue: true });
      const result = await runtime.continueTask({ conversationId: fact.conversationId, taskId: fact.taskId,
        interruptedTurnId: fact.interruptedTurnId, recoveryRevision: fact.recoveryRevision });
      expect(result.ok).toBe(true); expect(requests).toBe(1);
      expect(f.persistence.db.prepare("SELECT count(*) AS n FROM a9_tasks WHERE status='active'").get()).toEqual({ n: 0 });
    } finally { await f.close(); }
  });

  it('F4 rejects a foreign Diff synchronously before and during startup recovery', async () => {
    const f = environment(); const gate = deferred();
    try {
      const runtime = f.createRuntime(); const foreignSession = runtime.getSnapshot().activeConversationId;
      f.persistence.saveCheckpoint({ turnId: 'foreign-turn', sessionId: foreignSession, payload: {} });
      await f.services[0].write('foreign.txt', 'foreign interrupted fact', { turnId: 'foreign-pending' });
      f.persistence.upsertTask('foreign-task', foreignSession, 'active');
      f.persistence.upsertTurn('foreign-pending', 'foreign-task', foreignSession, 'active');
      runtime.createConversation();
      expect(() => runtime.getDiff('foreign-turn')).toThrow('A9_CHECKPOINT_CONVERSATION_MISMATCH');
      const sessionId = runtime.getSnapshot().activeConversationId;
      await f.services[0].write('recover.txt', 'durable fact', { turnId: 'crash-turn' });
      f.persistence.upsertTask('crash-task', sessionId, 'active');
      f.persistence.upsertTurn('crash-turn', 'crash-task', sessionId, 'active');
      await runtime.shutdown(); f.closeDatabases(); holdRecovery(gate);
      const reopened = f.createRuntime();
      expect(() => reopened.getDiff('foreign-turn')).toThrow('A9_CHECKPOINT_CONVERSATION_MISMATCH');
      expect(() => reopened.getDiff('foreign-pending')).toThrow('A9_CHECKPOINT_CONVERSATION_MISMATCH');
      const diff = reopened.getDiff('crash-turn');
      expect(typeof diff.then).toBe('function'); gate.release();
      expect((await diff).ok).toBe(true);
    } finally { gate.release(); await f.close(); }
  });

  it.each(['normal', 'listing-failure'])('F3 revokes both populated caches before new-secret validation yields (%s)', async failure => {
    const f = environment(); const gate = deferred(), entered = deferred();
    const secret = 'NEWLY-REGISTERED-CHECKPOINT-SECRET-61';
    let configuring: Promise<any> | undefined;
    try {
      // TEST_ONLY model output; no network is needed to instantiate the real loop manager.
      const baseUrl = 'http://fixture.invalid';
      const runtime = f.createRuntime(f.a, { wrapProvider: () => ({ sendStreamRequest: async () => ({
        content: 'done', toolCalls: [], finishReason: 'stop', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      }) }) });
      runtime.setMode('full_access');
      await runtime.configureProvider({ baseUrl, model: 'fixture', skipProbe: true });
      fs.writeFileSync(path.join(f.a, 'note.txt'), secret, 'utf8');
      await f.services[0].read('note.txt');
      await f.services[0].write('note.txt', 'safe replacement', { turnId: 'secret-turn' });
      f.persistence.saveCheckpoint({ turnId: 'secret-turn', sessionId: runtime.getSnapshot().activeConversationId, payload: {} });
      expect((await runtime.submitTurn('complete without tools')).ok).toBe(true);
      expect(f.services).toHaveLength(2);
      const managers = f.services.map(service => service.getCheckpointManager());
      expect(managers[0]).not.toBe(managers[1]);
      for (const manager of managers) {
        expect(manager.loadCheckpoint('secret-turn')).toBeDefined();
        expect(JSON.stringify(manager.getTurnDiff('secret-turn'))).toContain(secret);
      }
      if (failure === 'listing-failure') jest.spyOn(managers[1], 'listPersistedTurns').mockImplementation(() => {
        throw new Error('TEST_ONLY_CHECKPOINT_LISTING_FAILED');
      });
      const validate = managers[0].revalidatePersistedTurnsAsync.bind(managers[0]);
      // Start real validation (which revokes manager 1), then hold its completion.
      jest.spyOn(managers[0], 'revalidatePersistedTurnsAsync').mockImplementation(() => {
        const result = validate();
        const settled = result.then(() => null, (error: any) => error);
        entered.release();
        return gate.promise.then(async () => { const error = await settled; if (error) throw error; });
      });
      configuring = runtime.configureProvider({ baseUrl, model: 'fixture', apiKey: secret, skipProbe: true });
      const configured = configuring!.then(() => null, error => error);
      await entered.promise;
      let readError: any, exposed = false;
      try { exposed = JSON.stringify(await runtime.getDiff('secret-turn')).includes(secret); }
      catch (error) { readError = error; }
      gate.release();
      const configurationError = await configured;
      expect(exposed).toBe(false);
      expect(String(readError && readError.message)).toContain('A9_CHECKPOINT_SECRET_BLOCKED');
      expect(String(configurationError && configurationError.message)).toContain('A9_CHECKPOINT_SECRET_BLOCKED');
      expect(JSON.stringify(runtime.getSnapshot())).not.toContain(secret);
      expect(JSON.stringify(f.persistence.listSessionEvents(runtime.getSnapshot().activeConversationId))).not.toContain(secret);
    } finally {
      gate.release(); if (configuring) await configuring.catch(() => {});
      await f.close();
    }
  });
});
