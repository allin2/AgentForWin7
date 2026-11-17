'use strict';

const { parentPort, workerData } = require('worker_threads');
const { fail, compileAndInspectTags, renderBatch } = require('./office-template-core');

(async () => {
  try {
    if (!workerData || !['inspect', 'render_batch'].includes(workerData.action)) {
      throw fail('A9_OFFICE_FORMAT_UNSUPPORTED');
    }
    if (workerData.action === 'inspect') {
      const buffer = Buffer.from(workerData.buffer);
      parentPort.postMessage({ ok: true, result: compileAndInspectTags(buffer, workerData.format || 'docx') });
    } else {
      parentPort.postMessage({ ok: true, result: renderBatch(workerData) });
    }
  } catch (error) {
    const code = /^A9_OFFICE_[A-Z0-9_]+$/.test(String(error && error.code ? error.code : ''))
      ? error.code
      : 'A9_OFFICE_TEMPLATE_FAILED';
    parentPort.postMessage({ ok: false, error: { code, message: String(error && error.message ? error.message : code).slice(0, 300) } });
  } finally {
    parentPort.close();
  }
})();
