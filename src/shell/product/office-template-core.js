'use strict';

const fs = require('fs');
const crypto = require('crypto');
const posix = require('path').posix;
const { TextDecoder } = require('util');
const { DOMParser } = require('../office-lite/node_modules/@xmldom/xmldom');
const PizZip = require('../office-lite/node_modules/pizzip');
const Docxtemplater = require('../office-lite/node_modules/docxtemplater');
const { readOfficeZip } = require('./office-lite-zip');

const SAFE_TAG_RE = /^(?:\.|[\p{L}\p{N}_]+(?:\.[\p{L}\p{N}_]+)*)$/u;
const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype', 'toString', 'valueOf', 'hasOwnProperty']);
const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const A_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CT_NS = 'http://schemas.openxmlformats.org/package/2006/content-types';

function fail(code, detail) {
  return Object.assign(new Error(detail ? `${code}: ${detail}` : code), { code });
}

function validateSafeTag(tag) {
  if (typeof tag !== 'string' || !tag || tag.length > 256 || !SAFE_TAG_RE.test(tag)) {
    throw fail('A9_OFFICE_TEMPLATE_EXPRESSION_FORBIDDEN', String(tag || '').slice(0, 80));
  }
  const segments = tag === '.' ? [] : tag.split('.');
  if (segments.some(seg => FORBIDDEN_SEGMENTS.has(seg))) {
    throw fail('A9_OFFICE_TEMPLATE_EXPRESSION_FORBIDDEN', tag.slice(0, 80));
  }
  return segments;
}

function safeParser(tag) {
  const segments = validateSafeTag(tag);
  return {
    get(scope) {
      if (tag === '.') {
        if (typeof scope === 'function') return undefined;
        return scope;
      }
      let cur = scope;
      for (const seg of segments) {
        if (!cur || typeof cur !== 'object' || !Object.prototype.hasOwnProperty.call(cur, seg)) {
          return undefined;
        }
        cur = cur[seg];
      }
      if (typeof cur === 'function') return undefined;
      return cur;
    },
  };
}

function parseXmlStrict(buffer) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch (_err) {
    throw fail('A9_OFFICE_XML_INVALID');
  }
  if (text.includes('\0') || /<!\s*(?:DOCTYPE|ENTITY)/i.test(text)) {
    throw fail('A9_OFFICE_XML_ENTITY_UNSUPPORTED');
  }
  let doc;
  try {
    doc = new DOMParser({ onError: () => { throw fail('A9_OFFICE_XML_INVALID'); } }).parseFromString(text, 'application/xml');
  } catch (err) {
    throw (err && err.code) ? err : fail('A9_OFFICE_XML_INVALID');
  }
  const stack = [doc];
  let count = 0;
  while (stack.length) {
    const n = stack.pop();
    if (++count > 100000) throw fail('A9_OFFICE_XML_LIMIT');
    for (let c = n.lastChild; c; c = c.previousSibling) stack.push(c);
  }
  return doc;
}

function descendants(node, local, ns) {
  return Array.from(node.getElementsByTagNameNS(ns, local));
}

function checkedTemplateParts(buffer, format, options = {}) {
  const parts = readOfficeZip(buffer, {
    maxEntries: options.maxEntries || 512,
    maxBytes: options.maxBytes || 4 * 1024 * 1024,
    maxInflatedBytes: options.maxInflatedBytes || 32 * 1024 * 1024,
  });
  const xml = new Map();
  for (const [name, bytes] of parts) {
    const isEmptyDir = name.endsWith('/') && bytes.length === 0;
    if (!isEmptyDir && /(?:^|\/)(?:vbaproject|embeddings|activex|externallinks|connections|macrosheets)(?:[.\/]|$)|_xmlsignatures|\.bin$/i.test(name)) {
      throw fail('A9_OFFICE_ACTIVE_CONTENT_UNSUPPORTED');
    }
    if (/\.(?:xml|rels)$/i.test(name)) {
      const doc = parseXmlStrict(bytes);
      xml.set(name, doc);
      if (name.endsWith('.rels')) {
        for (const rel of descendants(doc, 'Relationship', REL_NS)) {
          const target = rel.getAttribute('Target') || '';
          if ((rel.getAttribute('TargetMode') || '').toLowerCase() === 'external'
            || /^(?:[a-z][\w+.-]*:|\/|\\)/i.test(target)
            || target.includes('\\')
            || target.includes('%')) {
            throw fail('A9_OFFICE_EXTERNAL_RELATION_UNSUPPORTED');
          }
          const base = name === '_rels/.rels' ? '' : posix.dirname(posix.dirname(name));
          const resolved = posix.normalize(posix.join(base, target));
          if (resolved.startsWith('../')) {
            throw fail('A9_OFFICE_EXTERNAL_RELATION_UNSUPPORTED');
          }
        }
      }
    }
  }
  const types = xml.get('[Content_Types].xml');
  const core = format === 'docx' ? 'word/document.xml' : 'ppt/presentation.xml';
  const expected = format === 'docx'
    ? [
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml',
    ]
    : [
      'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
      'application/vnd.openxmlformats-officedocument.presentationml.template.main+xml',
    ];
  if (!types || !xml.has(core) || !descendants(types, 'Override', CT_NS)
    .some(n => n.getAttribute('PartName') === '/' + core && expected.includes(n.getAttribute('ContentType')))) {
    throw fail('A9_OFFICE_FORMAT_MISMATCH');
  }
  return { parts, xml };
}

function classifyDocxtemplaterError(err) {
  if (err && err.code && /^A9_OFFICE_/.test(err.code)) return err;
  const subErrors = err && err.properties && Array.isArray(err.properties.errors) ? err.properties.errors : [err];
  for (const sub of subErrors) {
    const id = sub && sub.properties && sub.properties.id;
    const xtag = sub && sub.properties && sub.properties.xtag;
    if (sub && sub.code === 'A9_OFFICE_TEMPLATE_EXPRESSION_FORBIDDEN') return sub;
    if (xtag && /[^.\p{L}\p{N}_]/u.test(String(xtag).replace(/^[#^/]/, ''))) {
      return fail('A9_OFFICE_TEMPLATE_EXPRESSION_FORBIDDEN', String(xtag).slice(0, 80));
    }
    if (id) return fail('A9_OFFICE_TEMPLATE_SYNTAX_ERROR', String(id));
  }
  return fail('A9_OFFICE_TEMPLATE_SYNTAX_ERROR');
}

function compileAndInspectTags(buffer, format, options = {}) {
  const checked = checkedTemplateParts(buffer, format, options);
  let doc;
  try {
    const zip = new PizZip(buffer);
    doc = new Docxtemplater(zip, {
      parser: safeParser,
      paragraphLoop: true,
      linebreaks: true,
      stripInvalidXMLChars: true,
      errorLogging: false,
      nullGetter: () => '',
    });
  } catch (err) {
    throw classifyDocxtemplaterError(err);
  }

  const rootFields = new Map();
  function recordField(container, name, kind, fileName, inverted) {
    let entry = container.get(name);
    if (!entry) {
      entry = {
        name,
        kind,
        occurrences: 0,
        parts: [],
        ...(kind === 'loop' ? { inverted: Boolean(inverted), children: new Map() } : {}),
      };
      container.set(name, entry);
    }
    if (entry.kind !== kind && !(entry.kind === 'loop' && kind === 'loop')) {
      throw fail('A9_OFFICE_TEMPLATE_CONFLICT', name);
    }
    entry.occurrences += 1;
    if (!entry.parts.includes(fileName)) entry.parts.push(fileName);
    return entry;
  }

  function walk(parts, fileName, container) {
    for (const part of parts || []) {
      if (!part || part.type !== 'placeholder') continue;
      if (part.module && part.module !== 'loop') {
        throw fail('A9_OFFICE_TEMPLATE_EXPRESSION_FORBIDDEN', String(part.module));
      }
      if (part.raw && /^[@~$=]/.test(String(part.raw).trim())) {
        throw fail('A9_OFFICE_TEMPLATE_EXPRESSION_FORBIDDEN', String(part.raw).slice(0, 80));
      }
      validateSafeTag(part.value);
      if (Array.isArray(part.subparsed)) {
        const loopEntry = recordField(container, part.value, 'loop', fileName, part.inverted);
        walk(part.subparsed, fileName, loopEntry.children);
      } else {
        if (part.value === '.' && container === rootFields) {
          throw fail('A9_OFFICE_TEMPLATE_EXPRESSION_FORBIDDEN', '.');
        }
        recordField(container, part.value, 'scalar', fileName, false);
      }
    }
  }

  for (const fileName of doc.templatedFiles || []) {
    const compiled = doc.compiled && doc.compiled[fileName];
    if (compiled && Array.isArray(compiled.postparsed)) {
      walk(compiled.postparsed, fileName, rootFields);
    }
  }

  function serializeFields(map, prefix = '') {
    const out = [];
    for (const entry of [...map.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const fullPath = prefix ? `${prefix}.${entry.name}` : entry.name;
      out.push({
        name: entry.name,
        path: fullPath,
        kind: entry.kind,
        occurrences: entry.occurrences,
        parts: entry.parts,
        ...(entry.kind === 'loop' ? { inverted: entry.inverted, children: serializeFields(entry.children, fullPath) } : {}),
      });
    }
    return out;
  }

  const warnings = [];
  if (format === 'docx') {
    for (const [name, xmlDoc] of checked.xml) {
      if (!/^word\/(?:document|header\d+|footer\d+)\.xml$/i.test(name)) continue;
      if (['txbxContent', 'sdt', 'altChunk'].some(local => descendants(xmlDoc, local, W_NS).length > 0)) {
        warnings.push('模板含文本框、内容控件或复杂对象；不承诺任意内容下保持原分页或版式不变。');
        break;
      }
    }
  }
  const fields = serializeFields(rootFields);
  return {
    schemaVersion: 1,
    format,
    fields,
    templatedFiles: [...(doc.templatedFiles || [])],
    supportedFeatures: format === 'docx'
      ? ['paragraphs', 'tables', 'headers_footers', 'cross_run_placeholders', 'section_loops']
      : ['slides', 'notes', 'cross_run_placeholders', 'section_loops'],
    limitations: [
      '不承诺字体缺失、长文本、跨页表格或文本框溢出时仍保持原分页与版式。',
      format === 'docx'
        ? '批量生成前须由操作员在指定 Office/WPS 查看环境确认普通样张与边界样张。'
        : 'PPTX 结构由纯 JS 读写生成，实际视觉排版以指定 PowerPoint / WPS 查看环境为准。',
    ],
    warnings,
  };
}

function sameIdentity(actual, expected) {
  return Boolean(actual && expected)
    && actual.dev === expected.dev
    && actual.ino === expected.ino
    && actual.size === expected.size
    && actual.mtimeMs === expected.mtimeMs
    && actual.ctimeMs === expected.ctimeMs;
}

function validateRenderValue(value) {
  if (value === null || value === undefined) return;
  if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return;
  if (typeof value === 'string') {
    if (value.length > 16384 || /[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]/.test(value)) {
      throw fail('A9_OFFICE_CONTENT_INVALID');
    }
    for (let i = 0; i < value.length; i++) {
      const code = value.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(++i);
        if (!(next >= 0xdc00 && next <= 0xdfff)) throw fail('A9_OFFICE_CONTENT_INVALID');
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        throw fail('A9_OFFICE_CONTENT_INVALID');
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 2000) throw fail('A9_OFFICE_UNIT_LIMIT');
    for (const item of value) validateRenderValue(item);
    return;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (FORBIDDEN_SEGMENTS.has(k)) throw fail('A9_OFFICE_CONTENT_INVALID');
      validateRenderValue(v);
    }
    return;
  }
  throw fail('A9_OFFICE_CONTENT_INVALID');
}

function writeTempVerified(tempPath, tempIdentity, outBuf) {
  const lstat = fs.lstatSync(tempPath);
  if (!lstat.isFile() || lstat.isSymbolicLink()) throw fail('A9_OFFICE_TEMP_IDENTITY_CHANGED');
  const fd = fs.openSync(tempPath, 'r+');
  try {
    const st = fs.fstatSync(fd);
    if (!sameIdentity(st, tempIdentity) || st.size !== 0) throw fail('A9_OFFICE_TEMP_IDENTITY_CHANGED');
    let offset = 0;
    while (offset < outBuf.length) {
      const n = fs.writeSync(fd, outBuf, offset, outBuf.length - offset, offset);
      if (!n) throw fail('A9_OFFICE_WRITE_INCOMPLETE');
      offset += n;
    }
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return {
    tempPath,
    bytes: outBuf.length,
    sha256: crypto.createHash('sha256').update(outBuf).digest('hex'),
  };
}

function renderTemplateBuffer(templateBuffer, format, data, maxOutputBytes) {
  validateRenderValue(data);
  let doc;
  try {
    const zip = new PizZip(templateBuffer);
    doc = new Docxtemplater(zip, {
      parser: safeParser,
      paragraphLoop: true,
      linebreaks: true,
      stripInvalidXMLChars: true,
      errorLogging: false,
      nullGetter: () => '',
    });
    doc.render(data);
  } catch (err) {
    throw classifyDocxtemplaterError(err);
  }
  const outBuf = doc.getZip().generate({ type: 'nodebuffer', compression: 'DEFLATE' });
  if (outBuf.length > maxOutputBytes) throw fail('A9_OFFICE_BYTE_LIMIT');
  checkedTemplateParts(outBuf, format, { maxEntries: 512, maxBytes: maxOutputBytes, maxInflatedBytes: 32 * 1024 * 1024 });
  return outBuf;
}

function renderBatch(input) {
  const format = input.format || 'docx';
  if (format !== 'docx' && format !== 'pptx') throw fail('A9_OFFICE_FORMAT_UNSUPPORTED');
  const templateBuffer = Buffer.from(input.templateBuffer);
  const maxOutputBytes = Number.isSafeInteger(input.maxOutputBytes) && input.maxOutputBytes > 0
    ? input.maxOutputBytes
    : 8 * 1024 * 1024;
  compileAndInspectTags(templateBuffer, format, { maxBytes: maxOutputBytes });

  const results = [];
  for (const item of input.items || []) {
    const outBuf = renderTemplateBuffer(templateBuffer, format, item.data, maxOutputBytes);
    results.push(writeTempVerified(item.tempPath, item.tempIdentity, outBuf));
  }
  return { schemaVersion: 1, format, items: results };
}

function readPptxSummary(buffer, maxOutputBytes = 16 * 1024 * 1024) {
  const { xml } = checkedTemplateParts(buffer, 'pptx', {
    maxEntries: 512,
    maxBytes: maxOutputBytes,
    maxInflatedBytes: 48 * 1024 * 1024,
  });
  const slideEntries = [];
  for (const [name, doc] of xml) {
    const match = /^ppt\/slides\/slide(\d+)\.xml$/i.exec(name);
    if (!match) continue;
    slideEntries.push({ index: Number(match[1]), name, doc });
  }
  slideEntries.sort((a, b) => a.index - b.index);
  const slides = slideEntries.map((entry) => {
    const texts = descendants(entry.doc, 't', A_NS)
      .map(n => (n.textContent || '').trim())
      .filter(Boolean);
    const notesName = `ppt/notesSlides/notesSlide${entry.index}.xml`;
    const notesDoc = xml.get(notesName);
    const notesTexts = notesDoc
      ? descendants(notesDoc, 't', A_NS).map(n => (n.textContent || '').trim()).filter(Boolean)
      : [];
    return { index: entry.index, partName: entry.name, texts, notesTexts };
  });
  return { slideCount: slides.length, slides };
}

module.exports = {
  fail,
  validateSafeTag,
  safeParser,
  parseXmlStrict,
  descendants,
  checkedTemplateParts,
  compileAndInspectTags,
  renderTemplateBuffer,
  renderBatch,
  writeTempVerified,
  readPptxSummary,
  sameIdentity,
  validateRenderValue,
};
