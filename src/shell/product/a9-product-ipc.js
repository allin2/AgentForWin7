'use strict';

/**
 * A9 产品 IPC（A9-06）：版本化 + Schema 校验的 a9 动作白名单。
 * Renderer 只能通过此窄接口访问 A9 能力；未知 action / 多余字段 / 类型
 * 不符一律结构化拒绝。Renderer 不获得 fs/child_process/凭据/任意网络。
 */

const { serializeError } = require('./desktop-host');

const A9_ACTIONS = Object.freeze({
  SNAPSHOT_GET: 'a9.snapshot.get',
  WORKSPACE_LIST: 'a9.workspace.list',
  WORKSPACE_ACTIVATE: 'a9.workspace.activate',
  WORKSPACE_CLOSE: 'a9.workspace.close',
  WORKDIR_START: 'a9.workdir.start',
  WORKDIR_GET: 'a9.workdir.get',
  WORKDIR_OPEN: 'a9.workdir.open',
  WORKDIR_RENAME: 'a9.workdir.rename',
  WORKDIR_LINK: 'a9.workdir.link',
  WORKSPACE_BROWSE: 'a9.workspace.browse',
  MODE_SET: 'a9.mode.set',
  PROVIDER_CONFIGURE: 'a9.provider.configure',
  PROVIDER_PROBE: 'a9.provider.probe',
  IMAGE_PREVIEW: 'a9.image.preview',
  SHELL_CONFIGURE: 'a9.shell.configure',
  TURN_SUBMIT: 'a9.turn.submit',
  TASK_CONTINUE: 'a9.task.continue',
  TURN_RESUME_APPROVAL: 'a9.turn.resumeApproval',
  QUESTION_REPLY: 'a9.question.reply',
  TURN_STOP: 'a9.turn.stop',
  MANAGED_DISMISS_RECOVERED: 'a9.managed.dismissRecovered',
  CONVERSATION_CREATE: 'a9.conversation.create',
  CONVERSATION_ACTIVATE: 'a9.conversation.activate',
  CONVERSATION_RENAME: 'a9.conversation.rename',
  CONVERSATION_ARCHIVE: 'a9.conversation.archive',
  CONVERSATION_RESTORE: 'a9.conversation.restore',
  CONVERSATION_SETTLE: 'a9.conversation.settle',
  CONVERSATION_REOPEN: 'a9.conversation.reopen',
  CONVERSATION_VISIT: 'a9.conversation.visit',
  DRAFT_SAVE: 'a9.draft.save',
  QUEUE_UPDATE: 'a9.queue.update',
  CHECKPOINT_LIST: 'a9.checkpoint.list',
  CHECKPOINT_UNDO_TURN: 'a9.checkpoint.undoTurn',
  CHECKPOINT_UNDO_FILE: 'a9.checkpoint.undoFile',
  DIFF_GET: 'a9.diff.get',
  GIT_STATUS: 'a9.git.status',
  WORKSPACE_READ: 'a9.workspace.read',
  EVENTS_QUERY: 'a9.events.query',
  CONVERSATION_QUERY: 'a9.conversation.query',
});

/**
 * v7 (ADR-0123): compact snapshots and history pages; existing v6 requests remain supported.
 * v6（ADR-0114）：在 v5 有界文件读取基础上增加按会话有界查询持久化事件
 * （a9.events.query，UI 过程回看；跨会话请求由 runtime 拒绝）。
 */
const A9_IPC_SCHEMA_VERSION = 9; // ADR-0319: workspace/conversation-bound requests

function exactObject(value, keys, code, optionalKeys = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw Object.assign(new Error(`${code}: request must be an object`), { code });
  }
  const allowed = keys.concat(optionalKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw Object.assign(new Error(`${code}: unknown field '${key}'`), { code });
  }
  for (const key of keys) {
    if (!(key in value)) throw Object.assign(new Error(`${code}: missing field '${key}'`), { code });
  }
}

// A9-49 restricted runtimes hold no conversation; their snapshot scope carries only the workspace.
const A9_RESTRICTED_STATUSES = Object.freeze(['electron_sqlite_unavailable', 'diagnostics', 'schema_refused']);

function restrictedScopeRuntime(registry, request) {
  const scope = request.scope;
  if (!registry || request.schemaVersion !== 9 || !scope || typeof scope !== 'object' || Array.isArray(scope)) return null;
  const keys = Object.keys(scope);
  if (keys.length !== 1 || keys[0] !== 'workspaceId') return null;
  const active = registry.getActive();
  if (!active || active.workspaceId !== scope.workspaceId || !active.runtime) return null;
  return A9_RESTRICTED_STATUSES.includes(active.runtime.status) ? active.runtime : null;
}

function createA9ProductRequestHandler(options) {
  const config = options || {};
  let selectionInFlight = false;
  return async function handleA9ProductRequest(event, request) {
    if (!config.isValidRendererSender || !config.isValidRendererSender(event)) {
      return { ok: false, error: { code: 'RENDERER_CAPABILITY_DENIED' } };
    }
    try {
      exactObject(request, ['schemaVersion', 'action', 'payload'], 'A9_REQUEST_SCHEMA_INVALID', ['scope']);
      if (![6, 7, 8, A9_IPC_SCHEMA_VERSION].includes(request.schemaVersion)) {
        throw Object.assign(new Error(`A9_SCHEMA_VERSION_UNSUPPORTED:${request.schemaVersion}`), { code: 'A9_SCHEMA_VERSION_UNSUPPORTED' });
      }
      if (!Object.values(A9_ACTIONS).includes(request.action)) {
        throw Object.assign(new Error(`A9_ACTION_UNAVAILABLE:${request.action}`), { code: 'A9_ACTION_UNAVAILABLE' });
      }
      const registry = config.workspaceRegistry;
      const inboxAction = [A9_ACTIONS.CONVERSATION_SETTLE, A9_ACTIONS.CONVERSATION_REOPEN, A9_ACTIONS.CONVERSATION_VISIT].includes(request.action);
      if (inboxAction && (request.schemaVersion !== 9 || !request.scope)) {
        throw Object.assign(new Error('A9_SCOPE_REQUIRED'), { code: 'A9_SCOPE_REQUIRED' });
      }
      const workspaceActions = [A9_ACTIONS.WORKSPACE_LIST, A9_ACTIONS.WORKSPACE_ACTIVATE, A9_ACTIONS.WORKSPACE_CLOSE];
      const restrictedRuntime = inboxAction ? null : restrictedScopeRuntime(registry, request);
      if (request.scope !== undefined && !restrictedRuntime) {
        exactObject(request.scope, ['workspaceId', 'conversationId'], 'A9_SCOPE_INVALID');
        if (request.schemaVersion !== 9 || !/^[a-f0-9]{64}$/.test(request.scope.workspaceId)
          || typeof request.scope.conversationId !== 'string' || !request.scope.conversationId || request.scope.conversationId.length > 256) {
          throw Object.assign(new Error('A9_SCOPE_INVALID'), { code: 'A9_SCOPE_INVALID' });
        }
      }
      if (request.action === A9_ACTIONS.WORKDIR_START) {
        if (!registry || request.schemaVersion !== 9 || request.scope) throw Object.assign(new Error('A9_SCOPE_INVALID'), { code: 'A9_SCOPE_INVALID' });
        exactObject(request.payload, ['prompt'], 'A9_PAYLOAD_INVALID', ['mode']);
        if (request.payload.mode !== undefined && !['full_access', 'read_only'].includes(request.payload.mode)) throw Object.assign(new Error('A9_PAYLOAD_INVALID'), { code: 'A9_PAYLOAD_INVALID' });
        if (typeof request.payload.prompt !== 'string' || !request.payload.prompt.trim() || request.payload.prompt.length > 8000) {
          throw Object.assign(new Error('A9_PAYLOAD_INVALID'), { code: 'A9_PAYLOAD_INVALID' });
        }
        if (selectionInFlight) throw Object.assign(new Error('A9_WORKSPACE_SELECTION_BUSY'), { code: 'A9_WORKSPACE_SELECTION_BUSY' });
        selectionInFlight = true;
        let prepared;
        try { prepared = registry.startDefaultConversation(request.payload.prompt, request.payload.mode); }
        finally { selectionInFlight = false; }
        const { runtime, scope, workdir } = prepared;
        try {
          const result = await runtime.submitTurn(request.payload.prompt, { acceptOnly: true });
          return { ...result, scope, workdir };
        } catch (error) {
          return { ok: false, error: serializeError(error), scope, workdir };
        }
      }
      if (workspaceActions.includes(request.action)) {
        if (!registry || request.schemaVersion !== 9) throw Object.assign(new Error('A9_ACTION_UNAVAILABLE'), { code: 'A9_ACTION_UNAVAILABLE' });
        const values = request.payload;
        if (request.action === A9_ACTIONS.WORKSPACE_LIST) {
          exactObject(values, [], 'A9_PAYLOAD_INVALID');
          return { ok: true, workspaces: registry.directory(), accounting: registry.accounting() };
        }
        if (selectionInFlight) throw Object.assign(new Error('A9_WORKSPACE_SELECTION_BUSY'), { code: 'A9_WORKSPACE_SELECTION_BUSY' });
        selectionInFlight = true;
        try {
          if (request.action === A9_ACTIONS.WORKSPACE_CLOSE) {
            exactObject(values, ['workspaceId', 'confirmed'], 'A9_PAYLOAD_INVALID');
            if (values.confirmed !== true || typeof values.workspaceId !== 'string') throw Object.assign(new Error('A9_PAYLOAD_INVALID'), { code: 'A9_PAYLOAD_INVALID' });
            const result = await registry.close(values.workspaceId);
            const next = registry.getActive();
            if (next && config.selectWorkspace) await config.selectWorkspace(next.workspaceRoot);
            return result;
          }
          exactObject(values, [], 'A9_PAYLOAD_INVALID', ['workspaceId', 'conversationId', 'createConversation', 'chooseDirectory']);
          for (const key of ['createConversation', 'chooseDirectory']) if (values[key] !== undefined && typeof values[key] !== 'boolean') throw Object.assign(new Error('A9_PAYLOAD_INVALID'), { code: 'A9_PAYLOAD_INVALID' });
          if ((values.workspaceId !== undefined && (typeof values.workspaceId !== 'string' || !/^[a-f0-9]{64}$/.test(values.workspaceId)))
            || (values.conversationId !== undefined && (typeof values.conversationId !== 'string' || !values.conversationId || values.conversationId.length > 256))
            || (values.chooseDirectory && values.workspaceId) || (values.createConversation && values.conversationId)) throw Object.assign(new Error('A9_PAYLOAD_INVALID'), { code: 'A9_PAYLOAD_INVALID' });
          let workspace;
          if (values.chooseDirectory) {
            workspace = config.chooseWorkspace && await config.chooseWorkspace();
            if (!workspace) return { ok: false, cancelled: true };
          } else {
            const known = registry.directory().find(item => item.workspaceId === values.workspaceId);
            if (!known) throw Object.assign(new Error('A9_WORKSPACE_UNKNOWN'), { code: 'A9_WORKSPACE_UNKNOWN' });
            workspace = known.workspaceRoot;
          }
          const knownBefore = new Set(registry.directory().map(item => item.workspaceId));
          const entry = registry.open(workspace);
          const snapshot = entry.runtime.getSnapshot({ conversationPage: true });
          if (values.conversationId && values.conversationId !== snapshot.activeConversationId) {
            const response = await entry.runtime.activateConversation(values.conversationId);
            if (!response || !response.ok) return response;
          } else if (values.createConversation) {
            // A newly opened, empty workspace already has its initial conversation.
            if (knownBefore.has(entry.workspaceId)) {
              const response = await entry.runtime.createConversation();
              if (!response || !response.ok) return response;
            }
          }
          if (config.selectWorkspace) await config.selectWorkspace(entry.workspaceRoot);
          registry.activate(entry.workspaceRoot);
          const current = entry.runtime.getSnapshot({ conversationPage: true });
          return { ok: true, scope: { workspaceId: entry.workspaceId, conversationId: current.activeConversationId } };
        } finally { selectionInFlight = false; }
      }
      if (registry && request.schemaVersion < 9 && request.action !== A9_ACTIONS.SNAPSHOT_GET) {
        throw Object.assign(new Error('A9_SCOPE_REQUIRED'), { code: 'A9_SCOPE_REQUIRED' });
      }
      if (registry && request.schemaVersion === 9 && request.action !== A9_ACTIONS.SNAPSHOT_GET && !request.scope) {
        throw Object.assign(new Error('A9_SCOPE_REQUIRED'), { code: 'A9_SCOPE_REQUIRED' });
      }
      const runtime = restrictedRuntime || (registry && request.scope
        ? (inboxAction ? registry.resolveInboxScope(request.scope)
          : request.action === A9_ACTIONS.WORKDIR_LINK ? registry.resolveWorkdirLinkScope(request.scope) : registry.resolve(request.scope))
        : config.getA9Runtime ? await config.getA9Runtime() : null);
      if (runtime && runtime.__a9WorkspaceRequired === true) {
        return {
          ok: false,
          error: {
            code: 'A9_WORKSPACE_REQUIRED',
            message: '尚未选择工作区：A9 runtime 只能绑定主进程确认的活动工作区。',
            recommendedAction: '在产品中选择一个本地工作区后重试。',
          },
        };
      }
      if (!runtime) throw Object.assign(new Error('A9_RUNTIME_UNAVAILABLE'), { code: 'A9_RUNTIME_UNAVAILABLE' });

      const payload = request.payload || {};
      switch (request.action) {
        case A9_ACTIONS.WORKDIR_GET:
        case A9_ACTIONS.WORKDIR_OPEN:
        case A9_ACTIONS.WORKDIR_RENAME:
        case A9_ACTIONS.WORKDIR_LINK: {
          if (!registry || request.schemaVersion !== 9 || !request.scope) throw Object.assign(new Error('A9_SCOPE_REQUIRED'), { code: 'A9_SCOPE_REQUIRED' });
          exactObject(payload, request.action === A9_ACTIONS.WORKDIR_RENAME ? ['name'] : [], 'A9_PAYLOAD_INVALID');
          if (request.action === A9_ACTIONS.WORKDIR_GET) return { ok: true, workdir: runtime.getWorkdirInfo() };
          if (request.action === A9_ACTIONS.WORKDIR_OPEN) {
            const info = runtime.getWorkdirInfo();
            if (!info.created) throw Object.assign(new Error('目录尚未创建。'), { code: 'A9_WORKDIR_NOT_CREATED' });
            if (!config.openWorkdir) throw Object.assign(new Error('A9_WORKDIR_OPEN_UNAVAILABLE'), { code: 'A9_WORKDIR_OPEN_UNAVAILABLE' });
            await config.openWorkdir(info.path);
            return { ok: true };
          }
          if (selectionInFlight) throw Object.assign(new Error('A9_WORKSPACE_SELECTION_BUSY'), { code: 'A9_WORKSPACE_SELECTION_BUSY' });
          selectionInFlight = true;
          try {
            return await registry.changeWorkdir(request.scope, request.action === A9_ACTIONS.WORKDIR_RENAME ? 'rename' : 'link',
              request.action === A9_ACTIONS.WORKDIR_RENAME ? payload.name : async () => {
                if (!config.chooseWorkspace) throw Object.assign(new Error('A9_WORKDIR_PICKER_UNAVAILABLE'), { code: 'A9_WORKDIR_PICKER_UNAVAILABLE' });
                return config.chooseWorkspace();
              });
          } finally { selectionInFlight = false; }
        }
        case A9_ACTIONS.WORKSPACE_BROWSE:
          if (!registry || request.schemaVersion !== 9 || !request.scope) throw Object.assign(new Error('A9_SCOPE_REQUIRED'), { code: 'A9_SCOPE_REQUIRED' });
          exactObject(payload, ['path'], 'A9_PAYLOAD_INVALID');
          if (typeof payload.path !== 'string' || payload.path.length > 1024) throw Object.assign(new Error('A9_PAYLOAD_INVALID'), { code: 'A9_PAYLOAD_INVALID' });
          return await runtime.listWorkspaceDirectory(payload.path || '.');
        case A9_ACTIONS.SNAPSHOT_GET:
          exactObject(payload, [], 'A9_PAYLOAD_INVALID', ['conversationPage']);
          if (payload.conversationPage !== undefined && (request.schemaVersion < 7 || typeof payload.conversationPage !== 'boolean')) {
            throw Object.assign(new Error('A9_PAYLOAD_INVALID: conversationPage requires v7 boolean'), { code: 'A9_PAYLOAD_INVALID' });
          }
          {
            const snapshot = runtime.getSnapshot(payload);
            const active = registry && registry.getActive();
            return { ok: true, snapshot: { ...snapshot, ...(active ? {
              scope: { workspaceId: active.workspaceId, conversationId: snapshot.activeConversationId },
              workspaces: registry.directory(), accounting: registry.accounting(),
            } : {}) } };
          }
        case A9_ACTIONS.CONVERSATION_QUERY:
          exactObject(payload, ['conversationId'], 'A9_PAYLOAD_INVALID', ['before', 'limit']);
          if (request.schemaVersion < 7 || typeof payload.conversationId !== 'string' || !payload.conversationId ||
              (payload.limit !== undefined && (!Number.isSafeInteger(payload.limit) || payload.limit < 1 || payload.limit > 100))) {
            throw Object.assign(new Error('A9_PAYLOAD_INVALID: invalid conversation page'), { code: 'A9_PAYLOAD_INVALID' });
          }
          if (payload.before !== undefined) {
            exactObject(payload.before, ['createdAt', 'taskId'], 'A9_PAYLOAD_INVALID');
            if (typeof payload.before.createdAt !== 'string' || payload.before.createdAt.length > 64 ||
                typeof payload.before.taskId !== 'string' || !payload.before.taskId || payload.before.taskId.length > 256) {
              throw Object.assign(new Error('A9_PAYLOAD_INVALID: invalid cursor'), { code: 'A9_PAYLOAD_INVALID' });
            }
          }
          return await runtime.queryConversation(payload);
        case A9_ACTIONS.MODE_SET: {
          exactObject(payload, ['mode'], 'A9_PAYLOAD_INVALID');
          return await runtime.setMode(payload.mode);
        }
        case A9_ACTIONS.PROVIDER_CONFIGURE: {
          const allowed = ['baseUrl', 'model', 'apiKey', 'rememberApiKey', 'customHeaders', 'caBundle', 'proxy', 'imageInputEnabled'];
          for (const key of Object.keys(payload)) {
            if (!allowed.includes(key)) throw Object.assign(new Error(`A9_PAYLOAD_INVALID: unknown '${key}'`), { code: 'A9_PAYLOAD_INVALID' });
          }
          return registry ? await registry.configureProvider(runtime, payload) : await runtime.configureProvider(payload);
        }
        case A9_ACTIONS.PROVIDER_PROBE:
          return { ok: true, probe: await runtime.probeProvider() };
        case A9_ACTIONS.IMAGE_PREVIEW:
          exactObject(payload, ['conversationId', 'reference'], 'A9_PAYLOAD_INVALID');
          if (typeof payload.conversationId !== 'string' || !payload.conversationId || payload.conversationId.length > 256 ||
              typeof payload.reference !== 'string' || !/^[a-f0-9]{40}$/.test(payload.reference)) {
            throw Object.assign(new Error('A9_PAYLOAD_INVALID: image identity'), { code: 'A9_PAYLOAD_INVALID' });
          }
          return await runtime.previewImage(payload);
        case A9_ACTIONS.SHELL_CONFIGURE: {
          // The Renderer cannot name an executable. For an explicit kind the
          // main process opens a native file picker and supplies the path.
          exactObject(payload, ['kind', 'envOverlay'], 'A9_PAYLOAD_INVALID');
          return await runtime.configureShell(payload);
        }
        case A9_ACTIONS.TASK_CONTINUE:
          exactObject(payload, ['conversationId', 'taskId', 'interruptedTurnId', 'recoveryRevision'], 'A9_PAYLOAD_INVALID');
          if (!['conversationId', 'taskId', 'interruptedTurnId'].every((key) => typeof payload[key] === 'string' && payload[key].length > 0 && payload[key].length <= 256) ||
              typeof payload.recoveryRevision !== 'string' || !/^[a-f0-9]{64}$/.test(payload.recoveryRevision)) {
            throw Object.assign(new Error('A9_PAYLOAD_INVALID: invalid continuation identity'), { code: 'A9_PAYLOAD_INVALID' });
          }
          return await runtime.continueTask(payload);
        case A9_ACTIONS.TURN_SUBMIT: {
          exactObject(payload, ['prompt'], 'A9_PAYLOAD_INVALID');
          return await runtime.submitTurn(payload.prompt);
        }
        case A9_ACTIONS.TURN_RESUME_APPROVAL: {
          exactObject(payload, ['approvalId', 'decision', 'bindingDigest', 'conversationId', 'taskId', 'turnId'], 'A9_PAYLOAD_INVALID');
          if (payload.decision !== 'approved' && payload.decision !== 'denied') {
            throw Object.assign(new Error('A9_PAYLOAD_INVALID: decision must be approved|denied'), { code: 'A9_PAYLOAD_INVALID' });
          }
          return await runtime.resumeApproval(payload);
        }
        case A9_ACTIONS.QUESTION_REPLY: {
          exactObject(payload, ['conversationId', 'questionId', 'revision', 'decision'], 'A9_PAYLOAD_INVALID', ['answer']);
          if (typeof payload.conversationId !== 'string' || !payload.conversationId || payload.conversationId.length > 256
            || typeof payload.questionId !== 'string' || !payload.questionId || payload.questionId.length > 256
            || !Number.isSafeInteger(payload.revision) || payload.revision < 1
            || (payload.decision !== 'answered' && payload.decision !== 'cancelled')) {
            throw Object.assign(new Error('A9_PAYLOAD_INVALID: invalid question identity or decision'), { code: 'A9_PAYLOAD_INVALID' });
          }
          if (payload.decision === 'answered') {
            if (typeof payload.answer !== 'string' || !payload.answer.trim() || payload.answer.length > 2048) {
              throw Object.assign(new Error('A9_PAYLOAD_INVALID: answer must be non-empty and at most 2048 characters'), { code: 'A9_PAYLOAD_INVALID' });
            }
          } else if (payload.answer !== undefined) {
            throw Object.assign(new Error('A9_PAYLOAD_INVALID: cancelled replies must not contain an answer'), { code: 'A9_PAYLOAD_INVALID' });
          }
          if (payload.conversationId !== runtime.getSnapshot().activeConversationId) {
            throw Object.assign(new Error('A9_PAYLOAD_INVALID: conversation mismatch'), { code: 'A9_PAYLOAD_INVALID' });
          }
          return await runtime.answerQuestion(payload);
        }
        case A9_ACTIONS.MANAGED_DISMISS_RECOVERED:
          exactObject(request.payload, ['conversationId', 'handleId', 'recoveryRevision'], 'A9_PAYLOAD_INVALID');
          if (!['conversationId', 'handleId'].every((key) => typeof payload[key] === 'string' && payload[key].trim() && payload[key].length <= 256)
              || typeof payload.recoveryRevision !== 'string' || !/^[a-f0-9]{64}$/.test(payload.recoveryRevision)) {
            throw Object.assign(new Error('A9_PAYLOAD_INVALID: invalid recovered process identity'), { code: 'A9_PAYLOAD_INVALID' });
          }
          return await runtime.dismissRecovered(payload);
        case A9_ACTIONS.TURN_STOP:
          return await runtime.stop();
        case A9_ACTIONS.CONVERSATION_CREATE:
          exactObject(payload, [], 'A9_PAYLOAD_INVALID');
          return await runtime.createConversation();
        case A9_ACTIONS.CONVERSATION_ACTIVATE:
          exactObject(payload, ['conversationId'], 'A9_PAYLOAD_INVALID');
          return await runtime.activateConversation(payload.conversationId);
        case A9_ACTIONS.CONVERSATION_RENAME:
          exactObject(payload, ['conversationId', 'title'], 'A9_PAYLOAD_INVALID');
          return await runtime.renameConversation(payload.conversationId, payload.title);
        case A9_ACTIONS.CONVERSATION_ARCHIVE:
          exactObject(payload, ['conversationId'], 'A9_PAYLOAD_INVALID');
          return await runtime.archiveConversation(payload.conversationId);
        case A9_ACTIONS.CONVERSATION_RESTORE:
          exactObject(payload, ['conversationId'], 'A9_PAYLOAD_INVALID');
          return await runtime.restoreConversation(payload.conversationId);
        case A9_ACTIONS.CONVERSATION_SETTLE:
        case A9_ACTIONS.CONVERSATION_REOPEN:
        case A9_ACTIONS.CONVERSATION_VISIT: {
          exactObject(request.payload, ['conversationId'], 'A9_PAYLOAD_INVALID');
          if (typeof payload.conversationId !== 'string' || !payload.conversationId.trim() || payload.conversationId.length > 256) {
            throw Object.assign(new Error('A9_PAYLOAD_INVALID'), { code: 'A9_PAYLOAD_INVALID' });
          }
          if (request.scope.conversationId !== payload.conversationId) {
            throw Object.assign(new Error('A9_SCOPE_INVALID'), { code: 'A9_SCOPE_INVALID' });
          }
          const method = { [A9_ACTIONS.CONVERSATION_SETTLE]: 'settleConversation',
            [A9_ACTIONS.CONVERSATION_REOPEN]: 'reopenConversation', [A9_ACTIONS.CONVERSATION_VISIT]: 'visitConversation' }[request.action];
          if (typeof runtime[method] !== 'function') {
            throw Object.assign(new Error('A9_RUNTIME_UNAVAILABLE'), { code: 'A9_RUNTIME_UNAVAILABLE' });
          }
          return await runtime[method](payload.conversationId);
        }
        case A9_ACTIONS.QUEUE_UPDATE: {
          exactObject(payload, ['conversationId', 'operation'], 'A9_PAYLOAD_INVALID', ['text', 'itemId']);
          const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 256;
          if (request.schemaVersion < 8 || !validId(payload.conversationId)
            || !['add', 'remove', 'pause', 'resume'].includes(payload.operation)
            || (payload.operation === 'add' ? typeof payload.text !== 'string' || !payload.text.trim() || payload.text.length > 8000 : payload.text !== undefined)
            || (payload.operation === 'remove' ? !validId(payload.itemId) : payload.itemId !== undefined)) {
            throw Object.assign(new Error('A9_PAYLOAD_INVALID: invalid queue operation'), { code: 'A9_PAYLOAD_INVALID' });
          }
          return await runtime.updateQueue(payload);
        }
        case A9_ACTIONS.DRAFT_SAVE:
          exactObject(payload, ['text'], 'A9_PAYLOAD_INVALID');
          return await runtime.saveDraft(payload.text);
        case A9_ACTIONS.CHECKPOINT_LIST:
          exactObject(request.payload, [], 'A9_PAYLOAD_INVALID', ['conversationId', 'before', 'limit']);
          if (payload.conversationId !== undefined &&
              (typeof payload.conversationId !== 'string' || payload.conversationId.length === 0)) {
            throw Object.assign(new Error('A9_PAYLOAD_INVALID: invalid conversationId'), { code: 'A9_PAYLOAD_INVALID' });
          }
          if (payload.before !== undefined) {
            exactObject(payload.before, ['createdAt', 'turnId'], 'A9_PAYLOAD_INVALID');
            if (typeof payload.before.createdAt !== 'string' || payload.before.createdAt.length === 0 ||
                typeof payload.before.turnId !== 'string' || payload.before.turnId.length === 0) {
              throw Object.assign(new Error('A9_PAYLOAD_INVALID: invalid checkpoint cursor'), { code: 'A9_PAYLOAD_INVALID' });
            }
          }
          if (payload.limit !== undefined && (!Number.isSafeInteger(payload.limit) || payload.limit < 1 || payload.limit > 100)) {
            throw Object.assign(new Error('A9_PAYLOAD_INVALID: invalid checkpoint limit'), { code: 'A9_PAYLOAD_INVALID' });
          }
          return await runtime.listCheckpoints(payload);
        case A9_ACTIONS.CHECKPOINT_UNDO_TURN: {
          exactObject(payload, ['turnId'], 'A9_PAYLOAD_INVALID', ['confirmationId']);
          if (typeof payload.turnId !== 'string' || payload.turnId.length === 0 ||
              (payload.confirmationId !== undefined && (typeof payload.confirmationId !== 'string' || payload.confirmationId.length === 0))) {
            throw Object.assign(new Error('A9_PAYLOAD_INVALID: turnId is required and confirmationId must be a non-empty string when supplied'), { code: 'A9_PAYLOAD_INVALID' });
          }
          return await runtime.undoTurn(payload.turnId, payload.confirmationId);
        }
        case A9_ACTIONS.CHECKPOINT_UNDO_FILE: {
          exactObject(payload, ['turnId', 'path'], 'A9_PAYLOAD_INVALID', ['confirmationId']);
          if (typeof payload.turnId !== 'string' || payload.turnId.length === 0 ||
              typeof payload.path !== 'string' || payload.path.length === 0 ||
              (payload.confirmationId !== undefined && (typeof payload.confirmationId !== 'string' || payload.confirmationId.length === 0))) {
            throw Object.assign(new Error('A9_PAYLOAD_INVALID: turnId/path are required and confirmationId must be a non-empty string when supplied'), { code: 'A9_PAYLOAD_INVALID' });
          }
          return await runtime.undoFile(payload.turnId, payload.path, payload.confirmationId);
        }
        case A9_ACTIONS.DIFF_GET: {
          exactObject(payload, ['turnId'], 'A9_PAYLOAD_INVALID');
          return await runtime.getDiff(payload.turnId);
        }
        case A9_ACTIONS.GIT_STATUS:
          return await runtime.gitStatus();
        case A9_ACTIONS.WORKSPACE_READ: {
          const allowed = ['path', 'startLine', 'maxLines', 'encoding'];
          for (const key of Object.keys(payload)) {
            if (!allowed.includes(key)) throw Object.assign(new Error(`A9_PAYLOAD_INVALID: unknown '${key}'`), { code: 'A9_PAYLOAD_INVALID' });
          }
          if (typeof payload.path !== 'string' || !Number.isSafeInteger(payload.startLine) || payload.startLine < 1 ||
              !Number.isSafeInteger(payload.maxLines) || payload.maxLines < 1 || payload.maxLines > 2000) {
            throw Object.assign(new Error('A9_PAYLOAD_INVALID: path/startLine/maxLines are required'), { code: 'A9_PAYLOAD_INVALID' });
          }
          if (payload.encoding !== undefined && !['utf-8', 'gbk', 'utf-16le'].includes(payload.encoding)) {
            throw Object.assign(new Error('A9_PAYLOAD_INVALID: unsupported encoding'), { code: 'A9_PAYLOAD_INVALID' });
          }
          return await runtime.readWorkspaceFile(payload);
        }
        case A9_ACTIONS.EVENTS_QUERY: {
          // ADR-0114：有界事件查询。conversationId 必填（runtime 绑定当前会话并
          // 拒绝跨会话）；turnId/beforeEventId/limit 可选且严格类型化。
          exactObject(payload, ['conversationId'], 'A9_PAYLOAD_INVALID', ['turnId', 'beforeEventId', 'limit']);
          if (typeof payload.conversationId !== 'string' || payload.conversationId.length === 0) {
            throw Object.assign(new Error('A9_PAYLOAD_INVALID: conversationId must be a non-empty string'), { code: 'A9_PAYLOAD_INVALID' });
          }
          if (payload.turnId !== undefined && (typeof payload.turnId !== 'string' || payload.turnId.length === 0)) {
            throw Object.assign(new Error('A9_PAYLOAD_INVALID: turnId must be a non-empty string when supplied'), { code: 'A9_PAYLOAD_INVALID' });
          }
          if (payload.beforeEventId !== undefined && !Number.isSafeInteger(payload.beforeEventId)) {
            throw Object.assign(new Error('A9_PAYLOAD_INVALID: beforeEventId must be a safe integer when supplied'), { code: 'A9_PAYLOAD_INVALID' });
          }
          if (payload.limit !== undefined &&
              (!Number.isSafeInteger(payload.limit) || payload.limit < 1 || payload.limit > 1000)) {
            throw Object.assign(new Error('A9_PAYLOAD_INVALID: limit must be an integer between 1 and 1000 when supplied'), { code: 'A9_PAYLOAD_INVALID' });
          }
          return await runtime.queryEvents(payload);
        }
        default:
          throw Object.assign(new Error('A9_ACTION_UNAVAILABLE'), { code: 'A9_ACTION_UNAVAILABLE' });
      }
    } catch (error) {
      return { ok: false, error: serializeError(error) };
    }
  };
}

module.exports = { createA9ProductRequestHandler, A9_ACTIONS, A9_IPC_SCHEMA_VERSION };
