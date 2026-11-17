'use strict';

const { contextBridge, ipcRenderer } = require('electron');

let messageCounter = 0;
const legacyA8ReviewEnabled = process.argv.some((item) =>
  item.indexOf('--a8-review-smoke-') === 0 || item.indexOf('--a8-boundary-smoke-') === 0);

// Only observation timers: the underlying invoke is never raced or cancelled.
// These actions deliberately await user interaction, model/tool work or cleanup.
const intentionalWaits = new Map([
  ['product:a9-request', new Set([
    'a9.provider.configure', 'a9.provider.probe', 'a9.shell.configure', 'a9.workdir.link',
    'a9.turn.submit', 'a9.task.continue', 'a9.turn.resumeApproval', 'a9.question.reply',
    'a9.turn.stop', 'a9.workspace.close', 'a9.workdir.rename',
  ])],
  ['desktop:request', new Set(['workspace.select'])],
]);
const pendingRequests = new Map();
const requestWaitListeners = new Set();
let diagnosticDirectory = '';
function requestWaitStatus() {
  const now = Date.now();
  let oldest = now;
  for (const start of pendingRequests.values()) oldest = Math.min(oldest, start);
  return now - oldest >= 8000 ? { elapsedSeconds: Math.floor((now - oldest) / 1000), directory: diagnosticDirectory } : null;
}
function notifyRequestWait() {
  const status = requestWaitStatus();
  for (const callback of requestWaitListeners) {
    try { callback(status); }
    catch (error) { setTimeout(() => { throw error; }, 0); }
  }
}
async function invokeObserved(channel, value) {
  const action = value && (value.action || value.type);
  const observed = !(intentionalWaits.get(channel) || new Set()).has(action);
  const id = Symbol();
  let timer;
  let interval;
  if (observed) {
    pendingRequests.set(id, Date.now());
    timer = setTimeout(() => {
      notifyRequestWait();
      interval = setInterval(notifyRequestWait, 1000);
    }, 8000);
  }
  try {
    const result = value === undefined ? await ipcRenderer.invoke(channel) : await ipcRenderer.invoke(channel, value);
    if (channel === 'product:get-diagnostics' && result && result.diagnosticLog) {
      diagnosticDirectory = result.diagnosticLog.directory || '';
    }
    return result;
  } finally {
    if (observed) {
      pendingRequests.delete(id);
      clearTimeout(timer); clearInterval(interval);
      notifyRequestWait();
    }
  }
}

function request(type, sessionId, payload) {
  messageCounter += 1;
  return invokeObserved('desktop:request', {
    protocolVersion: '1.0.0',
    id: `renderer-${Date.now()}-${messageCounter}`,
    type,
    direction: 'renderer_to_core',
    sessionId: sessionId || 'desktop',
    timestamp: new Date().toISOString(),
    payload: payload || {},
  });
}

function a8Request(action, sessionId, payload) {
  return invokeObserved('product:a8-request', {
    schemaVersion: 1,
    action,
    sessionId,
    payload: payload || {},
  });
}

function a9Request(action, payload, scope) {
  return invokeObserved('product:a9-request', {
    schemaVersion: scope || ['a9.workspace.list', 'a9.workspace.activate', 'a9.workspace.close', 'a9.workdir.start', 'a9.conversation.browse', 'a9.history.search', 'a9.history.locate', 'a9.delivery.get'].includes(action) || action === 'a9.snapshot.get' ? 9 : action === 'a9.queue.update' ? 8 : 7,
    action,
    payload: payload || {},
    ...(scope ? { scope } : {}),
  });
}

const legacyA8ReviewApi = legacyA8ReviewEnabled ? Object.freeze({
  prepareReview: (sessionId, taskId, proposals) => a8Request('review.prepare', sessionId, { taskId, proposals }),
  getReview: (sessionId, taskId) => a8Request('review.get', sessionId, { taskId }),
  decideReview: (sessionId, taskId, relativePath, decision) => a8Request('review.decide', sessionId, { taskId, relativePath, decision }),
  issueReviewApproval: (sessionId, taskId, subject) => a8Request('review.approval.issue', sessionId, { taskId, subject: subject || 'desktop-user' }),
  applyReview: (sessionId, taskId, approval) => a8Request('review.apply', sessionId, { taskId, approval }),
  recordReviewValidation: (sessionId, taskId, input) => a8Request('review.validation', sessionId, { taskId, ...input }),
  restoreReviewRecovery: (sessionId, taskId) => a8Request('review.recovery', sessionId, { taskId }),
  submitReviewTask: (sessionId, prompt) => a8Request('review.task.submit', sessionId, { prompt }),
}) : Object.freeze({});

function createA9Api(scope) {
  const boundRequest = (action, payload) => a9Request(action, payload, scope);
  return Object.freeze({
    snapshot: () => a9Request('a9.snapshot.get', { conversationPage: true }),
    listWorkspaces: () => a9Request('a9.workspace.list', {}),
    activateWorkspace: values => a9Request('a9.workspace.activate', values),
    closeWorkspace: workspaceId => a9Request('a9.workspace.close', { workspaceId, confirmed: true }),
    forScope: scope => createA9Api(scope),
    startDefaultConversation: (prompt, mode) => a9Request('a9.workdir.start', { prompt, ...(mode !== undefined ? { mode } : {}) }),
    getWorkdir: () => boundRequest('a9.workdir.get', {}),
    openWorkdir: () => boundRequest('a9.workdir.open', {}),
    renameWorkdir: name => boundRequest('a9.workdir.rename', { name }),
    linkWorkdir: () => boundRequest('a9.workdir.link', {}),
    listWorkspaceDirectory: path => boundRequest('a9.workspace.browse', { path: path || '' }),
    queryConversation: (values) => boundRequest('a9.conversation.query', values || {}),
    browseConversation: (values) => boundRequest('a9.conversation.browse', values),
    searchHistory: values => boundRequest('a9.history.search', values),
    locateHistory: values => boundRequest('a9.history.locate', values),
    getDelivery: values => boundRequest('a9.delivery.get', values),
    setMode: (mode) => boundRequest('a9.mode.set', { mode }),
    configureProvider: (values) => boundRequest('a9.provider.configure', values),
    probeProvider: () => boundRequest('a9.provider.probe', {}),
    previewImage: (conversationId, reference) => boundRequest('a9.image.preview', { conversationId, reference }),
    configureShell: (values) => boundRequest('a9.shell.configure', values),
    submitTurn: (prompt) => boundRequest('a9.turn.submit', { prompt }),
    continueTask: (conversationId, taskId, interruptedTurnId, recoveryRevision) => boundRequest('a9.task.continue', {
      conversationId, taskId, interruptedTurnId, recoveryRevision,
    }),
    selectOfficeActions: (approvalId, bindingDigest, selectedActionIds, conversationId, taskId, turnId) => boundRequest('a9.approval.select', {
      approvalId, bindingDigest, selectedActionIds, conversationId, taskId, turnId,
    }),
    confirmTemplateSample: (values) => boundRequest('a9.template.confirmSample', values),
    previewHtmlReport: (targetPath) => boundRequest('a9.office.previewHtml', { path: targetPath }),
    resumeApproval: (approvalId, decision, bindingDigest, conversationId, taskId, turnId) => boundRequest('a9.turn.resumeApproval', {
      approvalId, decision, bindingDigest, conversationId, taskId, turnId,
    }),
    replyQuestion: (conversationId, questionId, revision, decision, answer) => boundRequest('a9.question.reply', {
      conversationId, questionId, revision, decision,
      ...(decision === 'answered' ? { answer } : {}),
    }),
    stop: () => boundRequest('a9.turn.stop', {}),
    dismissRecovered: (conversationId, handleId, recoveryRevision) => boundRequest('a9.managed.dismissRecovered', {
      conversationId, handleId, recoveryRevision,
    }),
    createConversation: () => boundRequest('a9.conversation.create', {}),
    activateConversation: (conversationId) => boundRequest('a9.conversation.activate', { conversationId }),
    renameConversation: (conversationId, title) => boundRequest('a9.conversation.rename', { conversationId, title }),
    archiveConversation: (conversationId) => boundRequest('a9.conversation.archive', { conversationId }),
    restoreConversation: (conversationId) => boundRequest('a9.conversation.restore', { conversationId }),
    settleConversation: (conversationId) => boundRequest('a9.conversation.settle', { conversationId }),
    reopenConversation: (conversationId) => boundRequest('a9.conversation.reopen', { conversationId }),
    visitConversation: (conversationId) => boundRequest('a9.conversation.visit', { conversationId }),
    saveDraft: (text) => boundRequest('a9.draft.save', { text }),
    updateQueue: (values) => boundRequest('a9.queue.update', values),
    listCheckpoints: (options) => boundRequest('a9.checkpoint.list', options || {}),
    undoTurn: (turnId, confirmationId) => boundRequest('a9.checkpoint.undoTurn', { turnId, ...(confirmationId ? { confirmationId } : {}) }),
    undoFile: (turnId, path, confirmationId) => boundRequest('a9.checkpoint.undoFile', { turnId, path, ...(confirmationId ? { confirmationId } : {}) }),
    getDiff: (turnId) => boundRequest('a9.diff.get', { turnId }),
    gitStatus: () => boundRequest('a9.git.status', {}),
    readWorkspaceFile: (path, startLine, maxLines, encoding) => boundRequest('a9.workspace.read', {
      path,
      startLine,
      maxLines,
      ...(encoding ? { encoding } : {}),
    }),
    queryEvents: (values) => boundRequest('a9.events.query', values || {}),
  });
}

const productApi = Object.freeze({
  getDiagnostics: () => invokeObserved('product:get-diagnostics'),
  onRequestWait: callback => {
    if (typeof callback !== 'function') throw new TypeError('onRequestWait callback must be a function');
    requestWaitListeners.add(callback);
    callback(requestWaitStatus());
    return () => requestWaitListeners.delete(callback);
  },
  a9: createA9Api(),
  getSettings: () => request('settings.get', 'desktop', {}),
  setSettings: (values) => request('settings.set', 'desktop', { values }),
  clearSavedApiKey: () => request('settings.credential_clear', 'desktop', { credential: 'api-key' }),
  selectWorkspace: () => request('workspace.select', 'desktop', {}),
  createSession: (workspacePath, label) => request('session.create', 'desktop', {
    workspacePath,
    ...(label ? { label } : {}),
  }),
  listSessions: () => request('session.list', 'desktop', {}),
  closeSession: (sessionId) => request('session.close', sessionId, { sessionId }),
  getSession: (sessionId) => a8Request('session.get', sessionId, {}),
  setGoal: (sessionId, text, expectedRevision) => a8Request('goal.set', sessionId, { text, expectedRevision }),
  resolveGoal: (sessionId, status, expectedRevision) => a8Request('goal.resolve', sessionId, { status, expectedRevision }),
  listWorkspace: (sessionId, path) => a8Request('workspace.list', sessionId, { path: path || '' }),
  readWorkspaceFile: (sessionId, path, startLine, maxLines, encoding) => a8Request('workspace.read', sessionId, {
    path,
    ...(startLine ? { startLine } : {}),
    ...(maxLines ? { maxLines } : {}),
    ...(encoding ? { encoding } : {}),
  }),
  ...legacyA8ReviewApi,
  submitTask: (sessionId, prompt, scenario, executionMode, refs) => request('task.submit', sessionId, {
    sessionId,
    prompt,
    ...(scenario ? { scenario } : {}),
    ...((executionMode || (Array.isArray(refs) && refs.length > 0)) ? { context: {
      ...(executionMode ? { executionMode } : {}),
      ...(Array.isArray(refs) && refs.length > 0 ? { refs } : {}),
    } } : {}),
  }),
  cancelTask: (sessionId, taskId) => request('task.cancel', sessionId, { taskId }),
  approveTask: (sessionId, taskId, approvalId, planHash, workspaceBaseHash) => request('task.approve', sessionId, {
    taskId, approvalId, planHash, workspaceBaseHash,
  }),
  rejectTask: (sessionId, taskId, approvalId, reason) => request('task.reject', sessionId, {
    taskId, approvalId, reason,
  }),
  approvePlan: (sessionId, taskId, approvalId, planHash) => request('task.approve', sessionId, {
    taskId, approvalId, planHash, workspaceBaseHash: 'execution-plan',
  }),
  rejectPlan: (sessionId, taskId, approvalId, _planHash, reason) => request('task.reject', sessionId, {
    taskId, approvalId, reason,
  }),
  prepareUndo: (sessionId, taskId) => request('task.undo_prepare', sessionId, { sessionId, taskId }),
  getRecovery: (sessionId) => request('recovery.get', sessionId, { sessionId }),
  restoreRecovery: (sessionId) => request('recovery.restore', sessionId, { sessionId }),
  onTaskEvent: (callback) => {
    if (typeof callback !== 'function') throw new TypeError('onTaskEvent callback must be a function');
    const listener = (_event, message) => {
      if (!message || message.type !== 'task.event') return;
      callback(message.payload);
    };
    ipcRenderer.on('desktop:event', listener);
    return () => ipcRenderer.removeListener('desktop:event', listener);
  },
  signalReady: () => ipcRenderer.send('product:renderer-ready', {
    protocolVersion: '1.0.0',
    ready: true,
  }),
});

contextBridge.exposeInMainWorld('win7Agent', productApi);
