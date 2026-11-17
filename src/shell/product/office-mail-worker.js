'use strict';

const fs = require('fs');
const path = require('path');
const { parentPort, workerData } = require('worker_threads');
const { parseEmlBuffer } = require('./a9-office-mail');

const MAX_EML_FILES = 500;
const MAX_EML_BYTES = 16 * 1024 * 1024;

function fail(code, detail) {
  return Object.assign(new Error(detail ? `${code}: ${detail}` : code), { code });
}

function resolveEmlDir(workspaceRoot, emlDir = '') {
  const realRoot = fs.realpathSync(workspaceRoot);
  const clean = String(emlDir || '').replace(/\/+$/, '');
  if (clean.length > 4096 || /[\\\x00-\x1f:*?"<>|]/.test(clean) || path.isAbsolute(clean) || path.win32.isAbsolute(clean)) {
    throw fail('MAIL_PATH_INVALID');
  }
  const target = clean ? path.resolve(realRoot, clean) : realRoot;
  const rel = path.relative(realRoot, target);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw fail('MAIL_PATH_REDIRECTED');
  }
  let probe = realRoot;
  if (rel) {
    for (const seg of rel.split(path.sep)) {
      probe = path.join(probe, seg);
      if (fs.lstatSync(probe).isSymbolicLink()) throw fail('MAIL_PATH_REDIRECTED');
    }
  }
  const resolved = fs.realpathSync(target);
  const st = fs.lstatSync(resolved);
  if (!st.isDirectory() || st.isSymbolicLink()) throw fail('MAIL_PATH_INVALID');
  return { realRoot, resolved };
}

function scanEmlFiles(workspaceRoot, emlDir = '') {
  const { realRoot, resolved: baseDir } = resolveEmlDir(workspaceRoot, emlDir);
  const files = [];
  const stack = [baseDir];
  while (stack.length) {
    const dir = stack.pop();
    const entries = fs.readdirSync(dir).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const subdirs = [];
    for (const name of entries) {
      if (['.git', '.agent_recovery'].includes(name.toLowerCase()) || /^_待清理隔离区_/.test(name)) continue;
      const abs = path.join(dir, name);
      const st = fs.lstatSync(abs);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        subdirs.push(abs);
      } else if (st.isFile() && /\.eml$/i.test(name)) {
        if (files.length >= MAX_EML_FILES) throw fail('MAIL_EML_FILE_LIMIT');
        const rel = path.relative(realRoot, abs).replace(/\\/g, '/');
        files.push({ rel, abs, size: st.size });
      }
    }
    stack.push(...subdirs.reverse());
  }
  return files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

function resolveSingleEml(workspaceRoot, messageId, emlDir = '') {
  const { realRoot, resolved: baseDir } = resolveEmlDir(workspaceRoot, emlDir);
  const clean = String(messageId || '');
  if (!clean || clean.length > 4096 || !/\.eml$/i.test(clean) || /[\\\x00-\x1f:*?"<>|]/.test(clean)
    || path.isAbsolute(clean) || path.win32.isAbsolute(clean)) {
    throw fail('MAIL_MESSAGE_NOT_FOUND');
  }
  const abs = path.resolve(realRoot, clean);
  const relFromBase = path.relative(baseDir, abs);
  if (relFromBase === '..' || relFromBase.startsWith(`..${path.sep}`) || path.isAbsolute(relFromBase)) {
    throw fail('MAIL_PATH_REDIRECTED');
  }
  let probe = realRoot;
  for (const seg of path.relative(realRoot, abs).split(path.sep)) {
    probe = path.join(probe, seg);
    if (!fs.existsSync(probe) || fs.lstatSync(probe).isSymbolicLink()) {
      throw fail('MAIL_MESSAGE_NOT_FOUND');
    }
  }
  const st = fs.lstatSync(abs);
  if (!st.isFile() || st.isSymbolicLink()) throw fail('MAIL_MESSAGE_NOT_FOUND');
  if (st.size > MAX_EML_BYTES) throw fail('A9_OFFICE_MAIL_BYTE_LIMIT');
  return { abs, rel: path.relative(realRoot, abs).replace(/\\/g, '/') };
}

function runMailAction(input) {
  const { action, workspaceRoot } = input;
  if (action === 'listFolders') {
    const files = scanEmlFiles(workspaceRoot, input.emlDir || '');
    const counts = new Map();
    for (const f of files) {
      const folder = path.posix.dirname(f.rel) === '.' ? '根目录' : path.posix.dirname(f.rel);
      counts.set(folder, (counts.get(folder) || 0) + 1);
    }
    return {
      schemaVersion: 1,
      sourceId: 'eml',
      kind: 'eml_directory',
      evidenceClass: 'LOCAL_EML_EXPORT',
      isSurrogate: false,
      folders: [...counts.entries()].map(([name, messageCount]) => ({ folderId: name, name, messageCount })),
    };
  }
  if (action === 'listMessages') {
    const files = scanEmlFiles(workspaceRoot, input.emlDir || '');
    const folderFilter = input.folder ? String(input.folder) : '';
    const filtered = folderFilter
      ? files.filter(f => (path.posix.dirname(f.rel) === '.' ? '根目录' : path.posix.dirname(f.rel)) === folderFilter)
      : files;
    const offset = Math.max(0, Number.parseInt(String(input.cursor || '0'), 10) || 0);
    const limit = Math.min(50, Math.max(1, Number(input.limit || 20)));
    const slice = filtered.slice(offset, offset + limit);
    const messages = slice.map((f) => {
      const parsed = parseEmlBuffer(fs.readFileSync(f.abs), f.rel);
      return {
        messageId: parsed.messageId,
        folder: parsed.folder,
        subject: parsed.subject,
        from: parsed.from,
        to: parsed.to,
        date: parsed.date,
        attachmentCount: parsed.attachments.length,
        snippet: parsed.textBody.slice(0, 160),
        sourcePath: parsed.sourcePath,
      };
    });
    const nextOffset = offset + slice.length;
    return {
      schemaVersion: 1,
      sourceId: 'eml',
      kind: 'eml_directory',
      evidenceClass: 'LOCAL_EML_EXPORT',
      isSurrogate: false,
      folder: folderFilter || '*',
      total: filtered.length,
      cursor: offset,
      nextCursor: nextOffset < filtered.length ? String(nextOffset) : null,
      hasMore: nextOffset < filtered.length,
      messages,
    };
  }
  if (action === 'readMessage') {
    const resolved = resolveSingleEml(workspaceRoot, input.messageId, input.emlDir || '');
    const parsed = parseEmlBuffer(fs.readFileSync(resolved.abs), resolved.rel);
    return {
      messageId: parsed.messageId,
      folder: parsed.folder,
      subject: parsed.subject,
      from: parsed.from,
      to: parsed.to,
      ...(parsed.cc ? { cc: parsed.cc } : {}),
      date: parsed.date,
      charset: parsed.charset,
      textBody: parsed.textBody,
      ...(parsed.htmlBody ? { htmlBody: parsed.htmlBody } : {}),
      attachments: parsed.attachments.map(({ bytes: _b, ...meta }) => meta),
      sourcePath: parsed.sourcePath,
    };
  }
  if (action === 'readAttachmentBytes') {
    const resolved = resolveSingleEml(workspaceRoot, input.messageId, input.emlDir || '');
    const parsed = parseEmlBuffer(fs.readFileSync(resolved.abs), resolved.rel);
    const att = parsed.attachments.find(a => a.attachmentId === input.attachmentId);
    if (!att) throw fail('MAIL_ATTACHMENT_NOT_FOUND');
    return {
      attachmentId: att.attachmentId,
      filename: att.filename,
      contentType: att.contentType,
      bytes: att.bytes,
      sha256: att.sha256,
    };
  }
  throw fail('MAIL_INPUT_INVALID');
}

(() => {
  try {
    parentPort.postMessage({ ok: true, result: runMailAction(workerData || {}) });
  } catch (error) {
    const code = /^(?:MAIL_|A9_OFFICE_MAIL_)[A-Z0-9_]+$/.test(String(error && error.code ? error.code : ''))
      ? error.code
      : 'A9_OFFICE_MAIL_FAILED';
    parentPort.postMessage({ ok: false, error: { code, message: String(error && error.message ? error.message : code).slice(0, 300) } });
  } finally {
    parentPort.close();
  }
})();
