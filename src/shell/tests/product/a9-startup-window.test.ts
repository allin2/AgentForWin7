import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vm from 'vm';
import { EventEmitter } from 'events';

const temporaryWorkspaces: string[] = [];
const cleanups: Array<() => void> = [];
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('STARTUP_TEST_CONDITION_NOT_REACHED');
    await new Promise(resolve => setImmediate(resolve));
  }
}
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  for (const workspace of temporaryWorkspaces.splice(0)) fs.rmSync(workspace, { recursive: true, force: true });
});

function loadMainHarness(options: { failHost?: boolean; deferPaint?: boolean; restore?: Promise<void>; platform?: NodeJS.Platform; appAlreadyReady?: boolean; ordinaryWorkspace?: boolean; hasLock?: boolean; errorDialog?: () => void } = {}) {
  const productMain = process.env.A9_62_REVIEW_MAIN || path.join(__dirname, '..', '..', 'product', 'main.js');
  const source = fs.readFileSync(productMain, 'utf8');
  const calls: string[] = [];
  const records: Array<{ event: string; values: any; sync?: boolean }> = [];
  const workspacePath = options.restore || options.ordinaryWorkspace ? fs.mkdtempSync(path.join(os.tmpdir(), 'w7ca-startup-')) : '/workspace';
  if (options.restore || options.ordinaryWorkspace) temporaryWorkspaces.push(workspacePath);
  let a9Config: any;
  const ipc: Record<string, any> = {};
  const app = new EventEmitter() as any;
  app.disableHardwareAcceleration = () => calls.push('app.disableHardwareAcceleration');
  // Readiness is not recorded as a call: it is a gate, not a policy action.
  app.isReady = () => Boolean(options.appAlreadyReady);
  app.requestSingleInstanceLock = () => options.hasLock !== false;
  app.whenReady = () => { calls.push('app.whenReady'); return Promise.resolve(); };
  app.getPath = (name: string) => {
    if (name === 'documents') throw new Error('DEFAULT_ROOT_MUST_STAY_LAZY');
    return '/tmp/a9-startup-test';
  };
  app.quit = () => { calls.push('app.quit'); app.emit('before-quit', { preventDefault() {} }); app.emit('will-quit'); app.emit('quit', {}, 0); };
  app.exit = () => calls.push('app.exit');
  const window = new (class extends EventEmitter {
    webContents: any = new EventEmitter(); destroyed = false;
    constructor() { super(); this.webContents.send = () => {}; }
    setMenuBarVisibility() {} loadFile() { if (!options.deferPaint) process.nextTick(() => this.emit('ready-to-show')); return Promise.resolve(); }
    show() { calls.push('window.show'); } focus() {} isDestroyed() { return this.destroyed; } isMinimized() { return false; } restore() {}
    destroy() { this.destroyed = true; this.emit('closed'); } close() { this.emit('close', { preventDefault() {} }); }
  })();
  const electron = { app, BrowserWindow: class { constructor() { return window as any; } }, dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showErrorBox() { calls.push('error-dialog'); if (options.errorDialog) options.errorDialog(); }, showMessageBox: async () => ({ response: 0 }) }, ipcMain: { handle: (name: string, handler: any) => { ipc[name] = handler; }, on: () => {} }, safeStorage: {}, session: { defaultSession: {} } };
  const host = { selectWorkspace: async () => { calls.push('restore.start'); if (options.restore) await options.restore; calls.push('restore.end'); return { workspacePath, displayName: 'test' }; }, listSessions: () => [], createSession: () => ({ sessionId: 's1' }), getDiagnostics: () => ({}), getSettings: () => ({}), dispose: () => calls.push('host.dispose'), getActiveWorkspacePath: () => null };
  const local = (request: string): any => {
    if (request.endsWith('/a9-diagnostics-log')) {
      const { createFlightRecorder, errorFacts } = require(process.env.A9_62_REVIEW_LOGGER || '../../product/a9-diagnostics-log');
      const record = async (event: string, values: any) => { records.push({ event, values }); return true; };
      const log = { record, critical: record, checkpoint: record, criticalCheckpoint: record, fatal: record,
        criticalSync: (event: string, values: any) => { records.push({ event, values, sync: true }); return true; },
        stop() {}, snapshot: () => ({ directory: '/test-only/diagnostics', recordCount: records.length }) };
      return { errorFacts, createDiagnosticsLog: () => log, createFlightRecorder: () => {
        const recorder = createFlightRecorder(log); cleanups.push(() => recorder.stop()); return recorder;
      } };
    }
    if (request.endsWith('/policy')) return { createWindowOptions: () => ({}), isTrustedLocalUrl: () => true };
    if (request.endsWith('/desktop-ipc')) return { createDesktopRequestHandler: () => async (event: any) => { if (event.sender !== window.webContents) throw new Error('RENDERER_CAPABILITY_DENIED'); calls.push('desktop.handler'); return { ok: true }; } };
    if (request.endsWith('/a8-product-ipc')) return { createA8ProductRequestHandler: () => async () => ({ ok: true }) };
    if (request.endsWith('/a9-product-ipc')) return { createA9ProductRequestHandler: (config: any) => { a9Config = config; return async () => ({ ok: true }); } };
    if (request.endsWith('/a9-workspace-registry')) return require('../../product/a9-workspace-registry');
    if (request.endsWith('/a9-agent-runtime')) return {
      createA9AgentRuntime: () => ({
        getWorkdirInfo: () => { throw Object.assign(new Error('ordinary workspace'), { code: 'A9_WORKDIR_NOT_AUTO' }); },
        getSnapshot: () => ({ status: 'ready', activeConversationId: 'ordinary', conversationControls: { canSwitch: true } }),
      }),
      openA9RuntimePersistence: () => ({ status: 'ready', manager: { getWorkspaceWorkdir: () => null } }),
    };
    if (request.endsWith('/a9-package-runtime')) return { loadA9PackageRuntime: () => null };
    if (request.endsWith('/active-workspace-store')) return { createActiveWorkspaceStore: () => ({ load: () => options.restore ? { workspacePath } : null, save() {} }) };
    if (request.endsWith('/security-policy')) return { installSessionPolicy() {}, installWindowPolicy() {} };
    if (request.endsWith('/desktop-host')) return { createDesktopHost: () => { calls.push('createDesktopHost'); if (options.failHost) throw new Error('HOST_FAIL'); return host; }, serializeError: (e: any) => ({ code: e.code || 'ERR', message: e.message }) };
    if (request.endsWith('/credential-vault')) return { createDpapiCredentialVault: () => ({}) };
    if (request.endsWith('/runner-runtime')) return { createProductRunner: () => null };
    if (request.endsWith('/rc-composition')) return { createRcComposition: () => null };
    if (request.endsWith('/dist/ipc/schema')) return { schemaValidator: { validateMessage: () => ({ valid: true, errors: [] }) } };
    if (request.endsWith('/dist/ipc/messages')) return { IPCDirection: { RENDERER_TO_CORE: 'renderer-to-core', CORE_TO_RENDERER: 'core-to-renderer' }, IPCMessageType: { TASK_EVENT: 'task:event', WORKSPACE_SELECTED: 'workspace:selected' } };
    throw new Error(`unexpected local require ${request}`);
  };
  const fsMock = { ...fs, existsSync: () => false };
  const processMock = Object.create(process);
  const processEvents = new EventEmitter();
  processMock.on = processEvents.on.bind(processEvents);
  Object.defineProperty(processMock, 'platform', { value: options.platform || process.platform });
  const context: any = { require: (request: string) => request === 'electron' ? electron : request.startsWith('.') ? local(path.resolve(path.dirname(productMain), request)) : request === 'fs' ? fsMock : require(request), __dirname: path.dirname(productMain), __filename: productMain, process: processMock, console, Buffer, setImmediate, clearTimeout, setTimeout, Promise, Date, Object, String, Number, Array, JSON, Error };
  vm.runInNewContext(source, context, { filename: productMain });
  return { app, window, ipc, calls, a9Config, workspacePath, records, processEvents };
}

describe('A9-17 real main entry startup ordering', () => {
  test('disables hardware acceleration on Windows before app readiness', () => {
    const h = loadMainHarness({ platform: 'win32' });
    expect(h.calls.slice(0, 2)).toEqual(['app.disableHardwareAcceleration', 'app.whenReady']);
  });

  test('keeps hardware acceleration policy unchanged outside Windows', () => {
    const h = loadMainHarness({ platform: 'darwin' });
    expect(h.calls).not.toContain('app.disableHardwareAcceleration');
  });

  // WIN7-33 regression: Electron rejects disableHardwareAcceleration() once the
  // app is ready.  The packaged entry loads this module before readiness, but
  // the candidate acceptance driver requires this module from inside
  // app.whenReady(), so the unguarded call aborted every driver phase on the
  // target machine and the mandatory product-chain gate could not run at all.
  test('loads after readiness without an illegal late rendering call', () => {
    const h = loadMainHarness({ platform: 'win32', appAlreadyReady: true });
    expect(h.calls).not.toContain('app.disableHardwareAcceleration');
    expect(h.calls).toContain('app.whenReady');
  });

  // The guard must be readiness-based, never a blanket Windows exemption: as
  // long as the entry loads before readiness the Windows policy still applies.
  test('still applies the Windows rendering policy on every pre-ready load', () => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const h = loadMainHarness({ platform: 'win32' });
      expect(h.calls).toContain('app.disableHardwareAcceleration');
    }
  });

  test('defers host creation until ready-to-show and gates valid IPC', async () => {
    const h = loadMainHarness();
    await Promise.resolve();
    expect(h.calls).not.toContain('createDesktopHost');
    await until(() => h.calls.includes('createDesktopHost'));
    expect(h.calls).toContain('createDesktopHost');
    await h.ipc['desktop:request']({ sender: h.window.webContents, senderFrame: { url: 'file:///tmp' } }, {});
    expect(h.calls).toContain('desktop.handler');
  });

  test('initialization failure does not execute IPC handler', async () => {
    const h = loadMainHarness({ failHost: true });
    await until(() => h.calls.includes('app.exit'));
    await expect(h.ipc['desktop:request']({ sender: h.window.webContents, senderFrame: { url: 'file:///tmp' } }, {})).rejects.toBeTruthy();
    expect(h.calls).not.toContain('desktop.handler');
  });

  test('closing before paint prevents late host creation', async () => {
    const h = loadMainHarness({ deferPaint: true });
    await until(() => h.window.listenerCount('close') > 0);
    h.window.close();
    await Promise.resolve();
    h.window.emit('ready-to-show');
    await new Promise(resolve => setImmediate(resolve));
    expect(h.window.destroyed).toBe(true);
    expect(h.calls).not.toContain('createDesktopHost');
    expect(h.calls).not.toContain('desktop.handler');
  });

  test('IPC waits through workspace restoration and is cancelled on close', async () => {
    let release!: () => void;
    const restore = new Promise<void>(resolve => { release = resolve; });
    const h = loadMainHarness({ restore });
    await until(() => h.calls.includes('restore.start'));
    expect(h.calls).toContain('restore.start');
    const pending = h.ipc['desktop:request']({ sender: h.window.webContents, senderFrame: { url: 'file:///tmp' } }, {});
    const result = expect(pending).rejects.toBeTruthy();
    expect(h.calls).not.toContain('desktop.handler');
    h.window.close();
    h.app.emit('will-quit');
    release();
    await result;
    expect(h.calls).toContain('host.dispose');
    expect(h.calls).not.toContain('desktop.handler');
  });

  test('ordinary workspace activation keeps the main desktop-host selection path', async () => {
    const h = loadMainHarness({ ordinaryWorkspace: true });
    await until(() => h.calls.includes('createDesktopHost'));
    await expect(h.a9Config.selectWorkspace(h.workspacePath)).resolves.toMatchObject({ workspacePath: h.workspacePath });
    expect(h.calls).toContain('restore.end');
  });

  test('ordinary workspace startup restoration does not call default-directory management', async () => {
    const h = loadMainHarness({ restore: Promise.resolve() });
    await until(() => h.calls.includes('restore.end'));
    expect(h.calls).toContain('restore.start');
    expect(h.calls).toContain('restore.end');
  });

  test('invalid sender is rejected without waiting for startup', async () => {
    const h = loadMainHarness();
    await expect(h.ipc['desktop:request']({ sender: {}, senderFrame: { url: 'file:///tmp' } }, {})).rejects.toThrow('RENDERER_CAPABILITY_DENIED');
    expect(h.calls).not.toContain('desktop.handler');
  });
});

describe('A9-62 review main regressions', () => {
  test('R2 normal quit emits before-quit/will-quit/dispose once and synchronously finishes confirmed exit', async () => {
    const h = loadMainHarness();
    await until(() => h.calls.includes('createDesktopHost'));
    await h.ipc['product:get-diagnostics']({ sender: h.window.webContents, senderFrame: { url: 'file:///tmp' } });
    let before = 0; let will = 0;
    h.app.on('before-quit', () => before++); h.app.on('will-quit', () => will++);
    expect(() => h.app.quit()).not.toThrow();
    await new Promise(resolve => setImmediate(resolve));
    expect(before).toBe(1); expect(will).toBe(1);
    expect(h.calls.filter(call => call === 'app.quit')).toHaveLength(1);
    expect(h.calls.filter(call => call === 'host.dispose')).toHaveLength(1);
    expect(h.records.filter(row => row.event === 'exit-requested')).toHaveLength(1);
    expect(h.records.filter(row => row.event === 'exit-begin')).toHaveLength(0);
    expect(h.records.filter(row => row.event === 'exit-end')).toEqual([
      expect.objectContaining({ sync: true, values: { exitCode: 0 } }),
    ]);
  });

  test('R4 excludes native error-dialog blocking time from the heartbeat stall', async () => {
    let now = process.hrtime.bigint();
    const clock = jest.spyOn(process.hrtime, 'bigint').mockImplementation(() => now);
    try {
      const h = loadMainHarness({ errorDialog: () => { now += BigInt(3000000000); } });
      await until(() => h.calls.includes('createDesktopHost'));
      await h.ipc['product:get-diagnostics']({ sender: h.window.webContents, senderFrame: { url: 'file:///tmp' } });
      h.processEvents.emit('uncaughtException', Object.assign(new Error('fake error'), { code: 'EIO' }));
      await until(() => h.calls.includes('error-dialog'));
      await h.ipc['product:get-diagnostics']({ sender: h.window.webContents, senderFrame: { url: 'file:///tmp' } });
      expect(h.records.filter(row => row.event === 'main-thread-stall')).toHaveLength(0);
    } finally { clock.mockRestore(); }
  });

  test('R5 second-instance exit finishes app-ready before exit and records its reason', async () => {
    const h = loadMainHarness({ hasLock: false });
    await until(() => h.calls.includes('app.exit'));
    const begin = h.records.find(row => row.event === 'startup-stage-begin' && row.values.stage === 'app-ready');
    const end = h.records.find(row => row.event === 'startup-stage-end' && row.values.stage === 'app-ready');
    expect(begin).toBeDefined(); expect(end).toBeDefined();
    expect(end!.values.operationId).toBe(begin!.values.operationId);
    expect(h.records.filter(row => row.event === 'second-instance-exit')).toHaveLength(1);
    expect(h.calls).not.toContain('app.whenReady');
    expect(h.calls).not.toContain('createDesktopHost');
  });
});


describe('A9-62 R3 fatal and quit entry regressions', () => {
  test('S3 startup failure and uncaught exception use the synchronous emergency path', async () => {
    const failed = loadMainHarness({ failHost: true });
    await until(() => failed.calls.includes('app.exit'));
    expect(failed.records.filter(row => row.event === 'startup-failed')).toEqual([
      expect.objectContaining({ sync: true }),
    ]);
    const h = loadMainHarness();
    await until(() => h.calls.includes('createDesktopHost'));
    h.processEvents.emit('uncaughtException', Object.assign(new Error('fake'), { code: 'EIO' }));
    expect(h.records.filter(row => row.event === 'uncaught-exception')).toEqual([
      expect.objectContaining({ sync: true, values: expect.objectContaining({ errorCode: 'EIO' }) }),
    ]);
  });

  test('S6 cancelled quit records every request and only confirmed quit records exit-end', async () => {
    const h = loadMainHarness();
    await until(() => h.calls.includes('createDesktopHost'));
    // Emit the Electron event for a quit that a later listener cancels. No will-quit occurs.
    h.app.emit('before-quit', { preventDefault() {} });
    expect(h.records.filter(row => row.event === 'exit-begin' || row.event === 'exit-end')).toHaveLength(0);
    expect(h.records.filter(row => row.event === 'exit-requested')).toHaveLength(1);
    h.app.quit();
    expect(h.records.filter(row => row.event === 'exit-requested')).toHaveLength(2);
    expect(h.records.filter(row => row.event === 'exit-end')).toHaveLength(1);
  });
});
