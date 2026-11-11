'use strict';

const fs = require('fs');
const path = require('path');

const FILE_BYTES = 2 * 1024 * 1024;
const LINE_BYTES = 4096;
const ERROR_NAMES = new Set(['Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'URIError', 'EvalError', 'AggregateError']);
const SYSTEM_CODES = new Set(['EACCES', 'EPERM', 'ENOENT', 'ENOSPC', 'EIO', 'EMFILE', 'ENFILE', 'EBUSY', 'EROFS', 'ERR_DLOPEN_FAILED']);
const PRODUCT_CODES = new Set(['A9_STARTUP_FAILED', 'A9_IPC_FAILED', 'A9_MAIN_UNCAUGHT_EXCEPTION', 'A9_MAIN_UNHANDLED_REJECTION',
  'A9_WORKSPACE_REQUIRED', 'A9_SCOPE_INVALID', 'A9_PAYLOAD_INVALID', 'A9_ACTION_UNAVAILABLE', 'A9_WORKSPACE_SELECTION_BUSY',
  'A9_PROVIDER_UNVERIFIED', 'A9_CHECKPOINT_EVIDENCE_UNAVAILABLE', 'A9_MODE_SELECTION_REQUIRED', 'A9_RUNTIME_UNAVAILABLE',
  'APP_SHUTTING_DOWN', 'STARTUP_NOT_READY', 'RENDERER_CAPABILITY_DENIED', 'IPC_SCHEMA_INVALID', 'IPC_DIRECTION_DENIED']);
const STACK_FILES = new Set(['main.js', 'a9-diagnostics-log.js', 'desktop-host.js', 'a9-agent-runtime.js', 'a9-workspace-registry.js', 'a9-product-ipc.js', 'a9-package-runtime.js', 'active-workspace-store.js', 'rc-composition.js', 'runner-runtime.js']);

function errorFacts(error, fallback = 'A9_DIAGNOSTIC_ERROR') {
  // Error messages can contain entire requests. The Runtime's secret-aware
  // redactor is private; the acceptance-report regex is not sufficient here.
  // Never persist a message, arbitrary class name, function name or raw stack.
  try {
    const code = error && typeof error.code === 'string' ? error.code : '';
    const errorCode = SYSTEM_CODES.has(code) || PRODUCT_CODES.has(code) ? code : fallback;
    const errorName = error && ERROR_NAMES.has(error.name) ? error.name : 'Error';
    const stackFrames = [];
    if (error && typeof error.stack === 'string') {
      for (const frame of error.stack.slice(0, 8192).split('\n').slice(1, 6)) {
        const match = /(?:[/\\])([a-z0-9-]+\.js):(\d{1,7}):(\d{1,7})\)?$/.exec(frame);
        if (match && STACK_FILES.has(match[1])) stackFrames.push({ file: match[1], line: Number(match[2]), column: Number(match[3]) });
      }
    }
    return { errorCode, errorName, ...(stackFrames.length ? { stackFrames } : {}) };
  } catch (_error) {
    return { errorCode: fallback, errorName: 'Error' };
  }
}

function createDiagnosticsLog(options) {
  const config = options || {};
  const io = config.fs || fs;
  const directory = path.join(config.userDataPath, 'diagnostics');
  const activePath = path.join(directory, 'main.jsonl');
  const previousPath = path.join(directory, 'main.previous.jsonl');
  const fatalPath = path.join(directory, 'main.fatal.jsonl');
  const maxFileBytes = Math.max(512, Math.min(FILE_BYTES, config.maxFileBytes || FILE_BYTES));
  const maxLineBytes = Math.max(256, Math.min(LINE_BYTES, maxFileBytes, config.maxLineBytes || LINE_BYTES));
  const maxQueue = Math.max(1, Math.min(256, config.maxQueue || 256));
  const stats = { recordCount: 0, writtenCount: 0, droppedCount: 0, writeFailureCount: 0, truncatedCount: 0 };
  const queue = [];
  let draining = false;
  let fatalWritten = false;
  let stopped = false;
  let lastWrite = Promise.resolve(true);

  function encode(event, values) {
    const row = { schemaVersion: 1, timestamp: new Date().toISOString(), pid: process.pid, event };
    // Only host-selected metadata is accepted. No generic object serialization.
    for (const key of ['stage', 'channel', 'action', 'errorCode', 'errorName', 'reason', 'version', 'electron', 'node']) {
      if (typeof values[key] === 'string') row[key] = values[key].slice(0, 96);
    }
    for (const key of ['operationId', 'durationMs', 'exitCode', 'pendingCount']) {
      if (Number.isFinite(values[key])) row[key] = Math.max(-2147483648, Math.min(Number.MAX_SAFE_INTEGER, Math.round(values[key])));
    }
    if (Array.isArray(values.stackFrames)) row.stackFrames = values.stackFrames.slice(0, 5).map(frame => ({ file: frame.file, line: frame.line, column: frame.column }));
    if (Array.isArray(values.pending)) row.pending = values.pending.slice(0, 16).map(item => ({
      operationId: item.operationId, ...(item.stage ? { stage: item.stage } : {}),
      ...(item.channel ? { channel: item.channel, action: item.action } : {}),
    }));
    let line = JSON.stringify(row) + '\n';
    if (Buffer.byteLength(line, 'utf8') > maxLineBytes) {
      stats.truncatedCount += 1;
      // Keep valid JSON and the operation identity, never cut a UTF-8 byte sequence.
      delete row.pending;
      delete row.stackFrames;
      row.truncated = true;
      for (const key of Object.keys(row)) if (typeof row[key] === 'string' && key !== 'timestamp') row[key] = row[key].slice(0, 32);
      line = JSON.stringify(row) + '\n';
      if (Buffer.byteLength(line, 'utf8') > maxLineBytes) line = JSON.stringify({ schemaVersion: 1, timestamp: row.timestamp, pid: row.pid, event: 'record-truncated', truncated: true }) + '\n';
    }
    return line;
  }

  async function size(file) {
    try { return (await io.promises.stat(file)).size; }
    catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
  }

  async function drain() {
    if (draining) return;
    draining = true;
    try {
      while (queue.length) {
        const item = queue[0];
        try {
          await io.promises.mkdir(directory, { recursive: true });
          if (await size(activePath) + Buffer.byteLength(item.line, 'utf8') > maxFileBytes) {
            try { await io.promises.unlink(previousPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
            await io.promises.rename(activePath, previousPath);
          }
          await io.promises.appendFile(activePath, item.line, 'utf8');
          stats.writtenCount += 1;
          item.resolve(true);
        } catch (_error) {
          stats.writeFailureCount += 1;
          item.resolve(false);
        }
        queue.shift();
      }
    } finally { draining = false; }
  }

  function record(event, values = {}) {
    stats.recordCount += 1;
    if (stopped || queue.length >= maxQueue) { stats.droppedCount += 1; return Promise.resolve(false); }
    try {
      const line = encode(event, values);
      const result = new Promise(resolve => queue.push({ line, resolve }));
      lastWrite = result;
      void drain();
      return result;
    } catch (_error) {
      stats.writeFailureCount += 1;
      return Promise.resolve(false);
    }
  }

  async function boundedWait(result) {
    // This bounds only diagnostic I/O waiting, never an Agent command or tool.
    let timer;
    try { return await Promise.race([result, new Promise(resolve => { timer = setTimeout(() => resolve(false), 50); })]); }
    finally { clearTimeout(timer); }
  }

  function fatal(event, values = {}) {
    if (fatalWritten) return boundedWait(record(event, values));
    fatalWritten = true;
    stats.recordCount += 1;
    try {
      const line = encode(event, values);
      io.mkdirSync(directory, { recursive: true });
      let length = 0;
      try { length = io.statSync(fatalPath).size; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      // Separate emergency file cannot race the asynchronous normal rotation.
      io.writeFileSync(fatalPath, line, { encoding: 'utf8', flag: length + Buffer.byteLength(line, 'utf8') > maxFileBytes ? 'w' : 'a' });
      stats.writtenCount += 1;
      return Promise.resolve(true);
    } catch (_error) { stats.writeFailureCount += 1; return Promise.resolve(false); }
  }

  return { record, checkpoint: (event, values) => boundedWait(record(event, values)), flush: () => boundedWait(lastWrite),
    fatal, stop: () => { stopped = true; }, snapshot: () => ({ directory, ...stats, queuedCount: queue.length }) };
}

function createFlightRecorder(log) {
  const pending = new Map();
  let sequence = 0;
  let lastTick = process.hrtime.bigint();
  let timer;
  let stopped = false;
  const elapsed = start => Number(process.hrtime.bigint() - start) / 1e6;
  function pulse() {
    const durationMs = elapsed(lastTick);
    if (durationMs > 1000) void log.record('main-thread-stall', { durationMs, pendingCount: pending.size, pending: Array.from(pending.values()).slice(0, 16) });
    lastTick = process.hrtime.bigint();
  }
  function tick() {
    pulse();
    if (!stopped) { timer = setTimeout(tick, 250); if (timer.unref) timer.unref(); }
  }
  timer = setTimeout(tick, 250);
  if (timer.unref) timer.unref();

  function begin(kind, facts, recordStart = true) {
    pulse();
    const operationId = ++sequence;
    const metadata = { ...facts, operationId };
    const start = process.hrtime.bigint();
    if (pending.size < 256) pending.set(operationId, metadata);
    const ready = recordStart ? log.checkpoint(`${kind}-begin`, metadata) : Promise.resolve();
    return {
      ready,
      end(error) {
        // Sample before removing the action: a synchronous block can end in
        // a microtask before the heartbeat timer gets another turn.
        pulse();
        pending.delete(operationId);
        const durationMs = elapsed(start);
        if (recordStart || error || durationMs > 1000) void log.record(`${kind}-end`, {
          ...metadata, durationMs, ...(error ? errorFacts(error, kind === 'ipc' ? 'A9_IPC_FAILED' : 'A9_STARTUP_FAILED') : {}),
        });
      },
    };
  }
  async function stage(stage, work) {
    const operation = begin('startup-stage', { stage });
    await operation.ready;
    try { const result = await work(); operation.end(); return result; }
    catch (error) { operation.end(error); throw error; }
  }
  return { begin, stage, stop() { stopped = true; clearTimeout(timer); log.stop(); } };
}

module.exports = { createDiagnosticsLog, createFlightRecorder, errorFacts };
