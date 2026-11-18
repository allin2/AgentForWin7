'use strict';

/**
 * Office 外围端口（Phase C / C1 拆分自 a9-agent-runtime.js）：
 * ZIP 归档 / 模板渲染 / 报告 PPTX Worker 与本地 EML 邮件适配器的惰性实例、
 * 注入 A9WorkspaceService 的选项，以及关闭时的释放。
 *
 * 只持有这些端口的生命周期，不接触审批、会话或工作区模式状态；审批通行证
 * （officeBatchApproval）仍由运行时注入，Office 业务规则仍在 a9-office-*.js 与 workspace 包内。
 */

function unavailable(code) {
  return Object.assign(new Error(code), { code });
}

function createOfficeWorkerPorts({ config, workspaceRoot }) {
  const archiveModule = require('./a9-office-archive');
  const templateModule = require('./a9-office-template');
  const reportModule = require('./a9-office-report');
  const mailModule = require('./a9-office-mail');
  let archiveWorkerPort = null;
  let templateWorkerPort = null;
  let reportWorkerPort = null;
  let mailEmlAdapter = null;
  const templateSampleStore = new Map();

  function getMailEmlAdapter() {
    if (!mailEmlAdapter) {
      if (!mailModule.emlAvailable()) throw unavailable('MAIL_EML_ADAPTER_UNAVAILABLE');
      mailEmlAdapter = mailModule.createEmlDirectoryMailAdapter({ workspaceRoot });
    }
    return mailEmlAdapter;
  }
  function getArchiveWorkerPort() {
    if (!archiveWorkerPort) {
      if (!archiveModule.yazlAvailable()) throw unavailable('ARCHIVE_WORKER_UNAVAILABLE');
      archiveWorkerPort = archiveModule.createArchiveWorkerPort(config.archiveWorkerOptions);
    }
    return archiveWorkerPort;
  }
  function getTemplateWorkerPort() {
    if (!templateWorkerPort) {
      if (!templateModule.docxtemplaterAvailable()) throw unavailable('TEMPLATE_WORKER_UNAVAILABLE');
      templateWorkerPort = templateModule.createTemplateWorkerPort(config.templateWorkerOptions);
    }
    return templateWorkerPort;
  }
  function getReportWorkerPort() {
    if (!reportWorkerPort) {
      if (!reportModule.pptxAvailable()) throw unavailable('REPORT_WORKER_UNAVAILABLE');
      reportWorkerPort = reportModule.createReportWorkerPort(config.reportWorkerOptions);
    }
    return reportWorkerPort;
  }

  /** 依可用性组装传给 A9WorkspaceService 的 Office 端口选项（不含审批通行证）。 */
  function workspaceOptions() {
    const officeArchiveWorker = {
      createZip: (input, signal) => getArchiveWorkerPort().createZip(input, signal),
      close: () => (archiveWorkerPort ? archiveWorkerPort.close() : Promise.resolve()),
    };
    const officeTemplateWorker = {
      inspectTemplate: (buffer, format, signal) => getTemplateWorkerPort().inspectTemplate(buffer, format, signal),
      renderBatch: (input, signal) => getTemplateWorkerPort().renderBatch(input, signal),
      close: () => (templateWorkerPort ? templateWorkerPort.close() : Promise.resolve()),
    };
    const officeReportWorker = {
      createLayoutsPresentation: (input, signal) => getReportWorkerPort().createLayoutsPresentation(input, signal),
      fillTemplatePresentation: (input, signal) => getReportWorkerPort().fillTemplatePresentation(input, signal),
      close: () => (reportWorkerPort ? reportWorkerPort.close() : Promise.resolve()),
    };
    const officeMailEmlAdapter = mailModule.emlAvailable()
      ? {
        schemaVersion: 1,
        sourceId: 'eml',
        kind: 'eml_directory',
        evidenceClass: 'LOCAL_EML_EXPORT',
        listFolders: (opts, sig) => getMailEmlAdapter().listFolders(opts, sig),
        listMessages: (opts, sig) => getMailEmlAdapter().listMessages(opts, sig),
        readMessage: (id, opts, sig) => getMailEmlAdapter().readMessage(id, opts, sig),
        readAttachmentBytes: (id, attId, opts, sig) => getMailEmlAdapter().readAttachmentBytes(id, attId, opts, sig),
      }
      : undefined;
    return {
      ...(archiveModule.yazlAvailable() ? { officeArchiveWorker } : {}),
      ...(templateModule.docxtemplaterAvailable() ? { officeTemplateWorker, officeTemplateSamples: templateSampleStore } : {}),
      ...(reportModule.pptxAvailable() ? { officeReportWorker } : {}),
      ...(officeMailEmlAdapter ? { officeMailEmlAdapter } : {}),
    };
  }

  return {
    availability: () => ({
      archive: archiveModule.yazlAvailable(),
      template: templateModule.docxtemplaterAvailable(),
      report: reportModule.pptxAvailable(),
    }),
    workspaceOptions,
    /** 是否已有需要在关闭时释放的端口（惰性：未使用过则没有）。 */
    hasOpenPorts: () => Boolean(archiveWorkerPort || templateWorkerPort || reportWorkerPort || mailEmlAdapter),
    /** 依次（归档、模板、报告、邮件）异步释放已创建的端口；未创建的返回已完成的 Promise。 */
    closeOpenPorts: () => [archiveWorkerPort, templateWorkerPort, reportWorkerPort, mailEmlAdapter]
      .map((port) => (port ? Promise.resolve().then(() => port.close()) : Promise.resolve())),
  };
}

module.exports = { createOfficeWorkerPorts };
