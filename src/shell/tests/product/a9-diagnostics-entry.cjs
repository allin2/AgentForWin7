'use strict';

// Candidate-external fault injection. No fault switches exist in the product.
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const { execFileSync, spawn } = require('child_process');
const runRoot = process.env.A9_62_RUN_ROOT;
const productMain = process.env.A9_62_PRODUCT_MAIN;
const mode = process.env.A9_62_CASE;
const dialogMode = process.env.A9_62_DIALOG_MODE || 'interactive';
const fakeSecret = 'sk-A9_62_FAKE_SECRET_0123456789';
app.setPath('userData', path.join(runRoot, '中文 user data %#'));
const write = (name, value) => fs.writeFileSync(path.join(runRoot, name), JSON.stringify(value, null, 2) + '\n', 'utf8');
const lifecycle = { beforeQuit: 0, willQuit: 0, dispose: 0 };
app.on('before-quit', () => lifecycle.beforeQuit++);
app.on('will-quit', () => lifecycle.willQuit++);
app.on('quit', () => write('lifecycle.json', lifecycle));
const ipcTimes = [];
const registerHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, handler) => registerHandle(channel, (event, ...args) => {
  ipcTimes.push(Date.now());
  return handler(event, ...args);
});
write('runtime.json', { electron: process.versions.electron, node: process.versions.node, mode, dialogMode });
const originalErrorBox = dialog.showErrorBox.bind(dialog);
dialog.showErrorBox = (title, content) => {
  write('dialog.json', { title, content });
  if (!mode.startsWith('native-') && mode !== 'baseline-uncaught' && mode !== 'slow-uncaught') throw new Error('UNEXPECTED_NATIVE_DIALOG');
  if (mode === 'slow-uncaught' || dialogMode === 'capture') return; // Fault test observes fatal persistence without user interaction.
  return originalErrorBox(title, content);
};
function block(milliseconds) {
  const start = process.hrtime.bigint();
  while (Number(process.hrtime.bigint() - start) / 1e6 < milliseconds) { /* intentional starvation */ }
}
if (mode.startsWith('baseline-')) {
  app.whenReady().then(() => {
    setTimeout(() => {
      const error = new Error('A9_62_BASELINE_EXCEPTION');
      if (mode === 'baseline-uncaught') throw error;
      Promise.reject(error);
    }, 30);
    setTimeout(() => { write('alive.json', { alive: true }); app.exit(0); }, 300);
  });
} else {
  let observedDiagnostics;
  let registry;
  if (mode.startsWith('cancel-quit')) {
    const registryModule = require(path.join(path.dirname(productMain), 'a9-workspace-registry.js'));
    const createRegistry = registryModule.createA9WorkspaceRegistry;
    registryModule.createA9WorkspaceRegistry = config => {
      registry = createRegistry({ ...config, openPersistence: () => ({ status: 'test-unavailable' }),
        createRuntime: () => ({ getSnapshot: () => ({ managedProcesses: [{ handleId: 'test-child', lastProbeStatus: 'running' }] }),
          async shutdown(options) {
            const stopManaged = options.stopManaged !== false;
            write('shutdown-choice.json', { stopManaged });
            if (stopManaged) {
              await new Promise(resolve => { background.once('exit', resolve); background.kill(); });
            }
            return { unresolved: [], stopped: stopManaged ? ['test-child'] : [], leftToSystem: stopManaged ? [] : ['test-child'] };
          } }),
      });
      return registry;
    };
  }
  let background;
  const loggerModule = require(path.join(path.dirname(productMain), 'a9-diagnostics-log.js'));
  const createLog = loggerModule.createDiagnosticsLog;
  loggerModule.createDiagnosticsLog = options => {
    const slow = ['slow-startup', 'slow-uncaught'].includes(mode);
    const pending = mode === 'early-exit' || mode === 'early-quit';
    const io = { ...fs, promises: { ...fs.promises,
      ...(pending ? { mkdir: () => new Promise(() => {}) } : {}),
      ...(slow ? { appendFile: async (...args) => {
        await new Promise(resolve => setTimeout(resolve, 200));
        return fs.promises.appendFile(...args);
      } } : {}),
    } };
    observedDiagnostics = createLog({ ...options, fs: io });
    app.on('quit', () => write('log-stats.json', observedDiagnostics.snapshot()));
    return observedDiagnostics;
  };
  const host = require(path.join(path.dirname(productMain), 'desktop-host.js'));
  const createHost = host.createDesktopHost;
  host.createDesktopHost = (...args) => {
    if (['startup-failure', 'native-startup', 'slow-startup'].includes(mode)) throw Object.assign(new Error(fakeSecret), { code: 'ENOSPC' });
    if (mode === 'stall-stage') block(3000);
    if (mode === 'kill-stage') { write('kill-ready.json', { stage: 'desktop-host' }); block(60000); }
    const result = createHost(...args);
    const dispose = result.dispose.bind(result);
    result.dispose = (...values) => { lifecycle.dispose++; return dispose(...values); };
    return result;
  };
  const ipc = require(path.join(path.dirname(productMain), 'a9-product-ipc.js'));
  const createHandler = ipc.createA9ProductRequestHandler;
  ipc.createA9ProductRequestHandler = config => {
    const handler = createHandler(config);
    return async (event, request) => {
      if (request.action === 'a9.workspace.list') {
        if (mode === 'stall-ipc') block(3000);
        if (mode === 'kill-ipc') { write('kill-ready.json', { action: 'a9.workspace.list' }); block(60000); }
      }
      return handler(event, request);
    };
  };
  if (['smoke', 'startup-failure', 'slow-startup'].includes(mode)) process.argv.push('--smoke-report=' + path.join(runRoot, 'smoke.json'));
  app.on('browser-window-created', (_event, window) => {
    window.webContents.once('did-finish-load', () => {
      if (['smoke', 'startup-failure', 'native-startup', 'slow-startup', 'kill-stage', 'early-exit', 'early-quit'].includes(mode)) return;
      void (async () => {
        const diagnostics = await window.webContents.executeJavaScript('window.win7Agent.getDiagnostics()');
        write('diagnostics.json', diagnostics);
        if (['stall-ipc', 'kill-ipc', 'ipc-failure'].includes(mode)) {
          // The real Renderer/preload/IPC/main path invokes the production
          // handler. Only starvation is injected around its actual behavior.
          const result = await window.webContents.executeJavaScript(mode === 'ipc-failure'
            ? "window.win7Agent.a9.configureProvider({unexpectedField: 'sk-A9_62_FAKE_SECRET_0123456789'})"
            : 'window.win7Agent.a9.listWorkspaces()');
          write('ipc-result.json', result);
        }
        if (mode === 'native-uncaught' || mode === 'slow-uncaught') {
          setTimeout(() => { throw Object.assign(new Error(fakeSecret), { code: 'EIO' }); }, 10);
          setTimeout(() => { write('alive.json', { alive: true }); app.quit(); }, 300);
          return;
        }
        if (mode === 'rejection') {
          Promise.reject(Object.assign(new Error(fakeSecret), { code: 'EIO' }));
          await new Promise(resolve => setTimeout(resolve, 200));
          write('alive.json', { alive: true });
        }
        if (mode === 'fifo-exit') {
          execFileSync('mkfifo', [path.join(observedDiagnostics.snapshot().directory, 'main.fatal.jsonl')]);
          write('fifo-ready.json', { ready: true });
          app.quit();
          return;
        }
        if (mode.startsWith('cancel-quit')) {
          background = spawn('/usr/local/bin/node', ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', env: { ...process.env, NODE_OPTIONS: '' } });
          const workspace = path.join(runRoot, 'background workspace');
          fs.mkdirSync(workspace);
          registry.open(workspace);
          let choices = 0;
          dialog.showMessageBox = async options => {
            if (options.title !== '退出时处理后台进程') throw new Error('UNEXPECTED_QUIT_DIALOG');
            choices++;
            return { response: choices === 1 ? 2 : mode === 'cancel-quit-leave' ? 1 : 0 };
          };
          app.quit();
          await new Promise(resolve => setTimeout(resolve, 150));
          await observedDiagnostics.flush();
          const directory = observedDiagnostics.snapshot().directory;
          const before = fs.readdirSync(directory).filter(name => name.endsWith('.jsonl'))
            .flatMap(name => fs.readFileSync(path.join(directory, name), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)));
          write('cancelled.json', { choices, alive: background.exitCode === null, events: before.map(row => row.event) });
          app.quit();
          return;
        }
        if (mode === 'normal-exit') {
          write('normal-exit-requested.json', { requested: true });
          app.quit();
          return;
        }
        if (mode === 'steady-2m') {
          const startedAt = Date.now();
          let requests = 0;
          const logBytes = () => {
            const directory = path.join(app.getPath('userData'), 'diagnostics');
            return fs.readdirSync(directory).filter(name => name.endsWith('.jsonl'))
              .reduce((sum, name) => sum + fs.statSync(path.join(directory, name)).size, 0);
          };
          const initialBytes = logBytes();
          const minuteSamples = [];
          const sample = minute => minuteSamples.push({ minute, at: Date.now(), logBytes: logBytes(),
            ipcCount: ipcTimes.filter(time => time >= startedAt + (minute - 1) * 60000 && time < startedAt + minute * 60000).length });
          const firstSample = setTimeout(() => sample(1), 60000);
          const interval = setInterval(() => {
            requests += 1;
            void window.webContents.executeJavaScript('window.win7Agent.a9.listWorkspaces()').catch(() => {});
          }, 1000);
          setTimeout(() => {
            clearInterval(interval);
            clearTimeout(firstSample);
            sample(2);
            const finishedAt = Date.now();
            const ipcCount = ipcTimes.filter(time => time >= startedAt && time < finishedAt).length;
            write('steady.json', { startedAt, finishedAt, durationMs: finishedAt - startedAt, requests, ipcCount,
              ipcPerMinute: ipcCount / ((finishedAt - startedAt) / 60000), logBytes: logBytes(), initialBytes,
              minuteSamples: minuteSamples.map((sample, index) => ({ ...sample, bytesWritten: sample.logBytes - (index ? minuteSamples[index - 1].logBytes : initialBytes) })),
              operations: 'one workspace-list Renderer/preload IPC per second plus normal product initialization/polling; no model requests' });
            app.quit();
          }, 120000);
          return;
        }
        if (mode === 'window-events') {
          window.emit('unresponsive'); window.emit('responsive');
          // Real renderer crash; the two BrowserWindow responsiveness signals
          // above are explicit event injection, not an OS responsiveness test.
          await new Promise(resolve => {
            window.webContents.once('render-process-gone', resolve);
            window.webContents.forcefullyCrashRenderer();
          });
          // Verify asynchronous event persistence separately from exit. A
          // synchronous quit can end libuv before queued writes complete.
          const expected = ['window-unresponsive', 'window-responsive', 'render-process-gone'];
          const deadline = Date.now() + 2000;
          for (;;) {
            await observedDiagnostics.flush();
            const snapshot = observedDiagnostics.snapshot();
            if (snapshot.writeFailureCount) throw new Error('EVENT_DIAGNOSTIC_WRITE_FAILED');
            const directory = snapshot.directory;
            const events = fs.readdirSync(directory).filter(name => name.endsWith('.jsonl'))
              .flatMap(name => fs.readFileSync(path.join(directory, name), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line).event));
            if (expected.every(event => events.includes(event))) break;
            if (Date.now() >= deadline) throw new Error('EVENT_DIAGNOSTICS_NOT_DRAINED');
            await new Promise(resolve => setTimeout(resolve, 10));
          }
        }
        app.quit();
      })().catch(error => { write('driver-error.json', { code: error.code, message: String(error.message).slice(0, 500) }); app.exit(7); });
    });
  });
  if (mode === 'early-exit') {
    // app.exit before Electron readiness dispatches neither quit nor process
    // exit events. Exercise the product quit hook immediately after loading
    // main on the supported ready entry, while async mkdir is still pending.
    app.whenReady().then(() => { require(productMain); app.exit(0); });
  } else {
    require(productMain);
    if (mode === 'early-quit') app.quit();
  }
}
