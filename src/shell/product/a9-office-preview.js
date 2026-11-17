'use strict';

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const MAX_HTML_PREVIEW_BYTES = 4 * 1024 * 1024;
const PREVIEW_PARTITION = 'a9-office-html-preview';
const PREVIEW_CSP = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src 'none'; font-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

const MAX_BLOCKED_REQUEST_RECORDS = 50;
const NET_ERR_ACCESS_DENIED = -10;
const CSP_META = `<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">`;

function fail(code) {
  return Object.assign(new Error(code), { code });
}

/**
 * 在 HTML 字节流中真实注入 CSP <meta>（H-P2-09）。优先放在 <head> 之后，其次 <html> 之后，
 * 其次 <!doctype> 之后（避免进入 quirks mode），最后放在文档开头。只做 ASCII 级定位，不改写原有字节；
 * UTF-16 文档无法做 ASCII 注入，显式拒绝而不是以无 CSP 的方式预览。
 */
function injectPreviewCsp(htmlBytes) {
  const bytes = Buffer.isBuffer(htmlBytes) ? htmlBytes : Buffer.from(htmlBytes);
  if (bytes.length >= 2 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff))) {
    throw fail('A9_OFFICE_PREVIEW_ENCODING_UNSUPPORTED');
  }
  const probe = bytes.subarray(0, Math.min(bytes.length, 64 * 1024)).toString('latin1');
  let at = 0;
  let insertion = CSP_META;
  const head = /<head(?:\s[^>]*)?>/i.exec(probe);
  const html = head ? null : /<html(?:\s[^>]*)?>/i.exec(probe);
  const doctype = head || html ? null : /^\s*<!doctype[^>]*>/i.exec(probe);
  if (head) {
    at = head.index + head[0].length;
  } else if (html) {
    at = html.index + html[0].length;
    insertion = `<head>${CSP_META}</head>`;
  } else if (doctype) {
    at = doctype[0].length;
  }
  // BOM 之前不得插入内容。
  if (at === 0 && bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) at = 3;
  return Buffer.concat([bytes.subarray(0, at), Buffer.from(insertion, 'ascii'), bytes.subarray(at)]);
}

function isValidUtf8(buffer) {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    return true;
  } catch (_notUtf8) {
    return false;
  }
}

function comparableFileUrl(value) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'file:' || parsed.host !== '') return null;
    const decoded = decodeURIComponent(parsed.pathname);
    return process.platform === 'win32' ? decoded.toLowerCase() : decoded;
  } catch (_invalid) {
    return null;
  }
}

/** 请求 URL 是否就是预览目标本身（忽略 hash，路径按平台大小写规则比较）。 */
function isPreviewTargetUrl(requestUrl, targetUrl) {
  if (requestUrl === targetUrl) return true;
  const a = comparableFileUrl(requestUrl);
  return a !== null && a === comparableFileUrl(targetUrl);
}

/** 非目标请求分类：UNC/远程主机的 file:// 会触发 NTLM 凭据外泄，单独标注。 */
function classifyBlockedRequest(requestUrl) {
  try {
    const parsed = new URL(requestUrl);
    if (parsed.protocol === 'file:') return parsed.host ? 'file_unc' : 'file_local';
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'ftp:' ? 'remote' : 'other';
  } catch (_invalid) {
    return /^\\\\|^\/\//.test(String(requestUrl)) ? 'file_unc' : 'other';
  }
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

  const blockedRequests = [];
  function recordBlocked(requestUrl) {
    if (blockedRequests.length >= MAX_BLOCKED_REQUEST_RECORDS) return;
    blockedRequests.push({ kind: classifyBlockedRequest(requestUrl), url: String(requestUrl).slice(0, 200) });
  }

  function createPreviewSessionForTarget(targetUrl, document) {
    if (!session.fromPartition) throw fail('A9_OFFICE_PREVIEW_SESSION_UNAVAILABLE');
    partitionCounter += 1;
    const ses = session.fromPartition(`${PREVIEW_PARTITION}-${partitionCounter}`, { cache: false });
    ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    if (typeof ses.setPermissionCheckHandler === 'function') {
      ses.setPermissionCheckHandler(() => false);
    }
    ses.on('will-download', (event) => {
      event.preventDefault();
    });
    // 显式拦截：除目标文档外的一切请求（含其他本地 file://、UNC file://host/share、远程 URL）一律取消。
    ses.webRequest.onBeforeRequest((details, callback) => {
      if (isPreviewTargetUrl(details.url, targetUrl)) {
        callback({ cancel: false });
        return;
      }
      recordBlocked(details.url);
      callback({ cancel: true });
    });
    // 目标文档经 file 协议拦截器返回已注入 CSP 的内容；其余 file 请求拒绝。
    // 拦截器不可用时失败关闭，不退回到无 CSP 的预览。
    if (!ses.protocol || typeof ses.protocol.interceptBufferProtocol !== 'function') {
      throw fail('A9_OFFICE_PREVIEW_CSP_UNAVAILABLE');
    }
    const intercepted = ses.protocol.interceptBufferProtocol('file', (request, callback) => {
      if (!isPreviewTargetUrl(request.url, targetUrl)) {
        recordBlocked(request.url);
        callback({ error: NET_ERR_ACCESS_DENIED });
        return;
      }
      callback({
        mimeType: 'text/html',
        ...(isValidUtf8(document) ? { charset: 'utf-8' } : {}),
        headers: { 'Content-Security-Policy': PREVIEW_CSP },
        data: document,
      });
    });
    if (intercepted === false) throw fail('A9_OFFICE_PREVIEW_CSP_UNAVAILABLE');
    return ses;
  }

  async function open({ workspaceRoot, relativePath, show = true }) {
    const target = validatePreviewHtmlTarget(workspaceRoot, relativePath);
    const document = injectPreviewCsp(fs.readFileSync(target.absolute));
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

    const ses = createPreviewSessionForTarget(target.fileUrl, document);

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
      if (!isPreviewTargetUrl(navUrl, target.fileUrl)) event.preventDefault();
    });
    wc.on('will-redirect', (event, navUrl) => {
      if (!isPreviewTargetUrl(navUrl, target.fileUrl)) event.preventDefault();
    });
    wc.on('will-attach-webview', (event) => {
      event.preventDefault();
    });
    previewWin.on('closed', () => {
      windows.delete(previewWin);
    });

    try {
      await previewWin.loadURL(target.fileUrl);
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

  return { open, closeAll, getWindows, getBlockedRequests: () => blockedRequests.slice(), previewCsp: PREVIEW_CSP };
}

module.exports = {
  MAX_HTML_PREVIEW_BYTES,
  PREVIEW_PARTITION,
  PREVIEW_CSP,
  validatePreviewHtmlTarget,
  injectPreviewCsp,
  isPreviewTargetUrl,
  classifyBlockedRequest,
  createRestrictedHtmlPreviewManager,
};
