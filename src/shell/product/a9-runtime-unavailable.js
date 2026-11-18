'use strict';

/**
 * 持久化不可用时的降级运行时（Phase C / C1 拆分自 a9-agent-runtime.js）：
 * Electron-ABI better-sqlite3 预检、SQLite 不可用运行时、数据库受限诊断运行时。
 * 它们不依赖主运行时闭包；所有动作 fail-closed 并返回稳定错误码。
 */

const path = require('path');
const { boundedDiagnosticText } = require('./a9-runtime-redaction');

const A9_PROTOCOL_VERSION = 1;

function preflightElectronSqlite(root) {
  try {
    const modulePath = path.join(String(root), 'node_modules', 'better-sqlite3');
    // eslint-disable-next-line global-require
    const Database = require(modulePath);
    const probe = new Database(':memory:');
    const version = probe.prepare('select sqlite_version() v').get();
    probe.close();
    return {
      ok: true,
      sqliteVersion: version && version.v,
      openDatabase: (databasePath, opts) => new Database(databasePath, opts && opts.readonly ? { readonly: true } : {}),
    };
  } catch (err) {
    // A9-67 F-028: a stable probe code precedes the bounded detail so the
    // diagnostic is classifiable without parsing platform-specific messages.
    const message = `${err && err.message ? err.message : String(err)}`;
    const errorCode = err && typeof err.code === 'string' ? err.code : '';
    const code = errorCode === 'MODULE_NOT_FOUND' ? 'A9_PROBE_SQLITE_MODULE_MISSING'
      : errorCode === 'ERR_DLOPEN_FAILED' || /NODE_MODULE_VERSION/.test(message) ? 'A9_PROBE_SQLITE_ABI_MISMATCH'
        : 'A9_PROBE_SQLITE_OPEN_FAILED';
    return { ok: false, code, reason: `${code}: ${message}` };
  }
}

function createSqliteUnavailableRuntime(reason) {
  const safeReason = boundedDiagnosticText(reason);
  return {
    protocolVersion: 1,
    status: 'electron_sqlite_unavailable',
    shareProviderState() { throw Object.assign(new Error('ELECTRON_SQLITE_UNAVAILABLE'), { code: 'ELECTRON_SQLITE_UNAVAILABLE' }); },
    acceptProviderState() { throw Object.assign(new Error('ELECTRON_SQLITE_UNAVAILABLE'), { code: 'ELECTRON_SQLITE_UNAVAILABLE' }); },
    diagnostics: { code: 'ELECTRON_SQLITE_UNAVAILABLE', detail: safeReason },
    whenReady() { return Promise.resolve(); },
    assertAvailable() {},
    configureProvider() { throw new Error('ELECTRON_SQLITE_UNAVAILABLE'); },
    probeProvider() { throw new Error('ELECTRON_SQLITE_UNAVAILABLE'); },
    configureShell() { throw new Error('ELECTRON_SQLITE_UNAVAILABLE'); },
    async continueTask() { return { ok: false, error: { code: 'ELECTRON_SQLITE_UNAVAILABLE' } }; },
    dismissRecovered() { return { ok: false, error: { code: 'ELECTRON_SQLITE_UNAVAILABLE' } }; },
    selectOfficeActions() { return { ok: false, error: { code: 'ELECTRON_SQLITE_UNAVAILABLE' } }; },
    confirmTemplateSample() { return { ok: false, error: { code: 'ELECTRON_SQLITE_UNAVAILABLE' } }; },
    previewHtmlReport() { return { ok: false, error: { code: 'ELECTRON_SQLITE_UNAVAILABLE' } }; },
    installOfficeSkills() { return { ok: false, error: { code: 'ELECTRON_SQLITE_UNAVAILABLE' } }; },
    updateQueue() { return { ok: false, error: { code: 'A9_QUEUE_UNAVAILABLE' } }; },
    async submitTurn() { return { ok: false, error: { code: 'ELECTRON_SQLITE_UNAVAILABLE', message: 'Electron-ABI better-sqlite3 预检失败，A9 持久化不可用。' } }; },
    async resumeApproval() { return { ok: false, error: { code: 'ELECTRON_SQLITE_UNAVAILABLE' } }; },
    async answerQuestion() { return { ok: false, error: { code: 'ELECTRON_SQLITE_UNAVAILABLE' } }; },
    stop() { return { ok: false }; },
    saveDraft() { return { ok: false, error: { code: 'ELECTRON_SQLITE_UNAVAILABLE' } }; },
    createConversation() { throw new Error('ELECTRON_SQLITE_UNAVAILABLE'); },
    activateConversation() { throw new Error('ELECTRON_SQLITE_UNAVAILABLE'); },
    renameConversation() { throw new Error('ELECTRON_SQLITE_UNAVAILABLE'); },
    archiveConversation() { throw new Error('ELECTRON_SQLITE_UNAVAILABLE'); },
    restoreConversation() { throw new Error('ELECTRON_SQLITE_UNAVAILABLE'); },
    settleConversation() { return { ok: false, error: { code: 'ELECTRON_SQLITE_UNAVAILABLE' } }; },
    reopenConversation() { return { ok: false, error: { code: 'ELECTRON_SQLITE_UNAVAILABLE' } }; },
    visitConversation() { return { ok: false, error: { code: 'ELECTRON_SQLITE_UNAVAILABLE' } }; },
    canLeaveWorkspace() { return { allowed: true, reason: null }; },
    getWorkdirInfo() { return {}; },
    getTransferWorkspace() { throw Object.assign(new Error('ELECTRON_SQLITE_UNAVAILABLE'), { code: 'ELECTRON_SQLITE_UNAVAILABLE' }); },
    getWorkdirConversationId() { return null; },
    ensureWorkdir() { throw Object.assign(new Error('ELECTRON_SQLITE_UNAVAILABLE'), { code: 'ELECTRON_SQLITE_UNAVAILABLE' }); },
    listWorkspaceDirectory() { return { ok: false, error: { code: 'ELECTRON_SQLITE_UNAVAILABLE' } }; },
    setMode() { throw new Error('ELECTRON_SQLITE_UNAVAILABLE'); },
    getSnapshot() { return { schemaVersion: 1, status: 'electron_sqlite_unavailable', diagnostics: { code: 'ELECTRON_SQLITE_UNAVAILABLE', detail: safeReason } }; },
    listCheckpoints() { return { ok: false, error: { code: 'ELECTRON_SQLITE_UNAVAILABLE' } }; },
    queryEvents() { return { ok: false, error: { code: 'ELECTRON_SQLITE_UNAVAILABLE' } }; },
    queryConversation() { return { ok: false, error: { code: 'ELECTRON_SQLITE_UNAVAILABLE' } }; },
    browseConversation() { return { ok: false, error: { code: 'ELECTRON_SQLITE_UNAVAILABLE' } }; },
    searchHistory() { return { ok: false, error: { code: 'ELECTRON_SQLITE_UNAVAILABLE' } }; },
    locateHistory() { return { ok: false, error: { code: 'ELECTRON_SQLITE_UNAVAILABLE' } }; },
    getDelivery() { return { ok: false, error: { code: 'ELECTRON_SQLITE_UNAVAILABLE' } }; },
    readWorkspaceFile() { return { ok: false, error: { code: 'ELECTRON_SQLITE_UNAVAILABLE' } }; },
    previewImage() { return { ok: false, error: { code: 'ELECTRON_SQLITE_UNAVAILABLE' } }; },
    undoTurn() { throw new Error('ELECTRON_SQLITE_UNAVAILABLE'); },
    undoFile() { throw new Error('ELECTRON_SQLITE_UNAVAILABLE'); },
    getDiff() { throw new Error('ELECTRON_SQLITE_UNAVAILABLE'); },
    async gitStatus() { return { ok: false, error: { code: 'ELECTRON_SQLITE_UNAVAILABLE' } }; },
    getShutdownStage() { return null; },
    shutdown() {},
  };
}

function createDiagnosticsRuntime(outcome) {
  const diagnosticStatus = outcome && outcome.status === 'schema_refused' ? 'schema_refused' : 'diagnostics';
  const safeDiagnostics = {
    code: diagnosticStatus === 'schema_refused' ? 'A9_SCHEMA_REFUSED' : 'A9_PERSISTENCE_DIAGNOSTICS',
    detail: boundedDiagnosticText(outcome && (outcome.error || outcome.reason || 'A9 persistence unavailable')),
    ...(outcome && outcome.hint ? { hint: boundedDiagnosticText(outcome.hint) } : {}),
    ...(outcome && Number.isSafeInteger(outcome.foundVersion) ? { foundVersion: outcome.foundVersion } : {}),
  };
  return {
    protocolVersion: A9_PROTOCOL_VERSION,
    status: diagnosticStatus,
    shareProviderState() { throw Object.assign(new Error('A9_DIAGNOSTICS_MODE'), { code: 'A9_DIAGNOSTICS_MODE' }); },
    acceptProviderState() { throw Object.assign(new Error('A9_DIAGNOSTICS_MODE'), { code: 'A9_DIAGNOSTICS_MODE' }); },
    diagnostics: safeDiagnostics,
    whenReady() { return Promise.resolve(); },
    assertAvailable() {},
    configureProvider() { throw new Error('A9_DIAGNOSTICS_MODE'); },
    probeProvider() { throw new Error('A9_DIAGNOSTICS_MODE'); },
    configureShell() { throw new Error('A9_DIAGNOSTICS_MODE'); },
    async continueTask() { return { ok: false, error: { code: 'A9_DIAGNOSTICS_MODE' } }; },
    dismissRecovered() { return { ok: false, error: { code: 'A9_DIAGNOSTICS_MODE' } }; },
    selectOfficeActions() { return { ok: false, error: { code: 'A9_DIAGNOSTICS_MODE' } }; },
    confirmTemplateSample() { return { ok: false, error: { code: 'A9_DIAGNOSTICS_MODE' } }; },
    previewHtmlReport() { return { ok: false, error: { code: 'A9_DIAGNOSTICS_MODE' } }; },
    installOfficeSkills() { return { ok: false, error: { code: 'A9_DIAGNOSTICS_MODE' } }; },
    updateQueue() { return { ok: false, error: { code: 'A9_QUEUE_UNAVAILABLE' } }; },
    async submitTurn() { return { ok: false, error: { code: 'A9_DIAGNOSTICS_MODE', message: '数据库受限诊断模式，禁止执行任务。' } }; },
    async resumeApproval() { return { ok: false, error: { code: 'A9_DIAGNOSTICS_MODE' } }; },
    async answerQuestion() { return { ok: false, error: { code: 'A9_DIAGNOSTICS_MODE' } }; },
    stop() { return { ok: false }; },
    saveDraft() { return { ok: false, error: { code: 'A9_DIAGNOSTICS_MODE' } }; },
    createConversation() { throw new Error('A9_DIAGNOSTICS_MODE'); },
    activateConversation() { throw new Error('A9_DIAGNOSTICS_MODE'); },
    renameConversation() { throw new Error('A9_DIAGNOSTICS_MODE'); },
    archiveConversation() { throw new Error('A9_DIAGNOSTICS_MODE'); },
    restoreConversation() { throw new Error('A9_DIAGNOSTICS_MODE'); },
    settleConversation() { return { ok: false, error: { code: 'A9_DIAGNOSTICS_MODE' } }; },
    reopenConversation() { return { ok: false, error: { code: 'A9_DIAGNOSTICS_MODE' } }; },
    visitConversation() { return { ok: false, error: { code: 'A9_DIAGNOSTICS_MODE' } }; },
    canLeaveWorkspace() { return { allowed: true, reason: null }; },
    getWorkdirInfo() { return {}; },
    getTransferWorkspace() { throw Object.assign(new Error('A9_DIAGNOSTICS_MODE'), { code: 'A9_DIAGNOSTICS_MODE' }); },
    getWorkdirConversationId() { return null; },
    ensureWorkdir() { throw Object.assign(new Error('A9_DIAGNOSTICS_MODE'), { code: 'A9_DIAGNOSTICS_MODE' }); },
    listWorkspaceDirectory() { return { ok: false, error: { code: 'A9_DIAGNOSTICS_MODE' } }; },
    setMode() { throw new Error('A9_DIAGNOSTICS_MODE'); },
    getSnapshot() { return { schemaVersion: A9_PROTOCOL_VERSION, status: diagnosticStatus, diagnostics: safeDiagnostics }; },
    listCheckpoints() { return { ok: false, error: { code: 'A9_DIAGNOSTICS_MODE' } }; },
    queryEvents() { return { ok: false, error: { code: 'A9_DIAGNOSTICS_MODE' } }; },
    queryConversation() { return { ok: false, error: { code: 'A9_DIAGNOSTICS_MODE' } }; },
    browseConversation() { return { ok: false, error: { code: 'A9_DIAGNOSTICS_MODE' } }; },
    searchHistory() { return { ok: false, error: { code: 'A9_DIAGNOSTICS_MODE' } }; },
    locateHistory() { return { ok: false, error: { code: 'A9_DIAGNOSTICS_MODE' } }; },
    getDelivery() { return { ok: false, error: { code: 'A9_DIAGNOSTICS_MODE' } }; },
    readWorkspaceFile() { return { ok: false, error: { code: 'A9_DIAGNOSTICS_MODE' } }; },
    previewImage() { return { ok: false, error: { code: 'A9_DIAGNOSTICS_MODE' } }; },
    undoTurn() { throw new Error('A9_DIAGNOSTICS_MODE'); },
    undoFile() { throw new Error('A9_DIAGNOSTICS_MODE'); },
    getDiff() { throw new Error('A9_DIAGNOSTICS_MODE'); },
    async gitStatus() { return { ok: false, error: { code: 'A9_DIAGNOSTICS_MODE' } }; },
    getShutdownStage() { return null; },
    shutdown() {},
  };
}

module.exports = { A9_PROTOCOL_VERSION, preflightElectronSqlite, createSqliteUnavailableRuntime, createDiagnosticsRuntime };
