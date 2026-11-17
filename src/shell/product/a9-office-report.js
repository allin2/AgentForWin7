'use strict';

const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');

function pptxAvailable() {
  return ['pptxgenjs', 'image-size', 'docxtemplater', 'pizzip', '@xmldom/xmldom'].every((name) => {
    try {
      return fs.statSync(path.join(__dirname, '../office-lite/node_modules', name, 'package.json')).isFile();
    } catch (_err) {
      return false;
    }
  });
}

function reportError(code, message, extra = {}) {
  return Object.assign(new Error(message || code), { code, ...extra });
}

function createReportWorkerPort({
  timeoutMs = 30_000,
  workerPath,
  maxOldGenerationSizeMb = 128,
  maxYoungGenerationSizeMb = 16,
} = {}) {
  let active = null;
  let closed = false;

  async function runWorker(workerData, signal) {
    if (closed) throw reportError('A9_OFFICE_CLOSED');
    if (signal?.aborted) throw reportError('A9_OFFICE_CANCELLED');
    if (active) throw reportError('A9_OFFICE_BUSY');

    const worker = new Worker(workerPath || path.join(__dirname, 'office-report-worker.js'), {
      workerData,
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
          failure = reportError('A9_OFFICE_CANCELLED');
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
          failure = reportError('A9_OFFICE_WORKER_FAILED');
        });
        worker.on('exit', (exitCode, exitSignal) => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
          const exitMeta = { workerExitCode: exitCode, workerSignal: exitSignal || null };
          if (signal?.aborted) failure = reportError('A9_OFFICE_CANCELLED', 'A9_OFFICE_CANCELLED', exitMeta);
          else if (closed) failure = reportError('A9_OFFICE_CLOSED', 'A9_OFFICE_CLOSED', exitMeta);
          else if (timedOut) failure = reportError('A9_OFFICE_TIMEOUT', 'A9_OFFICE_TIMEOUT', exitMeta);

          if (failure) return reject(Object.assign(failure, exitMeta));
          if (exitCode !== 0 || !message) {
            const code = message && !message.ok && message.error && message.error.code
              ? message.error.code
              : 'A9_OFFICE_WORKER_FAILED';
            return reject(reportError(code, (message && message.error && message.error.message) || code, exitMeta));
          }
          if (!message.ok) {
            return reject(reportError(
              (message.error && message.error.code) || 'A9_OFFICE_REPORT_FAILED',
              (message.error && message.error.message) || 'A9_OFFICE_REPORT_FAILED',
              exitMeta,
            ));
          }
          resolve({ ...message.result, workerExitCode: exitCode });
        });
      });
    } finally {
      if (active === worker) active = null;
    }
  }

  return {
    createLayoutsPresentation(input, signal) {
      return runWorker({ action: 'create_presentation_layouts', ...input }, signal);
    },
    fillTemplatePresentation(input, signal) {
      return runWorker({ action: 'fill_presentation_template', ...input }, signal);
    },
    async close() {
      closed = true;
      if (active) await active.terminate();
    },
  };
}

module.exports = { pptxAvailable, createReportWorkerPort };
