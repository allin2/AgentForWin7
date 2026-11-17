'use strict';

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const MAX_HTML_PREVIEW_BYTES = 4 * 1024 * 1024;
const PREVIEW_PARTITION = 'a9-office-html-preview';
const PREVIEW_CSP = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src 'none'; font-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

function fail(code) {
  return Object.assign(new Error(code), { code });
}

function validatePreviewHtmlTarget(workspaceRoot, relativePath) {
  if (typeof workspaceRoot !== 'string' || !workspaceRoot || typeof relativePath !== 'string' || !relativePath) {
    throw fail('A9_OFFICE_PREVIEW_PATH_INVALID');
  }
  if (relativePath.length > 4096 || /[\\\x00-\x1f:*?"<>|]/.test(relativePath)
    || path.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath)) {
    throw fail('A9_OFFICE_PREVIEW_PATH_INVALID');
  }
  if (!/\.html?$/i.test(relativePath)) {
    throw fail('A9_OFFICE_PREVIEW_FORMAT_UNSUPPORTED');
  }
  const realRoot = fs.realpathSync(workspaceRoot);
  const lexical = path.resolve(realRoot, relativePath);
  const relLex = path.relative(realRoot, lexical);
  if (!relLex || relLex === '..' || relLex.startsWith(`..${path.sep}`) || path.isAbsolute(relLex)) {
    throw fail('A9_OFFICE_PREVIEW_OUTSIDE_WORKSPACE');
  }
  let probe = realRoot;
  for (const seg of relLex.split(path.sep)) {
    probe = path.join(probe, seg);
    const lst = fs.lstatSync(probe);
    if (lst.isSymbolicLink()) throw fail('A9_OFFICE_PREVIEW_SYMLINK_REJECTED');
  }
  const absolute = fs.realpathSync(lexical);
  const relReal = path.relative(realRoot, absolute);
  if (!relReal || relReal === '..' || relReal.startsWith(`..${path.sep}`) || path.isAbsolute(relReal)) {
    throw fail('A9_OFFICE_PREVIEW_OUTSIDE_WORKSPACE');
  }
  const stat = fs.lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) throw fail('A9_OFFICE_PREVIEW_NOT_FILE');
  if (stat.size <= 0 || stat.size > MAX_HTML_PREVIEW_BYTES) throw fail('A9_OFFICE_PREVIEW_BYTE_LIMIT');
  return {
    absolute,
    relative: relReal.replace(/\\/g, '/'),
    bytes: stat.size,
    fileUrl: pathToFileURL(absolute).toString(),
  };
}

function createRestrictedHtmlPreviewManager({ BrowserWindow, session, allowTestScriptEval = false } = {}) {
  const windows = new Set();
  let partitionCounter = 0;

  function createPreviewSessionForTarget(targetUrl) {
    partitionCounter += 1;
    const ses = session.fromPartition(`${PREVIEW_PARTITION}-${partitionCounter}`, { cache: false });
    ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    if (typeof ses.setPermissionCheckHandler === 'function') {
      ses.setPermissionCheckHandler(() => false);
    }
    ses.on('will-download', (event) => {
      event.preventDefault();
    });
    ses.webRequest.onBeforeRequest((details, callback) => {
      callback({ cancel: details.url !== targetUrl });
    });
    return ses;
  }

  async function open({ workspaceRoot, relativePath, show = true }) {
    const target = validatePreviewHtmlTarget(workspaceRoot, relativePath);
    if (!BrowserWindow || !session) {
      return {
        ok: true,
        previewed: target.relative,
        bytes: target.bytes,
        chromiumVersion: process.versions.chrome || null,
        restricted: true,
        csp: PREVIEW_CSP,
        windowOpened: false,
      };
    }

    const ses = createPreviewSessionForTarget(target.fileUrl);

    const previewWin = new BrowserWindow({
      width: 1080,
      height: 760,
      minWidth: 720,
      minHeight: 520,
      show,
      title: `离线看板受限预览 — ${target.relative}`,
      autoHideMenuBar: true,
      backgroundColor: '#f8fafc',
      webPreferences: {
        session: ses,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        nodeIntegrationInSubFrames: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        javascript: allowTestScriptEval === true,
        webviewTag: false,
        spellcheck: false,
      },
    });
    previewWin.setMenuBarVisibility(false);
    windows.add(previewWin);

    const wc = previewWin.webContents;
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.on('will-navigate', (event, navUrl) => {
      if (navUrl !== target.fileUrl) event.preventDefault();
    });
    wc.on('will-attach-webview', (event) => {
      event.preventDefault();
    });
    previewWin.on('closed', () => {
      windows.delete(previewWin);
    });

    try {
      await previewWin.loadFile(target.absolute);
    } catch (err) {
      windows.delete(previewWin);
      try { if (!previewWin.isDestroyed()) previewWin.destroy(); } catch (_ignored) {}
      throw err;
    }
    return {
      ok: true,
      previewed: target.relative,
      bytes: target.bytes,
      chromiumVersion: process.versions.chrome || null,
      restricted: true,
      csp: PREVIEW_CSP,
      windowOpened: true,
    };
  }

  function getWindows() {
    return [...windows].filter(w => !w.isDestroyed());
  }

  function closeAll() {
    for (const win of [...windows]) {
      try {
        if (!win.isDestroyed()) win.close();
      } catch (_ignored) { /* best-effort */ }
    }
    windows.clear();
  }

  return { open, closeAll, getWindows, previewCsp: PREVIEW_CSP };
}

module.exports = {
  MAX_HTML_PREVIEW_BYTES,
  PREVIEW_PARTITION,
  PREVIEW_CSP,
  validatePreviewHtmlTarget,
  createRestrictedHtmlPreviewManager,
};
