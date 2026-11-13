/// <reference path="./better-sqlite3.d.ts" />
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vm from 'vm';
import Database from 'better-sqlite3';

const product = process.env.A9_65_PRODUCT || path.resolve(__dirname, '../../product');
const read = (file: string) => fs.readFileSync(path.join(product, file), 'utf8');
const deferred = () => { let resolve!: (value?: any) => void; let reject!: (error: Error) => void; const promise = new Promise<any>((r, j) => { resolve = r; reject = j; }); return { promise, resolve, reject }; };
const tick = () => new Promise(r => setTimeout(r, 0));
async function bounded(promise: Promise<any>) { let timer: any; try { return await Promise.race([promise, new Promise((_r, reject) => { timer = setTimeout(() => reject(new Error('missing report terminal state')), 150); })]); } finally { clearTimeout(timer); } }
const stages = ['checkpoint_recovery', 'active_task_cancel', 'office_close', 'state_operations', 'managed_process_stop', 'background_manager_dispose'];

// Execute the production shutdown closure with controlled lifecycle peripherals.
function shutdownHarness(blocked?: string) {
  const gate = deferred(); const events: any[] = []; const release = jest.fn(); const office = jest.fn(() => blocked === 'office_close' ? gate.promise : Promise.resolve());
  const result = { stopped: [], leftToSystem: [], unresolved: [] };
  const manager = { list: () => [], getActiveCount: () => 0, dispose: jest.fn(() => blocked === 'background_manager_dispose' ? gate.promise.then(() => result) : Promise.resolve(result)) };
  const pending = new Set(blocked === 'state_operations' ? [gate.promise] : []);
  if (pending.size) gate.promise.then(() => pending.clear());
  const context: any = { Promise, Date, setTimeout, clearTimeout, config: { shutdownStageRecorder: (stage: string) => { events.push(['begin', stage]); return { end: () => events.push(['end', stage]) }; } },
    shutdownPromise: null, shutdownRequested: false, queueClosed: false, pauseQueue() {}, imageService: null, officeService: { close: office },
    loopTrustedRunner: { getBackgroundManager: () => manager }, workspaceLockReleased: false, lockHeld: true,
    persistence: { releaseWorkspaceLock: release }, canonicalWorkspace: '/test', ownerId: 'owner', checkpointRecoveryPending: blocked === 'checkpoint_recovery',
    checkpointRecoveryReady: blocked === 'checkpoint_recovery' ? gate.promise : Promise.resolve(), activeController: blocked === 'active_task_cancel' ? { abort: jest.fn() } : null,
    agentStatus: 'idle', pendingStateOperations: pending, managedStopPromise: blocked === 'managed_process_stop' ? gate.promise : null,
    currentPendingApproval: null, currentPendingQuestion: null, recordManagedHandle() {}, };
  const source = read('a9-agent-runtime.js');
  const start = source.includes('  let shutdownStage =') ? source.indexOf('  let shutdownStage =') : source.indexOf('  function shutdown(options');
  vm.runInNewContext(source.slice(start, source.indexOf('\n  return {\n    protocolVersion:', start)) + '\nthis.shutdown = shutdown; this.stage = () => typeof shutdownStage === "undefined" ? null : shutdownStage;', context);
  gate.promise.then(() => { context.activeController = null; });
  return { context, gate, events, release, office, manager, result };
}

function mainHarness(shutdown: any, stage = 'office_close') {
  const source = read('main.js'); const dialogs: string[] = []; const records: any[] = [];
  const close = jest.fn(); const quit = jest.fn();
  const runtime = { getSnapshot: () => ({ managedProcesses: [] }), getShutdownStage: () => stage };
  const context: any = { Promise, Error, Array, String, Date, setTimeout: (fn: any, ms: number) => setTimeout(fn, ms === 30000 ? 15 : ms), clearTimeout,
    a9Workspaces: { directory: () => [{ opened: true, workspaceId: 'one' }], getById: () => ({ runtime }), shutdown },
    diagnosticsLog: { record: (event: string, values: any) => { records.push({ event, ...values }); }, snapshot: () => ({ directory: '/日志/diagnostics' }) },
    dialog: { showErrorBox: (title: string, detail: string) => dialogs.push(title + detail) }, mainWindow: { close, isDestroyed: () => false }, app: { quit }, flightRecorder: { withoutStall: (_r: any, fn: any) => fn() } };
  vm.runInNewContext(source.slice(source.indexOf('let a9ShutdownComplete ='), source.indexOf('function beginA9ShutdownBeforeQuit')) + '\nthis.execute = executeA9ShutdownChoice;', context);
  return { context, dialogs, records, close, quit };
}

describe('A9-65 visible shutdown waits', () => {
  test.each(stages)('reports %s without ending cleanup or releasing its lock', async stage => {
    const h = shutdownHarness(stage); const first = h.context.shutdown({ cancelPending: true, stopManaged: false });
    const m = mainHarness(jest.fn(() => first), stage);
    try {
      expect(await bounded(m.context.execute())).toBe(false);
      expect(h.context.stage()).toBe(stage); expect(h.release).not.toHaveBeenCalled();
      expect(h.events).toContainEqual(['begin', stage]); expect(h.events).not.toContainEqual(['end', stage]);
      expect(m.dialogs.join('')).toContain(stage); expect(m.dialogs.join('')).toContain('/日志/diagnostics');
      expect(m.records).toContainEqual(expect.objectContaining({ event: 'shutdown-wait-reported', stage }));
    } finally { h.gate.resolve(h.result); await first; }
  });
  test.each([true, false])('retry shares one cleanup even with stopManaged=%s and late completion resumes close', async stopManaged => {
    const h = shutdownHarness('office_close'); const start = jest.fn(() => h.context.shutdown({ stopManaged })); const m = mainHarness(start);
    try {
      expect(await bounded(m.context.execute())).toBe(false);
      const retry = m.context.execute(); await tick();
      expect(start).toHaveBeenCalledTimes(1); expect(h.office).toHaveBeenCalledTimes(1);
      expect(h.context.shutdown({ stopManaged })).toBe(h.context.shutdown({ stopManaged }));
      expect(await bounded(retry)).toBe(false);
      h.gate.resolve(); await h.context.shutdown({ stopManaged }); await tick();
      expect(h.release).toHaveBeenCalledTimes(1); expect(h.manager.dispose).toHaveBeenCalledTimes(1); expect(m.close).toHaveBeenCalledTimes(1);
    } finally { h.gate.resolve(); }
  });
  test('window close and application quit share an attempt; late success quits exactly once', async () => {
    const gate = deferred(); const start = jest.fn(() => gate.promise); const m = mainHarness(start);
    try {
      expect(await bounded(m.context.execute('window'))).toBe(false);
      const quit = m.context.execute('quit'); await tick(); expect(start).toHaveBeenCalledTimes(1);
      expect(await bounded(quit)).toBe(false);
      gate.resolve({ unresolved: [], leftToSystem: [], stopped: [] });
      await tick(); expect(m.quit).toHaveBeenCalledTimes(1); expect(m.close).not.toHaveBeenCalled();
    } finally { gate.resolve({ unresolved: [], leftToSystem: [], stopped: [] }); }
  });
  test('normal cleanup keeps the baseline result and releases only after disposal', async () => {
    const h = shutdownHarness('background_manager_dispose'); const promise = h.context.shutdown();
    await tick(); expect(h.release).not.toHaveBeenCalled(); h.gate.resolve();
    expect(await promise).toBe(h.result); expect(h.release).toHaveBeenCalledTimes(1);
    expect(h.context.shutdown()).toBe(promise); expect(h.context.stage()).toBe(null);
    expect(h.events.filter(e => e[0] === 'begin').map(e => e[1])).toEqual(stages);
  });
  test('idle cleanup still releases its lock synchronously', async () => {
    const h = shutdownHarness(); h.context.officeService = null;
    const promise = h.context.shutdown(); expect(h.release).toHaveBeenCalledTimes(1);
    expect(await promise).toEqual({ stopped: [], leftToSystem: [], unresolved: [] });
    expect(h.events).toEqual([]);
  });
  test('report describes late automatic close without claiming exit was cancelled', async () => {
    const gate = deferred(); const m = mainHarness(() => gate.promise);
    try {
      expect(await bounded(m.context.execute())).toBe(false);
      expect(m.dialogs[0]).toContain('清理仍在继续');
      expect(m.dialogs[0]).toContain('窗口将在完成后自动关闭');
      expect(m.dialogs[0]).not.toContain('退出已取消');
      gate.resolve({ unresolved: [] }); await tick(); expect(m.close).toHaveBeenCalledTimes(1);
    } finally { gate.resolve({ unresolved: [] }); }
  });
  test('concurrent and repeated waiters share one report; late failure is reported once', async () => {
    const gate = deferred(); const start = jest.fn(() => gate.promise); const m = mainHarness(start);
    const timer = jest.fn(m.context.setTimeout); m.context.setTimeout = timer;
    try {
      const window = m.context.execute('window'); const quit = m.context.execute('quit');
      expect(await bounded(Promise.all([window, quit]))).toEqual([false, false]);
      expect(m.dialogs).toHaveLength(1); expect(m.records).toHaveLength(1);
      const timers = timer.mock.calls.length;
      expect(await bounded(m.context.execute())).toBe(false);
      expect(timer).toHaveBeenCalledTimes(timers); expect(start).toHaveBeenCalledTimes(1);
      expect(m.dialogs).toHaveLength(1);
      gate.reject(new Error('late cleanup failure')); await tick();
      expect(m.dialogs).toHaveLength(2); expect(m.close).not.toHaveBeenCalled(); expect(m.quit).not.toHaveBeenCalled();
    } finally { gate.resolve({ unresolved: [] }); }
  });
  test('report measures actual elapsed cleanup time when its callback is delayed', async () => {
    const gate = deferred(); const m = mainHarness(() => gate.promise); let now = 1000;
    m.context.Date = { now: () => now };
    try {
      const waiting = m.context.execute(); await tick(); now = 61000;
      expect(await bounded(waiting)).toBe(false);
      expect(m.records).toEqual([expect.objectContaining({ durationMs: 60000 })]);
    } finally { gate.resolve({ unresolved: [] }); await tick(); }
  });
  test.each([false, true])('in-flight stopManaged=%s refuses an opposite policy and preserves the original cleanup', async stopManaged => {
    const h = shutdownHarness('office_close'); const first = h.context.shutdown({ stopManaged });
    try {
      await tick();
      await expect(bounded(h.context.shutdown({ stopManaged: !stopManaged }))).rejects.toMatchObject({ code: 'A9_SHUTDOWN_POLICY_CONFLICT' });
      expect(h.context.shutdown({ stopManaged })).toBe(first);
      expect(h.release).not.toHaveBeenCalled(); expect(h.office).toHaveBeenCalledTimes(1);
      h.gate.resolve(); await first;
      expect(h.manager.dispose).toHaveBeenCalledTimes(1);
      expect(h.manager.dispose).toHaveBeenCalledWith({ stopManaged });
    } finally { h.gate.resolve(); await first; }
  });
});

function rendererFunction(file: string, name: string, end: string, context: any) {
  const source = read('renderer/' + file); const start = source.indexOf('  ' + (name === 'refreshDiagnostics' || name === 'refreshGit' ? 'async ' : '') + 'function ' + name + '(');
  const text = source.slice(start, source.indexOf(end, start));
  vm.runInNewContext(text + `\nthis.run = ${name};`, context); return context.run;
}
const nodes = () => { const map = new Map<string, any>(); return { el: (id: string) => { if (!map.has(id)) map.set(id, { textContent: '', children: [], appendChild(n: any) { this.children.push(n); } }); return map.get(id); }, document: { createElement: () => ({ textContent: '' }) } }; };

describe('A9-65 diagnostic projections', () => {
  test('panel shows directory, nonzero counters and persistence entries; empty counters stay hidden', async () => {
    for (const nonzero of [true, false]) {
      const dom = nodes(); const snapshot = { status: 'ready', persistenceDiagnostics: nonzero ? [{ code: 'A9_SQLITE_WAL_UNAVAILABLE', detail: '已有说明' }] : [] };
      const response = { diagnosticLog: { directory: '/诊断目录', writeFailureCount: nonzero ? 3 : 0, droppedCount: nonzero ? 4 : 0, suppressedCount: nonzero ? 5 : 0, ipcWaitSuspended: nonzero } };
      const run = rendererFunction('a9-workbench.js', 'refreshDiagnostics', '\n  // A9-55', { ...dom, state: { snapshot }, api: { getDiagnostics: async () => response }, runtimeDiagnostic: () => '' });
      await run(); const text = dom.el('diagnostics').children.map((n: any) => n.textContent).join('|');
      expect(text).toContain('/诊断目录');
      if (nonzero) for (const value of ['3', '4', '5', 'A9_SQLITE_WAL_UNAVAILABLE', '已有说明', 'IPC']) expect(text).toContain(value);
      else expect(text).not.toMatch(/写入失败|丢弃|抑制|IPC|WAL/);
    }
  });
  test.each(['a9-agent-panel.js', 'a9-workbench.js'])('%s displays Git diagnostic codes and preserves an ordinary non-repository', async file => {
    for (const diagnostics of [[], [{ code: 'A9_GIT_SPAWN_FAILED', detail: 'Git 不可用' }]]) {
      const dom = nodes(); const git = { isGit: false, degradedReason: '非 Git 工作区', entries: [], diagnostics };
      const context: any = { ...dom, lastGitStatus: null, state: { gitRequest: 0, snapshot: { status: 'ready' } }, a9: { gitStatus: async () => ({ ok: true, projection: git }) }, text: (id: string, value: string) => { dom.el(id).textContent = value; }, captureScope: () => ({}), sameScope: () => true, scopedApi: () => context.a9, canUseRuntime: () => true };
      if (file === 'a9-agent-panel.js') rendererFunction(file, 'renderGitStatus', '\n  async function chooseMode', context)(git);
      else await rendererFunction(file, 'refreshGit', '\n  function providerValues', context)();
      expect(dom.el('a9-git-status').textContent).toBe(diagnostics.length ? 'A9_GIT_SPAWN_FAILED: Git 不可用' : '非 Git 工作区');
    }
  });
  test('runtime reads at most 20 code/detail persistence facts and forwards Git diagnostics', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a9-65-runtime-')); const dbs: any[] = []; let runtime: any;
    try {
      const mod = require(path.join(product, 'a9-agent-runtime.js'));
      runtime = mod.createA9AgentRuntime({ workspaceRoot: root, dataRoot: path.join(root, 'data'), openDatabase: (f: string, o: any) => { const db = new Database(f, o); dbs.push(db); return db; },
        openPersistence: (values: any, open: any) => { const outcome = open(values); outcome.manager.getDiagnostics = () => Array.from({ length: 25 }, () => ({ code: 'A9_SQLITE_WAL_UNAVAILABLE', detail: '已有说明', rowId: 'private' })); return outcome; } });
      const snapshot = runtime.getSnapshot({ conversationPage: true }); expect(snapshot.persistenceDiagnostics).toHaveLength(20);
      expect(snapshot.persistenceDiagnostics[0]).toEqual({ code: 'A9_SQLITE_WAL_UNAVAILABLE', detail: '已有说明' });
      const git = await runtime.gitStatus(); expect(git.projection.isGit).toBe(false);
      expect(git.projection.diagnostics).toContainEqual(expect.objectContaining({ code: 'A9_GIT_NOT_REPOSITORY' }));
    } finally { await runtime?.shutdown(); for (const db of dbs) if (db.open) db.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });
});

async function realRuntime(extra: any, run: (runtime: any, log: any, root: string) => Promise<void>, shutdownOptions = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a9-65-real-')); const dbs: any[] = []; let runtime: any;
  const { createDiagnosticsLog, createFlightRecorder } = require('../../product/a9-diagnostics-log');
  const log = createDiagnosticsLog({ userDataPath: root }); const recorder = createFlightRecorder(log);
  try {
    // Production initializes this log at process startup. Idle shutdown no
    // longer creates it incidentally through empty stage records.
    await log.record('process-start', {});
    const mod = require(path.join(product, 'a9-agent-runtime.js'));
    runtime = mod.createA9AgentRuntime({ workspaceRoot: root, dataRoot: path.join(root, 'data'),
      openDatabase: (f: string, o: any) => { const db = new Database(f, o); dbs.push(db); return db; },
      shutdownStageRecorder: (stage: string) => recorder.begin('shutdown-stage', { stage }), ...extra });
    await runtime.whenReady(); await run(runtime, log, root);
  } finally {
    try { await runtime?.shutdown(shutdownOptions); await log.flush(); } finally {
      recorder.stop(); for (const db of dbs) if (db.open) db.close(); fs.rmSync(root, { recursive: true, force: true });
    }
  }
}

test.each([true, false])('real registry close(stopManaged=%s) refuses a conflicting application shutdown and retains the SQLite lock', async stopManaged => {
  const gate = deferred(); const runner = require('../../../runner/dist');
  let manager: any; let disposals = 0;
  const modules: any = Object.fromEntries(['core', 'gateway', 'state', 'workspace', 'runner'].map(name => [name, require(`../../../${name}/dist`)]));
  modules.gitAdapter = require('../../../git-adapter/dist');
  modules.runner = { ...runner, TrustedShellRunner: class extends runner.TrustedShellRunner {
    constructor(...args: any[]) { super(...args); manager = super.getBackgroundManager();
      const dispose = manager.dispose.bind(manager);
      manager.getActiveCount = () => disposals ? 0 : 1;
      manager.dispose = async (...values: any[]) => { disposals++; await gate.promise; return dispose(...values); };
    }
  } };
  try {
    await realRuntime({ modules }, async (runtime, log, root) => {
      const { createA9WorkspaceRegistry } = require(path.join(product, 'a9-workspace-registry.js'));
      const registry = createA9WorkspaceRegistry({ createRuntime: () => runtime });
      const entry = registry.open(root);
      const first = registry.close(entry.workspaceId, { stopManaged });
      const runtimeShutdown = runtime.shutdown({ stopManaged });
      try {
        const m = mainHarness(() => first, 'background_manager_dispose'); expect(await bounded(m.context.execute())).toBe(false);
        const conflict = await bounded(registry.shutdown({ stopManaged: !stopManaged }));
        expect(conflict.unresolved).toHaveLength(1);
        expect(conflict.stopped).toEqual([]); expect(conflict.leftToSystem).toEqual([]);
        expect(runtime.getShutdownStage()).toBe('background_manager_dispose'); expect(runtime.getSnapshot().lock.held).toBe(true);
        const db = new Database(path.join(root, 'data/a9-state.db'));
        try { expect((db.prepare('SELECT count(*) n FROM a9_workspace_locks').get() as any).n).toBe(1); } finally { db.close(); }
        await log.flush(); const lines = fs.readFileSync(path.join(log.snapshot().directory, 'critical.jsonl'), 'utf8');
        const rows = lines.trim().split('\n').map(line => JSON.parse(line));
        expect(rows).toContainEqual(expect.objectContaining({ event: 'shutdown-stage-begin', stage: 'background_manager_dispose' }));
        expect(rows).not.toContainEqual(expect.objectContaining({ event: 'shutdown-stage-end', stage: 'background_manager_dispose' }));
        expect(runtime.shutdown({ stopManaged })).toBe(runtimeShutdown); expect(disposals).toBe(1);
      } finally { gate.resolve(); await first; }
      expect(runtime.getSnapshot().lock.held).toBe(false);
    }, { stopManaged });
  } finally { gate.resolve(); }
});

describe('A9-65 secret verification reasons', () => {
  test.each(['读取失败', '内容不是合法 JSON', '内容不一致'])('%s never includes credential data', async reason => {
    const secret = 'A9_65_UNIQUE_CREDENTIAL_9ea4c1';
    const source = read('a9-agent-runtime.js'); const start = source.indexOf('  async function verifyPersistedSecretsReadable()');
    const context: any = { apiKeyVault: { loadApiKey: () => secret }, memoryApiKey: secret, memorySecrets: { headerValues: { Authorization: secret } },
      secretsVault: { loadApiKey: () => { if (reason === '读取失败') throw new Error(secret); return reason === '内容不是合法 JSON' ? '{' + secret : '{}'; } }, providerDiagnostics: null };
    vm.runInNewContext(source.slice(start, source.indexOf('\n  async function classifyProviderWithProbe', start)) + '\nthis.verify = verifyPersistedSecretsReadable; this.diagnostic = () => providerDiagnostics;', context);
    expect(await context.verify()).toBe(false); expect(context.diagnostic()).toEqual({ code: 'A9_PROVIDER_SECRET_VERIFY_FAILED', detail: reason });
    expect(JSON.stringify(context.diagnostic())).not.toContain(secret);
  });
});

test.each(['读取失败', '内容不是合法 JSON', '内容不一致'])('public configuration projects %s without leaking credentials into diagnostics, logs or snapshot', async reason => {
  const marker = 'A9_65_UNIQUE_CREDENTIAL_9ea4c1';
  const safeStorage = { isEncryptionAvailable: () => true, encryptString: () => Buffer.from('opaque-ciphertext'),
    decryptString: () => { if (reason === '读取失败') throw new Error(marker); return reason === '内容不是合法 JSON' ? '{' + marker : '{}'; } };
  await realRuntime({ safeStorage, vaultPlatform: 'win32' }, async (runtime, log) => {
    const response = await runtime.configureProvider({ baseUrl: 'https://example.invalid', model: 'fixture', customHeaders: { 'X-Private': marker }, rememberApiKey: true, skipProbe: true });
    const snapshot = runtime.getSnapshot();
    expect(snapshot.provider.diagnostics).toEqual({ code: 'A9_PROVIDER_SECRET_VERIFY_FAILED', detail: reason });
    expect(snapshot.provider.apiKey.remembered).toBe(false);
    expect(response.keyRemembered).toBe(false);
    await runtime.shutdown();
    await log.flush();
    const logs = fs.readdirSync(log.snapshot().directory).filter((name: string) => name.endsWith('.jsonl'))
      .map((name: string) => fs.readFileSync(path.join(log.snapshot().directory, name), 'utf8')).join('');
    expect(JSON.stringify({ response, snapshot, diagnostic: snapshot.provider.diagnostics, logs })).not.toContain(marker);
  });
});

const excluded = {
  'product:a9-request': ['a9.provider.configure', 'a9.provider.probe', 'a9.shell.configure', 'a9.workdir.link', 'a9.turn.submit', 'a9.task.continue', 'a9.turn.resumeApproval', 'a9.question.reply', 'a9.turn.stop', 'a9.workspace.close', 'a9.workdir.rename'],
  'desktop:request': ['workspace.select'],
};
function preloadHarness() {
  let api: any; const held = deferred(); const source = read('preload.js');
  const context: any = { process: { argv: [] }, setTimeout, clearTimeout, setInterval, clearInterval, Date, Promise, Map, Set,
    require: () => ({ contextBridge: { exposeInMainWorld: (_n: any, value: any) => { api = value; } }, ipcRenderer: { invoke: (channel: string) => channel === 'product:get-diagnostics' ? Promise.resolve({ diagnosticLog: { directory: '/诊断目录' } }) : held.promise } }) };
  vm.runInNewContext(source, context); return { api, held, context };
}
describe('A9-65 renderer request observation', () => {
  beforeEach(() => jest.useFakeTimers()); afterEach(() => jest.useRealTimers());
  test('pending request shows elapsed seconds and directory, then disappears on return', async () => {
    const h = preloadHarness(); const updates: any[] = [];
    expect(typeof h.api.onRequestWait).toBe('function'); h.api.onRequestWait((v: any) => updates.push(v));
    await h.api.getDiagnostics(); const pending = h.api.a9.snapshot();
    await jest.advanceTimersByTimeAsync(9000);
    expect(updates[updates.length - 1]).toMatchObject({ elapsedSeconds: 9, directory: '/诊断目录' });
    h.held.resolve({ ok: true }); await pending; expect(updates[updates.length - 1]).toBe(null);
  });
  test.each(Object.entries(excluded).flatMap(([channel, actions]) => actions.map(action => [channel, action])))('%s/%s is an intentional wait', async (channel, action) => {
    const h = preloadHarness(); const updates: any[] = []; expect(typeof h.api.onRequestWait).toBe('function'); h.api.onRequestWait((v: any) => updates.push(v));
    // Invoke the exact public request entry, with the real channel/action envelope.
    vm.runInNewContext(`this.pending = ${channel === 'product:a9-request' ? 'a9Request' : channel === 'desktop:request' ? 'request' : 'a8Request'}(${JSON.stringify(action)}, {});`, h.context);
    await jest.advanceTimersByTimeAsync(10000); expect(updates.filter(Boolean)).toHaveLength(0);
    h.held.resolve({ ok: true }); await h.context.pending;
  });
});
