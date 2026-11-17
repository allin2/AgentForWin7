'use strict';

const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');

function yazlAvailable() {
  return ['yazl', 'buffer-crc32'].every((name) => {
    try {
      return fs.statSync(path.join(__dirname, '../office-lite/node_modules', name, 'package.json')).isFile();
    } catch (_err) {
      return false;
    }
  });
}

function archiveError(code, extra = {}) {
  return Object.assign(new Error(code), { code, ...extra });
}

function createArchiveWorkerPort({
  timeoutMs = 60_000,
  workerPath,
  maxOldGenerationSizeMb = 128,
  maxYoungGenerationSizeMb = 16,
} = {}) {
  let active = null;
  let closed = false;

  async function createZip(input, signal) {
    if (closed) throw archiveError('ARCHIVE_CLOSED');
    if (signal?.aborted) throw archiveError('ARCHIVE_CANCELLED');
    if (active) throw archiveError('ARCHIVE_BUSY');

    const worker = new Worker(workerPath || path.join(__dirname, 'office-zip-worker.js'), {
      workerData: input,
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
          failure = archiveError('ARCHIVE_CANCELLED');
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
        worker.on('error', (err) => {
          const code = /^ARCHIVE_[A-Z0-9_]+$/.test(String(err && err.code ? err.code : ''))
            ? err.code
            : 'ARCHIVE_WORKER_FAILED';
          failure = archiveError(code);
        });
        worker.on('exit', (exitCode, exitSignal) => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
          const exitMeta = { workerExitCode: exitCode, workerSignal: exitSignal || null };
          if (signal?.aborted) failure = archiveError('ARCHIVE_CANCELLED', exitMeta);
          else if (closed) failure = archiveError('ARCHIVE_CLOSED', exitMeta);
          else if (timedOut) failure = archiveError('ARCHIVE_TIMEOUT', exitMeta);

          if (failure) return reject(Object.assign(failure, exitMeta));
          if (exitCode !== 0 || !message) {
            const code = message && !message.ok && message.error && message.error.code
              ? message.error.code
              : 'ARCHIVE_WORKER_FAILED';
            return reject(archiveError(code, exitMeta));
          }
          if (!message.ok) {
            return reject(archiveError((message.error && message.error.code) || 'ARCHIVE_WORKER_FAILED', exitMeta));
          }
          resolve({ ...message.result, workerExitCode: exitCode });
        });
      });
    } finally {
      if (active === worker) active = null;
    }
  }

  async function close() {
    closed = true;
    if (active) await active.terminate();
  }

  return { createZip, close };
}

module.exports = { yazlAvailable, createArchiveWorkerPort };
