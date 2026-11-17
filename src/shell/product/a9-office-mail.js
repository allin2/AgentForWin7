'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { TextDecoder } = require('util');
const { Worker } = require('worker_threads');
const parseMime = require('../office-lite/node_modules/emailjs-mime-parser').default;
const codec = require('../office-lite/node_modules/emailjs-mime-codec');

const MAX_EML_BYTES = 16 * 1024 * 1024;
const MAX_BODY_CHARS = 64 * 1024;
const SUPPORTED_CHARSETS = new Set([
  'utf-8', 'utf8', 'gbk', 'gb2312', 'gb18030', 'big5',
  'us-ascii', 'ascii', 'iso-8859-1', 'latin1', 'windows-1252',
]);

function fail(code, detail) {
  return Object.assign(new Error(detail ? `${code}: ${detail}` : code), { code });
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function normalizeCharset(raw) {
  const clean = String(raw || 'utf-8').trim().replace(/^["']|["']$/g, '').toLowerCase();
  if (!clean || clean === 'ascii' || clean === 'us-ascii') return 'utf-8';
  if (clean === 'latin1' || clean === 'iso-8859-1') return 'iso-8859-1';
  if (clean === 'utf8') return 'utf-8';
  if (!SUPPORTED_CHARSETS.has(clean)) throw fail('A9_OFFICE_MAIL_CHARSET_UNSUPPORTED', clean);
  return clean;
}

function decodeTextStrict(bytes, rawCharset) {
  const charset = normalizeCharset(rawCharset);
  try {
    return new TextDecoder(charset, { fatal: true }).decode(bytes);
  } catch (_err) {
    throw fail('A9_OFFICE_MAIL_ENCODING_ERROR', charset);
  }
}

function decodeQuotedPrintableBytes(rawLatin1) {
  const cleaned = rawLatin1.replace(/=\r?\n/g, '');
  const out = [];
  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (ch === '=' && /^[0-9a-f]{2}$/i.test(cleaned.slice(i + 1, i + 3))) {
      out.push(Number.parseInt(cleaned.slice(i + 1, i + 3), 16));
      i += 2;
    } else if (ch === '=') {
      throw fail('A9_OFFICE_MAIL_ENCODING_ERROR', 'invalid quoted-printable');
    } else {
      out.push(cleaned.charCodeAt(i) & 0xff);
    }
  }
  return Buffer.from(out);
}

function decodeBase64Strict(rawLatin1) {
  const stripped = rawLatin1.replace(/\s+/g, '');
  if (!stripped) return Buffer.alloc(0);
  if (stripped.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(stripped)) {
    throw fail('A9_OFFICE_MAIL_ENCODING_ERROR', 'invalid base64');
  }
  return Buffer.from(stripped, 'base64');
}

function decodeRfc2047Strict(input) {
  if (typeof input !== 'string' || !input) return '';
  // Collapse whitespace between adjacent encoded-words per RFC 2047 §6.2.
  const collapsed = input.replace(/\?=\s+=\?/g, '?==?');
  return collapsed.replace(/=\?([^?]+)\?([bqBQ])\?([^?]*)\?=/g, (_all, charset, enc, text) => {
    const upper = enc.toUpperCase();
    let bytes;
    if (upper === 'B') {
      bytes = decodeBase64Strict(text);
    } else {
      const qp = text.replace(/_/g, ' ');
      bytes = decodeQuotedPrintableBytes(qp);
    }
    return decodeTextStrict(bytes, charset);
  });
}

function decodeRfc2231Param(rawValue) {
  const match = /^([^']*)'[^']*'(.*)$/.exec(String(rawValue || '').trim());
  if (!match) return decodeRfc2047Strict(String(rawValue || '').trim());
  const charset = match[1] || 'utf-8';
  const encoded = match[2];
  const bytes = [];
  for (let i = 0; i < encoded.length; i++) {
    if (encoded[i] === '%' && /^[0-9a-f]{2}$/i.test(encoded.slice(i + 1, i + 3))) {
      bytes.push(Number.parseInt(encoded.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(encoded.charCodeAt(i) & 0xff);
    }
  }
  return decodeTextStrict(Buffer.from(bytes), charset);
}

function extractRawHeaders(rawPart) {
  const splitIdx = rawPart.indexOf('\n\n');
  const headText = splitIdx >= 0 ? rawPart.slice(0, splitIdx) : rawPart;
  const bodyText = splitIdx >= 0 ? rawPart.slice(splitIdx + 2) : '';
  const unfolded = [];
  for (const line of headText.split('\n')) {
    if (/^[ \t]/.test(line) && unfolded.length) {
      unfolded[unfolded.length - 1] += ' ' + line.trim();
    } else if (line.trim()) {
      unfolded.push(line);
    }
  }
  const map = new Map();
  for (const line of unfolded) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const val = line.slice(colon + 1).trim();
    map.set(key, val);
  }
  return { headers: map, rawBody: bodyText };
}

function parseParam(headerVal, name) {
  if (!headerVal) return undefined;
  // Check RFC 2231 continuations: name*0*=...; name*1*=...
  const contRe = new RegExp(`(?:^|;)\\s*${name}\\*(\\d+)(\\*?)\\s*=\\s*(?:"([^"]*)"|([^;\\s]+))`, 'gi');
  const contMatches = [];
  let cm;
  while ((cm = contRe.exec(headerVal)) !== null) {
    contMatches.push({ index: Number(cm[1]), encoded: cm[2] === '*', val: cm[3] !== undefined ? cm[3] : cm[4] });
  }
  if (contMatches.length > 0) {
    contMatches.sort((a, b) => a.index - b.index);
    const joined = contMatches.map(m => m.val).join('');
    return contMatches[0].encoded ? decodeRfc2231Param(joined) : decodeRfc2047Strict(joined);
  }
  const extRe = new RegExp(`(?:^|;)\\s*${name}\\*\\s*=\\s*("?)([^";]+)\\1`, 'i');
  const extMatch = extRe.exec(headerVal);
  if (extMatch) return decodeRfc2231Param(extMatch[2]);
  const quotedRe = new RegExp(`(?:^|;)\\s*${name}\\s*=\\s*"([^"]*)"`, 'i');
  const qMatch = quotedRe.exec(headerVal);
  if (qMatch) return decodeRfc2047Strict(qMatch[1]);
  const bareRe = new RegExp(`(?:^|;)\\s*${name}\\s*=\\s*([^;\\s]+)`, 'i');
  const bMatch = bareRe.exec(headerVal);
  if (bMatch) return decodeRfc2047Strict(bMatch[1]);
  return undefined;
}

function decodePartFromRaw(node) {
  const { headers, rawBody } = extractRawHeaders(node.raw || '');
  const rawCt = headers.get('content-type') || '';
  const rawCte = (headers.get('content-transfer-encoding') || '7bit').split(';')[0].trim().toLowerCase();
  const rawCd = headers.get('content-disposition') || '';
  const parsedCt = rawCt ? codec.parseHeaderValue(rawCt) : { value: 'text/plain', params: {} };
  const parsedCd = rawCd ? codec.parseHeaderValue(rawCd) : { value: '', params: {} };
  const contentType = String(parsedCt.value || 'text/plain').toLowerCase().trim();
  const disposition = String(parsedCd.value || '').toLowerCase().trim();
  const charset = parseParam(rawCt, 'charset') || (parsedCt.params && parsedCt.params.charset) || 'utf-8';
  const filename = parseParam(rawCd, 'filename') || parseParam(rawCt, 'name') || '';

  let bodyBytes;
  if (rawCte === 'base64') {
    bodyBytes = decodeBase64Strict(rawBody);
  } else if (rawCte === 'quoted-printable') {
    bodyBytes = decodeQuotedPrintableBytes(rawBody);
  } else if (rawCte === '7bit' || rawCte === '8bit' || rawCte === 'binary' || !rawCte) {
    bodyBytes = Buffer.from(rawBody, 'latin1');
  } else {
    throw fail('A9_OFFICE_MAIL_CTE_UNSUPPORTED', rawCte);
  }

  return {
    contentType,
    disposition,
    charset,
    filename,
    cte: rawCte || '7bit',
    bytes: bodyBytes,
  };
}

function stripHtmlBasic(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function formatAddresses(list, fallbackRaw) {
  if (Array.isArray(list) && list.length) {
    return list.map(a => {
      const name = a.name ? decodeRfc2047Strict(String(a.name)) : '';
      const addr = a.address ? String(a.address) : '';
      return name && addr ? `${name} <${addr}>` : (name || addr);
    }).filter(Boolean);
  }
  return fallbackRaw ? [decodeRfc2047Strict(fallbackRaw)] : [];
}

function parseEmlBuffer(buffer, relativePath) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0 || buffer.length > MAX_EML_BYTES) {
    throw fail('A9_OFFICE_MAIL_BYTE_LIMIT');
  }
  const tree = parseMime(buffer.toString('latin1'));
  const rootHeaders = extractRawHeaders(tree.raw || '').headers;
  const subjectRaw = rootHeaders.get('subject') || (tree.headers.subject && tree.headers.subject[0] && tree.headers.subject[0].initial) || '';
  const subject = decodeRfc2047Strict(subjectRaw);
  const fromList = formatAddresses(tree.headers.from && tree.headers.from[0] && tree.headers.from[0].value, rootHeaders.get('from'));
  const toList = formatAddresses(tree.headers.to && tree.headers.to[0] && tree.headers.to[0].value, rootHeaders.get('to'));
  const ccList = formatAddresses(tree.headers.cc && tree.headers.cc[0] && tree.headers.cc[0].value, rootHeaders.get('cc'));
  const date = (tree.headers.date && tree.headers.date[0] && tree.headers.date[0].value) || rootHeaders.get('date') || '';

  const textParts = [];
  const htmlParts = [];
  const attachments = [];
  let detectedCharset = 'utf-8';
  let attCounter = 0;

  function walk(node) {
    if (Array.isArray(node.childNodes) && node.childNodes.length > 0) {
      for (const child of node.childNodes) walk(child);
      return;
    }
    const decoded = decodePartFromRaw(node);
    const isAttachment = decoded.disposition === 'attachment'
      || Boolean(decoded.filename)
      || !/^text\/(?:plain|html)$/i.test(decoded.contentType);

    if (isAttachment) {
      if (decoded.cte !== 'base64' && decoded.cte !== 'quoted-printable') {
        throw fail('A9_OFFICE_MAIL_CTE_UNSUPPORTED', `attachment requires base64 or quoted-printable, got ${decoded.cte}`);
      }
      attCounter += 1;
      const filename = decoded.filename || `attachment-${attCounter}.bin`;
      attachments.push({
        attachmentId: `att-${String(attCounter).padStart(3, '0')}`,
        filename,
        contentType: decoded.contentType,
        sizeBytes: decoded.bytes.length,
        sha256: sha256(decoded.bytes),
        bytes: decoded.bytes,
      });
      return;
    }

    const text = decodeTextStrict(decoded.bytes, decoded.charset);
    detectedCharset = normalizeCharset(decoded.charset);
    if (decoded.contentType === 'text/html') htmlParts.push(text);
    else textParts.push(text);
  }

  walk(tree);

  const htmlBody = htmlParts.length ? htmlParts.join('\n').slice(0, MAX_BODY_CHARS) : undefined;
  const textBody = (textParts.length ? textParts.join('\n') : stripHtmlBasic(htmlBody || '')).slice(0, MAX_BODY_CHARS);
  return {
    messageId: relativePath,
    folder: path.posix.dirname(relativePath) === '.' ? '根目录' : path.posix.dirname(relativePath),
    subject,
    from: fromList[0] || '',
    to: toList,
    ...(ccList.length ? { cc: ccList } : {}),
    date: String(date),
    charset: detectedCharset,
    textBody,
    ...(htmlBody ? { htmlBody } : {}),
    attachments,
    sourcePath: relativePath,
  };
}

function emlAvailable() {
  return ['emailjs-mime-parser', 'emailjs-mime-codec', 'emailjs-addressparser'].every((name) => {
    try {
      return fs.statSync(path.join(__dirname, '../office-lite/node_modules', name, 'package.json')).isFile();
    } catch (_err) {
      return false;
    }
  });
}

function createEmlDirectoryMailAdapter({
  workspaceRoot,
  timeoutMs = 30_000,
  workerPath,
  maxOldGenerationSizeMb = 128,
  maxYoungGenerationSizeMb = 16,
}) {
  let active = null;
  let closed = false;

  async function runWorker(workerData, signal) {
    if (closed) throw fail('MAIL_CANCELLED');
    if (signal?.aborted) throw fail('MAIL_CANCELLED');
    if (active) throw fail('MAIL_BUSY');

    const worker = new Worker(workerPath || path.join(__dirname, 'office-mail-worker.js'), {
      workerData: { ...workerData, workspaceRoot },
      resourceLimits: { maxOldGenerationSizeMb, maxYoungGenerationSizeMb },
      env: {},
    });
    active = worker;

    try {
      return await new Promise((resolve, reject) => {
        let message;
        let failure;
        let timedOut = false;
        const abort = () => {
          failure = fail('MAIL_CANCELLED');
          void worker.terminate();
        };
        const timer = setTimeout(() => {
          timedOut = true;
          void worker.terminate();
        }, timeoutMs);
        signal?.addEventListener('abort', abort, { once: true });

        worker.on('message', (value) => {
          message = value;
        });
        worker.on('error', () => {
          failure = fail('A9_OFFICE_MAIL_WORKER_FAILED');
        });
        worker.on('exit', (exitCode) => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
          if (signal?.aborted || closed) failure = fail('MAIL_CANCELLED');
          else if (timedOut) failure = fail('A9_OFFICE_MAIL_TIMEOUT');
          if (failure) return reject(failure);
          if (exitCode !== 0 || !message) {
            const code = message && !message.ok && message.error && message.error.code
              ? message.error.code
              : 'A9_OFFICE_MAIL_WORKER_FAILED';
            return reject(fail(code, message && message.error && message.error.message));
          }
          if (!message.ok) {
            return reject(fail((message.error && message.error.code) || 'A9_OFFICE_MAIL_FAILED', message.error && message.error.message));
          }
          const result = message.result;
          if (result && result.bytes && !(result.bytes instanceof Buffer)) {
            result.bytes = Buffer.from(result.bytes);
          }
          resolve(result);
        });
      });
    } finally {
      if (active === worker) active = null;
    }
  }

  return {
    schemaVersion: 1,
    sourceId: 'eml',
    kind: 'eml_directory',
    evidenceClass: 'LOCAL_EML_EXPORT',
    listFolders(options = {}, signal) {
      return runWorker({ action: 'listFolders', emlDir: options.emlDir || '' }, signal);
    },
    listMessages(options = {}, signal) {
      return runWorker({
        action: 'listMessages',
        emlDir: options.emlDir || '',
        folder: options.folder || '',
        cursor: options.cursor || '0',
        limit: options.limit || 20,
      }, signal);
    },
    readMessage(messageId, options = {}, signal) {
      return runWorker({
        action: 'readMessage',
        messageId,
        emlDir: options.emlDir || '',
      }, signal);
    },
    readAttachmentBytes(messageId, attachmentId, options = {}, signal) {
      return runWorker({
        action: 'readAttachmentBytes',
        messageId,
        attachmentId,
        emlDir: options.emlDir || '',
      }, signal);
    },
    async close() {
      closed = true;
      if (active) await active.terminate();
    },
  };
}

module.exports = {
  emlAvailable,
  createEmlDirectoryMailAdapter,
  parseEmlBuffer,
  decodeRfc2047Strict,
  decodeTextStrict,
};
