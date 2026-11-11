'use strict';

const fs = require('fs');
const path = require('path');

const FILE_BYTES = 2 * 1024 * 1024;
const LINE_BYTES = 4096;
const CODE_PATTERN = /^(?:A[89]_[A-Z0-9_]+|E[A-Z0-9]{2,15}|ERR_[A-Z0-9_]{2,44})$/;
const ERROR_NAMES = new Set(['Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'URIError', 'EvalError', 'AggregateError']);
const STACK_FILES = new Set(['main.js', 'a9-diagnostics-log.js', 'desktop-host.js', 'a9-agent-runtime.js', 'a9-workspace-registry.js', 'a9-product-ipc.js', 'a9-package-runtime.js', 'active-workspace-store.js', 'rc-composition.js', 'runner-runtime.js']);

function errorFacts(error, fallback = 'A9_DIAGNOSTIC_ERROR') {
  // Error messages can contain entire requests. Never persist a message,
  // arbitrary class name, function name, or raw stack.
  try {
    const code = error && typeof error.code === 'string' ? error.code : '';
    const errorCode = code.length <= 48 && CODE_PATTERN.test(code) && !/[0-9]{6}/.test(code) ? code : fallback;
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
  const maxFileBytes = Math.max(512, Math.min(FILE_BYTES, config.maxFileBytes || FILE_BYTES));
  const maxLineBytes = Math.max(256, Math.min(LINE_BYTES, maxFileBytes / 2, config.maxLineBytes || LINE_BYTES));
  const maxQueue = Math.max(1, Math.min(256, config.maxQueue || 256));
  // 1 MiB IPC + two 2 MiB critical files + 1 MiB emergency = 6 MiB.
  const normal = { activePath: path.join(directory, 'main.jsonl'), previousPath: null, bytes: 0, limit: maxFileBytes / 2 };
  const critical = { activePath: path.join(directory, 'critical.jsonl'), previousPath: path.join(directory, 'critical.previous.jsonl'), bytes: 0, previousBytes: 0, limit: maxFileBytes };
  const emergency = { activePath: path.join(directory, 'main.fatal.jsonl'), bytes: 0, limit: maxFileBytes / 2 };
  const normalQueue = [];
  const criticalQueue = [];
  const stats = { recordCount: 0, writtenCount: 0, droppedCount: 0, writeFailureCount: 0, truncatedCount: 0 };
  let lastNormalWrite = Promise.resolve(true);
  let lastCriticalWrite = Promise.resolve(true);
  let normalDraining = false;
  let criticalDraining = false;
  let stopped = false;
  let ipcWaitSuspended = false;

  function encode(event, values) {
    const row = { schemaVersion: 1, timestamp: new Date().toISOString(), pid: process.pid, event };
    for (const key of ['stage', 'channel', 'action', 'errorCode', 'errorName', 'reason', 'version', 'electron', 'node', 'blockReason']) {
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
      delete row.pending;
      delete row.stackFrames;
      row.truncated = true;
      for (const key of Object.keys(row)) if (typeof row[key] === 'string' && key !== 'timestamp') row[key] = row[key].slice(0, 32);
      line = JSON.stringify(row) + '\n';
      if (Buffer.byteLength(line, 'utf8') > maxLineBytes) line = JSON.stringify({ schemaVersion: 1, timestamp: row.timestamp, pid: row.pid, event: 'record-truncated', truncated: true }) + '\n';
    }
    return line;
  }

  let directoryReady = false;
  let initialization;
  async function statAsyncOrZero(file) {
    if (!file) return 0;
    try { return (await io.promises.stat(file)).size; } catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
  }
  function initialize() {
    if (!initialization) initialization = (async () => {
      await io.promises.mkdir(directory, { recursive: true });
      // Reuse the previous format's rotated file as critical history. Its
      // bounded retention still applies; obsolete rotation is removed once.
      const legacyPath = path.join(directory, 'main.previous.jsonl');
      const legacyBytes = await statAsyncOrZero(legacyPath);
      if (legacyBytes) {
        if (await statAsyncOrZero(critical.previousPath)) await io.promises.unlink(legacyPath);
        else await io.promises.rename(legacyPath, critical.previousPath);
      }
      normal.bytes = await statAsyncOrZero(normal.activePath);
      critical.bytes = await statAsyncOrZero(critical.activePath);
      critical.previousBytes = await statAsyncOrZero(critical.previousPath);
      emergency.bytes = await statAsyncOrZero(emergency.activePath);
      for (const state of [normal, critical, emergency]) {
        if (state.bytes > state.limit) { await io.promises.truncate(state.activePath, 0); state.bytes = 0; }
      }
      if (critical.previousBytes > critical.limit) {
        await io.promises.truncate(critical.previousPath, 0); critical.previousBytes = 0;
      }
      directoryReady = true;
    })();
    return initialization;
  }

  async function appendAsync(state, line) {
    await initialize();
    const bytes = Buffer.byteLength(line, 'utf8');
    if (state.bytes + bytes > state.limit) {
      if (state.previousPath) {
        try { await io.promises.unlink(state.previousPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        try { await io.promises.rename(state.activePath, state.previousPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        state.previousBytes = state.bytes;
      } else {
        await io.promises.writeFile(state.activePath, '', 'utf8');
      }
      state.bytes = 0;
    }
    await io.promises.appendFile(state.activePath, line, 'utf8');
    state.bytes += bytes;
  }

  let syncDirectoryReady = false;
  function appendSync(line) {
    // Fatal/exit only: a bounded record must not open a FIFO or follow a link.
    // Async initialization may still be pending when Electron exits early.
    if (!directoryReady && !syncDirectoryReady) {
      io.mkdirSync(directory, { recursive: true });
      syncDirectoryReady = true;
    }
    let existingBytes = 0;
    try {
      const target = io.lstatSync(emergency.activePath);
      if (!target.isFile()) throw new Error('A9_DIAGNOSTIC_TARGET_INVALID');
      existingBytes = target.size;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const bytes = Buffer.byteLength(line, 'utf8');
    const rotate = existingBytes + bytes > emergency.limit;
    io.writeFileSync(emergency.activePath, line, { encoding: 'utf8', flag: rotate ? 'w' : 'a' });
    emergency.bytes = (rotate ? 0 : existingBytes) + bytes;
  }

  async function drain(state, queue, criticalDrain) {
    if (criticalDrain ? criticalDraining : normalDraining) return;
    if (criticalDrain) criticalDraining = true; else normalDraining = true;
    try {
      while (queue.length) {
        const item = queue[0];
        try {
          await appendAsync(state, item.line);
          stats.writtenCount += 1;
          ipcWaitSuspended = false;
          item.resolve(true);
        } catch (_error) {
          stats.writeFailureCount += 1;
          item.resolve(false);
        }
        queue.shift();
      }
    } finally {
      if (criticalDrain) criticalDraining = false; else normalDraining = false;
    }
  }

  function enqueue(state, queue, event, values, criticalRecord) {
    stats.recordCount += 1;
    if (stopped || queue.length >= maxQueue) { stats.droppedCount += 1; return Promise.resolve(false); }
    try {
      const result = new Promise(resolve => queue.push({ line: encode(event, values), resolve }));
      if (criticalRecord) lastCriticalWrite = result; else lastNormalWrite = result;
      void drain(state, queue, criticalRecord);
      return result;
    } catch (_error) {
      stats.writeFailureCount += 1;
      return Promise.resolve(false);
    }
  }

  async function boundedWait(result, onTimeout) {
    let timer;
    try { return await Promise.race([result, new Promise(resolve => { timer = setTimeout(() => { if (onTimeout) onTimeout(); resolve(false); }, 50); })]); }
    finally { clearTimeout(timer); }
  }

  function criticalSync(event, values = {}) {
    stats.recordCount += 1;
    try {
      appendSync(encode(event, values));
      stats.writtenCount += 1;
      ipcWaitSuspended = false;
      return true;
    } catch (_error) {
      stats.writeFailureCount += 1;
      return false;
    }
  }

  function isCritical(event, values) {
    return event !== 'ipc-begin' && event !== 'ipc-end' || Boolean(values.errorCode) || (event === 'ipc-end' && values.durationMs > 1000);
  }
  function record(event, values = {}) {
    return isCritical(event, values) ? enqueue(critical, criticalQueue, event, values, true)
      : enqueue(normal, normalQueue, event, values, false);
  }
  return {
    record,
    critical: (event, values = {}) => enqueue(critical, criticalQueue, event, values, true),
    checkpoint: (event, values = {}) => {
      const result = record(event, values);
      if (event !== 'ipc-begin') return boundedWait(result);
      if (ipcWaitSuspended) return Promise.resolve(false);
      return boundedWait(result, () => { ipcWaitSuspended = true; });
    },
    criticalCheckpoint: (event, values = {}) => boundedWait(enqueue(critical, criticalQueue, event, values, true)),
    fatal: (event, values = {}) => boundedWait(enqueue(critical, criticalQueue, event, values, true)),
    flush: () => boundedWait(Promise.all([lastNormalWrite, lastCriticalWrite])),
    criticalSync,
    stop: () => { stopped = true; },
    snapshot: () => ({ directory, ...stats, ipcWaitSuspended, queuedCount: normalQueue.length + criticalQueue.length }),
  };
}

function createFlightRecorder(log) {
  const pending = new Map();
  let sequence = 0;
  let lastTick = process.hrtime.bigint();
  let timer;
  let stopped = false;
  let stallSuppressed = false;
  const elapsed = start => Number(process.hrtime.bigint() - start) / 1e6;
  function pulse() {
    const durationMs = elapsed(lastTick);
    if (!stallSuppressed && durationMs > 1000) void log.critical('main-thread-stall', { durationMs, pendingCount: pending.size, pending: Array.from(pending.values()).slice(0, 16) });
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
    const ready = recordStart ? (kind === 'ipc' ? log.checkpoint(`${kind}-begin`, metadata) : log.criticalCheckpoint(`${kind}-begin`, metadata)) : Promise.resolve();
    return {
      ready,
      end(error) {
        pulse();
        pending.delete(operationId);
        const durationMs = elapsed(start);
        if (recordStart || error || durationMs > 1000) {
          const values = { ...metadata, durationMs, ...(error ? errorFacts(error, kind === 'ipc' ? 'A9_IPC_FAILED' : 'A9_STARTUP_FAILED') : {}) };
          void (kind === 'ipc' ? log.record(`${kind}-end`, values) : log.critical(`${kind}-end`, values));
        }
      },
    };
  }
  async function stage(stage, work) {
    const operation = begin('startup-stage', { stage });
    await operation.ready;
    try { const result = await work(); operation.end(); return result; }
    catch (error) { operation.end(error); throw error; }
  }
  function withoutStall(reason, work) {
    stallSuppressed = true;
    try { return work(); }
    finally { stallSuppressed = false; lastTick = process.hrtime.bigint(); void log.critical('main-thread-blocked', { blockReason: reason }); }
  }
  return { begin, stage, withoutStall, stop() { stopped = true; clearTimeout(timer); log.stop(); } };
}

module.exports = { createDiagnosticsLog, createFlightRecorder, errorFacts };
