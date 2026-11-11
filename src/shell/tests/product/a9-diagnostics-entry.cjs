'use strict';

// Candidate-external fault injection. No fault switches exist in the product.
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, dialog } = require('electron');
const runRoot = process.env.A9_62_RUN_ROOT;
const productMain = process.env.A9_62_PRODUCT_MAIN;
const mode = process.env.A9_62_CASE;
const fakeSecret = 'sk-A9_62_FAKE_SECRET_0123456789';
app.setPath('userData', path.join(runRoot, '中文 user data %#'));
const write = (name, value) => fs.writeFileSync(path.join(runRoot, name), JSON.stringify(value, null, 2) + '\n', 'utf8');
write('runtime.json', { electron: process.versions.electron, node: process.versions.node, mode });
const originalErrorBox = dialog.showErrorBox.bind(dialog);
dialog.showErrorBox = (title, content) => {
  write('dialog.json', { title, content });
  if (!mode.startsWith('native-') && mode !== 'baseline-uncaught') throw new Error('UNEXPECTED_NATIVE_DIALOG');
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
  const host = require(path.join(path.dirname(productMain), 'desktop-host.js'));
  const createHost = host.createDesktopHost;
  host.createDesktopHost = (...args) => {
    if (['startup-failure', 'native-startup'].includes(mode)) throw Object.assign(new Error(fakeSecret), { code: 'ENOSPC' });
    if (mode === 'stall-stage') block(3000);
    if (mode === 'kill-stage') { write('kill-ready.json', { stage: 'desktop-host' }); block(60000); }
    return createHost(...args);
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
  if (['smoke', 'startup-failure'].includes(mode)) process.argv.push('--smoke-report=' + path.join(runRoot, 'smoke.json'));
  app.on('browser-window-created', (_event, window) => {
    window.webContents.once('did-finish-load', () => {
      if (['smoke', 'startup-failure', 'native-startup', 'kill-stage'].includes(mode)) return;
      void (async () => {
        const diagnostics = await window.webContents.executeJavaScript('window.win7Agent.getDiagnostics()');
        write('diagnostics.json', diagnostics);
        if (['stall-ipc', 'kill-ipc', 'ipc-failure'].includes(mode)) {
          // The real Renderer/preload/IPC/main path invokes the production
          // handler. Only starvation is injected around its actual behavior.
          const result = await window.webContents.executeJavaScript(mode === 'ipc-failure'
            ? "window.win7Agent.a9.setProvider({unexpectedField: 'sk-A9_62_FAKE_SECRET_0123456789'})"
            : 'window.win7Agent.a9.listWorkspaces()');
          write('ipc-result.json', result);
        }
        if (mode === 'native-uncaught') {
          setTimeout(() => { throw Object.assign(new Error(fakeSecret), { code: 'EIO' }); }, 10);
          setTimeout(() => { write('alive.json', { alive: true }); app.quit(); }, 300);
          return;
        }
        if (mode === 'rejection') {
          Promise.reject(Object.assign(new Error(fakeSecret), { code: 'EIO' }));
          await new Promise(resolve => setTimeout(resolve, 200));
          write('alive.json', { alive: true });
        }
        if (mode === 'window-events') {
          window.emit('unresponsive'); window.emit('responsive');
          // Real renderer crash; the two BrowserWindow responsiveness signals
          // above are explicit event injection, not an OS responsiveness test.
          await new Promise(resolve => {
            window.webContents.once('render-process-gone', resolve);
            window.webContents.forcefullyCrashRenderer();
          });
        }
        app.quit();
      })().catch(error => { write('driver-error.json', { code: error.code, message: String(error.message).slice(0, 500) }); app.exit(7); });
    });
  });
  require(productMain);
}
