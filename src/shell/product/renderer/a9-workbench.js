'use strict';

/**
 * A9 Alpha 1 unified workbench.
 *
 * Renderer capabilities stay limited to the frozen preload API. This file does
 * not access Node, the filesystem, child processes, credentials, or networking.
 *
 * ADR-0114：对话流按事件渲染过程（model_note / plan_updated / 工具活动组 /
 * approval 留痕），事件以 eventId 去重增量并入；历史过程经 a9.events.query
 * 有界回看。所有不可信文本一律 textContent，单条说明 16 KB、单条工具输出
 * 8 KB 截断并明示。
 */
(function startA9Workbench(root) {
  const api = root.win7Agent;
  // Capture the view identity when a method is read. Each IPC stays bound to
  // that workspace even if the user switches before the response arrives.
  const a9 = api && api.a9 && new Proxy({}, {
    get(_target, key) {
      const target = api.a9;
      const scoped = state.snapshot && state.snapshot.scope && typeof target.forScope === 'function'
        ? target.forScope(state.snapshot.scope) : target;
      return scoped[key];
    },
  });
  if (api && typeof api.onRequestWait === 'function') {
    api.onRequestWait(status => {
      const node = document.getElementById('main-response-wait');
      if (!node) return;
      node.hidden = !status;
      node.textContent = status
        ? `主进程已有 ${status.elapsedSeconds} 秒没有响应。诊断日志：${status.directory || '尚未取得诊断日志目录'}` : '';
    });
    // Cache the existing diagnostic directory before the first long request.
    void api.getDiagnostics().catch(() => { console.warn('A9_DIAGNOSTIC_DIRECTORY_UNAVAILABLE'); });
  }
  const SUPPORTED_MODES = new Set(['full_access', 'read_only']);
  const MODE_LABELS = Object.freeze({
    full_access: 'Full Access',
    read_only: 'Read Only',
    review: 'Review（不可用）',
    needs_selection: '待选择',
  });
  const TAB_IDS = ['files', 'changes', 'activity', 'environment'];
  const NOTE_LIMIT = 16 * 1024;
  const TOOL_OUTPUT_LIMIT = 8 * 1024;
  const EVENT_GLOBAL_LIMIT = 2000;
  const EVENT_BYTE_LIMIT = 4 * 1024 * 1024;
  const EVENT_TURN_LIMIT = 500;
  const EVENT_TRIM_RATIO = 0.9;
  const TERMINAL_OUTCOMES = new Set([
    'completed', 'completed_with_warnings', 'blocked', 'failed', 'cancelled', 'interrupted',
  ]);
  const OUTCOME_LABELS = Object.freeze({
    completed: '完成',
    completed_with_warnings: '完成（有警告）',
    blocked: '受阻',
    failed: '失败',
    cancelled: '已停止',
    interrupted: '已中断',
    needs_approval: '等待批准',
    needs_input: '等待回答',
    running: '运行中',
  });
  const state = {
    snapshot: null,
    conversationFacts: new Map(),
    conversationPage: null,
    historyLoading: false,
    historyError: '',
    historyNote: null,
    historyExpanded: false,
    explorerSessionId: null,
    explorerPath: '',
    eventsLoaded: false,
    gitWorkspace: null,
    findMatches: [],
    findIndex: -1,
    findObserver: null,
    findTimer: null,
    inboxSettleTimer: null,
    gitRequest: 0,
    explorerRequest: 0,
    viewer: null,
    running: false,
    outputGapRequests: new Set(),
    approvalDecision: null,
    officeSelectionUpdating: false,
    sampleConfirmBusy: null,
    officeSampleSignature: null,
    officeSkillsBusy: false,
    questionReply: null,
    lastFocused: null,
    providerHydratedSignature: null,
    conversationSignature: null,
    continuingTaskId: null,
    managedRenderSignature: null,
    managedConfirmation: null,
    managedDismissBusy: false,
    // 用户手动收起后台进程记录后，轮询不再把它重新展开。
    managedUserCollapsed: false,
    renderedConversationId: null,
    activeConversationId: null,
    checkpointScope: '',
    checkpointGeneration: 0,
    checkpointKnown: new Map(),
    checkpointVisible: 10,
    checkpointLoading: false,
    checkpointError: '',
    reviewCache: new Map(),
    reviewEpoch: 0,
    reviewOpenTurn: null,
    reviewOpenFile: null,
    reviewConfirmation: null,
    reviewMessages: new Map(),
    pendingUndo: null,
    undoInFlight: null,
    summaryQueue: [],
    summaryActive: 0,
    summaryQueued: new Set(),
    draftHydratedConversationId: null,
    draftTimer: null,
    draftSaving: false,
    queueBusy: false,
    undoConfirmations: Object.create(null),
    // ADR-0114：事件数据层与过程渲染状态。
    inspectorEvents: new Map(),
    eventBytes: 0,
    releasedEventCount: 0,
    lowestLoadedEventId: null,
    evictedThroughId: 0,
    turnEvents: new Map(),
    turnIdToFactTask: new Map(),
    activeTurnId: null,
    eventMaxId: 0,
    eventsTruncated: false,
    eventsBeforeId: null,
    eventsError: '',
    eventsLoading: false,
    eventsStatusNote: null,
    workspaceSelectionGeneration: 0,
    workspaceOperation: false,
    defaultConversationPending: false,
    workdirBusy: false,
    workspaceDirectory: [],
    snapshotGeneration: 0,
    snapshotRequest: null,
    snapshotPollingRequests: 0,
    snapshotPollingPauses: 0,
    snapshotPollingClosed: false,
    stopSnapshotPolling: null,
    streamDom: new Map(),
    truncatedNote: null,
    localRequest: null,
    searchQuery: '',
    streamFollow: true,
    liveTimer: null,
    turnStartAt: 0,
    lastEventAt: 0,
    pendingToolLabel: null,
    // A9-19：运行中工具项的开始时刻（P05 已运行时长）与内存预览（P02，ADR-0135）。
    pendingToolAt: 0,
    runningItems: new Set(),
    liveModelPreview: null,
    // A9-57（ADR-0325）：只读浏览身份。与执行快照、activeConversationId、事件缓存、草稿和队列分离。
    browse: null,
    browseGeneration: 0,
    browseReturn: null,
    browseSaved: null,
  };

  function el(id) { return document.getElementById(id); }
  function text(id, value) { const node = el(id); if (node) node.textContent = String(value == null ? '' : value); }
  function modeLabel(mode) { return MODE_LABELS[mode] || String(mode || '-'); }
  function pathName(value) {
    const parts = String(value || '').split(/[\\/]+/).filter(Boolean);
    return parts[parts.length - 1] || '已连接工作区';
  }
  function errorMessage(response, fallback) {
    const error = response && response.error ? response.error : response;
    return error && (error.message || error.detail || error.reason)
      ? String(error.message || error.detail || error.reason)
      : fallback;
  }
  /** ADR-0114 显示上限：截断必须明示，不静默吞内容。 */
  function clampText(value, limit) {
    const content = String(value == null ? '' : value);
    if (content.length <= limit) return content;
    return `${content.slice(0, limit)}\n[已截断；完整内容见持久化事件与日志]`;
  }
  function formatElapsed(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return minutes > 0 ? `${minutes}分${seconds}秒` : `${seconds}秒`;
  }
  function runtimeDiagnostic(snapshot) {
    const diagnostic = snapshot && snapshot.diagnostics ? snapshot.diagnostics : {};
    const code = String(diagnostic.code || (snapshot && snapshot.status) || 'A9_RUNTIME_RESTRICTED').slice(0, 100);
    const rawDetail = String(diagnostic.detail || diagnostic.hint || diagnostic.error || '').slice(0, 500);
    const detail = rawDetail
      .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1***redacted***@')
      .replace(/((?:authorization|api[-_]?key|password|secret|access[-_]?token)\s*[:=]\s*)(?:bearer\s+)?[^\s,;&]+/gi, '$1***redacted***');
    return detail ? `${code}: ${detail}` : code;
  }
  function setFieldError(id, message) {
    const node = el(id);
    if (!node) return;
    node.textContent = message || '';
    node.hidden = !message;
  }
  function showGlobalError(message, recoveryLabel, recovery) {
    const banner = el('error-banner');
    if (!banner) return;
    banner.textContent = '';
    const copy = document.createElement('span');
    copy.textContent = message;
    banner.appendChild(copy);
    if (recoveryLabel && typeof recovery === 'function') {
      const action = document.createElement('button');
      action.type = 'button';
      action.textContent = recoveryLabel;
      action.addEventListener('click', recovery, { once: true });
      banner.appendChild(action);
    }
    banner.hidden = false;
  }
  function clearGlobalError() {
    const banner = el('error-banner');
    if (!banner) return;
    banner.textContent = '';
    banner.hidden = true;
  }

  function setTaskState(label, kind, detail) {
    text('task-state', label);
    el('task-state').className = `task-pill ${kind || 'idle'}`;
    text('rail-task-value', label);
    const railState = el('rail-task-state');
    if (railState && railState.dataset) railState.dataset.state = kind || 'idle';
    text('rail-task-detail', detail || '任务事实会记录在中央时间线。');
  }

  function canSubmit() {
    if (state.workdirBusy) return false;
    if (state.defaultConversationPending) return !state.workspaceOperation && Boolean(el('task-prompt').value.trim());
    return root.win7AgentComposerController.controls(state.snapshot, state.running, el('task-prompt').value).canSend;
  }

  function activeManagedProcesses(snapshot) {
    return ((snapshot && snapshot.managedProcesses) || []).filter((item) => ['running', 'starting', 'running_unknown', 'identity_mismatch'].includes(item.lastProbeStatus) || item.cleanupRequired === true);
  }

  function renderManagedProcesses(snapshot) {
    const container = el('a9-managed-processes');
    if (!container) return;
    const records = (snapshot.managedProcesses || []).filter((item) => !item.owner || item.owner.conversationId === snapshot.activeConversationId);
    const signature = JSON.stringify([snapshot.workspaceRoot, snapshot.activeConversationId, records]);
    const wasHidden = container.hidden;
    container.hidden = records.length === 0;
    syncManagedProcessesDisclosure(records, wasHidden);
    if (state.managedRenderSignature === signature) return;
    state.managedRenderSignature = signature;
    const cards = el('a9-managed-cards'); cards.textContent = '';
    for (const item of records) {
      const card = document.createElement('article'); card.className = 'managed-process-card';
      card.dataset.handleId = item.handleId;
      card.dataset.conversationId = snapshot.activeConversationId;
      card.dataset.recoveryRevision = item.recoveryRevision || '';
      const title = document.createElement('strong'); title.textContent = item.handleId;
      const identity = document.createElement('p'); identity.className = 'quiet';
      identity.textContent = `PID ${item.pid || '未知'} · 启动时间 ${item.startedAt || '未知'}`;
      const command = document.createElement('pre'); command.className = 'managed-process-command';
      // command 已由 Runtime 的现有 redactSecrets 脱敏；仅以文本显示。
      command.textContent = item.command || '';
      const status = document.createElement('p'); status.className = 'managed-process-status';
      status.textContent = item.lastProbeStatus === 'user_dismissed'
        ? '用户确认处置，应用未证实清理'
        : item.cleanupRequired ? '清理未确认' : item.lastProbeStatus || '状态未知';
      card.append(title, identity, command, status);
      if (item.canDismissRecovered) {
        const button = document.createElement('button'); button.type = 'button';
        button.dataset.action = 'dismiss-recovered'; button.textContent = '我已检查残留，解除此记录';
        button.disabled = state.managedDismissBusy;
        button.addEventListener('click', () => {
          if (state.managedDismissBusy || state.managedConfirmation) return;
          // 捕获本卡片身份，轮询刷新不能替换确认目标。
          state.managedConfirmation = { conversationId: card.dataset.conversationId, handleId: item.handleId,
            recoveryRevision: item.recoveryRevision, trigger: button };
          const dialog = el('a9-managed-dismiss-dialog');
          Object.assign(dialog.dataset, { conversationId: card.dataset.conversationId, handleId: item.handleId, recoveryRevision: item.recoveryRevision });
          text('a9-managed-dismiss-identity', `${item.handleId} · PID ${item.pid} · ${item.startedAt}`);
          setFieldError('a9-managed-dismiss-error', '');
          openDialog(dialog); el('a9-managed-dismiss-cancel').focus();
        });
        card.appendChild(button);
      } else if (item.dismissBlockedReason) {
        const reason = document.createElement('p'); reason.className = 'quiet';
        reason.textContent = `暂不能解除记录：${item.dismissBlockedReason}`; card.appendChild(reason);
      }
      cards.appendChild(card);
    }
  }

  /**
   * 后台进程记录默认收起，只在“从无到有”时自动展开一次；用户手动收起后
   * 保持收起，不被后续轮询重新弹开。摘要行始终给出数量与运行中状态，
   * 收起时也能判断是否还有东西在跑。
   */
  function syncManagedProcessesDisclosure(records, wasHidden) {
    const details = el('a9-managed-details');
    if (!details) return;
    text('a9-managed-count', String(records.length));
    const activeCount = records.filter((item) => ['running', 'starting', 'running_unknown', 'identity_mismatch'].includes(item.lastProbeStatus)).length;
    const cleanupCount = records.filter((item) => item.cleanupRequired === true).length;
    text('a9-managed-summary-state', activeCount > 0
      ? `运行中 ${activeCount}`
      : cleanupCount > 0 ? `待处置 ${cleanupCount}` : '已结束');
    const container = el('a9-managed-processes');
    if (container) container.dataset.active = activeCount > 0 ? 'true' : 'false';
    if (wasHidden && records.length > 0 && !state.managedUserCollapsed) {
      details.open = true;
    }
  }

  function closeManagedDismiss() {
    if (state.managedDismissBusy) return;
    const confirmation = state.managedConfirmation;
    state.managedConfirmation = null;
    closeDialog(el('a9-managed-dismiss-dialog'));
    const trigger = confirmation && confirmation.trigger;
    const fallback = el('a9-managed-processes');
    const focus = trigger && trigger.isConnected ? trigger : fallback && !fallback.hidden ? fallback : el('task-prompt');
    if (focus) focus.focus();
  }

  async function confirmManagedDismiss() {
    if (state.browse && browseBlocked('解除后台进程记录')) return;
    const confirmation = state.managedConfirmation;
    if (!confirmation || state.managedDismissBusy) return;
    state.managedDismissBusy = true;
    const dialog = el('a9-managed-dismiss-dialog'); dialog.setAttribute('aria-busy', 'true');
    const buttons = [el('a9-managed-dismiss-confirm'), el('a9-managed-dismiss-cancel')];
    buttons.forEach((button) => { button.disabled = true; });
    setFieldError('a9-managed-dismiss-error', '');
    let succeeded = false;
    try {
      const result = await a9.dismissRecovered(confirmation.conversationId, confirmation.handleId, confirmation.recoveryRevision);
      if (!result || result.ok !== true) { setFieldError('a9-managed-dismiss-error', errorMessage(result, '解除记录失败，请刷新后重试。')); return; }
      succeeded = true;
      text('a9-managed-result', '用户确认处置，应用未证实清理');
      await refreshSnapshot();
    } catch (error) { setFieldError('a9-managed-dismiss-error', errorMessage(error, '解除记录失败，请刷新后重试。')); }
    finally {
      state.managedDismissBusy = false; dialog.removeAttribute('aria-busy');
      buttons.forEach((button) => { button.disabled = false; });
      if (succeeded) closeManagedDismiss();
      else el('a9-managed-dismiss-cancel').focus();
    }
  }

  function syncComposer() {
    if (state.defaultConversationPending) {
      el('task-prompt').disabled = state.workspaceOperation;
      el('run-task').hidden = false;
      el('run-task').disabled = !canSubmit();
      el('cancel-task').hidden = true;
      el('rail-stop').hidden = true;
      el('queue-task').hidden = true;
      el('composer-queue').hidden = true;
      text('session-status', '发送首条消息后以 Full Access 创建对话；需要文件或命令工具时才创建默认目录。');
      return;
    }
    const snapshot = state.snapshot;
    const runtimeUnavailable = Boolean(snapshot && snapshot.status !== 'ready');
    const blockedMode = !snapshot || runtimeUnavailable || !SUPPORTED_MODES.has(snapshot.mode);
    const blockedApproval = Boolean(snapshot && (snapshot.pendingApproval || snapshot.agentStatus === 'needs_approval'));
    const blockedQuestion = Boolean(snapshot && (snapshot.pendingQuestion || snapshot.agentStatus === 'needs_input'));
    const prompt = el('task-prompt');
    const send = el('run-task');
    const stop = el('cancel-task');
    const railStop = el('rail-stop');
    const hasManaged = activeManagedProcesses(snapshot).length > 0;
    const canStop = state.running || hasManaged || Boolean(snapshot && snapshot.controls && snapshot.controls.canStop);
    const stopKind = state.running
      ? 'turn'
      : snapshot && snapshot.controls ? snapshot.controls.stopKind : hasManaged ? 'managed_process' : 'none';
    prompt.disabled = Boolean(state.workdirBusy) || !root.win7AgentComposerController.controls(snapshot, state.running, prompt.value).canDraft;
    const draftingWhileRunning = state.running && !prompt.disabled;
    prompt.placeholder = draftingWhileRunning
      ? '起草下一条消息，当前任务结束后手动发送…'
      : '描述要完成的任务，或询问当前代码…';
    prompt.setAttribute('aria-label', draftingWhileRunning ? '下一条消息草稿' : '任务描述');
    el('composer-send-guidance').hidden = draftingWhileRunning;
    el('composer-draft-guidance').hidden = !draftingWhileRunning;
    el('composer-guidance').classList.toggle('drafting', draftingWhileRunning);
    send.hidden = state.running;
    const queueButton = el('queue-task');
    if (queueButton) {
      queueButton.hidden = !state.running;
      queueButton.disabled = state.workdirBusy || state.queueBusy || !root.win7AgentComposerController.controls(snapshot, state.running, prompt.value).canQueue;
    }
    renderQueue(snapshot);
    stop.hidden = !canStop;
    // ADR-0314：运行中可编辑下一条草稿，执行动作仍只有停止；不自动发送。
    railStop.hidden = true;
    send.disabled = !canSubmit();
    stop.disabled = !canStop;
    railStop.disabled = !canStop;
    const stopLabel = stopKind === 'turn' ? '停止任务' : stopKind === 'managed_process' ? '停止后台进程' : '停止';
    text('cancel-task-label', stopLabel);
    text('rail-stop-label', stopLabel);
    if (runtimeUnavailable) text('session-status', `Runtime 初始化受限：${runtimeDiagnostic(snapshot)}。请打开诊断查看原始运行时事实。`);
    else if (!snapshot) text('session-status', '选择一个本地工作区后再开始任务。');
    else if (blockedMode) text('session-status', '先为当前工作区明确选择 Full Access 或 Read Only。');
    else if (blockedApproval) text('session-status', '先处理当前绑定审批；同一工作区一次只执行一个 A9 任务。');
    else if (blockedQuestion) text('session-status', '先回答或取消当前问题；等待时不会继续模型请求，也不会自动同意任何操作。');
    else if (!snapshot.provider || !snapshot.provider.configured) text('session-status', 'Provider 尚未配置。打开设置并完成原生 tool_calls 探测。');
    else if (!snapshot.provider.probe || snapshot.provider.probe.classification !== 'tool_calling') text('session-status', 'Provider 尚未通过原生 tool_calls 探测；任务发送保持禁用。');
    else if (state.running) text('session-status', '任务正在执行；可起草下一条消息，Enter 换行，结束后手动发送。');
    else if (hasManaged) {
      const recovered = activeManagedProcesses(snapshot).filter((item) => item.pidReusePossible === true);
      text('session-status', recovered.length > 0
        ? `检测到 ${recovered.length} 个重启恢复的 PID 事实；身份无法证明，应用不会发送终止信号。请在系统中核对并停止后再次点击“停止后台进程”。`
        : '托管后台进程仍在运行；可继续工作，或点击“停止后台进程”回收进程树。');
    }
    // A9-56（ADR-0324）：就绪时不再常驻说明；空文本由 .status-line:empty 收起，阻断与异常仍写入同一 live region。
    else text('session-status', '');
    // A9-19 L03：阻断原因始终可见；例行说明在较矮窗口中收起（文本保留在 DOM 中）。
    const routine = Boolean(snapshot) && !runtimeUnavailable && !blockedMode && !blockedApproval && !blockedQuestion
      && Boolean(snapshot.provider && snapshot.provider.configured && snapshot.provider.probe
        && snapshot.provider.probe.classification === 'tool_calling') && !hasManaged;
    el('session-status').dataset.tone = routine ? 'info' : 'block';
  }

  function resizeComposer() {
    const prompt = el('task-prompt');
    prompt.style.height = 'auto';
    prompt.style.height = `${Math.min(prompt.scrollHeight, 170)}px`;
    syncComposer();
  }

  // 原生 DOM Range 只索引当前已加载正文，不请求更多历史或改写正文节点。
  function refreshConversationFind(navigate = false) {
    if (el('conversation-find').hidden) return;
    const query = el('conversation-find-input').value;
    const matches = [];
    if (query) {
      const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      const walker = document.createTreeWalker(el('a9-task-stream'), root.NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          return node.parentElement.closest('button, [hidden], [aria-hidden="true"]')
            ? root.NodeFilter.FILTER_REJECT : root.NodeFilter.FILTER_ACCEPT;
        },
      });
      let node;
      while ((node = walker.nextNode())) {
        pattern.lastIndex = 0;
        let match;
        while ((match = pattern.exec(node.data))) {
          matches.push({ node, start: match.index, end: match.index + match[0].length });
        }
      }
    }
    state.findMatches = matches;
    state.findIndex = matches.length ? Math.max(0, Math.min(state.findIndex, matches.length - 1)) : -1;
    selectConversationMatch(navigate);
  }

  function selectConversationMatch(navigate) {
    const total = state.findMatches.length;
    const hasQuery = Boolean(el('conversation-find-input').value);
    text('conversation-find-count', hasQuery ? `${total ? state.findIndex + 1 : 0} / ${total} 处匹配` : '输入查找内容');
    el('conversation-find-prev').disabled = total === 0;
    el('conversation-find-next').disabled = total === 0;
    const selection = root.getSelection();
    if (selection.anchorNode && el('a9-task-stream').contains(selection.anchorNode)) selection.removeAllRanges();
    if (!total) return;
    const match = state.findMatches[state.findIndex];
    const range = document.createRange();
    range.setStart(match.node, match.start);
    range.setEnd(match.node, match.end);
    selection.removeAllRanges();
    selection.addRange(range);
    if (!navigate) return;
    let parent = range.startContainer.parentElement;
    while (parent && parent !== el('conversation')) {
      if (parent.tagName === 'DETAILS') parent.open = true;
      parent = parent.parentElement;
    }
    state.streamFollow = false;
    const scroller = el('conversation');
    const rect = range.getBoundingClientRect();
    const viewport = scroller.getBoundingClientRect();
    scroller.scrollTop += rect.top - viewport.top - scroller.clientHeight / 2;
  }

  function openConversationFind() {
    if (state.browse && browseBlocked('使用正文查找（查找只覆盖执行对话正文）；可直接选择并复制只读正文')) return;
    if (navigationIsDrawer() && el('navigation-rail').classList.contains('open')) closeNavigation();
    if (inspectorIsDrawer() && el('inspector').classList.contains('open')) closeInspector();
    el('conversation-find').hidden = false;
    el('conversation-find-open').setAttribute('aria-expanded', 'true');
    refreshConversationFind();
    el('conversation-find-input').focus();
    el('conversation-find-input').select();
  }

  function closeConversationFind() {
    el('conversation-find').hidden = true;
    el('conversation-find-open').setAttribute('aria-expanded', 'false');
    state.findMatches = [];
    state.findIndex = -1;
    const selection = root.getSelection();
    if (selection.anchorNode && el('conversation').contains(selection.anchorNode)) selection.removeAllRanges();
    el('task-prompt').focus();
  }

  function moveConversationMatch(direction) {
    refreshConversationFind();
    if (!state.findMatches.length) return;
    state.findIndex = (state.findIndex + direction + state.findMatches.length) % state.findMatches.length;
    selectConversationMatch(true);
  }

  // ------------------------------------------------------------------
  // ADR-0114 事件数据层：归一化、去重并入、按轮次组织。
  // ------------------------------------------------------------------

  function normalizeTimelineEvent(raw) {
    if (!raw || typeof raw.type !== 'string') return null;
    const eventId = Number(raw.eventId);
    if (!Number.isSafeInteger(eventId) || eventId <= 0) return null;
    return {
      eventId,
      type: raw.type,
      turnId: raw.turnId || null,
      timestamp: raw.timestamp || '',
      data: raw.data && typeof raw.data === 'object' ? raw.data : {},
    };
  }

  function normalizeQueriedEvent(raw) {
    if (!raw) return null;
    const eventId = Number(raw.eventId);
    if (!Number.isSafeInteger(eventId) || eventId <= 0) return null;
    const payload = raw.payload && typeof raw.payload === 'object' ? raw.payload : null;
    const type = payload && typeof payload.type === 'string'
      ? payload.type
      : (typeof raw.eventType === 'string' ? raw.eventType : '');
    if (!type) return null;
    const data = payload && payload.data && typeof payload.data === 'object'
      ? payload.data
      : (payload || {});
    return {
      eventId,
      type,
      turnId: raw.turnId || null,
      timestamp: raw.createdAt || '',
      data,
    };
  }

  function estimatedEventBytes(event) {
    return JSON.stringify(event.data || {}).length * 2 + 128;
  }

  function discardEvent(event) {
    state.inspectorEvents.delete(event.eventId);
    state.eventBytes -= event.estimatedBytes;
    state.releasedEventCount += 1;
    state.evictedThroughId = Math.max(state.evictedThroughId, event.eventId);
    if (event.turnId) {
      const bucket = state.turnEvents.get(event.turnId);
      if (bucket) {
        bucket.ids.delete(event.eventId);
        bucket.events = bucket.events.filter((item) => item.eventId !== event.eventId);
        bucket.released = (bucket.released || 0) + 1;
      }
      // A tool end can mutate its start node. Rebuild affected blocks so no
      // removed event, group item or pending-tool reference remains in the DOM.
      state.streamDom.forEach((block) => {
        if (block.root.dataset.turnId !== event.turnId || !block.renderedIds.includes(event.eventId)) return;
        block.pendingItems.forEach(settleItem);
        block.progressEl.textContent = '';
        block.renderedEvents = 0;
        block.renderedIds = [];
        block.groupEl = null;
        block.groupItemsEl = null;
        block.groupCount = 0;
        block.pendingItems = new Map();
        block.legacyEl = null;
        block.releasedEl = null;
        if (block.previewEl) { block.previewEl = null; block.previewBodyEl = null; }
      });
    }
  }

  function enforceEventCaps() {
    const countTarget = Math.floor(EVENT_GLOBAL_LIMIT * EVENT_TRIM_RATIO);
    const byteTarget = Math.floor(EVENT_BYTE_LIMIT * EVENT_TRIM_RATIO);
    let discarded = false;
    if (state.inspectorEvents.size > EVENT_GLOBAL_LIMIT || state.eventBytes > EVENT_BYTE_LIMIT) {
      const oldest = eventsForInspector();
      for (const event of oldest) {
        if (state.inspectorEvents.size <= countTarget && state.eventBytes <= byteTarget) break;
        discardEvent(event);
        discarded = true;
      }
    }
    state.turnEvents.forEach((bucket) => {
      if (bucket.events.length <= EVENT_TURN_LIMIT) return;
      const target = Math.floor(EVENT_TURN_LIMIT * EVENT_TRIM_RATIO);
      for (const event of bucket.events.slice()) {
        if (bucket.events.length <= target) break;
        discardEvent(event);
        discarded = true;
      }
    });
    if (discarded) {
      const oldestRetained = eventsForInspector()[0];
      state.eventsBeforeId = oldestRetained ? oldestRetained.eventId : null;
      state.eventsTruncated = true;
    }
  }

  function ingestEvents(events, explicitOlder = false) {
    let changed = false;
    const lowestBeforeBatch = state.lowestLoadedEventId;
    let lowestInBatch = null;
    for (const event of events) {
      if (!event) continue;
      if (state.inspectorEvents.has(event.eventId)) continue;
      if (!explicitOlder && event.eventId <= state.evictedThroughId) continue;
      const bytes = estimatedEventBytes(event);
      const bucket = event.turnId ? state.turnEvents.get(event.turnId) : null;
      if (explicitOlder && (state.inspectorEvents.size >= EVENT_GLOBAL_LIMIT
        || state.eventBytes + bytes > EVENT_BYTE_LIMIT
        || (bucket && bucket.events.length >= EVENT_TURN_LIMIT))) continue;
      event.estimatedBytes = bytes;
      state.inspectorEvents.set(event.eventId, event);
      state.eventBytes += bytes;
      if (explicitOlder && lowestBeforeBatch !== null
        && event.eventId >= lowestBeforeBatch) {
        state.releasedEventCount = Math.max(0, state.releasedEventCount - 1);
        if (bucket) bucket.released = Math.max(0, (bucket.released || 0) - 1);
      }
      if (lowestInBatch === null || event.eventId < lowestInBatch) lowestInBatch = event.eventId;
      changed = true;
      if (event.eventId > state.eventMaxId) state.eventMaxId = event.eventId;
      if (event.type === 'turn_started' && event.turnId) {
        // 多个轮次同窗时以时间线顺序的最后一个 turn_started 为当前轮。
        state.activeTurnId = event.turnId;
      }
      if (!event.turnId) continue;
      const turnBucket = state.turnEvents.get(event.turnId);
      if (turnBucket) {
        if (turnBucket.ids.has(event.eventId)) continue;
        turnBucket.ids.add(event.eventId);
        turnBucket.events.push(event);
        turnBucket.events.sort((a, b) => a.eventId - b.eventId);
      } else {
        state.turnEvents.set(event.turnId, { ids: new Set([event.eventId]), events: [event], released: 0 });
      }
      if (event.type === 'tool_start') {
        state.pendingToolLabel = toolHeadline(event.data);
        state.pendingToolAt = Date.parse(event.timestamp || '') || Date.now();
      }
      if (event.type === 'tool_end') { state.pendingToolLabel = null; state.pendingToolAt = 0; }
      state.lastEventAt = Date.now();
      changed = true;
    }
    if (lowestInBatch !== null) {
      state.lowestLoadedEventId = lowestBeforeBatch === null
        ? lowestInBatch : Math.min(lowestBeforeBatch, lowestInBatch);
    }
    if (!explicitOlder) enforceEventCaps();
    return changed;
  }

  function ingestTimelineEvents(timeline) {
    return ingestEvents((timeline || []).map(normalizeTimelineEvent).filter(Boolean));
  }

  function eventsForTurn(turnId) {
    const bucket = turnId ? state.turnEvents.get(turnId) : null;
    return bucket ? bucket.events : [];
  }

  function eventsForInspector() {
    return Array.from(state.inspectorEvents.values()).sort((a, b) => a.eventId - b.eventId);
  }

  function resetConversationEvents() {
    if (typeof cancelPendingUndo === 'function') cancelPendingUndo();
    state.historyGeneration = (state.historyGeneration || 0) + 1;
    state.conversationFacts = new Map();
    state.conversationPage = null;
    state.historyLoading = false;
    state.historyError = '';
    state.historyNote = null;
    state.historyExpanded = false;
    state.inspectorEvents = new Map();
    state.eventBytes = 0;
    state.releasedEventCount = 0;
    state.lowestLoadedEventId = null;
    state.evictedThroughId = 0;
    state.turnEvents = new Map();
    state.turnIdToFactTask = new Map();
    state.activeTurnId = null;
    state.eventMaxId = 0;
    state.eventsTruncated = false;
    state.eventsBeforeId = null;
    state.eventsError = '';
    state.eventsLoading = false;
    state.eventsLoaded = false;
    state.findIndex = -1;
    state.findMatches = [];
    state.eventsStatusNote = null;
    state.streamDom = new Map();
    state.pendingToolLabel = null;
    state.truncatedNote = null;
    const stream = el('a9-task-stream');
    stream.textContent = '';
  }

  /**
   * 历史过程回看：会话加载/切换/轮次结束后拉取最近 300 条事件；截断以
   * hasMore 明示。失败不阻塞事实渲染（fail-open 于展示层，不涉及写入）。
   */
  async function loadConversationEvents(older = false) {
    if (!a9 || !state.activeConversationId) return;
    if (state.eventsLoading) return;
    const limit = older ? Math.min(300, EVENT_GLOBAL_LIMIT - state.inspectorEvents.size) : 300;
    if (limit <= 0) return;
    const requestedConversationId = state.activeConversationId;
    const generation = state.historyGeneration;
    state.eventsLoading = true;
    state.conversationSignature = null;
    if (state.snapshot) renderConversation(state.snapshot);
    try {
      const response = await a9.queryEvents({ conversationId: requestedConversationId, limit,
        ...(older && state.eventsBeforeId ? { beforeEventId: state.eventsBeforeId } : {}) });
      if (requestedConversationId !== state.activeConversationId || generation !== state.historyGeneration) return;
      if (!response || response.ok !== true) throw new Error(errorMessage(response, 'EVENT_HISTORY_UNAVAILABLE'));
      const normalized = (response.events || []).map(normalizeQueriedEvent).filter(Boolean);
      ingestEvents(normalized, older);
      if (older || state.eventsBeforeId === null) {
        state.eventsTruncated = response.hasMore === true || state.releasedEventCount > 0;
        const oldestRetained = eventsForInspector()[0];
        if (oldestRetained) state.eventsBeforeId = oldestRetained.eventId;
      }
      state.eventsError = '';
      state.eventsLoaded = true;
    } catch (_error) {
      if (requestedConversationId === state.activeConversationId && generation === state.historyGeneration) {
        // 异常可能来自传输层，不把未经脱敏的 message 带入会话界面。
        state.eventsError = '过程记录加载失败：未能获取记录，可重试。已有请求和结果仍保留。';
      }
    } finally {
      if (requestedConversationId === state.activeConversationId && generation === state.historyGeneration) {
        state.eventsLoading = false;
        state.conversationSignature = null;
        if (state.snapshot) {
          renderTimeline();
          renderConversation(state.snapshot);
        }
      }
    }
  }

  /** 事实（taskId）与轮次（turnId）在执行期间可能尚未关联；此处补齐映射。 */
  function resolveTurnId(fact) {
    if (fact.turnId) {
      state.turnIdToFactTask.set(fact.turnId, fact.taskId);
      return fact.turnId;
    }
    for (const entry of state.turnIdToFactTask.entries()) {
      if (entry[1] === fact.taskId) return entry[0];
    }
    // A9-19 F1：运行中任务在持久化中为 'active'（不止 running/needs_approval）；任一非终态事实
    // 都绑定当前活动轮次，否则运行中的过程事件要等轮次结束取得 turnId 才出现。
    if (!TERMINAL_OUTCOMES.has(fact.outcome) && state.activeTurnId
      && !state.turnIdToFactTask.has(state.activeTurnId)) {
      state.turnIdToFactTask.set(state.activeTurnId, fact.taskId);
      return state.activeTurnId;
    }
    return null;
  }

  // ------------------------------------------------------------------
  // 友好文案：工具活动与时间线标签（描述性文本，不虚构动作）。
  // ------------------------------------------------------------------

  function toolHeadline(data) {
    const name = data && data.toolName ? String(data.toolName) : 'tool';
    const args = (data && data.args) || {};
    switch (name) {
      case 'read': return `读取 ${args.path || ''}`.trim();
      case 'list': return `列出 ${args.path || '.'}`;
      case 'search': return `搜索 ${args.pattern || ''}`.trim();
      case 'write': return `写入 ${args.path || ''}`.trim();
      case 'edit': return `编辑 ${args.path || ''}`.trim();
      case 'copy': return `复制 ${args.source || ''} → ${args.destination || ''}`;
      case 'move': return `移动 ${args.source || ''} → ${args.destination || ''}`;
      case 'delete': return `删除 ${args.path || ''}`.trim();
      case 'shell': return `运行命令 ${String(args.command || '').slice(0, 80)}`;
      case 'update_plan': return '更新计划';
      default: return name;
    }
  }

  function toolDetailText(data) {
    const parts = [];
    if (data.error) parts.push(String(data.error));
    if (data.result) parts.push(String(data.result));
    const shell = data.shell;
    if (shell && typeof shell === 'object') {
      if (typeof shell.stdout === 'string' && shell.stdout) parts.push(shell.stdout);
      if (typeof shell.stderr === 'string' && shell.stderr) parts.push(`[stderr]\n${shell.stderr}`);
      if (shell.exitCode !== undefined) parts.push(`exit=${shell.exitCode}`);
      if (shell.truncated) parts.push('[输出预览已截断；完整字节见日志路径]');
    }
    if (data.externalChanges && Array.isArray(data.externalChanges) && data.externalChanges.length > 0) {
      parts.push(`外部文件变更 ${data.externalChanges.length} 处`);
    }
    return parts.join('\n').trim();
  }

  function toolEndStatus(data) {
    const shell = data.shell || {};
    let resultError = false;
    if (typeof data.result === 'string') {
      try {
        const result = JSON.parse(data.result);
        resultError = Boolean(result && typeof result === 'object' && result.error);
      } catch (_error) {
        // The runtime caps result at 1000 characters, which can truncate its
        // exception envelope. File contents remain nested in a content field.
        resultError = /^\s*\{\s*"error"\s*:\s*\{/.test(data.result);
      }
    }
    if (data.residueRisk || shell.residueRisk) return ['failed', '清理未确认'];
    if (data.cancelled === true || ['cancelled', 'canceled', 'interrupted'].includes(shell.status)) return ['stopped', '已停止'];
    if (data.denied) return ['denied', '已拒绝'];
    if (data.error || resultError || ['failed', 'error', 'timeout', 'timed_out'].includes(shell.status)
        || (typeof shell.exitCode === 'number' && shell.exitCode !== 0)
        || /^Tool execution error:|^Error:/i.test(String(data.result || ''))) return ['failed', '失败'];
    if (data.shell && shell.status !== 'completed' && shell.status !== 'success' && shell.exitCode !== 0) return ['interrupted', '结果未确认'];
    return ['success', ({ read: '已读取', list: '已列出', search: '已搜索' })[data.toolName] || '执行成功'];
  }

  function timelineEntryLabel(event) {
    const data = event.data || {};
    const shell = data.shell && data.shell.schemaVersion === 1 ? data.shell : null;
    switch (event.type) {
      case 'turn_started': return '任务开始';
      case 'turn_completed': return `任务${OUTCOME_LABELS[data.outcome] || '结束（结果未确认）'}`;
      case 'turn_failed': return `任务失败 · ${String(data.error || '').slice(0, 120)}`;
      case 'model_note': return '模型说明';
      case 'model_chunk': return '模型输出（汇总）';
      case 'plan_updated': return '更新计划';
      case 'approval_required': return `准备执行 · 等待批准 · ${data.toolName || '-'}`;
      case 'approval_resolved': return `审批${data.decision === 'approved' ? '已批准' : '已拒绝'} · ${data.toolName || '-'}`;
      case 'approval_invalidated': return `审批已失效，未执行 · ${data.toolName || '-'}`;
      case 'tool_start': return `正在${toolHeadline(data)}`;
      case 'tool_end':
        return `${toolHeadline(data)} · ${toolEndStatus(data)[1]}${shell && shell.exitCode !== undefined ? ` · exit=${shell.exitCode}` : ''}`;
      default: return event.type || 'event';
    }
  }

  // ------------------------------------------------------------------
  // 轮次渲染：按事实顺序维护轮次块，事件增量追加（保留展开态与滚动位置）。
  // ------------------------------------------------------------------

  function ensureTurnBlock(key) {
    let block = state.streamDom.get(key);
    if (block) return block;
    const stream = el('a9-task-stream');
    const rootArticle = document.createElement('article');
    rootArticle.className = 'turn-block';
    rootArticle.tabIndex = -1;
    rootArticle.dataset.turnKey = key;
    const request = document.createElement('div');
    request.className = 'turn-request';
    const requestHead = document.createElement('div');
    requestHead.className = 'turn-request-head';
    const requestLabel = document.createElement('strong');
    requestLabel.textContent = '你';
    const requestTime = document.createElement('span');
    const requestDuration = document.createElement('span');
    requestDuration.className = 'turn-duration';
    requestHead.appendChild(requestLabel);
    requestHead.appendChild(requestTime);
    requestHead.appendChild(requestDuration);
    const requestBody = document.createElement('div');
    requestBody.className = 'turn-request-body';
    request.appendChild(requestHead);
    request.appendChild(requestBody);
    const progress = document.createElement('div');
    progress.className = 'turn-progress';
    rootArticle.appendChild(request);
    rootArticle.appendChild(progress);
    stream.appendChild(rootArticle);
    block = {
      key,
      root: rootArticle,
      requestTime,
      requestDuration,
      requestBody,
      progressEl: progress,
      renderedEvents: 0,
      renderedIds: [],
      groupEl: null,
      groupItemsEl: null,
      groupCount: 0,
      pendingItems: new Map(),
      local: key === '__local__',
      legacyEl: null,
      releasedEl: null,
      outcomeEl: null,
      outcomeLabelEl: null,
      outcomeMetaEl: null,
      outcomeBodyEl: null,
      outcomeSig: '',
    };
    state.streamDom.set(key, block);
    return block;
  }

  function updateGroupSummary(block) {
    if (block.groupEl && block.groupEl.firstChild) {
      block.groupEl.firstChild.textContent = `工具活动 · ${block.groupCount} 项`;
    }
  }

  function ensureActivityGroup(block) {
    if (block.groupEl) return block.groupEl;
    const group = document.createElement('details');
    group.className = 'activity-group';
    if (state.running) { group.open = true; group.dataset.autoOpened = 'true'; }
    const summary = document.createElement('summary');
    summary.textContent = '工具活动';
    const items = document.createElement('ul');
    items.className = 'activity-items';
    group.appendChild(summary);
    group.appendChild(items);
    block.progressEl.appendChild(group);
    block.groupEl = group;
    block.groupItemsEl = items;
    block.groupCount = 0;
    block.pendingItems = new Map();
    return group;
  }

  function closeActivityGroup(block) {
    block.groupEl = null;
    block.groupItemsEl = null;
    block.pendingItems = new Map();
  }

  function addActivityItem(block, data, status, label) {
    ensureActivityGroup(block);
    const li = document.createElement('li');
    li.className = 'activity-item';
    const head = document.createElement('div');
    head.className = 'activity-item-head';
    const tool = document.createElement('span');
    tool.className = 'activity-tool';
    tool.textContent = toolHeadline(data);
    tool.title = data.toolName || '';
    const tag = document.createElement('span');
    tag.className = `status-tag ${status}`;
    tag.textContent = label;
    head.appendChild(tool);
    head.appendChild(tag);
    li.appendChild(head);
    block.groupItemsEl.appendChild(li);
    block.groupCount += 1;
    updateGroupSummary(block);
    return { li, tag, elapsedEl: null, startedAt: 0 };
  }

  /** A9-30：运行中的工具项显示已运行时长，输出到达后在活动卡呈现。 */
  function markItemRunning(item, data, startedAt) {
    item.startedAt = Number.isFinite(startedAt) ? startedAt : 0;
    const elapsed = document.createElement('span');
    elapsed.className = 'activity-elapsed';
    item.li.firstChild.insertBefore(elapsed, item.tag);
    item.elapsedEl = elapsed;
    if (data && data.toolName === 'shell') {
      const note = document.createElement('p');
      note.className = 'activity-pending-note';
      note.textContent = '命令运行中；收到输出后会在此显示，可随时停止。';
      item.li.appendChild(note);
      item.pendingNoteEl = note;
    }
    state.runningItems.add(item);
    tickRunningItems();
  }

  function settleItem(item, endedAt) {
    state.runningItems.delete(item);
    if (item.elapsedEl) item.elapsedEl.textContent = item.startedAt && Number.isFinite(endedAt) && endedAt >= item.startedAt
      ? `耗时 ${formatElapsed(endedAt - item.startedAt)}` : '';
    if (item.pendingNoteEl) { item.pendingNoteEl.remove(); item.pendingNoteEl = null; }
  }

  function tickRunningItems() {
    const now = Date.now();
    state.runningItems.forEach((item) => {
      if (!item.li.parentNode) { state.runningItems.delete(item); return; }
      if (item.elapsedEl) item.elapsedEl.textContent = item.startedAt && now >= item.startedAt
        ? `执行中 · 已运行 ${formatElapsed(now - item.startedAt)}` : '';
    });
  }

  function attachActivityDetail(item, data) {
    appendWorkdirBoundaryAction(item.li, data);
    if (data.image && data.image.reference && window.A9ImagePreview) {
      item.li.appendChild(window.A9ImagePreview.create(data.image, (conversationId, reference) =>
        api.a9.previewImage(conversationId, reference)));
    }
    const detailText = item.streamOutput ? [
      `退出：${data.shell && data.shell.exitCode !== null ? data.shell.exitCode : '未知'}`,
      data.shell && data.shell.processTreeReaped === true ? '进程树清理已确认' : '进程树清理未确认，请检查残留',
      data.shell && data.shell.truncated ? '输出已截断' : '',
    ].filter(Boolean).join('\n') : toolDetailText(data);
    if (!detailText) return;
    const detail = document.createElement('pre');
    detail.className = 'activity-detail';
    detail.textContent = clampText(detailText, TOOL_OUTPUT_LIMIT);
    item.li.appendChild(detail);
  }

  function appendEventNode(block, event) {
    const data = event.data || {};
    switch (event.type) {
      case 'turn_started': {
        const instruction = data.projectInstructions;
        if (!instruction) break;
        const statusText = {
          absent: '未找到工作区根 AGENTS.md',
          too_large: 'AGENTS.md 超过 32 KiB，未加载',
          decode_error: 'AGENTS.md 无法按 UTF-8 读取',
          secret_blocked: 'AGENTS.md 含已知秘密，未加载',
          outside: 'AGENTS.md 指向工作区外，未加载',
        };
        const note = document.createElement('p');
        note.className = 'note-line';
        note.textContent = instruction.status === 'loaded'
          ? `已加载 AGENTS.md（${(instruction.bytes / 1024).toFixed(1)} KB）`
          : (statusText[instruction.status] || 'AGENTS.md 未加载');
        block.progressEl.appendChild(note);
        break;
      }
      case 'model_note': {
        closeActivityGroup(block);
        const note = document.createElement('p');
        note.className = 'note-line';
        note.textContent = clampText(data.content, NOTE_LIMIT);
        block.progressEl.appendChild(note);
        break;
      }
      case 'plan_updated': {
        closeActivityGroup(block);
        block.progressEl.appendChild(buildPlanCard(data));
        break;
      }
      case 'approval_required': {
        closeActivityGroup(block);
        block.progressEl.appendChild(buildApprovalRecord('pending', `需要批准：${data.toolName || 'operation'}`,
          `准备执行，等待批准。${data.summary || data.reason || ''}`));
        break;
      }
      case 'approval_resolved': {
        closeActivityGroup(block);
        const approved = data.decision === 'approved';
        block.progressEl.appendChild(buildApprovalRecord(approved ? 'approved' : 'denied',
          `${approved ? '已批准' : '已拒绝'}：${data.toolName || 'operation'}`,
          data.decidedAt ? new Date(data.decidedAt).toLocaleString() : ''));
        break;
      }
      case 'approval_invalidated': {
        closeActivityGroup(block);
        block.progressEl.appendChild(buildApprovalRecord('denied',
          `审批已失效：${data.toolName || 'operation'}`,
          `目标或参数已变化，本次回复未生效、未执行。${data.invalidatedAt ? new Date(data.invalidatedAt).toLocaleString() : ''}`));
        break;
      }
      case 'tool_start': {
        ensureActivityGroup(block);
        if (!block.groupEl.dataset.eventId) block.groupEl.dataset.eventId = String(event.eventId);
        const item = addActivityItem(block, data, 'running', '执行中');
        markItemRunning(item, data, Date.parse(event.timestamp || ''));
        if (!block.outputItems) block.outputItems = new Map();
        if (data.callId) { block.pendingItems.set(String(data.callId), item); block.outputItems.set(String(data.callId), item); }
        else block.pendingItems.set('__last__', item);
        break;
      }
      case 'tool_output': {
        if (data.schemaVersion !== 1 || !data.toolCallId || !Number.isSafeInteger(data.outputSeq) || data.outputSeq < 1
          || !['stdout', 'stderr'].includes(data.stream) || typeof data.text !== 'string') break;
        const key = String(data.toolCallId);
        if (!block.outputItems) block.outputItems = new Map();
        let item = block.outputItems.get(key) || block.pendingItems.get(key);
        if (!item) {
          ensureActivityGroup(block);
          item = addActivityItem(block, { toolName: data.toolName === 'start_process' ? 'start_process' : 'shell', callId: key }, 'interrupted', '历史输出');
          block.pendingItems.set(key, item);
          block.outputItems.set(key, item);
        }
        if (!item.streamOutput) {
          item.streamOutput = { stdout: '', stderr: '', seq: 0, truncated: false };
          item.outputEl = document.createElement('pre');
          item.outputEl.className = 'activity-detail shell-live-output';
          item.outputEl.setAttribute('aria-label', 'Shell 输出');
          item.li.appendChild(item.outputEl);
        }
        const output = item.streamOutput;
        if (data.outputSeq <= output.seq) break;
        if (data.outputSeq !== output.seq + 1) {
          output.truncated = true;
          // One bounded history fetch per detected gap; existing pagination preserves identities.
          const gapKey = `${state.activeConversationId || ''}:${event.turnId}:${key}:${data.outputSeq}`;
          const requests = state.outputGapRequests || (state.outputGapRequests = new Set());
          if (!requests.has(gapKey) && requests.size < 128 && state.eventsBeforeId && typeof loadConversationEvents === 'function') {
            requests.add(gapKey);
            Promise.resolve().then(() => loadConversationEvents(true));
          }
        }
        output.seq = data.outputSeq;
        const room = Math.max(0, TOOL_OUTPUT_LIMIT - output.stdout.length - output.stderr.length);
        output[data.stream] += data.text.slice(0, room);
        output.truncated = output.truncated || data.truncated || data.text.length > room || Boolean(data.warning);
        if (data.warning === 'A9_OUTPUT_ENCODING_ERROR') output.warning = '输出编码错误，该流文本已停止';
        else if (data.warning === 'redaction_boundary') output.warning = '片段无法安全判定，已屏蔽';
        item.outputEl.textContent = `stdout:\n${output.stdout}\nstderr:\n${output.stderr}${output.truncated ? '\n[输出已截断或存在缺口]' : ''}${output.warning ? `\n[${output.warning}]` : ''}`;
        break;
      }
      case 'tool_end': {
        if (!data.toolName) break; // 仅 externalChanges 的事实不构成工具项
        const key = data.callId ? String(data.callId) : '__last__';
        const item = block.pendingItems.get(key) || (data.callId ? block.pendingItems.get('__last__') : null);
        if (item) {
          block.pendingItems.delete(key);
          settleItem(item, Date.parse(event.timestamp || ''));
          const [status, label] = toolEndStatus(data);
          item.tag.className = `status-tag ${status}`;
          item.tag.textContent = label;
          attachActivityDetail(item, data);
        } else {
          // 无配对 start（历史/恢复数据）时也如实展示终态。
          const [status, label] = toolEndStatus(data);
          addActivityItem(block, data, status, label, true);
          const last = Array.from(block.groupItemsEl.children).pop();
          if (last) attachActivityDetail({ li: last, tag: null }, data);
        }
        break;
      }
      default:
        break;
    }
  }

  function buildPlanCard(data) {
    const card = document.createElement('div');
    card.className = 'plan-card';
    const title = document.createElement('p');
    title.className = 'plan-title';
    title.textContent = '计划';
    title.title = '计划仅记录步骤，不代表工具已执行成功。';
    card.appendChild(title);
    const steps = document.createElement('ol');
    steps.className = 'plan-steps';
    (Array.isArray(data && data.plan) ? data.plan : []).forEach((line) => {
      const step = document.createElement('li');
      step.className = 'plan-step';
      step.textContent = String(line || '');
      steps.appendChild(step);
    });
    card.appendChild(steps);
    if (data && data.explanation) {
      const explanation = document.createElement('p');
      explanation.className = 'plan-explanation';
      explanation.textContent = clampText(data.explanation, 2000);
      card.appendChild(explanation);
    }
    return card;
  }

  function buildApprovalRecord(kind, headline, detailText) {
    const record = document.createElement('p');
    record.className = `approval-record ${kind}`;
    const body = document.createElement('span');
    body.className = 'approval-record-body';
    const strong = document.createElement('strong');
    strong.textContent = headline;
    body.appendChild(strong);
    if (detailText) {
      const detail = document.createElement('span');
      detail.className = 'approval-record-detail';
      detail.textContent = detailText;
      body.appendChild(detail);
    }
    record.appendChild(body);
    return record;
  }

  function projectOutcome(fact, events) {
    let outcome = null;
    let verification = 'not_applicable';
    let message = '';
    let verificationEvidence = null;
    for (const event of events) {
      if (event.type === 'turn_completed') {
        outcome = event.data.outcome || 'completed';
        verification = event.data.verification || 'not_applicable';
        message = event.data.finalMessage || '';
        verificationEvidence = event.data.verificationEvidence || null;
      } else if (event.type === 'turn_failed') {
        outcome = 'failed';
        message = event.data.error ? `模型调用失败：${event.data.error}` : '';
      }
    }
    if (!outcome && fact && TERMINAL_OUTCOMES.has(fact.outcome)) {
      outcome = fact.outcome;
      verification = fact.verification || 'not_applicable';
      message = fact.finalMessage || (fact.outcome === 'interrupted'
        ? '应用重启后恢复了中断事实；未重放模型、工具或旧审批。'
        : '');
    }
    return outcome ? { outcome, verification, message, verificationEvidence } : null;
  }

  function updateOutcomeCard(block, fact, events) {
    const projection = projectOutcome(fact, events);
    if (!projection) {
      if (block.outcomeEl) {
        block.outcomeEl.remove();
        block.outcomeEl = null;
        block.outcomeSig = '';
      }
      return;
    }
    const { outcome, verification, message, verificationEvidence } = projection;
    const signature = JSON.stringify([outcome, verification, message, verificationEvidence]);
    if (block.outcomeSig === signature) return;
    block.outcomeSig = signature;
    if (!block.outcomeEl) {
      const card = document.createElement('div');
      const head = document.createElement('div');
      head.className = 'outcome-head';
      const label = document.createElement('strong');
      const meta = document.createElement('span');
      head.appendChild(label);
      head.appendChild(meta);
      const body = document.createElement('div');
      body.className = 'outcome-body';
      card.appendChild(head);
      card.appendChild(body);
      block.root.appendChild(card);
      block.outcomeEl = card;
      block.outcomeLabelEl = label;
      block.outcomeMetaEl = meta;
      block.outcomeBodyEl = body;
    }
    const variant = outcome === 'failed' ? 'fail' : outcome === 'completed' ? '' : 'warn';
    block.outcomeEl.className = `outcome-card ${variant}`.trim();
    block.outcomeLabelEl.textContent = OUTCOME_LABELS[outcome] || outcome;
    // A9-19 L02：验证状态以中文呈现；not_applicable 不显示。
    const verificationText = verification === 'verified' ? '已验证' : verification === 'unverified' ? '未验证' : '';
    const timeText = fact && fact.updatedAt ? new Date(fact.updatedAt).toLocaleTimeString() : '';
    block.outcomeMetaEl.textContent = [verificationText, timeText].filter(Boolean).join(' · ');
    block.outcomeBodyEl.textContent = clampText(message || '任务已返回结果。', NOTE_LIMIT);
    if (verificationEvidence && verification === 'verified') {
      const evidence = document.createElement('small');
      evidence.className = 'verification-evidence';
      evidence.textContent = `依据：${verificationEvidence.command} 退出码 ${verificationEvidence.exitCode}`;
      block.outcomeBodyEl.appendChild(evidence);
    }
  }

  function updateContinuationCard(block, recovery) {
    if (!recovery && block.recovery && state.continuingTaskId === block.recovery.taskId) recovery = block.recovery;
    if (!recovery) {
      if (block.continueEl) { block.continueEl.remove(); block.continueEl = null; }
      return;
    }
    if (!block.continueEl) {
      const card = document.createElement('section');
      card.className = 'continuation-card';
      card.tabIndex = -1;
      card.setAttribute('aria-label', '中断任务继续');
      const title = document.createElement('strong');
      title.textContent = '继续中断任务';
      const facts = document.createElement('p');
      facts.className = 'continuation-facts';
      const reason = document.createElement('p');
      reason.className = 'continuation-reason';
      reason.setAttribute('role', 'status');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'primary';
      button.addEventListener('click', () => { void continueInterruptedTask(block.recovery, block); });
      card.appendChild(title);
      card.appendChild(facts);
      card.appendChild(reason);
      card.appendChild(button);
      block.root.appendChild(card);
      block.continueEl = card;
      block.continueFacts = facts;
      block.continueReason = reason;
      block.continueButton = button;
    }
    block.recovery = recovery;
    const busy = state.continuingTaskId === recovery.taskId;
    block.continueButton.textContent = busy ? '正在继续' : '继续';
    block.continueButton.disabled = busy || state.running || recovery.canContinue !== true;
    const unknown = (recovery.unknownResults || []).length;
    block.continueFacts.textContent = [
      `原目标：${recovery.originalGoal || '原目标不可用'}`,
      `已记录步骤：${(recovery.confirmedSteps || []).join('；') || '无'}`,
      `修改路径：${(recovery.changedPaths || []).join('、') || '未记录'}`,
      `验证：${recovery.verification === 'historical_verified' ? '历史检查已记录，继续后需重新验证' : '未验证'}`,
      unknown ? `${unknown} 项副作用结果未知，将先核查当前事实。` : '新轮重新核查当前事实。',
    ].join('\n');
    block.continueReason.textContent = block.continueError || (recovery.blockedReason
      ? `当前不能继续：${recovery.blockedReason}` : '继续会创建一个新轮次；旧工具与批准不会重放。');
  }

  function renderTurnDropped(block, released, remaining) {
    if (!released) {
      if (block.releasedEl) { block.releasedEl.remove(); block.releasedEl = null; }
      return;
    }
    if (!block.releasedEl) {
      block.releasedEl = document.createElement('p');
      block.releasedEl.className = 'legacy-note';
      block.progressEl.insertBefore(block.releasedEl, block.progressEl.firstChild);
    }
    block.releasedEl.textContent = `本轮较早的 ${released} 条过程已从界面释放，下方只显示最近 ${remaining} 条。`;
  }

  function updateTurnBlock(block, fact, events, released = 0) {
    let expanded = null;
    // Earlier pages can prepend events. Rebuild only the affected process block.
    if (block.renderedIds.some((id, index) => !events[index] || events[index].eventId !== id)) {
      expanded = new Set(Array.from(block.progressEl.querySelectorAll('details[open]')).map(node => node.dataset.eventId));
      block.progressEl.textContent = '';
      block.renderedEvents = 0;
      block.renderedIds = [];
      block.pendingItems = new Map();
      block.groupEl = null;
      block.groupItemsEl = null;
      block.groupCount = 0;
      block.legacyEl = null;
      block.releasedEl = null;
    }
    if (fact) {
      if (fact.requestPrompt) block.requestBody.textContent = clampText(fact.requestPrompt, NOTE_LIMIT);
      if (fact.createdAt) block.requestTime.textContent = new Date(fact.createdAt).toLocaleString();
    }
    // 仅使用同轮事件；缺失、无效或反向时间不能以 updatedAt 或当前时钟补算。
    const turnId = block.root.dataset.turnId;
    const started = events.find((event) => event.turnId === turnId && event.type === 'turn_started');
    const ended = started && events.find((event) => event.turnId === turnId && event.eventId > started.eventId
      && (event.type === 'turn_completed' || event.type === 'turn_failed'));
    const duration = ended ? Date.parse(ended.timestamp) - Date.parse(started.timestamp) : NaN;
    block.requestDuration.textContent = Number.isFinite(duration) && duration >= 0
      ? `耗时 ${Math.floor(duration / 1000)} 秒` : '';
    for (; block.renderedEvents < events.length; block.renderedEvents += 1) {
      appendEventNode(block, events[block.renderedEvents]);
      block.renderedIds.push(events[block.renderedEvents].eventId);
    }
    if (expanded) block.progressEl.querySelectorAll('details').forEach(node => {
      if (expanded.has(node.dataset.eventId)) node.open = true;
    });
    renderTurnDropped(block, released, events.length);
    if (events.length && block.legacyEl) { block.legacyEl.remove(); block.legacyEl = null; }
    const terminal = (fact && TERMINAL_OUTCOMES.has(fact.outcome))
      || events.some((event) => event.type === 'turn_completed' || event.type === 'turn_failed');
    if (terminal) {
      block.pendingItems.forEach((item) => {
        settleItem(item);
        item.tag.className = 'status-tag interrupted';
        item.tag.textContent = '结果未确认';
      });
      block.pendingItems = new Map();
      closeActivityGroup(block);
      // A9-19 P05：轮次结束后把运行中自动展开的工具活动折叠为摘要行（用户手动展开的不动）。
      block.progressEl.querySelectorAll('details').forEach((node) => {
        if (node.dataset.autoOpened === 'true') { node.open = false; delete node.dataset.autoOpened; }
      });
    }
    renderLivePreview(block, terminal);
    if (!block.local && !block.legacyEl && events.length === 0 && released === 0
      && fact && TERMINAL_OUTCOMES.has(fact.outcome)) {
      const note = document.createElement('p');
      note.className = 'legacy-note';
      note.textContent = '历史记录未包含过程。';
      block.progressEl.appendChild(note);
      block.legacyEl = note;
    }
    updateOutcomeCard(block, fact, events);
    const deliveryTurn = fact && resolveTurnId(fact);
    if (deliveryTurn && state.snapshot && state.snapshot.scope) {
      if (!block.deliveryEl || block.deliveryEl.dataset.turnId !== deliveryTurn) {
        if (block.deliveryEl) block.deliveryEl.remove();
        block.deliveryEl = buildDeliveryCard(state.snapshot.activeConversationId, deliveryTurn, false, fact.outcome);
        block.root.appendChild(block.deliveryEl);
      }
      if (typeof block.deliveryEl.syncDeliveryActions === 'function') block.deliveryEl.syncDeliveryActions();
      const stamp = `${fact.outcome}:${fact.updatedAt}:${state.eventMaxId}:${state.reviewEpoch}`;
      const card = block.deliveryEl;
      if (card.dataset.stamp !== stamp) {
        card.dataset.stamp = stamp; card.deliveryStale = true;
        if (card.open && !state.browse) void card.loadDelivery();
      }
    }
  }

  function updateSummaryForTurn(turnId) {
    const review = state.reviewCache.get(turnId);
    const fact = ((state.snapshot && state.snapshot.conversation) || []).find((item) => item.turnId === turnId);
    const block = fact && state.streamDom.get(fact.taskId);
    if (!block || !TERMINAL_OUTCOMES.has(fact.outcome)) return;
    const changed = review && (review.files || []).length + (review.unrecoverable || []).length;
    if (!changed) {
      if (block.summaryEl) { block.summaryEl.remove(); block.summaryEl = null; }
      return;
    }
    if (!block.summaryEl) {
      block.summaryEl = document.createElement('div');
      block.summaryEl.className = 'change-summary';
      block.summaryEl.dataset.turnId = turnId;
      block.root.appendChild(block.summaryEl);
    }
    const card = block.summaryEl;
    card.textContent = '';
    const counts = reviewCounts(review);
    const number = turnNumber(turnId);
    const title = document.createElement('strong');
    title.textContent = `${number === null ? '本轮' : `第 ${number} 轮`}改动了 ${changed} 个文件 · +${counts.additions} −${counts.deletions}`;
    card.appendChild(title);
    const open = document.createElement('button');
    open.type = 'button';
    open.textContent = '审阅';
    open.setAttribute('aria-label', `审阅 ${number === null ? turnId : `第 ${number} 轮`}的改动`);
    open.addEventListener('click', () => { void showDiff(turnId); });
    card.appendChild(open);
    const chips = document.createElement('div');
    chips.className = 'change-summary-files';
    (review.files || []).forEach((file) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = `change-summary-file${file.undone ? ' undone' : ''}`;
      chip.textContent = file.path;
      chip.setAttribute('aria-label', `审阅 ${file.path}`);
      chip.addEventListener('click', () => { void showDiff(turnId, file.path); });
      chips.appendChild(chip);
    });
    (review.unrecoverable || []).forEach((change) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'change-summary-file unrecoverable';
      chip.textContent = `${change.path}（无法撤销）`;
      chip.addEventListener('click', () => { void showDiff(turnId); });
      chips.appendChild(chip);
    });
    card.appendChild(chips);
  }

  function pumpSummaryQueue() {
    if (state.browse) return;
    while (state.summaryActive < 2 && state.summaryQueue.length) {
      const task = state.summaryQueue.shift();
      state.summaryActive += 1;
      void getReview(task.turnId).then((response) => {
        if (response && response.ok !== true) throw response;
      }).catch((error) => {
        state.checkpointError = errorMessage(error, '改动摘要读取失败，请重试。');
        if (state.snapshot) renderCheckpoints(state.snapshot);
      }).finally(() => {
        state.summaryActive -= 1;
        state.summaryQueued.delete(task.turnId);
        pumpSummaryQueue();
      });
    }
  }

  function loadRecentSummaries(snapshot) {
    if (state.browse) return;
    if (typeof orderedCheckpoints !== 'function') return;
    const known = new Set(orderedCheckpoints().map((checkpoint) => checkpoint.turnId));
    const facts = (snapshot.conversation || []).filter((fact) =>
      fact.turnId && TERMINAL_OUTCOMES.has(fact.outcome) && known.has(fact.turnId)).slice(-10);
    facts.forEach((fact) => {
      if (state.reviewCache.has(fact.turnId)) updateSummaryForTurn(fact.turnId);
      else if (!state.summaryQueued.has(fact.turnId)) {
        state.summaryQueued.add(fact.turnId);
        state.summaryQueue.push({ turnId: fact.turnId });
      }
    });
    pumpSummaryQueue();
  }

  /**
   * A9-19 P02（ADR-0135）：模型流式输出的内存预览。只来自快照 liveModelPreview（运行时已累积脱敏并
   * 保留尾部），不入事件、不落盘；轮次终态或预览消失即移除，由持久化的最终文本接替。
   */
  function renderLivePreview(block, terminal) {
    const preview = state.liveModelPreview;
    const turnId = block.local ? state.activeTurnId : block.root.dataset.turnId;
    const show = !terminal && preview && preview.text && turnId && preview.turnId === turnId;
    if (!show) {
      if (block.previewEl) { block.previewEl.remove(); block.previewEl = null; block.previewBodyEl = null; }
      return;
    }
    if (!block.previewEl) {
      const node = document.createElement('div');
      node.className = 'live-preview';
      node.setAttribute('aria-live', 'off');
      const label = document.createElement('span');
      label.className = 'live-preview-label';
      label.textContent = '模型正在输出';
      const body = document.createElement('p');
      body.className = 'live-preview-body';
      node.appendChild(label);
      node.appendChild(body);
      block.previewEl = node;
      block.previewBodyEl = body;
    }
    block.previewBodyEl.textContent = clampText(preview.text, NOTE_LIMIT);
    // 预览始终位于本轮过程的最后；新事件节点追加后把它移回末尾。
    block.previewEl.remove();
    block.progressEl.appendChild(block.previewEl);
  }

  function renderConversation(snapshot) {
    const facts = snapshot.conversation || [];
    const signature = JSON.stringify([
      snapshot.activeConversationId,
      state.eventMaxId,
      state.eventsLoading,
      state.continuingTaskId,
      snapshot.recoveryTasks || [],
      state.eventsError,
      state.eventsTruncated,
      state.releasedEventCount,
      state.inspectorEvents.size >= EVENT_GLOBAL_LIMIT,
      state.localRequest ? [state.localRequest.prompt, state.localRequest.at] : 0,
      state.liveModelPreview ? [state.liveModelPreview.turnId, String(state.liveModelPreview.text || '').length, state.liveModelPreview.updatedAt] : 0,
      facts.map((fact) => [
        fact.taskId, fact.turnId, fact.outcome, fact.updatedAt,
        String(fact.requestPrompt || '').length, String(fact.finalMessage || '').length,
      ]),
    ]);
    if (state.conversationSignature === signature) { loadRecentSummaries(snapshot); return; }
    state.conversationSignature = signature;
    if (state.renderedConversationId !== snapshot.activeConversationId) {
      state.renderedConversationId = snapshot.activeConversationId;
      resetConversationEvents();
    }
    const stream = el('a9-task-stream');
    if (state.localRequest) {
      const latest = facts.length > 0 ? facts[facts.length - 1] : null;
      if (latest && latest.requestPrompt === state.localRequest.prompt) state.localRequest = null;
    }
    let latestProjection = null;
    facts.forEach((fact) => {
      const block = ensureTurnBlock(fact.taskId || `fact:${facts.indexOf(fact)}`);
      const turnId = resolveTurnId(fact);
      block.root.dataset.turnId = turnId || '';
      const bucket = turnId ? state.turnEvents.get(turnId) : null;
      const events = bucket ? bucket.events : [];
      updateTurnBlock(block, fact, events, bucket ? bucket.released || 0 : 0);
      updateContinuationCard(block, (snapshot.recoveryTasks || []).find((recovery) => recovery.taskId === fact.taskId));
      latestProjection = projectOutcome(fact, events);
    });
    if (state.localRequest) {
      const block = ensureTurnBlock('__local__');
      block.requestBody.textContent = clampText(state.localRequest.prompt, NOTE_LIMIT);
      block.requestTime.textContent = new Date(state.localRequest.at).toLocaleTimeString();
      const bucket = state.activeTurnId ? state.turnEvents.get(state.activeTurnId) : null;
      const events = bucket ? bucket.events : [];
      block.root.dataset.turnId = state.activeTurnId || '';
      updateTurnBlock(block, null, events, bucket ? bucket.released || 0 : 0);
      latestProjection = projectOutcome(null, events) || latestProjection;
    } else if (state.streamDom.has('__local__')) {
      state.streamDom.get('__local__').root.remove();
      state.streamDom.delete('__local__');
    }
    text('a9-turn-outcome', latestProjection
      ? `${latestProjection.outcome} · ${latestProjection.verification}`
      : '');
    const atEventCap = state.inspectorEvents.size >= EVENT_GLOBAL_LIMIT;
    if (state.releasedEventCount || state.eventsTruncated || state.eventsError || atEventCap) {
      if (!state.truncatedNote || !state.truncatedNote.parentNode) {
        const note = document.createElement('p');
        note.className = 'legacy-note';
        stream.insertBefore(note, stream.firstChild);
        state.truncatedNote = note;
      }
      if (state.eventsError) {
        state.truncatedNote.setAttribute('role', 'alert');
        state.truncatedNote.dataset.historyError = 'true';
      } else if (state.truncatedNote.dataset.historyError === 'true') {
        state.truncatedNote.removeAttribute('role');
        delete state.truncatedNote.dataset.historyError;
      }
      const releasedNote = state.releasedEventCount
        ? `为控制内存，界面已释放最早的 ${state.releasedEventCount} 条过程记录（本地记录完整保存）。` : '';
      const historyNote = state.eventsError || (state.eventsTruncated && !atEventCap ? '还有更早的过程记录。' : '');
      const capNote = atEventCap ? ` 已达界面上限 ${EVENT_GLOBAL_LIMIT} 条，更早记录不再加载。` : '';
      state.truncatedNote.textContent = `${releasedNote}${historyNote ? `${releasedNote ? ' ' : ''}${historyNote}` : ''}${capNote}`;
      if (!atEventCap && (state.eventsTruncated || state.eventsError)) {
        const load = document.createElement('button');
        load.type = 'button';
        load.textContent = state.eventsError ? '重试加载' : '加载更早记录';
        load.disabled = state.eventsLoading;
        load.addEventListener('click', () => { void loadConversationEvents(Boolean(state.eventsBeforeId)); });
        state.truncatedNote.appendChild(load);
      }
    } else if (state.truncatedNote) {
      state.truncatedNote.remove();
      state.truncatedNote = null;
    }
    if (state.eventsStatusNote) state.eventsStatusNote.remove();
    state.eventsStatusNote = null;
    if (state.eventsLoading) {
      const status = document.createElement('p');
      status.setAttribute('role', 'status');
      status.textContent = '正在加载过程记录…';
      stream.insertBefore(status, stream.firstChild);
      state.eventsStatusNote = status;
    }
    el('a9-empty-state').hidden = facts.length > 0 || Boolean(state.localRequest);
    loadRecentSummaries(snapshot);
    if (state.streamFollow) scrollToLatest();
  }

  // ------------------------------------------------------------------
  // 等待反馈：本地 1s 计时；距最近事件 >10s 时显示等待对象与真实时长。
  // ------------------------------------------------------------------

  function startLiveTracking() {
    state.turnStartAt = Date.now();
    state.lastEventAt = Date.now();
    if (!state.liveTimer) state.liveTimer = root.setInterval(tickLiveStatus, 1000);
    tickLiveStatus();
  }

  function stopLiveTracking() {
    if (state.liveTimer) {
      root.clearInterval(state.liveTimer);
      state.liveTimer = null;
    }
    const node = el('live-status');
    if (node) {
      node.hidden = true;
      node.classList.remove('active');
    }
    state.pendingToolLabel = null;
    state.pendingToolAt = 0;
    state.liveModelPreview = null;
  }

  function tickLiveStatus() {
    const node = el('live-status');
    if (!node) return;
    if (!state.running) {
      node.hidden = true;
      node.classList.remove('active');
      return;
    }
    const now = Date.now();
    const idleMs = now - (state.lastEventAt || now);
    // A9-19 P04：从 0 秒起就说明在等什么；空闲 ≥10s 只追加强调样式。
    node.classList.toggle('active', idleMs >= 10000);
    if (state.pendingToolLabel) {
      text('live-label', `正在执行工具：${state.pendingToolLabel}`);
      text('live-elapsed', `已运行 ${formatElapsed(now - (state.pendingToolAt || state.lastEventAt || now))}`);
    } else if (state.liveModelPreview) {
      text('live-label', '模型正在输出…');
      text('live-elapsed', `本轮已运行 ${formatElapsed(now - (state.turnStartAt || now))}`);
    } else {
      text('live-label', '等待模型响应…');
      text('live-elapsed', `已等待 ${formatElapsed(idleMs)}`);
    }
    tickRunningItems();
    node.hidden = false;
    const jump = el('jump-latest');
    if (jump) jump.hidden = state.streamFollow;
  }

  function scrollToLatest() {
    const conversation = el('conversation');
    if (conversation) conversation.scrollTop = conversation.scrollHeight;
  }

  // ------------------------------------------------------------------
  // Inspector 与目录渲染。
  // ------------------------------------------------------------------

  // ADR-0120：Inspector 有界显示范围保持既有规则不变（当前会话按 eventId 升序的最后 60 行，
  // 规则名 LAST_60_BY_EVENT_ID_ASC）。仅为每行增加稳定身份属性，供正式验收按范围逐行核对。
  function renderTimeline() {
    const timeline = el('a9-timeline');
    timeline.textContent = '';
    const filePaths = new Set();
    let rawOutput = '';
    const visible = eventsForInspector().slice(-60);
    const emptyText = (subject) => state.eventsError
      ? `${state.eventsError}点击刷新可重试。`
      : state.eventsLoading ? `${subject}正在读取…`
        : !state.eventsLoaded && !visible.length ? `${subject}尚未读取，点击刷新。`
          : `已加载记录中没有${subject}项。`;
    text('activity-empty', visible.length ? (state.eventsError || '') : emptyText('活动'));
    text('file-empty', emptyText('文件'));
    timeline.dataset.displayRule = 'LAST_60_BY_EVENT_ID_ASC';
    timeline.dataset.displayRows = String(visible.length);
    visible.forEach((event) => {
      const data = event.data || {};
      const shell = data.shell && data.shell.schemaVersion === 1 ? data.shell : null;
      const item = document.createElement('li');
      const stamp = event.timestamp ? new Date(event.timestamp).toLocaleTimeString() : '';
      item.textContent = stamp ? `${stamp} · ${timelineEntryLabel(event)}` : timelineEntryLabel(event);
      item.dataset.eventId = String(event.eventId);
      item.dataset.eventType = event.type;
      if (event.turnId) item.dataset.turnId = String(event.turnId);
      timeline.appendChild(item);
      [data.path, data.relativePath, data.targetPath].filter(Boolean).forEach((value) => filePaths.add(String(value)));
      [shell && shell.stdout, shell && shell.stderr].filter((value) => typeof value === 'string').forEach((value) => { rawOutput += value; });
      if (shell && shell.truncated) rawOutput += '\n[输出预览已截断；完整字节见日志路径]\n';
    });
    text('file-count', filePaths.size);
    const fileList = el('file-activity');
    fileList.textContent = '';
    filePaths.forEach((filePath) => {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = filePath;
      button.addEventListener('click', () => { void openWorkspaceFile(filePath); });
      item.appendChild(button);
      fileList.appendChild(item);
    });
    el('file-empty').hidden = filePaths.size > 0;
    text('a9-shell-output', rawOutput ? rawOutput.slice(-64 * 1024) : emptyText('工具输出'));
  }

  function checkpointKey(checkpoint) { return `${checkpoint.createdAt}\u0000${checkpoint.turnId}`; }
  function orderedCheckpoints() {
    return Array.from(state.checkpointKnown.values()).sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt) || b.turnId.localeCompare(a.turnId));
  }

  function turnNumber(turnId) {
    if (state.conversationPage && state.conversationPage.hasMore) return null;
    const facts = (state.snapshot && state.snapshot.conversation) || [];
    const index = facts.findIndex((fact) => fact.turnId === turnId);
    return index < 0 ? null : index + 1;
  }

  function reviewCounts(review) {
    return (review.files || []).reduce((count, file) => ({
      additions: count.additions + (file.additions || 0),
      deletions: count.deletions + (file.deletions || 0),
      remaining: count.remaining + (file.undone ? 0 : 1),
    }), { additions: 0, deletions: 0, remaining: 0 });
  }

  function reviewActionLabel(file) {
    if (file.originalKind === 'directory' || file.newKind === 'directory') return '目录';
    return ({ create: '新建', modify: '修改', delete: '删除' })[file.action] || '改动';
  }

  function appendReviewFiles(item, turnId, review) {
    if (!review || state.reviewOpenTurn !== turnId) return;
    const files = document.createElement('div');
    files.className = 'review-files';
    (review.files || []).forEach((file, index) => {
      const row = document.createElement('div');
      row.className = `review-file${file.undone ? ' undone' : ''}`;
      const fileId = `review-file-${index}-${String(turnId).replace(/[^a-zA-Z0-9_-]/g, '-')}`;
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'review-file-toggle';
      const isTarget = (request) => request && request.turnId === turnId
        && (request.kind === 'turn' || request.path === file.path);
      toggle.textContent = `${reviewActionLabel(file)} · ${file.path} · +${file.additions} −${file.deletions} · ${file.undone ? '已撤销' : isTarget(state.undoInFlight) ? '正在撤销' : isTarget(state.pendingUndo) ? '即将撤销' : '未撤销'}`;
      toggle.setAttribute('aria-label', `查看 ${file.path} 的改动`);
      toggle.setAttribute('aria-expanded', String(state.reviewOpenFile === file.path));
      toggle.setAttribute('aria-controls', fileId);
      toggle.addEventListener('click', () => {
        state.reviewOpenFile = state.reviewOpenFile === file.path ? null : file.path;
        renderCheckpoints(state.snapshot);
      });
      row.appendChild(toggle);
      const detail = document.createElement('div');
      detail.id = fileId;
      detail.className = 'review-file-detail';
      detail.hidden = state.reviewOpenFile !== file.path;
      if (!detail.hidden) {
        const diff = document.createElement('pre');
        diff.className = 'review-file-diff';
        diff.textContent = file.diffText || '目录或二进制改动无文本 Diff。';
        detail.appendChild(diff);
        if (file.diffTruncated) {
          const note = document.createElement('p');
          note.textContent = 'Diff 预览已截断；请在文件视图核对完整内容。';
          detail.appendChild(note);
        }
        const undo = document.createElement('button');
        undo.type = 'button';
        undo.textContent = '撤销此文件';
        undo.disabled = file.undone || Boolean(state.pendingUndo || state.undoInFlight);
        undo.setAttribute('aria-label', `撤销 ${file.path}`);
        undo.addEventListener('click', () => queueUndo('file', turnId, file.path));
        detail.appendChild(undo);
      }
      row.appendChild(detail);
      const result = state.reviewMessages.get(`${turnId}\u0000${file.path}`);
      if (result) {
        const message = document.createElement('p');
        message.className = 'review-file-result';
        message.textContent = result;
        row.appendChild(message);
      }
      files.appendChild(row);
    });
    (review.unrecoverable || []).forEach((change) => {
      const warning = document.createElement('p');
      warning.className = 'review-unrecoverable';
      const reasonByCode = { too_large: '超过备份上限（单文件 2 MiB），轮前未保存原内容',
        outside: '位于工作区外，轮前未保存原内容', backup_failed: '备份失败，轮前未保存原内容' };
      const fallbackReason = ({ outside: '位于工作区外', too_large: '超过备份上限', backup_failed: '备份失败',
        created: '缺少可恢复基线', modified: '缺少原始内容', deleted: '缺少原始内容', renamed: '无法确定原始路径' })[change.kind]
        || '恢复依据不足';
      const parsedCode = /（([a-z_]+)）/.exec(String(change.reason || ''))?.[1];
      const reasonCode = reasonByCode[change.reasonCode] ? change.reasonCode : parsedCode;
      const reason = reasonByCode[reasonCode] || fallbackReason;
      const detail = reasonByCode[reasonCode] ? '' : String(change.reason || '').replace(/（[a-z_]+）/g, '');
      warning.textContent = `命令产生 · 无法撤销 · ${change.path}：${reason}${detail ? `（${detail}）` : ''}`;
      files.appendChild(warning);
    });
    if (state.reviewConfirmation && state.reviewConfirmation.turnId === turnId) {
      const confirm = document.createElement('div');
      confirm.className = 'review-confirmation';
      const message = document.createElement('p');
      message.textContent = '已重新收集命令后的当前状态。请先查看改动，再确认撤销；确认仅对这次请求有效。';
      confirm.appendChild(message);
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = '确认撤销';
      button.disabled = Boolean(state.undoInFlight);
      button.setAttribute('aria-label', `确认撤销 ${state.reviewConfirmation.path || '本轮全部改动'}`);
      button.addEventListener('click', () => { void executeUndo(state.reviewConfirmation); });
      confirm.appendChild(button);
      files.appendChild(confirm);
    }
    if (state.pendingUndo && state.pendingUndo.turnId === turnId) {
      const pending = document.createElement('div');
      pending.className = 'review-pending';
      pending.setAttribute('aria-live', 'polite');
      const countdown = document.createElement('span');
      countdown.textContent = `将在 ${Math.max(1, Math.ceil((state.pendingUndo.deadline - Date.now()) / 1000))} 秒后撤销。`;
      state.pendingUndo.countdownNode = countdown;
      pending.appendChild(countdown);
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.textContent = '撤回';
      cancel.addEventListener('click', cancelPendingUndo);
      pending.appendChild(cancel);
      files.appendChild(pending);
    }
    item.appendChild(files);
  }

  function renderCheckpoints(snapshot) {
    const previous = orderedCheckpoints();
    const oldestVisible = previous[state.checkpointVisible - 1];
    for (const checkpoint of snapshot.checkpoints || []) state.checkpointKnown.set(checkpointKey(checkpoint), checkpoint);
    const checkpoints = orderedCheckpoints();
    if (oldestVisible && state.checkpointVisible > 10) {
      const oldIndex = checkpoints.findIndex((checkpoint) => checkpointKey(checkpoint) === checkpointKey(oldestVisible));
      if (oldIndex >= 0) state.checkpointVisible = Math.max(state.checkpointVisible, oldIndex + 1);
    }
    const total = Number.isSafeInteger(snapshot.checkpointsTotal) ? snapshot.checkpointsTotal : checkpoints.length;
    const shown = Math.min(state.checkpointVisible, checkpoints.length);
    text('a9-checkpoint-count', shown < total ? `最近 ${shown} / 共 ${total}` : `共 ${total}`);
    text('a9-interruptions', (snapshot.interruptions || []).map((item) => `${item.kind}:${item.id}`).join(', ') || '无');
    const list = el('a9-checkpoint-list');
    list.textContent = '';
    checkpoints.slice(0, shown).forEach((checkpoint) => {
      const item = document.createElement('li');
      item.className = 'checkpoint-row';
      const identity = document.createElement('code');
      identity.className = 'checkpoint-id';
      identity.textContent = String(checkpoint.turnId);
      identity.title = String(checkpoint.turnId);
      const actions = document.createElement('div');
      actions.className = 'checkpoint-actions';
      const diff = document.createElement('button');
      diff.type = 'button';
      diff.textContent = '查看改动';
      diff.setAttribute('aria-label', `查看 ${checkpoint.turnId} Diff`);
      diff.addEventListener('click', () => { void showDiff(checkpoint.turnId); });
      const undo = document.createElement('button');
      undo.type = 'button';
      undo.textContent = '撤销本轮全部';
      undo.setAttribute('aria-label', `撤销 ${checkpoint.turnId}`);
      undo.disabled = Boolean(state.pendingUndo || state.undoInFlight);
      undo.addEventListener('click', () => queueUndo('turn', checkpoint.turnId));
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.textContent = '复制 ID';
      copy.setAttribute('aria-label', `复制完整 Turn ID ${checkpoint.turnId}`);
      copy.addEventListener('click', () => {
        const copied = copyText(String(checkpoint.turnId));
        copy.textContent = copied ? '已复制' : '复制失败';
      });
      actions.appendChild(diff);
      actions.appendChild(undo);
      actions.appendChild(copy);
      item.appendChild(identity);
      item.appendChild(actions);
      const review = state.reviewCache.get(checkpoint.turnId);
      const counts = review ? reviewCounts(review) : null;
      const heading = document.createElement('div');
      heading.className = 'review-turn-heading';
      heading.textContent = `${turnNumber(checkpoint.turnId) === null ? '更早的轮次' : `第 ${turnNumber(checkpoint.turnId)} 轮`}${counts ? ` · +${counts.additions} −${counts.deletions} · ${counts.remaining} 个文件未撤销` : ''}`;
      item.appendChild(heading);
      appendReviewFiles(item, checkpoint.turnId, review);
      list.appendChild(item);
    });
    if (state.checkpointError) {
      const error = document.createElement('li');
      error.textContent = state.checkpointError;
      list.appendChild(error);
    } else if (!total) {
      const empty = document.createElement('li');
      empty.textContent = Array.isArray(snapshot.checkpoints)
        ? '没有改动记录项。' : '改动记录尚未读取，点击刷新。';
      list.appendChild(empty);
    }
    if (shown < total) {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.disabled = state.checkpointLoading;
      button.textContent = state.checkpointLoading ? '加载中…' : `加载更早的 ${Math.min(20, total - shown)} 条（还有 ${total - shown} 条）`;
      button.addEventListener('click', () => { void loadOlderCheckpoints(); });
      item.appendChild(button);
      list.appendChild(item);
    }
  }

  async function loadOlderCheckpoints() {
    if (state.checkpointLoading || !state.snapshot) return;
    const snapshot = state.snapshot;
    const total = Number.isSafeInteger(snapshot.checkpointsTotal) ? snapshot.checkpointsTotal : state.checkpointKnown.size;
    const target = Math.min(total, state.checkpointVisible + 20);
    state.checkpointError = '';
    if (state.checkpointKnown.size >= target) {
      state.checkpointVisible = target;
      renderCheckpoints(snapshot);
      return;
    }
    const known = orderedCheckpoints();
    const oldest = known[known.length - 1];
    if (!oldest) return;
    const generation = state.checkpointGeneration;
    const conversationId = state.activeConversationId;
    state.checkpointLoading = true;
    renderCheckpoints(snapshot);
    try {
      const response = await a9.listCheckpoints({ conversationId, before: { createdAt: oldest.createdAt, turnId: oldest.turnId }, limit: 20 });
      if (generation !== state.checkpointGeneration) return;
      if (!response || response.ok !== true || response.conversationId !== conversationId) {
        state.checkpointError = errorMessage(response, 'checkpoint 加载失败，请重试。');
        return;
      }
      for (const checkpoint of response.checkpoints || []) state.checkpointKnown.set(checkpointKey(checkpoint), checkpoint);
      state.checkpointVisible = Math.min(target, state.checkpointKnown.size);
    } catch (error) {
      if (generation === state.checkpointGeneration) state.checkpointError = errorMessage(error, 'checkpoint 加载失败，请重试。');
    } finally {
      if (generation === state.checkpointGeneration) {
        state.checkpointLoading = false;
        renderCheckpoints(state.snapshot);
      }
    }
  }

  function conversationStatusLabel(activity) {
    if (activity === 'running') return '运行中';
    if (activity === 'cancelling') return '正在停止';
    if (activity === 'needs_approval') return '待审批';
    if (activity === 'needs_input') return '待回答';
    if (activity === 'failed') return '失败';
    if (activity === 'waiting_approval') return '待审批';
    if (activity === 'waiting_input') return '待回答';
    if (activity === 'interrupted') return '已中断';
    return '空闲';
  }

  /** A9-19 L01：行内时间用短格式（刚刚 / HH:mm / M月D日），给标题让出宽度；完整时间放在无障碍名称里。 */
  function shortConversationTime(value) {
    const date = new Date(value);
    if (!value || Number.isNaN(date.getTime())) return '';
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    if (diff >= 0 && diff < 60 * 1000) return '刚刚';
    const pad = (n) => String(n).padStart(2, '0');
    if (date.toDateString() === now.toDateString()) return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
    if (date.getFullYear() === now.getFullYear()) return `${date.getMonth() + 1}月${date.getDate()}日`;
    return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
  }

  // A9-52 收件箱：所有驻留工作区的对话混排。顺序为置顶 → 活跃 → 已结束（默认折叠）。
  // A9-54 §3.4（ADR-0321）：分组只由保存的时间戳现算。已结束 = 未置顶、无实时状态，且手动结束
  // （settledAt 非空），或无草稿且距 lastActivityAt 满 7 天；其余未置顶对话都在活跃组。
  const LIVE_ACTIVITY = Object.freeze({ running: 'running', cancelling: 'cancelling', needs_approval: 'needs_approval',
    needs_input: 'needs_input', waiting_approval: 'needs_approval', waiting_input: 'needs_input', failed: 'failed', interrupted: 'interrupted' });
  const PIN_STORAGE_KEY = 'a9.pinnedConversations.v1';
  const INBOX_DAY_MS = 24 * 60 * 60 * 1000;
  const INBOX_AUTO_SETTLE_MS = 7 * INBOX_DAY_MS;
  const INBOX_ACTION_ERRORS = Object.freeze({
    A9_CONVERSATION_BUSY: '对话正在运行、待审批或待回答，暂不能结束。',
    A9_CONVERSATION_ARCHIVED: '对话已归档，请先恢复对话。',
    A9_SCOPE_STALE: '该工作区已关闭或正在关闭，请刷新后重试。',
    A9_SCOPE_INVALID: '对话与请求目标不一致，请刷新后重试。',
  });

  function inboxActivity(value) { return LIVE_ACTIVITY[value] || 'idle'; }

  /** 徽标：中文名取前两个字；拉丁名取首字母加第一个数字，否则取前两个词的首字母。 */
  function workspaceBadge(name) {
    const value = String(name || '').trim();
    if (!value) return '?';
    if (/^[㐀-鿿]/.test(value)) return Array.from(value).slice(0, 2).join('');
    const digit = (value.match(/\d/) || [])[0];
    if (digit) return (value[0] + digit).toUpperCase();
    const words = value.split(/[-_\s.]+/).filter(Boolean);
    return ((words[0] || value)[0] + (words[1] ? words[1][0] : (words[0] || value).slice(1, 2))).toUpperCase();
  }
  function workspaceColor(id) {
    let hash = 0;
    for (const char of String(id || '')) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    return `ws-c${hash % 6}`;
  }
  function workspaceBadgeNode(workspace) {
    const badge = document.createElement('span');
    badge.className = `ws-badge ${workspaceColor(workspace.workspaceId)}`;
    badge.setAttribute('aria-hidden', 'true');
    badge.textContent = workspaceBadge(workspace.displayName);
    return badge;
  }

  function readPinnedConversations() {
    try {
      const value = JSON.parse(root.localStorage.getItem(PIN_STORAGE_KEY) || '[]');
      return new Set(Array.isArray(value) ? value.filter((item) => typeof item === 'string').slice(0, 64) : []);
    } catch (_error) { return new Set(); }
  }
  function togglePinnedConversation(sessionId) {
    if (state.browse && browseBlocked('置顶对话')) return;
    if (!sessionId) return;
    const pinned = readPinnedConversations();
    if (pinned.has(sessionId)) pinned.delete(sessionId); else pinned.add(sessionId);
    try { root.localStorage.setItem(PIN_STORAGE_KEY, JSON.stringify(Array.from(pinned).slice(-64))); } catch (_error) { /* 偏好不可写时只影响置顶。 */ }
    if (state.snapshot) renderConversationDirectory(state.snapshot);
  }

  /** 把当前快照与工作区目录合成一张列表；当前对话的状态以运行时实时状态为准。 */
  function inboxConversations(snapshot) {
    const controls = snapshot.conversationControls || {};
    const currentId = (snapshot.scope && snapshot.scope.workspaceId) || 'current';
    const current = { workspaceId: currentId, workspaceRoot: snapshot.workspaceRoot || '', displayName: pathName(snapshot.workspaceRoot) || '当前工作区', workdir: snapshot.workdir };
    const items = [];
    // ADR-0322：结束、恢复、记录查看按行自己的工作区组成 scope；当前工作区没有 scope 时不提供这些动作。
    const currentScopeId = snapshot.scope && snapshot.scope.workspaceId ? snapshot.scope.workspaceId : null;
    const add = (workspace, conversation, live, activeId, canSwitch, isCurrent) => {
      const bound = conversation.sessionId === activeId;
      const viewed = isCurrent && bound && !state.browse;
      const scopeWorkspaceId = isCurrent ? currentScopeId : workspace.workspaceId;
      items.push({
        key: `${workspace.workspaceId}:${conversation.sessionId}`,
        workspace, isCurrent, viewed, bound,
        sessionId: conversation.sessionId,
        title: conversation.title || '新对话',
        updatedAt: conversation.updatedAt,
        hasDraft: conversation.hasDraft === true,
        settledAt: conversation.settledAt || null,
        lastVisitedAt: conversation.lastVisitedAt || null,
        lastCompletedAt: conversation.lastCompletedAt || null,
        lastActivityAt: conversation.lastActivityAt || null,
        scope: scopeWorkspaceId && conversation.sessionId
          ? { workspaceId: scopeWorkspaceId, conversationId: conversation.sessionId } : null,
        activity: bound && live ? inboxActivity(live) : inboxActivity(conversation.activity),
        switchable: !viewed && (bound ? !isCurrent : canSwitch),
      });
    };
    (snapshot.conversations || []).filter((item) => item.state === 'active')
      .forEach((item) => add(current, item, snapshot.agentStatus, snapshot.activeConversationId, Boolean(controls.canSwitch), true));
    (snapshot.workspaces || []).filter((workspace) => workspace.opened && workspace.workspaceId !== currentId).forEach((workspace) => {
      (workspace.conversations || []).forEach((item) => add(workspace, item, workspace.status, workspace.activeConversationId, Boolean(workspace.canSwitch), false));
    });
    return items;
  }

  function inboxRank(item) {
    if (item.activity === 'needs_approval' || item.activity === 'needs_input') return 0;
    if (item.activity === 'failed' || item.activity === 'interrupted') return 1;
    if (item.activity === 'running' || item.activity === 'cancelling') return 2;
    if (item.unread) return 3;
    return 4;
  }

  function inboxTime(value) {
    const time = value ? Date.parse(value) : NaN;
    return Number.isFinite(time) ? time : null;
  }

  function classifyInbox(items, now = Date.now()) {
    const pinned = readPinnedConversations();
    for (const item of items) {
      const live = item.activity !== 'idle';
      const completedAt = inboxTime(item.lastCompletedAt);
      const visitedAt = inboxTime(item.lastVisitedAt);
      // “已完成”：最近一次成功完成晚于上次查看；从未查看视为最早。
      item.unread = !live && !item.viewed && completedAt !== null && completedAt > (visitedAt === null ? -Infinity : visitedAt);
      item.pinned = pinned.has(item.sessionId);
      const activityAt = inboxTime(item.lastActivityAt);
      // 正在查看等同于此刻查看：不因空闲自动折叠（手动结束除外），即使“记录查看”尚未回读到快照；
      // 离开后由保存的 lastVisitedAt 继续留在活跃组，直到手动结束或满 7 天。
      const idleFor = item.viewed ? 0 : activityAt === null ? null : now - activityAt;
      const autoSettle = !item.hasDraft && idleFor !== null && idleFor >= INBOX_AUTO_SETTLE_MS;
      const bucket = item.pinned ? 'pinned' : live ? 'active' : (item.settledAt || autoSettle) ? 'settled' : 'active';
      item.bucket = bucket;
      item.settleInDays = bucket === 'active' && !live && !item.hasDraft && !item.viewed && idleFor !== null
        ? Math.min(7, Math.max(1, Math.ceil((INBOX_AUTO_SETTLE_MS - idleFor) / INBOX_DAY_MS))) : null;
    }
    return items;
  }

  // 浏览器定时器的安全上限；更远的边界分段等待，每段到期重绘后重新计算。
  const INBOX_TIMER_MAX_MS = 2147483647;

  /**
   * 轮询停止时没有其他东西触发重绘：在活跃组中最早跨过 7 天边界的空闲行到期时重绘列表。
   * 全局只保留一个定时器；没有候选时不设。
   */
  function scheduleInboxSettleRedraw(items, now) {
    root.clearTimeout(state.inboxSettleTimer);
    state.inboxSettleTimer = null;
    let due = null;
    for (const item of items) {
      if (item.bucket !== 'active' || item.pinned || item.activity !== 'idle' || item.hasDraft || item.viewed) continue;
      const activityAt = inboxTime(item.lastActivityAt);
      if (activityAt === null) continue;
      const boundary = activityAt + INBOX_AUTO_SETTLE_MS;
      if (due === null || boundary < due) due = boundary;
    }
    if (due === null) return;
    const delay = Math.min(INBOX_TIMER_MAX_MS, Math.max(0, due - now));
    state.inboxSettleTimer = root.setTimeout(() => {
      state.inboxSettleTimer = null;
      if (state.snapshot) renderConversationDirectory(state.snapshot);
    }, delay);
  }

  /** 打开对话、或正在查看的对话运行完成时记录查看；失败只留诊断，不打断界面。 */
  function syncInboxVisit(items) {
    const viewed = items.find((item) => item.viewed);
    if (!viewed || !viewed.scope) {
      state.inboxVisitKey = null;
      state.inboxVisitCompletedAt = null;
      return;
    }
    const opened = state.inboxVisitKey !== viewed.key;
    const completedAt = inboxTime(viewed.lastCompletedAt);
    const visitedAt = inboxTime(viewed.lastVisitedAt);
    const completedUnseen = completedAt !== null && completedAt > (visitedAt === null ? -Infinity : visitedAt)
      && viewed.lastCompletedAt !== state.inboxVisitCompletedAt;
    state.inboxVisitKey = viewed.key;
    state.inboxVisitCompletedAt = viewed.lastCompletedAt;
    if (opened || completedUnseen) void recordInboxVisit(viewed.scope);
  }

  async function recordInboxVisit(scope) {
    const diagnostic = (code) => {
      state.inboxVisitDiagnostic = { code: String(code || 'A9_INBOX_VISIT_FAILED').slice(0, 100), conversationId: scope.conversationId, at: new Date().toISOString() };
      if (root.console && typeof root.console.warn === 'function') root.console.warn('A9_INBOX_VISIT_FAILED', state.inboxVisitDiagnostic.code);
    };
    try {
      const target = api && api.a9 && typeof api.a9.forScope === 'function' ? api.a9.forScope(scope) : null;
      if (!target || typeof target.visitConversation !== 'function') { diagnostic('A9_INBOX_VISIT_UNAVAILABLE'); return; }
      const response = await target.visitConversation(scope.conversationId);
      if (!response || response.ok !== true) diagnostic(response && response.error && response.error.code);
    } catch (error) {
      diagnostic(error && error.code);
    }
  }

  function inboxActionErrorText(response, label) {
    const code = response && response.error ? response.error.code : response && response.code;
    if (code && INBOX_ACTION_ERRORS[code]) return INBOX_ACTION_ERRORS[code];
    return `${label}失败${code ? `（${String(code).slice(0, 60)}）` : ''}，请刷新后重试。`;
  }

  /** ADR-0322：结束与恢复按该行自己的 scope 调用；scope.conversationId 与参数一致。 */
  async function runInboxAction(action, item) {
    const label = action === 'settle' ? '结束对话' : '恢复到活跃';
    if (state.browse && browseBlocked(label)) return null;
    if (!item.scope || state.inboxActionBusy) return null;
    state.inboxActionBusy = item.key;
    state.inboxActionError = null;
    if (state.snapshot) renderConversationDirectory(state.snapshot);
    let response = null;
    try {
      const target = api && api.a9 && typeof api.a9.forScope === 'function' ? api.a9.forScope(item.scope) : null;
      const method = action === 'settle' ? 'settleConversation' : 'reopenConversation';
      if (!target || typeof target[method] !== 'function') response = { ok: false, error: { code: 'A9_INBOX_ACTION_UNAVAILABLE' } };
      else response = await target[method](item.scope.conversationId);
      if (!response || response.ok !== true) state.inboxActionError = { key: item.key, message: inboxActionErrorText(response, label) };
    } catch (error) {
      state.inboxActionError = { key: item.key, message: inboxActionErrorText(error, label) };
    } finally {
      state.inboxActionBusy = null;
      await refreshSnapshot();
      if (state.snapshot) renderConversationDirectory(state.snapshot);
    }
    return response;
  }

  function inboxStatus(item) {
    if (item.activity === 'running') return { text: '运行中', kind: 'running' };
    if (item.activity === 'cancelling') return { text: '正在停止', kind: 'running' };
    if (item.activity === 'needs_approval') return { text: '待审批', kind: 'attention' };
    if (item.activity === 'needs_input') return { text: '待回答', kind: 'attention' };
    if (item.activity === 'interrupted') return { text: '已中断', kind: 'error' };
    if (item.activity === 'failed') return { text: '失败', kind: 'error' };
    if (item.unread) return { text: '已完成', kind: 'unread' };
    return null;
  }

  function appendConversationGroup(list, label, items, snapshot, collapsible) {
    if (!items.length && label !== '活跃') return;
    const head = document.createElement('li');
    head.className = 'conversation-group-head';
    const name = document.createElement('span');
    name.textContent = label;
    const count = document.createElement('span');
    count.textContent = String(items.length);
    if (collapsible) {
      const open = state.inboxSettledOpen === true || Boolean(state.searchQuery);
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'conversation-group-toggle';
      toggle.setAttribute('aria-expanded', String(open));
      toggle.appendChild(name);
      toggle.appendChild(count);
      toggle.addEventListener('click', () => {
        state.inboxSettledOpen = !open;
        renderConversationDirectory(state.snapshot);
      });
      head.appendChild(toggle);
      list.appendChild(head);
      if (!open) return;
    } else {
      head.appendChild(name);
      head.appendChild(count);
      list.appendChild(head);
    }
    if (!items.length) {
      const empty = document.createElement('li');
      empty.className = 'conversation-empty-note';
      empty.textContent = '没有需要关注的对话。';
      list.appendChild(empty);
    }
    items.forEach((item) => appendConversationRow(list, item, snapshot, false, collapsible));
  }

  /**
   * A9-57（ADR-0325）：行点击的去向。'switch' 沿用原激活流程；'browse' 只读查看同工作区对话（含已归档），
   * 不激活、不恢复；'return' 回到执行对话；'none' 不可点。只有执行对话忙、或行已归档时才进入只读查看；
   * 执行对话空闲时同工作区行仍走原激活流程。跨工作区行保持原逻辑。
   */
  function browseRowAction(conversation, snapshot, archived) {
    const scope = snapshot && snapshot.scope;
    const sameWorkspace = conversation.workspace && conversation.workspace.workspaceId && scope
      ? conversation.workspace.workspaceId === scope.workspaceId : archived || conversation.isCurrent === true;
    const browsable = Boolean(sameWorkspace && scope && scope.workspaceId && scope.conversationId
      && scope.conversationId === snapshot.activeConversationId && conversation.sessionId !== scope.conversationId
      && api && api.a9 && typeof api.a9.forScope === 'function');
    const browse = state.browse;
    if (browse && sameWorkspace && conversation.sessionId === browse.scope.conversationId) return 'return';
    if (browse && sameWorkspace && conversation.sessionId === browse.targetId) return 'none';
    if (sameWorkspace && scope && conversation.sessionId === scope.conversationId) return 'none';
    if (archived) return browsable ? 'browse' : 'none';
    const canSwitch = Boolean(snapshot.conversationControls && snapshot.conversationControls.canSwitch);
    if (browsable && (browse || !canSwitch)) return 'browse';
    if (browsable && canSwitch) return 'switch';
    if (conversation.switchable) return 'switch';
    if (conversation.isCurrent && !conversation.viewed && browsable) return 'browse';
    return 'none';
  }

  function appendConversationRow(list, conversation, snapshot, archived, compact) {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    const workspace = conversation.workspace || { workspaceId: 'current', displayName: pathName(snapshot.workspaceRoot) };
    const defaultWorkdir = workspace.workdir && workspace.workdir.origin === 'auto';
    const directoryName = defaultWorkdir ? pathName(workspace.workdir.path) : workspace.displayName;
    const badgeWorkspace = defaultWorkdir ? { ...workspace, displayName: '默认' } : workspace;
    const rowAction = browseRowAction(conversation, snapshot, archived);
    const browseTarget = Boolean(state.browse) && rowAction === 'none' && conversation.sessionId === state.browse.targetId;
    const viewed = state.browse ? browseTarget : archived ? false : conversation.viewed === true;
    button.className = `conversation-row${compact || archived ? ' compact' : ''}${conversation.unread ? ' unread' : ''}${browseTarget ? ' browsing' : ''}${rowAction === 'return' ? ' execution' : ''}`;
    button.disabled = rowAction === 'none';
    button.setAttribute('aria-current', String(viewed));
    button.dataset.workspaceId = workspace.workspaceId;
    button.dataset.conversationId = conversation.sessionId;
    const title = document.createElement('strong');
    title.className = 'conversation-title';
    const meta = document.createElement('small');
    meta.className = 'conversation-time';
    meta.textContent = shortConversationTime(conversation.updatedAt);
    const status = archived ? null : inboxStatus(conversation);
    const updated = conversation.updatedAt ? new Date(conversation.updatedAt).toLocaleString() : '';
    const controls = snapshot.conversationControls || {};
    const lockReason = conversation.isCurrent && !controls.canSwitch && !viewed
      ? `${controls.reason || '当前任务尚未结束'}，停止或完成后可切换`
      : !conversation.isCurrent && !conversation.switchable ? '该工作区任务尚未结束，停止或完成后可切换到其他对话' : '';
    const reason = rowAction === 'return' ? '执行对话，点击返回'
      : browseTarget ? '正在只读查看'
        : rowAction === 'browse' ? (archived ? '已归档，点击只读查看；不会恢复对话' : '点击只读查看；执行对话继续运行，不会切换')
          : archived ? '已归档，请先恢复对话' : viewed ? '当前对话' : lockReason;
    const statusText = status ? status.text : '空闲';
    const countdown = !archived && Number.isInteger(conversation.settleInDays) ? `${conversation.settleInDays} 天后结束` : '';
    const label = `${conversation.title || '新对话'}，${defaultWorkdir ? `默认目录 ${directoryName}` : workspace.displayName}，${statusText}${conversation.hasDraft ? '，有未发送草稿' : ''}${countdown ? `，${countdown}` : ''}${updated ? `，更新于 ${updated}` : ''}${reason ? `，${reason}` : ''}`;
    button.setAttribute('aria-label', label);
    button.title = `${conversation.title || '新对话'}\n${workspace.workspaceRoot || workspace.displayName}\n${statusText}${updated ? ` · ${updated}` : ''}${reason ? `\n${reason}` : ''}`;
    if (status) { meta.textContent = status.text; meta.className = `conversation-state ${status.kind}`; }
    if (compact || archived) {
      title.appendChild(workspaceBadgeNode(badgeWorkspace));
      if (defaultWorkdir) {
        const directory = document.createElement('small');
        directory.textContent = `${directoryName} · `;
        title.appendChild(directory);
      }
      title.appendChild(document.createTextNode(conversation.title || '新对话'));
      button.appendChild(title);
      button.appendChild(meta);
    } else {
      const line = document.createElement('span');
      line.className = 'conversation-workspace';
      line.appendChild(workspaceBadgeNode(badgeWorkspace));
      const directory = document.createElement('span');
      directory.textContent = directoryName;
      line.appendChild(directory);
      title.textContent = conversation.title || '新对话';
      const flags = document.createElement('span');
      flags.className = 'conversation-flags';
      if (conversation.hasDraft && !viewed) {
        flags.className += ' draft';
        flags.title = '有未发送草稿';
        flags.textContent = '草稿';
      } else if (countdown) {
        flags.className += ' countdown';
        flags.title = `空闲满 7 天后自动移到“已结束”`;
        flags.textContent = countdown;
      }
      button.appendChild(line);
      button.appendChild(meta);
      button.appendChild(title);
      button.appendChild(flags);
    }
    button.addEventListener('click', () => {
      // 旧 DOM 也按点击时的当前快照与浏览状态重新判定，不信任渲染时的结论。
      const action = browseRowAction(conversation, state.snapshot || snapshot, archived);
      if (action === 'return') { exitBrowse({ restoreFocus: true }); return; }
      if (action === 'browse') { openBrowse(conversation.sessionId); return; }
      if (action !== 'switch' || archived) return;
      if (state.browse) exitBrowse({ restoreFocus: false });
      if (conversation.isCurrent) void switchConversation(conversation.sessionId);
      else void activateWorkspace({ workspaceId: workspace.workspaceId, conversationId: conversation.sessionId });
    });
    item.appendChild(button);
    if (archived) {
      const restore = document.createElement('button');
      restore.type = 'button';
      restore.className = 'conversation-restore';
      restore.textContent = '恢复';
      restore.disabled = Boolean(state.browse) || !(snapshot.conversationControls && snapshot.conversationControls.canSwitch);
      if (restore.disabled) {
        restore.title = state.browse ? '只读查看中不能恢复对话，返回执行对话后再操作'
          : `${controls.reason || '当前任务尚未结束'}，停止或完成后可恢复`;
        restore.setAttribute('aria-label', `恢复 ${conversation.title || '对话'}，${restore.title}`);
      }
      restore.addEventListener('click', () => { void restoreConversation(conversation.sessionId); });
      item.appendChild(restore);
    } else {
      appendConversationRowFeedback(item, conversation);
      // A9-56：右键与 Shift+F10/菜单键都绑定在 <li> 上。禁用行（当前对话、锁定行）在 Chromium 108 不派发鼠标事件，
      // CSS 让禁用行按钮不接收指针，事件落到 <li>；提示文字同步到 <li>。
      if (button.disabled) {
        item.title = button.title;
        item.setAttribute('tabindex', '0');
        item.setAttribute('aria-label', label);
        item.setAttribute('aria-haspopup', 'menu');
        item.setAttribute('aria-keyshortcuts', 'Shift+F10 ContextMenu');
      }
      button.setAttribute('aria-keyshortcuts', 'Shift+F10 ContextMenu');
      item.addEventListener('contextmenu', (event) => {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        openRowMenu(conversation, rowMenuPoint(event, button));
      });
      item.addEventListener('keydown', (event) => {
        if (!event || !(event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey))) return;
        event.preventDefault();
        openRowMenu(conversation, rowMenuPoint(null, button));
      });
    }
    list.appendChild(item);
  }

  /** 行内只保留结束/恢复失败的中文原因；操作入口在右键菜单（A9-56，ADR-0324 替代 A9-54 悬停按钮）。 */
  function appendConversationRowFeedback(item, conversation) {
    item.className = 'conversation-item';
    const error = state.inboxActionError && state.inboxActionError.key === conversation.key ? state.inboxActionError.message : '';
    if (error) {
      const note = document.createElement('small');
      note.className = 'conversation-action-error';
      note.setAttribute('role', 'alert');
      note.textContent = error;
      item.appendChild(note);
    }
  }

  /**
   * A9-56（ADR-0324）：对话行右键菜单。菜单只记住被右键行的 workspaceId + conversationId（key），
   * 不先激活该行；每次列表重绘与每次点击都按当前快照重新解析该 key，目标离开驻留列表即关闭。
   * 置顶继续写 localStorage；结束/恢复继续走该行自己的 forScope，结束只给空闲的活跃行。
   */
  function rowMenuNodes() {
    const menu = el('conversation-row-menu');
    return menu ? { menu, pin: el('conversation-row-menu-pin'), lifecycle: el('conversation-row-menu-lifecycle'), note: el('conversation-row-menu-note') } : null;
  }

  function rowMenuItem(key) {
    if (!state.snapshot || !key) return null;
    return classifyInbox(inboxConversations(state.snapshot)).find((item) => item.key === key) || null;
  }

  function rowMenuLifecycle(item) {
    if (!item || !item.scope) return null;
    if (item.bucket === 'settled') return { action: 'reopen', label: '恢复到活跃', reason: '' };
    if (item.bucket !== 'active') return null;
    if (item.activity !== 'idle') {
      const status = inboxStatus(item);
      return { action: 'settle', label: '结束对话', reason: `当前状态为“${status ? status.text : '未空闲'}”，暂不能结束对话。` };
    }
    return { action: 'settle', label: '结束对话', reason: '' };
  }

  function renderRowMenu(item) {
    const nodes = rowMenuNodes();
    if (!nodes || !item) return;
    const title = item.title || '新对话';
    nodes.menu.setAttribute('aria-label', `对话操作：${title}`);
    nodes.pin.textContent = item.pinned ? '取消置顶' : '置顶';
    nodes.pin.setAttribute('aria-label', `${nodes.pin.textContent}：${title}`);
    const lifecycle = rowMenuLifecycle(item);
    const busy = Boolean(state.inboxActionBusy);
    const reason = lifecycle ? lifecycle.reason || (busy ? '正在处理上一项对话操作，请稍候。' : '') : '';
    nodes.lifecycle.hidden = !lifecycle;
    if (lifecycle) {
      nodes.lifecycle.dataset.action = lifecycle.action;
      nodes.lifecycle.textContent = lifecycle.label;
      nodes.lifecycle.setAttribute('aria-label', `${lifecycle.label}：${title}${reason ? `，${reason}` : ''}`);
      nodes.lifecycle.setAttribute('aria-disabled', String(Boolean(reason)));
      nodes.lifecycle.title = reason;
    }
    nodes.note.textContent = reason;
    nodes.note.hidden = !reason;
    const focused = document.activeElement;
    if (focused === nodes.lifecycle && nodes.lifecycle.hidden) nodes.pin.focus();
  }

  function rowMenuPoint(event, button) {
    if (event && (event.clientX || event.clientY)) return { x: event.clientX, y: event.clientY };
    const rect = button && typeof button.getBoundingClientRect === 'function' ? button.getBoundingClientRect() : null;
    return rect ? { x: rect.left + 16, y: rect.bottom - 4 } : { x: 8, y: 8 };
  }

  function ensureRowMenuListeners() {
    if (state.rowMenuBound) return;
    const nodes = rowMenuNodes();
    if (!nodes) return;
    state.rowMenuBound = true;
    nodes.pin.addEventListener('click', () => { void runRowMenuAction('pin'); });
    nodes.lifecycle.addEventListener('click', () => { void runRowMenuAction(nodes.lifecycle.dataset.action); });
    nodes.menu.addEventListener('keydown', handleRowMenuKey);
    // 键盘菜单键在焦点移入菜单后仍可能派发 contextmenu：菜单内不弹出其他菜单。
    nodes.menu.addEventListener('contextmenu', (event) => { if (event && typeof event.preventDefault === 'function') event.preventDefault(); });
    // 外点、任意滚动（捕获阶段）、窗口尺寸变化或失焦都关闭；右键另一行时先关闭再按新行打开。
    document.addEventListener('mousedown', (event) => {
      if (state.rowMenu && !nodes.menu.contains(event && event.target)) closeRowMenu(false);
    }, true);
    // 只看列表本身、其祖先或整页的滚动；运行中对话流的自动滚动不关闭菜单。
    document.addEventListener('scroll', (event) => {
      if (!state.rowMenu) return;
      const target = event && event.target;
      const list = el('conversation-list');
      if (!target || target === document || typeof target.contains !== 'function' || target.contains(list)) closeRowMenu(false);
    }, true);
    if (typeof root.addEventListener === 'function') {
      root.addEventListener('resize', () => { if (state.rowMenu) closeRowMenu(false); });
      root.addEventListener('blur', () => { if (state.rowMenu) closeRowMenu(false); });
    }
  }

  function openRowMenu(conversation, point) {
    if (state.browse && browseBlocked('打开对话操作菜单')) return;
    const nodes = rowMenuNodes();
    if (!nodes || !conversation || !conversation.key) return;
    const item = state.snapshot ? rowMenuItem(conversation.key) : null;
    if (!item) { closeRowMenu(false); return; }
    ensureRowMenuListeners();
    if (typeof setConversationMenu === 'function' && el('conversation-more').getAttribute('aria-expanded') === 'true') setConversationMenu(false);
    state.rowMenu = { key: item.key, workspaceId: item.workspace.workspaceId, conversationId: item.sessionId };
    renderRowMenu(item);
    nodes.menu.hidden = false;
    // 视口内定位：靠近触发点，越过右/下边缘时向左/向上翻转，最少留 4px。
    const width = nodes.menu.offsetWidth || 180;
    const height = nodes.menu.offsetHeight || 76;
    const viewWidth = root.innerWidth || (document.documentElement && document.documentElement.clientWidth) || width + 8;
    const viewHeight = root.innerHeight || (document.documentElement && document.documentElement.clientHeight) || height + 8;
    const left = point.x + width > viewWidth - 4 ? Math.max(4, viewWidth - width - 4) : Math.max(4, point.x);
    const top = point.y + height > viewHeight - 4 ? Math.max(4, point.y - height) : Math.max(4, point.y);
    nodes.menu.style.left = `${Math.round(left)}px`;
    nodes.menu.style.top = `${Math.round(top)}px`;
    nodes.pin.focus();
  }

  function closeRowMenu(restoreFocus) {
    const nodes = rowMenuNodes();
    const target = state.rowMenu;
    state.rowMenu = null;
    if (nodes) nodes.menu.hidden = true;
    if (restoreFocus && target) restoreRowMenuFocus(target);
  }

  function findConversationRowButton(target) {
    const list = el('conversation-list');
    if (!list || !target) return null;
    for (const li of Array.from(list.children || [])) {
      const button = li.children && li.children[0];
      if (button && button.dataset && button.dataset.workspaceId === target.workspaceId && button.dataset.conversationId === target.conversationId) return button;
    }
    return null;
  }

  /** 列表刷新会替换行节点：按 key 找回按钮或禁用按钮所在的可聚焦行；目标消失才回到顶部入口。 */
  function restoreRowMenuFocus(target) {
    const button = findConversationRowButton(target);
    if (button && !button.disabled) { button.focus(); return; }
    const item = button && button.parentNode;
    if (item && item.getAttribute('tabindex') === '0') { item.focus(); return; }
    const more = el('conversation-more');
    if (more && typeof more.focus === 'function') more.focus();
  }

  function handleRowMenuKey(event) {
    const nodes = rowMenuNodes();
    if (!nodes || !state.rowMenu) return;
    const items = [nodes.pin, nodes.lifecycle].filter((node) => !node.hidden);
    const index = items.indexOf(document.activeElement);
    if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault();
      if (typeof event.stopPropagation === 'function') event.stopPropagation();
      closeRowMenu(true);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      items[(index + step + items.length) % items.length].focus();
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      items[event.key === 'Home' ? 0 : items.length - 1].focus();
    }
  }

  /** 点击时按当前快照复核目标与状态；目标消失则关闭，状态已变则只刷新菜单、不调用后端。 */
  async function runRowMenuAction(kind) {
    const target = state.rowMenu;
    if (!target) return null;
    if (state.browse && browseBlocked('置顶、结束或恢复对话')) { closeRowMenu(false); return null; }
    const item = rowMenuItem(target.key);
    if (!item) { closeRowMenu(false); return null; }
    if (kind === 'pin') {
      closeRowMenu(false);
      togglePinnedConversation(item.sessionId);
      restoreRowMenuFocus(target);
      return null;
    }
    const lifecycle = rowMenuLifecycle(item);
    if (!lifecycle || lifecycle.action !== kind || lifecycle.reason || state.inboxActionBusy) {
      renderRowMenu(item);
      return null;
    }
    closeRowMenu(false);
    const response = await runInboxAction(kind, item);
    restoreRowMenuFocus(target);
    return response;
  }

  function syncRowMenu(items) {
    if (!state.rowMenu) return;
    const item = items.find((candidate) => candidate.key === state.rowMenu.key);
    if (!item) { closeRowMenu(false); return; }
    renderRowMenu(item);
  }

  function renderConversationDirectory(snapshot) {
    const conversations = snapshot.conversations || [];
    const query = state.searchQuery;
    const controls = snapshot.conversationControls || { canSwitch: false, maxActive: 16 };
    const filter = state.inboxFilter && (snapshot.workspaces || []).some((item) => item.opened && item.workspaceId === state.inboxFilter)
      ? state.inboxFilter : null;
    state.inboxFilter = filter;
    const currentId = (snapshot.scope && snapshot.scope.workspaceId) || 'current';
    const now = Date.now();
    const all = classifyInbox(inboxConversations(snapshot), now);
    // A9-57：只读查看期间用户没有在看执行对话，不把它的完成记为已查看；返回后照常记录。
    if (!state.browse) syncInboxVisit(all);
    scheduleInboxSettleRedraw(all, now);
    const visible = all.filter((item) => (!filter || item.workspace.workspaceId === filter)
      && (!query || String(item.title).toLocaleLowerCase().includes(query) || String(item.workspace.displayName).toLocaleLowerCase().includes(query)));
    const byTime = (a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
    const pinned = visible.filter((item) => item.bucket === 'pinned').sort(byTime);
    const active = visible.filter((item) => item.bucket === 'active').sort((a, b) => inboxRank(a) - inboxRank(b) || byTime(a, b));
    const settled = visible.filter((item) => item.bucket === 'settled').sort(byTime);
    const archived = (!filter || filter === currentId) ? conversations.filter((item) => item.state === 'archived'
      && (!query || String(item.title || '').toLocaleLowerCase().includes(query))) : [];
    const allActive = conversations.filter((item) => item.state === 'active');
    const activeList = el('conversation-list');
    const archivedList = el('conversation-archive-list');
    // A9-57：轮询会重建行节点；焦点原在某行时，重建后回到同一身份的新行，不丢给页面。
    const focused = document.activeElement;
    const inList = (list) => Boolean(focused && list && typeof list.contains === 'function' && list.contains(focused));
    const focusedRow = inList(activeList) || inList(archivedList)
      ? (focused.dataset && focused.dataset.conversationId ? focused
        : focused.children && focused.children[0] && focused.children[0].dataset ? focused.children[0] : null)
      : null;
    const focusedKey = focusedRow && focusedRow.dataset.conversationId
      ? { workspaceId: focusedRow.dataset.workspaceId, conversationId: focusedRow.dataset.conversationId } : null;
    activeList.textContent = '';
    archivedList.textContent = '';
    appendConversationGroup(activeList, '置顶', pinned, snapshot, false);
    appendConversationGroup(activeList, '活跃', active, snapshot, false);
    appendConversationGroup(activeList, '已结束', settled, snapshot, true);
    archived.forEach((item) => appendConversationRow(archivedList, { ...item, workspace: { workspaceId: currentId, displayName: pathName(snapshot.workspaceRoot), workdir: snapshot.workdir } }, snapshot, true));
    if (query && visible.length === 0 && archived.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'conversation-empty-note';
      empty.textContent = '没有匹配的对话。';
      activeList.appendChild(empty);
    }
    text('conversation-archive-count', archived.length);
    el('conversation-archive-section').hidden = archived.length === 0;
    el('conversation-new').disabled = !snapshot.scope && (!controls.canSwitch || allActive.length >= controls.maxActive);
    el('conversation-rename').disabled = !snapshot.activeConversationId;
    el('conversation-archive').disabled = !controls.canSwitch || !snapshot.activeConversationId;
    const pin = el('conversation-pin');
    if (pin) {
      pin.disabled = !snapshot.activeConversationId;
      pin.textContent = readPinnedConversations().has(snapshot.activeConversationId) ? '取消置顶' : '置顶当前对话';
    }
    renderInboxFilterChip(snapshot);
    syncRowMenu(all);
    text('conversation-directory-note', query
      ? `找到 ${visible.length + archived.length} 个匹配的对话（含当前工作区已归档）`
      : controls.canSwitch
        ? `当前工作区 ${allActive.length}/${controls.maxActive} 个未归档对话`
        : `当前工作区已锁定：${controls.reason || '当前任务尚未结束'}`);
    const current = conversations.find((item) => item.sessionId === snapshot.activeConversationId);
    if (current) text('workbench-title', current.title || '和工作区一起完成任务');
    if (focusedKey) focusDirectoryRow(focusedKey);
    if (state.browse) applyBrowseChrome();
  }

  /** 按工作区 + 对话身份在两张列表中找回行；禁用行回到可聚焦的 <li>。 */
  function focusDirectoryRow(target) {
    for (const listId of ['conversation-list', 'conversation-archive-list']) {
      const list = el(listId);
      for (const li of Array.from((list && list.children) || [])) {
        const button = li.children && li.children[0];
        if (!button || !button.dataset || button.dataset.conversationId !== target.conversationId
          || (target.workspaceId && button.dataset.workspaceId !== target.workspaceId)) continue;
        if (!button.disabled) { button.focus(); return true; }
        if (li.getAttribute && li.getAttribute('tabindex') === '0') { li.focus(); return true; }
        return false;
      }
    }
    return false;
  }

  function renderInboxFilterChip(snapshot) {
    const chip = el('conversation-filter-chip');
    if (!chip) return;
    const workspace = state.inboxFilter && (snapshot.workspaces || []).find((item) => item.workspaceId === state.inboxFilter);
    chip.hidden = !workspace;
    el('conversation-filter') && el('conversation-filter').classList.toggle('active', Boolean(workspace));
    chip.textContent = '';
    if (!workspace) return;
    const label = document.createElement('span');
    label.className = 'conversation-filter-label';
    label.textContent = '仅看';
    const name = document.createElement('span');
    name.className = 'conversation-filter-name';
    name.textContent = workspace.displayName;
    name.title = workspace.workspaceRoot;
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.setAttribute('aria-label', '显示全部工作区的对话');
    clear.textContent = '×';
    clear.addEventListener('click', () => { state.inboxFilter = null; renderConversationDirectory(state.snapshot); });
    chip.appendChild(label);
    chip.appendChild(workspaceBadgeNode(workspace));
    chip.appendChild(name);
    chip.appendChild(clear);
  }

  /** A9-56（ADR-0324）：输入框内不再显示执行目录条；有工作区后仍隐藏左上角选择卡片，目录看顶部入口。 */
  function renderComposerWorkspace(snapshot) {
    const workspace = snapshot && snapshot.workspaceRoot;
    const card = el('workspace-select');
    if (card) card.hidden = Boolean(workspace);
  }

  function hydrateDraft(snapshot) {
    if (!snapshot.activeConversationId || state.draftHydratedConversationId === snapshot.activeConversationId) return;
    state.draftHydratedConversationId = snapshot.activeConversationId;
    const draft = snapshot.draft || { text: '', persistence: 'memory' };
    el('task-prompt').value = draft.text || '';
    // A9-56：DPAPI 保护成功不再常驻提示；仅内存、恢复说明和失败仍显示。
    text('draft-status', draft.note || (draft.persistence === 'dpapi' ? '' : '草稿仅在当前进程保留。'));
    resizeComposer();
  }

  function sortedConversationFacts() {
    return Array.from(state.conversationFacts.values()).sort((a, b) =>
      a.createdAt === b.createdAt ? (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0)
        : a.createdAt < b.createdAt ? -1 : 1);
  }

  function renderHistoryControl() {
    const stream = el('a9-task-stream');
    if (!stream) return;
    if (state.historyNote) state.historyNote.remove();
    state.historyNote = null;
    if (!state.historyError && !(state.conversationPage && state.conversationPage.hasMore)) return;
    const note = document.createElement('p');
    note.className = 'legacy-note';
    note.className += ' conversation-history-note';
    note.textContent = state.historyError || '首屏仅加载最近的对话；更早内容仍完整保存在本机。';
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = state.historyLoading ? '正在加载…' : state.historyError ? '重试加载对话' : '加载更早对话';
    button.disabled = state.historyLoading;
    button.addEventListener('click', () => { void loadOlderConversation(); });
    note.appendChild(button);
    stream.insertBefore(note, stream.firstChild);
    state.historyNote = note;
  }

  async function loadOlderConversation() {
    if (state.historyLoading || !state.conversationPage || !state.conversationPage.nextBefore) return;
    const conversationId = state.activeConversationId;
    const before = state.conversationPage.nextBefore;
    const generation = state.historyGeneration;
    const isCurrent = () => state.activeConversationId === conversationId && state.historyGeneration === generation;
    const scroller = el('conversation');
    const anchorHeight = scroller.scrollHeight;
    const anchorTop = scroller.scrollTop;
    state.historyLoading = true;
    renderHistoryControl();
    try {
      const response = await a9.queryConversation({ conversationId, before, limit: 20 });
      if (!isCurrent()) return;
      if (!response || !response.ok || response.conversationId !== conversationId) throw new Error('对话加载失败，请重试。');
      for (const fact of response.facts) state.conversationFacts.set(fact.taskId, fact);
      state.conversationPage = { hasMore: response.hasMore, nextBefore: response.nextBefore };
      state.historyExpanded = true;
      state.historyError = '';
      state.snapshot = { ...state.snapshot, conversation: sortedConversationFacts() };
      state.conversationSignature = null;
      const follow = state.streamFollow;
      state.streamFollow = false;
      renderConversation(state.snapshot);
      // Moving existing nodes preserves details/focus state while inserting older facts in order.
      const stream = el('a9-task-stream');
      for (const fact of state.snapshot.conversation) {
        const block = state.streamDom.get(fact.taskId);
        if (block) stream.appendChild(block.root);
      }
      state.streamFollow = follow;
      scroller.scrollTop = anchorTop + scroller.scrollHeight - anchorHeight;
    } catch (error) {
      if (isCurrent()) state.historyError = '对话加载失败，请重试。';
    } finally {
      if (isCurrent()) {
        state.historyLoading = false;
        renderHistoryControl();
      }
    }
  }

  function syncCheckpointScope(snapshot) {
    const checkpointScope = `${snapshot.workspaceRoot || ''}\u0000${snapshot.activeConversationId || ''}`;
    if (state.checkpointScope !== checkpointScope) {
      cancelPendingUndo();
      state.checkpointScope = checkpointScope;
      state.checkpointGeneration += 1;
      state.reviewEpoch += 1;
      state.checkpointKnown.clear();
      state.checkpointVisible = 10;
      state.checkpointLoading = false;
      state.checkpointError = '';
      state.reviewCache.clear();
      state.reviewOpenTurn = null;
      state.reviewOpenFile = null;
      state.reviewConfirmation = null;
      state.reviewMessages.clear();
      state.summaryQueue = [];
      state.summaryQueued.clear();
    }
  }

  function renderSnapshot(snapshot) {
    // A9-57：执行对话或工作区真实变化即退出浏览；旧浏览代次的迟到回复随之失效。
    if (state.browse && !browseScopeMatches(state.browse, snapshot)) exitBrowse({ rerender: false });
    syncCheckpointScope(snapshot);
    state.activeConversationId = snapshot.activeConversationId || null;
    if (state.renderedConversationId !== state.activeConversationId) {
      state.renderedConversationId = state.activeConversationId;
      resetConversationEvents();
    }
    if (snapshot.conversationPage) {
      for (const fact of snapshot.conversation || []) state.conversationFacts.set(fact.taskId, fact);
      if (!state.historyExpanded) state.conversationPage = snapshot.conversationPage;
      snapshot = { ...snapshot, conversation: sortedConversationFacts() };
    }
    state.snapshot = snapshot;
    if (snapshot.workspaces) { state.workspaceDirectory = snapshot.workspaces; renderWorkspaceDirectory(); }
    const surface = el('a9-surface');
    surface.hidden = false;
    surface.dataset.a9Status = snapshot.status || 'unknown';
    const ready = snapshot.status === 'ready';
    const workspace = snapshot.workspaceRoot || '';
    if (state.gitWorkspace !== workspace) {
      state.gitWorkspace = workspace;
      state.gitRequest += 1;
      text('a9-git-status', 'Git 状态尚未读取，点击刷新。');
    }
    text('workspace-name', workspace ? pathName(workspace) : '选择本地工作区');
    text('workspace-path', workspace || '尚未选择');
    text('workspace-label', workspace ? pathName(workspace) : '未连接工作区');
    el('workspace-label').title = workspace;
    el('task-prompt').setAttribute('aria-description', workspace ? `执行目录：${workspace}` : '尚未选择工作区');
    renderComposerWorkspace(snapshot);
    renderWorkdir(snapshot);
    text('a9-workspace-value', workspace || '-');
    text('a9-mode-value', modeLabel(snapshot.mode));
    const shell = snapshot.shell || {};
    text('a9-shell-value', shell.available === false
      ? '设置无效（已阻止执行）'
      : `${shell.kind || '-'}${shell.version ? ` ${shell.version}` : ''}`);
    text('a9-shell-settings-state', shell.source === 'workspace_explicit'
      ? `当前：${shell.kind} · ${shell.path} · 环境键 ${Array.isArray(shell.envKeys) && shell.envKeys.length > 0 ? shell.envKeys.join(', ') : '无'}`
      : shell.source === 'invalid_saved_setting'
        ? '已保存设置无效；Shell 执行保持关闭。'
        : '当前：自动选择 PowerShell 5.1 / CMD。');
    if (shell.source === 'workspace_explicit') {
      el('a9-shell-kind').value = shell.kind;
      el('a9-shell-path').value = shell.path || '';
      el('a9-shell-version').value = shell.version || '';
    } else if (shell.source === 'automatic') {
      el('a9-shell-kind').value = 'automatic';
      el('a9-shell-path').value = '';
      el('a9-shell-version').value = '';
    }
    const provider = snapshot.provider || {};
    const promptInput = el('task-prompt');
    if (promptInput) promptInput.maxLength = Number.isSafeInteger(provider.composerMaxChars) ? provider.composerMaxChars : 128000;
    text('a9-provider-value', provider.configured ? `${provider.model} @ ${provider.baseUrl}` : '未配置');
    // A9-19 L02：Provider 分类属于诊断信息；探测通过时头部不再显示，异常时显示可操作的中文提示。
    const providerHealthy = provider.configured && provider.probe && provider.probe.classification === 'tool_calling';
    el('a9-provider-open').hidden = Boolean(providerHealthy);
    // 顶栏胶囊只在真实异常时用琥珀点；未配置属于“尚未设置”，用中性色，
    // 避免与“检查中”并列时出现两个琥珀点、读起来像两处故障。
    el('a9-provider-open').dataset.tone = provider.configured ? 'error' : 'unset';
    text('a9-provider-chip', !provider.configured ? '模型未配置'
      : provider.probe && provider.probe.classification ? `模型不可用：${provider.probe.classification}` : '模型未探测');
    text('a9-provider-key-state', provider.configured ? `key: ${provider.apiKey && provider.apiKey.remembered ? '已由 DPAPI 记住' : '仅当前进程'} (${provider.apiKey && provider.apiKey.source || 'none'})` : 'key: 未配置');
    text('a9-provider-probe-state', provider.probe ? provider.probe.classification : '未探测');
    setFieldError('a9-provider-diagnostics', provider.diagnostics
      ? `${provider.diagnostics.code || 'A9_PROVIDER_DIAGNOSTICS'}: ${provider.diagnostics.detail || 'Provider 需要检查。'}`
      : '');
    const providerHydratedSignature = JSON.stringify({
      configured: provider.configured === true,
      baseUrl: provider.baseUrl || '',
      model: provider.model || '',
      contextBudgetChars: provider.contextBudgetChars || snapshot.contextWindow && snapshot.contextWindow.budgetChars || 400000,
      composerMaxChars: provider.composerMaxChars || 128000,
      thinkingEnabled: provider.thinkingEnabled ?? null,
      reasoningEffort: provider.reasoningEffort || '',
      imageInputEnabled: provider.imageInputEnabled === true,
      remembered: Boolean(provider.apiKey && provider.apiKey.remembered),
      caBundle: provider.caBundle || '',
      customHeaderNames: provider.customHeaderNames || [],
      customHeaderValuesAvailable: provider.customHeaderValuesAvailable === true,
      proxy: provider.proxy || null,
    });
    if (state.providerHydratedSignature !== providerHydratedSignature) {
      el('a9-provider-url').value = provider.baseUrl || '';
      el('a9-provider-model').value = provider.model || '';
      el('a9-provider-budget').value = String(provider.contextBudgetChars || snapshot.contextWindow && snapshot.contextWindow.budgetChars || 400000);
      el('a9-provider-composer-max').value = String(provider.composerMaxChars || 128000);
      el('a9-provider-thinking').value = provider.thinkingEnabled === undefined
        ? 'auto'
        : provider.thinkingEnabled ? 'enabled' : 'disabled';
      el('a9-provider-effort').value = provider.reasoningEffort || 'auto';
      el('a9-provider-images').checked = provider.imageInputEnabled === true;
      el('a9-provider-remember').checked = Boolean(provider.apiKey && provider.apiKey.remembered);
      el('a9-provider-ca').value = provider.caBundle || '';
      el('a9-provider-header-name').value = (provider.customHeaderNames || [])[0] || '';
      el('a9-provider-header-value').value = '';
      el('a9-provider-proxy-host').value = provider.proxy && provider.proxy.host ? provider.proxy.host : '';
      el('a9-provider-proxy-port').value = provider.proxy && provider.proxy.port ? String(provider.proxy.port) : '';
      state.providerHydratedSignature = providerHydratedSignature;
    }
    text('a9-lock-value', snapshot.lock ? (snapshot.lock.held ? '本窗口持有写锁' : `由 ${snapshot.lock.holder || '其他窗口'} 持有`) : '-');
    text('a9-agent-value', snapshot.agentStatus || 'idle');
    const runtimeStatus = el('runtime-status');
    runtimeStatus.className = `connection ${ready ? 'ready' : 'failed'}`;
    runtimeStatus.innerHTML = '<i aria-hidden="true"></i>';
    runtimeStatus.appendChild(document.createTextNode(ready ? '运行时就绪' : '运行时受限'));
    runtimeStatus.hidden = ready; // A9-19 L02：就绪时不占头部，受限时保留并配合错误条。
    const runtimeError = ready ? '' : runtimeDiagnostic(snapshot);
    setFieldError('a9-runtime-error', runtimeError);
    if (!ready) showGlobalError(`Runtime 初始化受限：${runtimeDiagnostic(snapshot)}`, '打开诊断', () => openDrawer('diagnostics-drawer'));
    const modeButton = el('a9-mode-open');
    modeButton.hidden = !ready || !workspace;
    modeButton.disabled = !ready || !workspace;
    modeButton.textContent = `权限：${modeLabel(snapshot.mode)}`;
    modeButton.title = '';
    renderManagedProcesses(snapshot);
    renderTemplateSamples(snapshot);
    renderOfficeSkills(snapshot);
    renderApproval(snapshot);
    renderQuestion(snapshot);
    state.running = root.win7AgentStatus.isActive(snapshot.agentStatus);
    const preview = snapshot.liveModelPreview;
    state.liveModelPreview = preview && preview.turnId && typeof preview.text === 'string' ? preview : null;
    if (state.liveModelPreview) state.lastEventAt = Date.now();
    ingestTimelineEvents(snapshot.timeline);
    renderTimeline();
    renderCheckpoints(snapshot);
    renderConversationDirectory(snapshot);
    renderConversation(snapshot);
    renderHistoryControl();
    hydrateDraft(snapshot);
    const context = snapshot.contextWindow || {};
    const contextNote = el('context-window-note');
    contextNote.hidden = !context.note;
    contextNote.textContent = context.note || '';
    configureModeDialog(snapshot, false);
    const active = root.win7AgentStatus.isActive(snapshot.agentStatus);
    const managedActive = activeManagedProcesses(snapshot).length;
    state.running = active;
    if (snapshot.pendingQuestion || snapshot.agentStatus === 'needs_input') setTaskState('等待回答', 'running', '任务已暂停；回答只补充信息，不批准操作。');
    else if (snapshot.pendingApproval || snapshot.agentStatus === 'needs_approval') setTaskState('等待批准', 'running', '操作已暂停，等待你的决定。');
    else if (active) setTaskState(snapshot.agentStatus === 'cancelling' ? '正在停止' : '运行中', 'running');
    else if (root.win7AgentStatus.isFailure(snapshot.agentStatus)) setTaskState('失败', 'failed');
    else if (managedActive > 0) setTaskState(`后台运行 ${managedActive}`, 'running', '托管后台进程可通过下方停止按钮回收。');
    else setTaskState('空闲', 'idle');
    syncComposer();
    if (state.browse) {
      applyBrowseChrome();
      renderBrowseExecution(snapshot);
    }
  }

  async function refreshSnapshot(isCurrent = () => true) {
    if (!a9 || state.snapshotPollingClosed) return null;
    const generation = state.snapshotGeneration;
    const isFresh = () => !state.snapshotPollingClosed && generation === state.snapshotGeneration && isCurrent();
    // Explicit actions need facts read after the action. While a read is pending,
    // coalesce those callers into one fresh follow-up; timer ticks never queue.
    if (state.snapshotRequest) {
      const pending = state.snapshotRequest;
      if (!pending.next || pending.next.generation !== generation) {
        pending.next = {
          generation,
          promise: pending.promise.then(() => isFresh() ? refreshSnapshot(isCurrent) : null),
        };
      }
      const result = await pending.next.promise;
      return isFresh() ? result : null;
    }
    const request = { generation, promise: null };
    request.promise = Promise.resolve().then(async () => {
      try {
        const response = await a9.snapshot();
        if (!isFresh()) return null;
        if (state.defaultConversationPending) {
          if (response?.ok && response.snapshot.workspaces) state.workspaceDirectory = response.snapshot.workspaces;
          return null;
        }
        if (!response || response.ok !== true) {
          const code = response && response.error && response.error.code;
          if (code === 'A9_WORKSPACE_REQUIRED') {
            if (state.browse) exitBrowse({ rerender: false });
            state.snapshot = null;
            state.activeConversationId = null;
            state.renderedConversationId = null;
            state.running = false;
            state.localRequest = null;
            state.explorerSessionId = null;
            state.explorerRequest += 1;
            state.draftHydratedConversationId = null;
            stopLiveTracking();
            resetConversationEvents();
            closeDialog(el('a9-mode-dialog'));
            text('workspace-name', '选择本地工作区');
            text('workspace-path', '尚未选择');
            text('workspace-label', '未连接工作区');
            renderComposerWorkspace(null);
            renderWorkdir(null);
            text('task-prompt', '');
            el('task-prompt').value = '';
            el('a9-empty-state').hidden = false;
            el('a9-mode-open').hidden = true;
            el('a9-approval-card').hidden = true;
            if (el('a9-template-samples')) el('a9-template-samples').hidden = true;
            el('a9-question-host').hidden = true;
            el('a9-managed-processes').hidden = true;
            el('viewer-panel').hidden = true;
            el('workspace-tree').replaceChildren();
            el('conversation-list').replaceChildren();
            el('conversation-archive-section').hidden = true;
            el('conversation-new').disabled = false;
            text('conversation-directory-note', '尚未打开工作区，点“+”选择目录');
            setTaskState('空闲', 'idle', '选择一个工作区开始。');
            if (typeof a9.listWorkspaces === 'function') {
              const directory = await a9.listWorkspaces();
              if (!isFresh()) return null;
              if (directory?.ok) { state.workspaceDirectory = directory.workspaces; renderWorkspaceDirectory(); }
            }
            const surface = el('a9-surface');
            surface.hidden = false;
            surface.dataset.a9Status = 'workspace_required';
            text('runtime-status', '等待工作区');
            syncComposer();
            return null;
          }
          showSnapshotError(response);
          return null;
        }
        clearGlobalError();
        renderSnapshot(response.snapshot);
        return response.snapshot;
      } catch (error) {
        if (isFresh()) showSnapshotError(error);
        return null;
      }
    }).finally(() => {
      if (state.snapshotRequest === request) state.snapshotRequest = null;
      syncSnapshotPolling();
    });
    state.snapshotRequest = request;
    return request.promise;
  }

  function showSnapshotError(error) {
    const message = runtimeDiagnostic({ diagnostics: {
      code: 'A9_SNAPSHOT_REFRESH_FAILED', detail: errorMessage(error, '无法读取 A9 Runtime 状态。'),
    } });
    showGlobalError(message, '重试状态读取', () => { void refreshSnapshot(); });
  }

  async function saveDraftNow() {
    if (state.browse) return null;
    if (state.defaultConversationPending) return null;
    if (!a9 || !state.activeConversationId) return null;
    if (state.draftTimer) {
      root.clearTimeout(state.draftTimer);
      state.draftTimer = null;
    }
    state.draftSaving = true;
    const conversationId = state.activeConversationId;
    const draftText = el('task-prompt').value;
    const isCurrent = () => state.activeConversationId === conversationId && el('task-prompt').value === draftText;
    try {
      const response = await a9.saveDraft(draftText);
      if (isCurrent()) {
        el('draft-status').dataset.tone = !response || response.ok !== true ? 'error' : 'info';
        if (!response || response.ok !== true) {
          const reason = response && response.error && response.error.message ? `：${response.error.message}` : '，当前输入仍保留，请稍后重试。';
          text('draft-status', `草稿保存失败${reason}`);
        } else if (response.note) text('draft-status', response.note);
        else if (response.persistence === 'dpapi') text('draft-status', '');
        else if (response.persistence === 'memory') text('draft-status', '草稿仅在当前进程保留。');
      }
      return response;
    } catch (_error) {
      if (isCurrent()) {
        el('draft-status').dataset.tone = 'error';
        text('draft-status', '草稿保存失败，当前输入仍保留，请稍后重试。');
      }
      return { ok: false };
    } finally {
      state.draftSaving = false;
    }
  }

  function scheduleDraftSave() {
    if (state.browse) return;
    if (state.defaultConversationPending) return;
    if (state.draftTimer) root.clearTimeout(state.draftTimer);
    text('draft-status', '正在保存当前对话草稿…');
    el('draft-status').dataset.tone = 'info';
    state.draftTimer = root.setTimeout(() => { void saveDraftNow(); }, 450);
  }

  async function runConversationOperation(operation) {
    if (state.browse && browseBlocked('切换、新建、归档或恢复对话')) return null;
    if (state.workspaceOperation) return null;
    state.snapshotGeneration += 1;
    state.snapshotPollingPauses += 1;
    syncSnapshotPolling();
    cancelPendingUndo();
    clearGlobalError();
    try {
      await saveDraftNow();
      const response = await operation();
      if (!response || response.ok !== true) {
        showGlobalError(errorMessage(response, '对话操作失败。'), '刷新状态', () => { void refreshSnapshot(); });
        return response;
      }
      state.conversationSignature = null;
      state.draftHydratedConversationId = null;
      state.localRequest = null;
      await refreshSnapshot();
      await loadConversationEvents();
      dismissNavigationDrawer();
      return response;
    } catch (error) {
      showGlobalError(errorMessage(error, '对话操作失败。'), '刷新状态', () => { void refreshSnapshot(); });
      return null;
    } finally {
      state.snapshotPollingPauses -= 1;
      syncSnapshotPolling();
    }
  }

  /** A9-19 L05：重命名/归档收进“更多”菜单，释放左栏常驻行；键盘可达，aria 与可见状态同步。 */
  function setConversationMenu(open) {
    const menu = el('conversation-current-actions');
    const toggle = el('conversation-more');
    menu.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    if (open) {
      const first = menu.querySelector('button:not(:disabled)');
      if (first) first.focus();
    }
  }

  function workspaceSummary(workspace) {
    const isCurrent = state.snapshot && state.snapshot.scope && state.snapshot.scope.workspaceId === workspace.workspaceId;
    const items = isCurrent ? classifyInbox(inboxConversations(state.snapshot)).filter((item) => item.isCurrent)
      : (workspace.conversations || []).map((item) => ({ activity: item.sessionId === workspace.activeConversationId && workspace.status ? inboxActivity(workspace.status) : inboxActivity(item.activity) }));
    const attention = items.filter((item) => inboxRank(item) <= 1).length;
    const running = items.filter((item) => item.activity === 'running' || item.activity === 'cancelling').length;
    return { attention, running };
  }

  function pickerOption(list, index, options) {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.id = `conversation-workspace-option-${index}`;
    button.className = `project-picker-item${options.other ? ' project-picker-other' : ''}`;
    button.setAttribute('role', 'option');
    button.setAttribute('aria-selected', 'false');
    button.dataset.index = String(index);
    button.dataset.value = options.value;
    if (options.workspace) button.appendChild(workspaceBadgeNode(options.workspace));
    else { const plus = document.createElement('span'); plus.className = 'ws-badge project-picker-plus'; plus.setAttribute('aria-hidden', 'true'); plus.textContent = '+'; button.appendChild(plus); }
    const main = document.createElement('span');
    main.className = 'project-picker-main';
    const title = document.createElement('strong');
    title.textContent = options.title;
    const meta = document.createElement('small');
    meta.textContent = options.meta;
    main.appendChild(title);
    main.appendChild(meta);
    button.appendChild(main);
    if (options.summary) {
      const summary = document.createElement('span');
      summary.className = 'project-picker-summary';
      if (options.summary.attention) { const node = document.createElement('b'); node.className = 'attention'; node.textContent = `${options.summary.attention} 待处理`; summary.appendChild(node); }
      if (options.summary.running) { const node = document.createElement('b'); node.className = 'running'; node.textContent = `${options.summary.running} 运行中`; summary.appendChild(node); }
      if (!options.summary.attention && !options.summary.running) summary.textContent = '空闲';
      button.appendChild(summary);
    }
    if (options.shortcut) { const kbd = document.createElement('kbd'); kbd.textContent = options.shortcut; button.appendChild(kbd); }
    button.addEventListener('click', () => { void chooseWorkspaceFromPicker(options.value); });
    button.addEventListener('mousemove', () => { if (state.pickerIndex !== index) highlightPickerOption(index); });
    item.appendChild(button);
    list.appendChild(item);
  }

  function pickerSection(list, label) {
    const head = document.createElement('li');
    head.className = 'project-picker-section';
    head.setAttribute('role', 'presentation');
    head.textContent = label;
    list.appendChild(head);
  }

  function highlightPickerOption(index) {
    const options = Array.from(el('conversation-workspace-list').querySelectorAll('.project-picker-item'));
    if (!options.length) return;
    state.pickerIndex = (index + options.length) % options.length;
    options.forEach((option, position) => option.setAttribute('aria-selected', String(position === state.pickerIndex)));
    const current = options[state.pickerIndex];
    el('conversation-workspace-search').setAttribute('aria-activedescendant', current.id);
    if (typeof current.scrollIntoView === 'function') current.scrollIntoView({ block: 'nearest' });
  }

  /** 命令面板：已打开工作区按当前优先，其后是最近使用但未打开的目录，最后是“打开其他文件夹”。 */
  function renderProjectPicker() {
    const list = el('conversation-workspace-list');
    if (!list) return;
    const query = String(el('conversation-workspace-search').value || '').trim().toLocaleLowerCase();
    const match = (workspace) => !query || String(workspace.displayName).toLocaleLowerCase().includes(query)
      || String(workspace.workspaceRoot).toLocaleLowerCase().includes(query);
    const opened = state.workspaceDirectory.filter((workspace) => workspace.opened !== false && match(workspace))
      .sort((a, b) => Number(Boolean(b.active)) - Number(Boolean(a.active)));
    const recent = state.workspaceDirectory.filter((workspace) => workspace.opened === false && match(workspace));
    list.textContent = '';
    let index = 0;
    pickerOption(list, index++, { value: '__default__', title: '不选目录，直接开始', meta: '需要文件或命令工具时才创建默认目录', shortcut: 'Ctrl 1' });
    pickerSection(list, '已打开的工作区');
    if (!opened.length) {
      const empty = document.createElement('li');
      empty.className = 'project-picker-empty';
      empty.textContent = query ? '没有匹配的工作区。'
        : state.workspaceDirectory.length ? '当前没有打开的工作区。' : '还没有工作区，选择下方“打开其他文件夹…”。';
      list.appendChild(empty);
    }
    opened.forEach((workspace) => {
      pickerOption(list, index, { workspace, value: workspace.workspaceId, title: workspace.displayName,
        meta: `本地 · ${workspace.workspaceRoot}${workspace.active ? ' · 正在查看' : ''}`,
        summary: workspaceSummary(workspace), shortcut: index < 9 ? `Ctrl ${index + 1}` : '' });
      index += 1;
    });
    if (recent.length) {
      pickerSection(list, '最近使用（未打开）');
      recent.forEach((workspace) => {
        pickerOption(list, index, { workspace, value: workspace.workspaceId, title: workspace.displayName,
          meta: `选择即打开 · ${workspace.workspaceRoot}` });
        index += 1;
      });
    }
    pickerSection(list, '其他');
    pickerOption(list, index, { other: true, value: '__choose__', title: '打开其他文件夹…', meta: '从系统对话框选择本地目录', shortcut: 'Ctrl O' });
    highlightPickerOption(Math.min(state.pickerIndex || 0, index));
  }

  function createConversation() {
    if (state.browse && browseBlocked('新建对话')) return null;
    if (typeof api.a9.activateWorkspace !== 'function') return runConversationOperation(() => a9.createConversation());
    setFieldError('conversation-new-error', '');
    setWorkspaceMenu(false);
    el('conversation-workspace-search').value = '';
    state.pickerIndex = 0;
    renderProjectPicker();
    openDialog(el('conversation-new-dialog'));
    el('conversation-workspace-search').focus();
  }

  function handlePickerKey(event) {
    const options = Array.from(el('conversation-workspace-list').querySelectorAll('.project-picker-item'));
    const key = String(event.key || '');
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      event.preventDefault();
      highlightPickerOption((state.pickerIndex || 0) + (key === 'ArrowDown' ? 1 : -1));
    } else if (key === 'Enter' && !event.isComposing) {
      event.preventDefault();
      const option = options[state.pickerIndex || 0];
      if (option && !option.disabled) option.click();
    } else if (event.ctrlKey && /^[1-9]$/.test(key)) {
      event.preventDefault();
      const option = options[Number(key) - 1];
      if (option && !option.classList.contains('project-picker-other') && option.querySelector('kbd')) option.click();
    } else if (event.ctrlKey && key.toLowerCase() === 'o') {
      event.preventDefault();
      void chooseWorkspaceFromPicker('__choose__');
    }
  }

  /** 筛选与管理菜单：按工作区筛选对话列表；关闭入口只针对已打开的工作区。 */
  function renderWorkspaceDirectory() {
    if (state.snapshot) renderConversationDirectory(state.snapshot);
    const menu = el('workspace-menu');
    if (!menu || menu.hidden) return;
    menu.textContent = '';
    const head = document.createElement('p');
    head.className = 'workspace-menu-head';
    head.textContent = '按工作区筛选';
    menu.appendChild(head);
    const option = (workspace) => {
      const row = document.createElement('div');
      row.className = 'workspace-menu-row';
      const pick = document.createElement('button');
      pick.type = 'button';
      pick.setAttribute('role', 'menuitemradio');
      pick.setAttribute('aria-checked', String((state.inboxFilter || null) === (workspace ? workspace.workspaceId : null)));
      if (workspace) pick.appendChild(workspaceBadgeNode(workspace));
      const name = document.createElement('span');
      name.textContent = workspace ? workspace.displayName : '全部工作区';
      if (workspace) pick.title = workspace.workspaceRoot;
      pick.appendChild(name);
      pick.addEventListener('click', () => {
        state.inboxFilter = workspace ? workspace.workspaceId : null;
        setWorkspaceMenu(false);
        if (state.snapshot) renderConversationDirectory(state.snapshot);
      });
      row.appendChild(pick);
      if (workspace) {
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'workspace-menu-close';
        close.dataset.workspaceId = workspace.workspaceId;
        close.setAttribute('role', 'menuitem');
        close.textContent = '关闭…';
        close.setAttribute('aria-label', `停止并关闭工作区 ${workspace.displayName}`);
        close.disabled = state.workspaceOperation;
        close.addEventListener('click', () => { setWorkspaceMenu(false); openWorkspaceClose(workspace); });
        row.appendChild(close);
      }
      menu.appendChild(row);
    };
    option(null);
    state.workspaceDirectory.filter((workspace) => workspace.opened !== false).forEach(option);
  }

  function setWorkspaceMenu(open) {
    const menu = el('workspace-menu');
    const toggle = el('conversation-filter');
    if (!menu || !toggle) return;
    menu.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    if (open) {
      renderWorkspaceDirectory();
      const first = menu.querySelector('button');
      if (first) first.focus();
    }
  }

  async function activateWorkspace(values) {
    if (state.workspaceOperation) return null;
    // A9-57：跨工作区沿用原流程，先退出浏览，旧浏览代次的回复随之作废。
    if (state.browse) exitBrowse({ restoreFocus: false });
    state.workspaceOperation = true;
    state.workspaceSelectionGeneration += 1;
    state.snapshotGeneration += 1;
    state.snapshotPollingPauses += 1;
    syncSnapshotPolling(); renderWorkspaceDirectory();
    cancelPendingUndo(); clearGlobalError();
    try {
      const saved = await saveDraftNow();
      if (saved && saved.ok !== true) throw new Error('草稿保存失败，请保留输入后重试。');
      const response = await api.a9.activateWorkspace(values);
      if (!response || !response.ok) {
        if (!response?.cancelled) throw new Error(errorMessage(response, '工作区切换失败。'));
        return response;
      }
      state.defaultConversationPending = false;
      state.localRequest = null; state.conversationSignature = null;
      state.approvalDecision = null; state.questionReply = null; state.continuingTaskId = null; state.queueBusy = false;
      stopLiveTracking();
      state.draftHydratedConversationId = null; state.explorerSessionId = null;
      state.explorerRequest += 1; state.explorerPath = ''; state.viewer = null;
      el('code-viewer').replaceChildren();
      el('viewer-panel').hidden = true;
      // Modal mode selection belongs to the old view and must not cover B.
      closeDialog(el('a9-mode-dialog'));
      const snapshot = await refreshSnapshot();
      if (snapshot) {
        await ensureExplorerSession(snapshot.workspaceRoot);
        if (!snapshot.workdir && !state.explorerSessionId) {
          const session = await api.createSession(snapshot.workspaceRoot, pathName(snapshot.workspaceRoot));
          state.explorerSessionId = session?.session?.sessionId || null;
          await refreshWorkspace('');
        }
        await loadConversationEvents();
      }
      return response;
    } catch (error) {
      showGlobalError(errorMessage(error, '工作区切换失败。'), '刷新状态', () => { void refreshSnapshot(); });
      return { ok: false, error: { message: error.message } };
    } finally {
      state.workspaceOperation = false; state.snapshotPollingPauses -= 1;
      renderWorkspaceDirectory(); syncSnapshotPolling();
    }
  }

  async function chooseWorkspaceFromPicker(value) {
    if (state.browse && browseBlocked('新建对话')) return;
    if (value === '__default__') return prepareDefaultConversation();
    const dialog = el('conversation-new-dialog');
    const items = dialog.querySelectorAll('.project-picker-item');
    if (state.workspaceOperation || Array.from(items).some((item) => item.disabled)) return;
    items.forEach((item) => { item.disabled = true; });
    try {
      const response = await activateWorkspace({ createConversation: true,
        ...(value === '__choose__' ? { chooseDirectory: true } : { workspaceId: value }) });
      if (response?.ok) closeDialog(el('conversation-new-dialog'));
      else if (!response?.cancelled) setFieldError('conversation-new-error', errorMessage(response, '新建对话失败。'));
    } finally { items.forEach((item) => { item.disabled = false; }); }
  }

  function openWorkspaceClose(workspace) {
    if (state.browse && browseBlocked('关闭工作区')) return;
    if (!workspace) return;
    el('workspace-close-dialog').dataset.workspaceId = workspace.workspaceId;
    text('workspace-close-path', workspace.workspaceRoot);
    openDialog(el('workspace-close-dialog'));
  }

  async function confirmWorkspaceClose() {
    if (state.browse && browseBlocked('关闭工作区')) return;
    const workspaceId = el('workspace-close-dialog').dataset.workspaceId;
    const scope = state.snapshot && state.snapshot.scope;
    if (!workspaceId || state.workspaceOperation) return;
    const isCurrent = Boolean(scope && scope.workspaceId === workspaceId);
    if (isCurrent) {
      const saved = await saveDraftNow();
      if (saved && saved.ok !== true) return;
    }
    state.workspaceOperation = true; state.snapshotGeneration += 1;
    try {
      const response = await api.a9.closeWorkspace(workspaceId);
      if (!response?.ok) throw new Error(errorMessage(response, '工作区关闭失败。'));
      closeDialog(el('workspace-close-dialog'));
      if (state.inboxFilter === workspaceId) state.inboxFilter = null;
      if (isCurrent) {
        state.snapshot = null; state.activeConversationId = null; state.localRequest = null;
        state.explorerSessionId = null; state.explorerRequest += 1;
        resetConversationEvents();
      }
      await refreshSnapshot();
    } catch (error) { showGlobalError(errorMessage(error, '工作区关闭失败。')); }
    finally { state.workspaceOperation = false; renderWorkspaceDirectory(); }
  }

  function switchConversation(conversationId) {
    if (state.defaultConversationPending && state.defaultPreviousScope) return activateWorkspace({ workspaceId: state.defaultPreviousScope.workspaceId, conversationId });
    if (conversationId === state.activeConversationId) return Promise.resolve(null);
    return runConversationOperation(() => a9.activateConversation(conversationId));
  }

  function restoreConversation(conversationId) {
    return runConversationOperation(() => a9.restoreConversation(conversationId));
  }

  function archiveCurrentConversation() {
    if (!state.activeConversationId) return Promise.resolve(null);
    return runConversationOperation(() => a9.archiveConversation(state.activeConversationId));
  }

  function openRenameConversation() {
    if (state.browse && browseBlocked('重命名对话')) return;
    const current = ((state.snapshot && state.snapshot.conversations) || [])
      .find((item) => item.sessionId === state.activeConversationId);
    if (!current) return;
    el('conversation-rename-input').value = current.title || '';
    setFieldError('conversation-rename-error', '');
    openDialog(el('conversation-rename-dialog'));
    el('conversation-rename-input').focus();
    el('conversation-rename-input').select();
  }

  async function applyConversationRename() {
    if (state.browse && browseBlocked('重命名对话')) return;
    const title = el('conversation-rename-input').value.trim();
    if (!title) {
      setFieldError('conversation-rename-error', '对话名称不能为空。');
      return;
    }
    const response = await a9.renameConversation(state.activeConversationId, title);
    if (!response || response.ok !== true) {
      setFieldError('conversation-rename-error', errorMessage(response, '重命名失败。'));
      return;
    }
    closeDialog(el('conversation-rename-dialog'));
    await refreshSnapshot();
  }

  async function ensureExplorerSession(workspaceRoot) {
    if (state.snapshot && state.snapshot.workdir) { await refreshWorkspace(''); return; }
    if (!workspaceRoot || state.explorerSessionId) return;
    const result = await api.listSessions();
    const sessions = result && result.sessions ? result.sessions : [];
    const active = sessions.find((session) => session.status === 'ACTIVE' && session.workspacePath === workspaceRoot);
    if (active) {
      state.explorerSessionId = active.sessionId;
      await refreshWorkspace('');
    }
  }

  async function chooseWorkspace() {
    if (state.browse && browseBlocked('切换工作区')) return null;
    if (typeof api.a9.activateWorkspace === 'function') return activateWorkspace({ chooseDirectory: true });
    const selectionGeneration = ++state.workspaceSelectionGeneration;
    state.snapshotGeneration += 1;
    state.snapshotPollingPauses += 1;
    syncSnapshotPolling();
    cancelPendingUndo();
    clearGlobalError();
    try {
      await saveDraftNow();
      const result = await api.selectWorkspace();
      if (!result || !result.selected) return;
      if (selectionGeneration !== state.workspaceSelectionGeneration) return;
      let sessionsResult = await api.listSessions();
      let sessions = sessionsResult && sessionsResult.sessions ? sessionsResult.sessions : [];
      let session = sessions.find((item) => item.status === 'ACTIVE' && item.workspacePath === result.selected.workspacePath);
      if (!session) {
        const created = await api.createSession(result.selected.workspacePath, result.selected.displayName);
        session = created && created.session;
      }
      state.explorerSessionId = session ? session.sessionId : null;
      const refreshed = await refreshSnapshot(() => selectionGeneration === state.workspaceSelectionGeneration);
      if (selectionGeneration !== state.workspaceSelectionGeneration) return;
      if (!refreshed) return;
      resetConversationEvents();
      for (const fact of state.snapshot?.conversation || []) state.conversationFacts.set(fact.taskId, fact);
      state.conversationPage = state.snapshot?.conversationPage || null;
      state.conversationSignature = null;
      if (state.snapshot) renderConversation(state.snapshot);
      if (state.activeConversationId && (state.snapshot?.conversation || []).length > 0) {
        await loadConversationEvents();
      }
      if (selectionGeneration !== state.workspaceSelectionGeneration) return;
      await refreshWorkspace('');
      dismissNavigationDrawer();
    } catch (error) {
      showGlobalError(errorMessage(error, '工作区选择失败。'), '重新选择', () => { void chooseWorkspace(); });
    } finally {
      state.snapshotPollingPauses -= 1;
      syncSnapshotPolling();
    }
  }

  async function refreshWorkspace(pathValue) {
    const scope = state.snapshot && state.snapshot.scope;
    const scopedDirectory = Boolean(state.snapshot && state.snapshot.workdir && scope);
    if (!scopedDirectory && !state.explorerSessionId) return;
    const request = ++state.explorerRequest;
    const sessionId = state.explorerSessionId;
    const tree = el('workspace-tree');
    tree.textContent = '';
    text('workspace-tree-empty', '文件列表正在读取…');
    el('workspace-tree-empty').hidden = false;
    let response;
    try {
      response = scopedDirectory ? await a9.listWorkspaceDirectory(pathValue || '') : await api.listWorkspace(sessionId, pathValue || '');
      if (!response || response.ok === false || !response.result) throw response;
    } catch (error) {
      if (request !== state.explorerRequest || sessionId !== state.explorerSessionId || (scopedDirectory && (state.snapshot?.scope?.workspaceId !== scope.workspaceId || state.snapshot?.scope?.conversationId !== scope.conversationId))) return;
      const message = `文件列表读取失败：${errorMessage(error, '服务未返回目录')}，可重试。`;
      text('workspace-tree-empty', message);
      showGlobalError(message, '重试', () => {
        clearGlobalError();
        if (sessionId === state.explorerSessionId) void refreshWorkspace(pathValue);
      });
      return;
    }
    if (request !== state.explorerRequest || sessionId !== state.explorerSessionId || (scopedDirectory && (state.snapshot?.scope?.workspaceId !== scope.workspaceId || state.snapshot?.scope?.conversationId !== scope.conversationId))) return;
    const listing = response.result;
    state.explorerPath = listing.path || '';
    text('explorer-path', state.explorerPath || '/');
    el('workspace-up').disabled = !state.explorerPath;
    (listing.entries || []).forEach((entry) => {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = `${entry.type === 'directory' ? '▸' : '·'} ${entry.name}`;
      button.title = entry.path;
      button.addEventListener('click', () => {
        if (entry.type === 'directory') void refreshWorkspace(entry.path);
        else if (entry.type === 'file') void openWorkspaceFile(entry.path);
      });
      item.appendChild(button);
      tree.appendChild(item);
    });
    el('workspace-tree-empty').hidden = tree.children.length > 0;
    text('workspace-tree-empty', '此目录没有文件或子目录项。');
  }

  async function openWorkspaceFile(filePath, startLine, encoding) {
    if ((!state.explorerSessionId && !state.snapshot?.workdir) || !filePath) return;
    const sameFile = Boolean(state.viewer && state.viewer.path === filePath);
    const selectedEncoding = encoding === undefined
      ? (sameFile ? el('viewer-encoding').value : '')
      : encoding;
    el('viewer-encoding').value = selectedEncoding || '';
    let response;
    try { response = await a9.readWorkspaceFile(filePath, startLine || 1, 500, selectedEncoding || undefined); }
    catch (error) { response = { ok: false, error }; }
    if (!response || response.ok === false || !response.result) {
      showGlobalError(`文件读取失败：${errorMessage(response, '服务未返回文件')}，可重试。`, '重试', () => {
        clearGlobalError();
        void openWorkspaceFile(filePath, startLine, selectedEncoding);
      });
      return;
    }
    state.viewer = response.result;
    text('viewer-file', response.result.path);
    text('viewer-range', `${response.result.startLine || 1}–${response.result.endLine || response.result.lines.length}`);
    el('viewer-panel').hidden = false;
    if (!response.result.isText) {
      showGlobalError('无法自动识别为文本。请选择已知编码后重试；不会以乱码替代字符展示。');
    } else {
      clearGlobalError();
    }
    renderViewer();
    openInspector('files');
  }

  function renderViewer() {
    const target = el('code-viewer');
    target.textContent = '';
    if (!state.viewer) return;
    const query = el('viewer-search').value.toLocaleLowerCase();
    (state.viewer.lines || []).forEach((line) => {
      if (query && !String(line.text).toLocaleLowerCase().includes(query)) return;
      const row = document.createElement('div');
      row.className = 'code-line';
      row.dataset.line = String(line.line);
      const number = document.createElement('span');
      number.className = 'line-no';
      number.textContent = line.line;
      const code = document.createElement('span');
      code.className = 'line-code';
      code.textContent = line.text || ' ';
      row.appendChild(number);
      row.appendChild(code);
      target.appendChild(row);
    });
  }

  /**
   * ADR-0114：轮次提交复用事件流——本地先建请求卡，过程经 timeline 增量
   * 入流，终态由 turn_completed/事实渲染；不再双写结果卡。
   */
  function renderQueue(snapshot) {
    const panel = el('composer-queue');
    if (!panel) return;
    const queue = snapshot && snapshot.queue;
    panel.hidden = !queue || !queue.items.length;
    if (panel.hidden) return;
    text('queue-state', `${queue.paused ? '已暂停' : '顺序发送'} · ${queue.items.length}/8`);
    text('queue-note', queue.note || '仅排队内容会在上一轮正常完成后发送；停止、失败或重启后暂停。');
    const toggle = el('queue-toggle');
    toggle.textContent = queue.paused ? '继续队列' : '暂停队列';
    toggle.disabled = state.queueBusy || !snapshot || snapshot.status !== 'ready'
      || Boolean(snapshot.pendingApproval || snapshot.pendingQuestion);
    const list = el('queue-items');
    const signature = JSON.stringify([queue.items, state.queueBusy]);
    if (list.dataset.signature === signature) return;
    list.dataset.signature = signature;
    list.textContent = '';
    queue.items.forEach((item, index) => {
      const row = document.createElement('li');
      const copy = document.createElement('span');
      copy.textContent = `${index + 1}. ${item.text}`;
      const remove = document.createElement('button');
      remove.type = 'button'; remove.textContent = '移除';
      remove.setAttribute('aria-label', `移除第 ${index + 1} 条排队消息`);
      remove.disabled = state.queueBusy;
      remove.addEventListener('click', () => { void updateQueue('remove', { itemId: item.id }); });
      row.appendChild(copy); row.appendChild(remove); list.appendChild(row);
    });
  }

  async function updateQueue(operation, fields = {}) {
    if (state.browse && browseBlocked('修改队列')) return;
    const snapshot = state.snapshot;
    if (state.queueBusy || !snapshot || !snapshot.activeConversationId) return;
    const conversationId = snapshot.activeConversationId;
    const requestGeneration = state.snapshotGeneration;
    const isCurrent = () => state.activeConversationId === conversationId && state.snapshotGeneration === requestGeneration;
    const prompt = el('task-prompt');
    const originalText = prompt.value;
    if (operation === 'add') {
      if (!root.win7AgentComposerController.controls(snapshot, state.running, originalText).canQueue) return;
      if (state.draftTimer) { root.clearTimeout(state.draftTimer); state.draftTimer = null; }
    }
    state.queueBusy = true; syncComposer();
    try {
      const response = await a9.updateQueue({ conversationId, operation, ...fields,
        ...(operation === 'add' ? { text: originalText } : {}) });
      if (!isCurrent()) return;
      if (!response || response.ok !== true) {
        setFieldError('a9-turn-error', errorMessage(response, '队列更新失败，输入仍保留。'));
      } else if (state.activeConversationId === conversationId && operation === 'add' && prompt.value === originalText) {
        prompt.value = ''; resizeComposer(); await saveDraftNow();
      }
    } catch (error) { if (isCurrent()) setFieldError('a9-turn-error', errorMessage(error, '队列更新结果未知，请刷新核对后再操作。')); }
    finally { if (isCurrent()) { state.queueBusy = false; await refreshSnapshot(); syncComposer(); } }
  }

  async function submitPrompt() {
    if (state.browse && browseBlocked('发送消息')) return null;
    if (state.defaultConversationPending) return submitDefaultPrompt();
    const requestConversationId = state.activeConversationId;
    const requestGeneration = state.snapshotGeneration;
    const isCurrent = () => state.activeConversationId === requestConversationId && state.snapshotGeneration === requestGeneration;
    const prompt = el('task-prompt').value.trim();
    if (!prompt || !canSubmit()) return null;
    const providerMax = state.snapshot && state.snapshot.provider && state.snapshot.provider.composerMaxChars;
    const promptNode = el('task-prompt');
    const maxPromptChars = (Number.isSafeInteger(providerMax) && providerMax >= 1000)
      ? providerMax
      : (promptNode && Number.isSafeInteger(promptNode.maxLength) && promptNode.maxLength >= 1000 ? promptNode.maxLength : 128000);
    if (prompt.length > maxPromptChars) {
      setFieldError('a9-turn-error', `输入长度超过当前上限（${maxPromptChars} 字符），请精简或调高设置后重试。`);
      return null;
    }
    clearGlobalError();
    setFieldError('a9-turn-error', '');
    state.localRequest = { prompt, at: Date.now() };
    state.activeTurnId = null;
    el('task-prompt').value = '';
    resizeComposer();
    state.running = true;
    state.streamFollow = true;
    state.conversationSignature = null;
    if (state.snapshot) renderConversation(state.snapshot);
    setTaskState('运行中', 'running', 'Agent 正在读取事实并执行工具。');
    syncComposer();
    startLiveTracking();
    const finishPolling = beginSnapshotPolling();
    let response;
    try {
      response = await a9.submitTurn(prompt);
      if (isCurrent() && response && response.ok !== true) {
        const message = errorMessage(response, '任务执行失败。');
        state.localRequest = null;
        state.conversationSignature = null;
        setFieldError('a9-turn-error', message);
        showGlobalError(message, '打开设置', () => openDrawer('settings-drawer'));
      }
    } catch (error) {
      if (!isCurrent()) return null;
      const message = errorMessage(error, '任务执行失败。');
      state.localRequest = null;
      state.conversationSignature = null;
      setFieldError('a9-turn-error', message);
      showGlobalError(message, '重试状态读取', () => { void refreshSnapshot(); });
    } finally {
      await finishPolling();
      if (isCurrent()) {
        state.running = false;
        state.localRequest = null;
        stopLiveTracking();
        await refreshSnapshot();
        await loadConversationEvents();
        syncComposer();
        restoreComposerFocus();
      }
    }
    return response;
  }

  /**
   * 任务结束后把焦点交还输入框，让用户可以直接输入下一条。
   * 只在焦点仍在「本轮相关区域」时才接管：用户若已主动点到设置、审批卡
   * 或其他控件，不抢回来。输入框被禁用（模式未选、Provider 未就绪、
   * 等待审批）时也不接管，避免把焦点塞进不可用控件。
   */
  function restoreComposerFocus() {
    // A9-57：执行对话完成时不把用户从只读查看拉回。
    if (state.browse) return;
    const prompt = el('task-prompt');
    if (!prompt || prompt.disabled) return;
    const active = document.activeElement;
    const withinConversation = !active
      || active === document.body
      || active === document.documentElement
      || (el('conversation') && el('conversation').contains(active))
      || (el('a9-task-stream') && el('a9-task-stream').contains(active))
      || (el('a9-empty-state') && el('a9-empty-state').contains(active));
    if (withinConversation && typeof prompt.focus === 'function') {
      prompt.focus({ preventScroll: true });
    }
  }

  async function continueInterruptedTask(recovery, block) {
    if (state.browse && browseBlocked('继续执行任务')) return null;
    if (!recovery || !recovery.canContinue || state.running || state.continuingTaskId) return null;
    const requestGeneration = state.snapshotGeneration;
    const isCurrent = () => state.activeConversationId === recovery.conversationId && state.snapshotGeneration === requestGeneration;
    state.continuingTaskId = recovery.taskId;
    state.running = true;
    block.continueError = '';
    updateContinuationCard(block, recovery);
    // Focus stays on the task card; continuing does not opt the user into tail scrolling.
    block.continueEl.focus({ preventScroll: true });
    syncComposer();
    startLiveTracking();
    const finishPolling = beginSnapshotPolling();
    let response;
    try {
      response = await a9.continueTask(recovery.conversationId, recovery.taskId, recovery.interruptedTurnId, recovery.recoveryRevision);
      if (isCurrent() && (!response || response.ok !== true || (response.result && !['completed', 'completed_with_warnings', 'needs_approval'].includes(response.result.outcome)))) {
        block.continueError = errorMessage(response, response && response.result && response.result.finalMessage || '继续未完成，事实已保留；请刷新后再次主动尝试。');
        setFieldError('a9-turn-error', block.continueError);
      }
    } catch (error) {
      if (!isCurrent()) return null;
      block.continueError = errorMessage(error, '继续请求失败，事实保留。');
      setFieldError('a9-turn-error', block.continueError);
    } finally {
      await finishPolling();
      if (isCurrent()) {
      state.running = false;
      state.continuingTaskId = null;
      stopLiveTracking();
      state.conversationSignature = null;
      await refreshSnapshot();
      await loadConversationEvents();
      syncComposer();
      if (block.continueEl) block.continueEl.focus({ preventScroll: true });
      else block.root.focus({ preventScroll: true });
      }
    }
    return response;
  }

  async function stopTurn() {
    if (state.browse && browseBlocked('停止任务或后台进程')) return;
    const canStop = state.running || activeManagedProcesses(state.snapshot).length > 0 ||
      Boolean(state.snapshot && state.snapshot.controls && state.snapshot.controls.canStop);
    if (!canStop) return;
    el('cancel-task').disabled = true;
    setTaskState('正在停止', 'running', '正在清理当前任务和受管子进程。');
    try {
      const response = await a9.stop();
      if (!response || response.ok !== true) setFieldError('a9-turn-error', errorMessage(response, '停止请求失败。'));
    } finally {
      await refreshSnapshot();
    }
  }

  function setApprovalBusy(busy) {
    [['a9-approval-approve', '批准此操作'], ['a9-approval-deny', '拒绝']].forEach(([id, label]) => {
      const button = el(id);
      button.disabled = busy;
      button.textContent = busy ? '处理中…' : label;
      if (busy) button.setAttribute('aria-busy', 'true');
      else button.removeAttribute('aria-busy');
    });
  }

  function beginSnapshotPolling() {
    state.snapshotPollingRequests += 1;
    syncSnapshotPolling();
    return async () => {
      state.snapshotPollingRequests -= 1;
      syncSnapshotPolling();
      if (state.snapshotRequest) await state.snapshotRequest.promise;
    };
  }

  function syncSnapshotPolling() {
    const snapshot = state.snapshot;
    // cleanupRequired also covers historical recovery facts. It remains a UI /
    // backend guard, but cannot by itself keep a live refresh timer running.
    const hasLiveManaged = Boolean(snapshot && snapshot.status === 'ready'
      && (snapshot.managedProcesses || []).some((item) =>
        ['running', 'starting'].includes(item.lastProbeStatus) && item.pidReusePossible !== true
        && !['released', 'release_unknown'].includes(item.ownershipState)));
    const needed = (snapshot?.workspaces || []).some(item => item.opened
        && (root.win7AgentStatus.isActive(item.status) || root.win7AgentStatus.isAwaitingUser(item.status)))
      || state.snapshotPollingRequests > 0 || hasLiveManaged
      || Boolean(snapshot && root.win7AgentStatus.isActive(snapshot.agentStatus))
      || Boolean(snapshot && snapshot.queue && !snapshot.queue.paused && snapshot.queue.items.length);
    if (state.snapshotPollingClosed || state.snapshotPollingPauses > 0 || !needed) {
      if (state.stopSnapshotPolling) {
        void state.stopSnapshotPolling();
        state.stopSnapshotPolling = null;
      }
      return;
    }
    if (state.stopSnapshotPolling) return;
    let snapshotRefreshInFlight = null;
    const pollId = root.setInterval(() => {
      if (snapshotRefreshInFlight || state.snapshotRequest) return;
      snapshotRefreshInFlight = Promise.resolve(refreshSnapshot())
        .catch((error) => { if (!state.snapshotPollingClosed) showSnapshotError(error); })
        .finally(() => { snapshotRefreshInFlight = null; });
    }, 500);
    state.stopSnapshotPolling = async () => {
      root.clearInterval(pollId);
      if (snapshotRefreshInFlight) await snapshotRefreshInFlight;
    };
  }

  function openDialog(dialog) {
    if (!dialog) return;
    dialog.hidden = false;
    if (!dialog.open) {
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
    }
  }
  function closeDialog(dialog) {
    if (!dialog) return;
    if (dialog.open && typeof dialog.close === 'function') dialog.close();
    else dialog.removeAttribute('open');
    dialog.hidden = true;
  }

  function configureModeDialog(snapshot, forceOpen) {
    if (state.browse) { if (forceOpen) browseBlocked('修改权限模式'); return; }
    const dialog = el('a9-mode-dialog');
    if (!dialog || !snapshot || snapshot.status !== 'ready') return;
    const supported = SUPPORTED_MODES.has(snapshot.mode);
    const needsSelection = snapshot.mode === 'needs_selection' || !supported;
    const selectedMode = supported ? snapshot.mode : (snapshot.modeRecommended || 'full_access');
    // 轮询每 500ms 重跑本函数。对话框打开期间用户的单选必须先被尊重：只在
    // 对话框由关闭转为打开时按 snapshot 预选，否则用户刚选的 Read Only 会被
    // 下一次轮询改回 Full Access——那是权限选择被静默覆盖，不只是焦点问题。
    const willOpen = forceOpen || (needsSelection && !activeManagedProcesses(snapshot).some((item) => item.cleanupRequired));
    const alreadyOpen = dialog.open === true;
    if (!alreadyOpen || forceOpen) {
      dialog.querySelectorAll('input[name="a9-mode-choice"]').forEach((radio) => {
        radio.checked = radio.value === selectedMode;
      });
    }
    text('a9-mode-workspace', snapshot.workspaceRoot || '尚未绑定工作区');
    text('a9-mode-title', needsSelection ? '选择此工作区的权限' : '更改此工作区的权限');
    text('a9-mode-badge', needsSelection ? '必须选择' : '可随时更改');
    text('a9-mode-intro', snapshot.mode === 'review'
      ? '此工作区保存了不可用的 Review 模式，写入仍会被拒绝。请选择 Full Access 或 Read Only。'
      : needsSelection
        ? '每个工作区单独保存权限。Full Access 使用当前 Windows 用户权限，不提供额外沙箱。'
        : '模式将保存到此工作区；正在执行的任务不会被静默改变。');
    text('a9-mode-apply', needsSelection ? '使用所选模式' : '保存权限模式');
    // 轮询每 500ms 重跑本函数。若直接改 hidden，浏览器会把「正持有焦点」的取消
    // 按钮隐藏，焦点随即掉回 BODY——用户表现为刚点走的焦点被弹窗抢回。因此先把
    // 焦点转移到仍然可见的选项，再调整 hidden。
    const cancel = el('a9-mode-cancel');
    if (cancel.hidden !== needsSelection) {
      if (needsSelection && cancel.contains(document.activeElement)) {
        const fallback = dialog.querySelector('input[name="a9-mode-choice"]:checked')
          || dialog.querySelector('input[name="a9-mode-choice"]');
        if (fallback && typeof fallback.focus === 'function') fallback.focus();
      }
      cancel.hidden = needsSelection;
    }
    dialog.dataset.required = needsSelection ? 'true' : 'false';
    if (willOpen) {
      // 已打开的对话框不再重复 showModal 与抢焦点，否则用户刚移开的焦点会被
      // 下一次轮询拽回，表现为“弹窗关不掉”。
      openDialog(dialog);
      if (!alreadyOpen) {
        const selected = dialog.querySelector('input[name="a9-mode-choice"]:checked');
        if (selected && typeof selected.focus === 'function') selected.focus();
      }
    }
  }

  async function chooseMode() {
    if (state.browse && browseBlocked('修改权限模式')) return;
    const checked = document.querySelector('input[name="a9-mode-choice"]:checked');
    if (!checked || !SUPPORTED_MODES.has(checked.value)) return;
    const button = el('a9-mode-apply');
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    setFieldError('a9-mode-error', '');
    try {
      const response = await a9.setMode(checked.value);
      if (!response || response.ok !== true) {
        setFieldError('a9-mode-error', errorMessage(response, '权限模式保存失败。'));
        return;
      }
      closeDialog(el('a9-mode-dialog'));
      await refreshSnapshot();
    } catch (error) {
      setFieldError('a9-mode-error', errorMessage(error, '权限模式保存失败。'));
    } finally {
      button.disabled = false;
      button.removeAttribute('aria-busy');
    }
  }

  function syncOfficeSelectionUi(actions) {
    const selectionBox = el('a9-approval-selection');
    const list = el('a9-approval-selection-list');
    const applyBtn = el('a9-approval-select-apply');
    const approveBtn = el('a9-approval-approve');
    if (!selectionBox || !list || !applyBtn) return;
    if (!Array.isArray(actions) || !actions.length) {
      selectionBox.hidden = true;
      return;
    }
    const boxes = Array.from(list.querySelectorAll('input[type="checkbox"]'));
    const checkedIds = boxes.filter(box => box.checked).map(box => box.dataset.actionId).filter(Boolean);
    const total = actions.length;
    text('a9-approval-selection-count', `已选 ${checkedIds.length} / ${total}`);
    const narrowed = checkedIds.length > 0 && checkedIds.length < total;
    const busy = Boolean(state.approvalDecision || state.officeSelectionUpdating);
    applyBtn.disabled = busy || !narrowed;
    if (checkedIds.length === 0) {
      text('a9-approval-selection-note', '至少保留 1 项动作；若全部不执行请点击“拒绝”。');
      if (approveBtn) approveBtn.disabled = true;
    } else if (narrowed) {
      text('a9-approval-selection-note', '清单已缩减，请先点击“按勾选更新审批清单”重新绑定后再批准。');
      if (approveBtn) approveBtn.disabled = true;
    } else {
      text('a9-approval-selection-note', '可直接批准，或取消不需要的动作后更新清单。');
      if (approveBtn) approveBtn.disabled = busy;
    }
  }

  function renderApprovalSelection(pending) {
    const box = el('a9-approval-selection');
    const list = el('a9-approval-selection-list');
    const card = el('a9-approval-card');
    if (!box || !list || !card) return;
    const selection = pending && pending.officeSelection;
    const actions = selection && Array.isArray(selection.actions) ? selection.actions : null;
    if (!actions || !actions.length) {
      box.hidden = true;
      delete card.dataset.selectionKey;
      list.textContent = '';
      text('a9-approval-selection-count', '');
      text('a9-approval-selection-note', '');
      const approveBtn = el('a9-approval-approve');
      if (approveBtn && !state.approvalDecision) approveBtn.disabled = false;
      return;
    }
    box.hidden = false;
    const selectionKey = `${pending.approvalId}:${pending.bindingDigest}`;
    if (card.dataset.selectionKey !== selectionKey) {
      card.dataset.selectionKey = selectionKey;
      list.textContent = '';
      actions.forEach((action) => {
        const li = document.createElement('li');
        const label = document.createElement('label');
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = true;
        checkbox.dataset.actionId = String(action.actionId || '');
        checkbox.addEventListener('change', () => { syncOfficeSelectionUi(actions); });
        const span = document.createElement('span');
        const shaShort = action.sourceSha256 ? ` · ${String(action.sourceSha256).slice(0, 8)}…` : '';
        span.textContent = `${action.actionId} · ${action.kind} · ${action.source}${action.destination ? ` → ${action.destination}` : ''}${shaShort}`;
        label.appendChild(checkbox);
        label.appendChild(span);
        li.appendChild(label);
        list.appendChild(li);
      });
    }
    syncOfficeSelectionUi(actions);
  }

  async function applyOfficeSelection() {
    if (state.browse && browseBlocked('更新整理清单')) return null;
    if (state.officeSelectionUpdating || state.approvalDecision) return null;
    const card = el('a9-approval-card');
    const pending = state.snapshot && state.snapshot.pendingApproval;
    const list = el('a9-approval-selection-list');
    if (!card || card.hidden || !pending || !list || typeof a9.selectOfficeActions !== 'function') return null;
    const selectedActionIds = Array.from(list.querySelectorAll('input[type="checkbox"]'))
      .filter(box => box.checked)
      .map(box => box.dataset.actionId)
      .filter(Boolean);
    if (!selectedActionIds.length) return null;
    setFieldError('a9-approval-error', '');
    state.officeSelectionUpdating = true;
    const applyBtn = el('a9-approval-select-apply');
    if (applyBtn) applyBtn.disabled = true;
    try {
      const response = await a9.selectOfficeActions(
        card.dataset.approvalId,
        card.dataset.bindingDigest,
        selectedActionIds,
        card.dataset.conversationId,
        card.dataset.taskId,
        card.dataset.turnId,
      );
      if (!response || response.ok !== true) {
        setFieldError('a9-approval-error', errorMessage(response, '更新整理勾选清单失败，请重试。'));
        return response;
      }
      await refreshSnapshot();
      return response;
    } catch (error) {
      setFieldError('a9-approval-error', errorMessage(error, '更新整理勾选清单失败，请重试。'));
      return null;
    } finally {
      state.officeSelectionUpdating = false;
      if (state.snapshot) renderApproval(state.snapshot);
    }
  }

  function renderOfficeSkills(snapshot) {
    const button = el('a9-office-install-skills');
    const status = el('a9-office-skills-status');
    const confirmBox = el('a9-office-skills-confirm');
    if (!button || !status) return;
    const skills = snapshot && Array.isArray(snapshot.builtinOfficeSkills) ? snapshot.builtinOfficeSkills : [];
    const total = skills.length;
    const installed = skills.filter(s => s.installed).length;
    if (!snapshot || snapshot.status !== 'ready') {
      button.disabled = true;
      button.textContent = '安装内置办公技能';
      if (confirmBox) confirmBox.hidden = true;
      if (!state.officeSkillsBusy) status.textContent = '';
      return;
    }
    if (total > 0 && installed === total) {
      button.disabled = true;
      button.textContent = `内置办公技能已安装 (${installed}/${total})`;
      if (confirmBox) confirmBox.hidden = true;
      if (!state.officeSkillsBusy) status.textContent = '已在 .agents/skills/ 就绪；不覆盖已有技能文件。';
      return;
    }
    if (snapshot.mode !== 'full_access') {
      button.disabled = true;
      button.textContent = '安装内置办公技能';
      if (confirmBox) confirmBox.hidden = true;
      if (!state.officeSkillsBusy) status.textContent = '需 Full Access 权限才可写入工作区技能目录。';
      return;
    }
    button.disabled = state.officeSkillsBusy || state.running;
    button.textContent = installed > 0 ? `安装剩余内置办公技能 (${installed}/${total})` : '安装内置办公技能';
    if (confirmBox && !confirmBox.hidden && confirmBox.dataset.workspaceRoot !== String(snapshot.workspaceRoot || '')) {
      confirmBox.hidden = true;
      delete confirmBox.dataset.workspaceRoot;
    }
    if (!state.officeSkillsBusy && !status.textContent) {
      status.textContent = '先预览将写入的 .agents/skills/ 目标路径再确认安装（不覆盖已有文件）。';
    }
  }

  function openOfficeSkillsConfirm() {
    if (state.browse && browseBlocked('安装内置办公技能')) return;
    const snapshot = state.snapshot;
    const box = el('a9-office-skills-confirm');
    const list = el('a9-office-skills-targets');
    const status = el('a9-office-skills-status');
    if (!box || !list || !snapshot) return;
    const pending = (snapshot.builtinOfficeSkills || []).filter(s => !s.installed);
    if (!pending.length) return;
    list.textContent = '';
    pending.forEach((s) => {
      const li = document.createElement('li');
      li.textContent = `${s.targetPath} — ${s.description}`;
      list.appendChild(li);
    });
    box.dataset.workspaceRoot = String(snapshot.workspaceRoot || '');
    box.hidden = false;
    if (status) status.textContent = `待确认写入 ${pending.length} 个技能文件。`;
    const confirmBtn = el('a9-office-skills-confirm-btn');
    if (confirmBtn && typeof confirmBtn.focus === 'function') confirmBtn.focus();
  }

  function closeOfficeSkillsConfirm() {
    const box = el('a9-office-skills-confirm');
    if (box) {
      box.hidden = true;
      delete box.dataset.workspaceRoot;
    }
  }

  async function installOfficeSkills() {
    if (state.browse && browseBlocked('安装内置办公技能')) return null;
    if (state.officeSkillsBusy || typeof a9.installOfficeSkills !== 'function') return null;
    const button = el('a9-office-install-skills');
    const confirmBtn = el('a9-office-skills-confirm-btn');
    const status = el('a9-office-skills-status');
    state.officeSkillsBusy = true;
    if (button) button.disabled = true;
    if (confirmBtn) confirmBtn.disabled = true;
    if (status) status.textContent = '正在安装内置办公技能…';
    try {
      const response = await a9.installOfficeSkills();
      if (!response || response.ok !== true) {
        if (status) status.textContent = errorMessage(response, '安装失败；若工作区已存在同名技能文件，已拒绝覆盖。');
        return response;
      }
      closeOfficeSkillsConfirm();
      const count = response.result && Array.isArray(response.result.installed)
        ? response.result.installed.filter(i => i.status === 'succeeded').length : 0;
      if (status) status.textContent = `已安装 ${count} 份内置办公技能至 .agents/skills/（可在“改动”中查看与撤销）。`;
      await refreshSnapshot();
      return response;
    } catch (error) {
      if (status) status.textContent = errorMessage(error, '内置办公技能安装失败。');
      return null;
    } finally {
      state.officeSkillsBusy = false;
      if (confirmBtn) confirmBtn.disabled = false;
      if (state.snapshot) renderOfficeSkills(state.snapshot);
    }
  }

  function renderTemplateSamples(snapshot) {
    const dock = el('a9-template-samples');
    const list = el('a9-sample-list');
    if (!dock || !list) return;
    if (state.browse || !snapshot || snapshot.status !== 'ready') {
      dock.hidden = true;
      return;
    }
    const samples = Array.isArray(snapshot.templateSamples) ? snapshot.templateSamples : [];
    if (!samples.length) {
      dock.hidden = true;
      state.officeSampleSignature = null;
      list.textContent = '';
      setFieldError('a9-sample-error', '');
      return;
    }
    dock.hidden = false;
    const signature = JSON.stringify(samples.map(s => [s.sampleId, s.confirmedInViewer, s.confirmedAt || '', state.sampleConfirmBusy === s.sampleId]));
    if (state.officeSampleSignature === signature) return;
    state.officeSampleSignature = signature;
    list.textContent = '';
    samples.forEach((sample) => {
      const li = document.createElement('li');
      li.className = 'sample-confirm-item';
      const title = document.createElement('strong');
      title.textContent = `模板：${sample.templatePath} (${String(sample.templateSha256 || '').slice(0, 8)}…) · 查看环境：${sample.viewerEnvironment}`;
      const paths = document.createElement('span');
      paths.textContent = `普通样张：${sample.normalOutputPath} (${String(sample.normalSampleSha256 || '').slice(0, 8)}…) · 边界样张：${sample.boundaryOutputPath} (${String(sample.boundarySampleSha256 || '').slice(0, 8)}…)`;
      li.appendChild(title);
      li.appendChild(paths);
      const actions = document.createElement('div');
      actions.className = 'sample-confirm-item-actions';
      if (sample.confirmedInViewer) {
        const badge = document.createElement('span');
        badge.className = 'sample-confirm-badge';
        badge.textContent = `已在 ${sample.viewerEnvironment} 确认（可批量输出）`;
        actions.appendChild(badge);
      } else {
        const ackLabel = document.createElement('label');
        const ack = document.createElement('input');
        ack.type = 'checkbox';
        const confirmBtn = document.createElement('button');
        confirmBtn.type = 'button';
        confirmBtn.textContent = state.sampleConfirmBusy === sample.sampleId ? '确认中…' : '确认样张可批量输出';
        confirmBtn.disabled = true;
        ack.addEventListener('change', () => {
          confirmBtn.disabled = !ack.checked || state.sampleConfirmBusy === sample.sampleId;
        });
        confirmBtn.addEventListener('click', () => {
          if (!ack.checked) return;
          void confirmTemplateSample(sample);
        });
        ackLabel.appendChild(ack);
        ackLabel.appendChild(document.createTextNode(` 我已在 ${sample.viewerEnvironment} 核对普通与边界样张`));
        actions.appendChild(ackLabel);
        actions.appendChild(confirmBtn);
      }
      li.appendChild(actions);
      list.appendChild(li);
    });
  }

  async function confirmTemplateSample(sample) {
    if (state.browse && browseBlocked('确认模板样张')) return null;
    if (!sample || state.sampleConfirmBusy || typeof a9.confirmTemplateSample !== 'function') return null;
    setFieldError('a9-sample-error', '');
    state.sampleConfirmBusy = sample.sampleId;
    state.officeSampleSignature = null;
    if (state.snapshot) renderTemplateSamples(state.snapshot);
    try {
      const response = await a9.confirmTemplateSample({
        sampleId: sample.sampleId,
        viewerEnvironment: sample.viewerEnvironment,
        normalSampleSha256: sample.normalSampleSha256,
        boundarySampleSha256: sample.boundarySampleSha256,
      });
      if (!response || response.ok !== true) {
        setFieldError('a9-sample-error', errorMessage(response, '样张确认失败，文件可能已修改，请重新生成样张。'));
        return response;
      }
      await refreshSnapshot();
      return response;
    } catch (error) {
      setFieldError('a9-sample-error', errorMessage(error, '样张确认失败，请检查文件状态后重试。'));
      return null;
    } finally {
      state.sampleConfirmBusy = null;
      state.officeSampleSignature = null;
      if (state.snapshot) renderTemplateSamples(state.snapshot);
    }
  }

  function renderApproval(snapshot) {
    const card = el('a9-approval-card');
    const pending = snapshot.pendingApproval;
    const surrogateEl = el('a9-approval-surrogate');
    card.hidden = !pending;
    if (!pending) {
      delete card.dataset.approvalId;
      delete card.dataset.bindingDigest;
      delete card.dataset.conversationId;
      delete card.dataset.taskId;
      delete card.dataset.turnId;
      if (surrogateEl) { surrogateEl.hidden = true; surrogateEl.textContent = ''; }
      renderApprovalSelection(null);
      setFieldError('a9-approval-error', '');
      setApprovalBusy(false);
      return;
    }
    if (card.dataset.approvalId !== pending.approvalId) setFieldError('a9-approval-error', '');
    card.dataset.approvalId = pending.approvalId;
    card.dataset.bindingDigest = pending.bindingDigest;
    card.dataset.conversationId = pending.conversationId;
    card.dataset.taskId = pending.taskId;
    card.dataset.turnId = pending.turnId;
    text('a9-approval-tool', pending.toolName || 'operation');
    text('a9-approval-summary', pending.summary || '高影响操作需要确认。');
    if (surrogateEl) {
      const isSurrogate = /"evidenceClass"\s*:\s*"SURROGATE"|\bSURROGATE\b/.test(String(pending.summary || ''));
      surrogateEl.hidden = !isSurrogate;
      surrogateEl.textContent = isSurrogate
        ? '提示：此操作基于 Mock 模拟邮箱数据（SURROGATE），不代表真实邮箱连接或正式证据。'
        : '';
    }
    text('a9-approval-id', `approval: ${pending.approvalId}`);
    const git = pending.gitBinding;
    text('a9-approval-git', git
      ? `remote=${git.remote || '-'} · branch=${git.branch || '-'} · force=${git.force} · delete=${git.deleteTarget || '-'}`
      : `target digest: ${String(pending.bindingDigest || '').slice(0, 18)}…`);
    renderApprovalSelection(pending);
  }

  async function decideApproval(decision) {
    if (state.browse && browseBlocked('处理审批')) return null;
    if (state.approvalDecision) return state.approvalDecision;
    const card = el('a9-approval-card');
    if (card.hidden || !card.dataset.approvalId) return null;
    const approvalId = card.dataset.approvalId;
    const bindingDigest = card.dataset.bindingDigest;
    const conversationId = card.dataset.conversationId;
    const requestGeneration = state.snapshotGeneration;
    const isCurrent = () => state.activeConversationId === conversationId && state.snapshotGeneration === requestGeneration;
    const taskId = card.dataset.taskId;
    const turnId = card.dataset.turnId;
    setFieldError('a9-approval-error', '');
    setApprovalBusy(true);
    state.approvalDecision = (async () => {
      state.running = true;
      state.streamFollow = true;
      setTaskState('运行中', 'running', '审批已提交，Agent 正在继续执行；可随时停止。');
      syncComposer();
      startLiveTracking();
      const finishPolling = beginSnapshotPolling();
      let response;
      try {
        response = await a9.resumeApproval(approvalId, decision, bindingDigest, conversationId, taskId, turnId);
        if (!isCurrent()) return response;
        if (!response || response.ok !== true) {
          setFieldError('a9-approval-error', errorMessage(response, '审批回复失败，请刷新状态后重试。'));
          return response;
        }
        card.hidden = true;
        return response;
      } catch (error) {
        if (!isCurrent()) return null;
        setFieldError('a9-approval-error', errorMessage(error, '审批回复失败，请重试。'));
        return null;
      } finally {
        await finishPolling();
        if (isCurrent()) {
        state.running = false;
        stopLiveTracking();
        await refreshSnapshot();
        await loadConversationEvents();
        syncComposer();
        state.approvalDecision = null;
        setApprovalBusy(false);
        }
      }
    })();
    return state.approvalDecision;
  }

  function renderQuestion(snapshot) {
    const host = el('a9-question-host');
    const pending = snapshot.pendingQuestion;
    if (!pending) {
      if (state.questionCard) state.questionCard.update(null);
      host.hidden = true;
      host.textContent = '';
      state.questionCard = null;
      return;
    }
    host.hidden = false;
    if (!state.questionCard) {
      const card = document.createElement('section');
      card.id = 'a9-question-card';
      card.className = 'a9-question-card';
      host.textContent = '';
      host.appendChild(card);
      state.questionCard = root.A9QuestionCard.create(card, replyQuestion);
    }
    state.questionCard.update(pending, state.questionReply !== null);
  }

  async function replyQuestion(reply) {
    if (state.browse && browseBlocked('回答问题')) return null;
    if (state.questionReply) return state.questionReply;
    const pending = state.snapshot && state.snapshot.pendingQuestion;
    if (!pending) return null;
    const requestGeneration = state.snapshotGeneration;
    const isCurrent = () => state.activeConversationId === pending.conversationId && state.snapshotGeneration === requestGeneration;
    setFieldError('a9-turn-error', '');
    state.questionReply = (async () => {
      state.running = true;
      state.streamFollow = true;
      setTaskState('正在提交回答', 'running', '回答已提交，正在核对当前任务状态；这不批准任何操作。');
      syncComposer();
      startLiveTracking();
      const finishPolling = beginSnapshotPolling();
      let response;
      try {
        response = await a9.replyQuestion(
          pending.conversationId, pending.questionId, pending.revision, reply.decision, reply.answer,
        );
        if (!isCurrent()) return response;
        if (!response || response.ok !== true) {
          setFieldError('a9-turn-error', errorMessage(response, '回答提交失败，问题仍保留。'));
          return response;
        }
        state.snapshot = { ...state.snapshot, pendingQuestion: null };
        return response;
      } catch (error) {
        if (!isCurrent()) return null;
        setFieldError('a9-turn-error', errorMessage(error, '回答提交失败，问题仍保留。'));
        return null;
      } finally {
        await finishPolling();
        if (isCurrent()) {
        state.running = false;
        stopLiveTracking();
        await refreshSnapshot();
        await loadConversationEvents();
        syncComposer();
        state.questionReply = null;
        if (state.snapshot) renderQuestion(state.snapshot);
        }
      }
    })();
    return state.questionReply;
  }

  async function getReview(turnId) {
    if (state.browse) return null;
    const generation = state.checkpointGeneration;
    const epoch = state.reviewEpoch;
    const response = await a9.getDiff(turnId);
    if (generation !== state.checkpointGeneration || epoch !== state.reviewEpoch) return null;
    if (response && response.ok === true && response.review) {
      state.reviewCache.set(turnId, response.review);
      if (state.snapshot) renderCheckpoints(state.snapshot);
      updateSummaryForTurn(turnId);
    }
    return response;
  }

  async function showDiff(turnId, filePath) {
    if (state.browse && browseBlocked('查看执行改动')) return;
    const generation = state.checkpointGeneration;
    state.reviewOpenTurn = turnId;
    state.reviewOpenFile = filePath || null;
    let response;
    try { response = await getReview(turnId); }
    catch (error) { response = { ok: false, error }; }
    if (generation !== state.checkpointGeneration) return;
    text('a9-diff', response && response.ok === true
      ? (response.diff || []).map((item) => `--- ${item.path} (${item.action})\n${item.diffText}`).join('\n') || '此轮没有文件变更项。'
      : `Diff 读取失败：${errorMessage(response, '服务未返回改动')}，可重试。`);
    if (!response || response.ok !== true) {
      showGlobalError(`Diff 读取失败：${errorMessage(response, '服务未返回改动')}，可重试。`, '重试', () => {
        clearGlobalError();
        if (generation === state.checkpointGeneration) void showDiff(turnId, filePath);
      });
    }
    if (state.snapshot) renderCheckpoints(state.snapshot);
    openInspector('changes');
  }

  function cancelPendingUndo() {
    const pending = state.pendingUndo;
    if (!pending) return;
    root.clearTimeout(pending.timer);
    root.clearInterval(pending.tick);
    state.pendingUndo = null;
    text('a9-undo-state', '已撤回撤销；文件未改动。');
    if (state.snapshot) renderCheckpoints(state.snapshot);
  }

  function queueUndo(kind, turnId, path) {
    if (state.browse && browseBlocked('撤销改动')) return;
    if (state.pendingUndo || state.undoInFlight) return;
    state.reviewOpenTurn = turnId;
    const request = { kind, turnId, path: path || null, conversationId: state.activeConversationId };
    const pending = { ...request, deadline: Date.now() + 5000, timer: null, tick: null };
    pending.timer = root.setTimeout(() => {
      if (state.pendingUndo !== pending) return;
      root.clearInterval(pending.tick);
      state.pendingUndo = null;
      if (state.snapshot) renderCheckpoints(state.snapshot);
      if (request.conversationId === state.activeConversationId) void executeUndo(request);
    }, 5000);
    pending.tick = root.setInterval(() => {
      if (state.pendingUndo === pending && pending.countdownNode) {
        pending.countdownNode.textContent = `将在 ${Math.max(1, Math.ceil((pending.deadline - Date.now()) / 1000))} 秒后撤销。`;
      }
    }, 1000);
    state.pendingUndo = pending;
    text('a9-undo-state', `将在 5 秒后撤销${kind === 'file' ? ` ${path}` : '本轮改动'}；可撤回。`);
    if (state.snapshot) renderCheckpoints(state.snapshot);
  }

  function undoResultText(turnId, response) {
    if (!response || response.ok !== true) return errorMessage(response, '撤销失败。');
    const outcome = response.outcome || { restored: [], errors: [], drifted: [] };
    const review = state.reviewCache.get(turnId);
    const files = review ? review.files || [] : [];
    const messages = [];
    files.forEach((file) => {
      const key = `${turnId}\u0000${file.path}`;
      const drift = (response.driftReasons || []).find((entry) => entry.path === file.path);
      if (drift) {
        const later = drift.kind === 'later_turn' ? turnNumber(drift.laterTurnId) : null;
        const message = drift.kind === 'later_turn'
          ? `${file.path} 在${later === null ? `后续轮次 ${drift.laterTurnId}` : `第 ${later} 轮`}又被修改，先撤销后续轮次对它的修改；工作区未改动。`
          : `${file.path} 在本轮之后被外部修改；为避免覆盖你的修改，已拒绝撤销，工作区未改动。`;
        state.reviewMessages.set(key, message);
        messages.push(message);
      } else if ((outcome.restored || []).some((entry) => entry === file.path || entry.startsWith(`${file.path} (`))) {
        const message = `已撤销 ${file.path}`;
        state.reviewMessages.set(key, message);
        messages.push(message);
      } else if ((outcome.errors || []).some((entry) => entry.includes(file.path))) {
        const message = `${file.path} 未撤销。`;
        state.reviewMessages.set(key, message);
        messages.push(message);
      }
    });
    const covered = messages.length;
    if (!covered && (outcome.restored || []).length) messages.push(`已撤销 ${outcome.restored.length} 个文件。`);
    if (!covered && (outcome.drifted || []).length) messages.push(...outcome.drifted.map((entry) => `未撤销 ${entry}；工作区未改动。`));
    if (outcome.errors && outcome.errors.length) messages.push(...outcome.errors);
    if (!messages.length) messages.push('没有文件被撤销；工作区未改动。');
    return messages.join('\n');
  }

  async function executeUndo(request) {
    if (state.browse && browseBlocked('撤销改动')) return;
    if (!request || request.conversationId !== state.activeConversationId || state.undoInFlight) return;
    state.undoInFlight = request;
    if (state.snapshot) renderCheckpoints(state.snapshot);
    try {
      const response = request.kind === 'file'
        ? await a9.undoFile(request.turnId, request.path, request.confirmationId)
        : await a9.undoTurn(request.turnId, request.confirmationId);
      if (request.conversationId !== state.activeConversationId) return;
      if (response && response.needsConfirmation === true) {
        state.reviewConfirmation = { ...request, confirmationId: response.confirmationId };
        state.reviewOpenTurn = request.turnId;
        text('a9-undo-state', '命令后的状态已重新收集；查看改动后请确认撤销。');
        return;
      }
      state.reviewConfirmation = null;
      text('a9-undo-state', undoResultText(request.turnId, response));
      state.reviewEpoch += 1;
      state.reviewCache.delete(request.turnId);
      await refreshSnapshot();
      if (request.conversationId === state.activeConversationId) {
        try {
          const refreshed = await getReview(request.turnId);
          if (refreshed && refreshed.ok !== true) throw refreshed;
        }
        catch (error) {
          state.checkpointError = `撤销结果已返回，但改动状态刷新失败：${errorMessage(error, '请重试查看改动。')}`;
        }
      }
    } catch (error) {
      if (request.conversationId === state.activeConversationId) text('a9-undo-state', errorMessage(error, '撤销失败；请重试。'));
    } finally {
      if (state.undoInFlight === request) {
        state.undoInFlight = null;
        if (state.snapshot) renderCheckpoints(state.snapshot);
      }
    }
  }

  async function refreshGit() {
    const request = ++state.gitRequest;
    text('a9-git-status', 'Git 状态正在读取…');
    let response;
    try {
      response = await a9.gitStatus();
      if (!response || response.ok !== true || !response.projection) throw response;
    } catch (error) {
      if (request !== state.gitRequest) return;
      const message = `Git 状态读取失败：${errorMessage(error, '服务未返回状态')}，可重试。`;
      text('a9-git-status', message);
      showGlobalError(message, '重试', () => { clearGlobalError(); void refreshGit(); });
      return;
    }
    if (request !== state.gitRequest) return;
    const git = response.projection;
    const count = (git.entries || []).length;
    const divergence = [
      Number.isSafeInteger(git.ahead) && git.ahead > 0 ? `本地领先 ${git.ahead} 提交` : '',
      Number.isSafeInteger(git.behind) && git.behind > 0 ? `本地落后 ${git.behind} 提交` : '',
    ].filter(Boolean);
    const actions = [count > 0 ? `有 ${count} 处变更，可审阅 Diff`
      : git.clean === true ? '工作区干净，无需审阅 Diff' : '', ...divergence].filter(Boolean);
    const gitDiagnostics = (git.diagnostics || []).map(item => `${item.code}: ${item.detail || ''}`).join('；');
    text('a9-git-status', gitDiagnostics || (git.isGit === false
      ? (git.degradedReason || '非 Git 工作区')
      : `${git.branch || '-'} · ${git.clean ? 'clean' : `${count} 处变更`} · 外部机制：${(git.externalMechanisms || []).map((item) => item.kind).join(', ') || '无'}${actions.length ? `。${actions.join('；')}。` : ''}`));
  }

  function providerValues() {
    const provider = state.snapshot && state.snapshot.provider ? state.snapshot.provider : {};
    const values = {
      baseUrl: el('a9-provider-url').value.trim(),
      model: el('a9-provider-model').value.trim(),
      rememberApiKey: el('a9-provider-remember').checked,
      imageInputEnabled: el('a9-provider-images').checked,
    };
    const budgetEl = el('a9-provider-budget');
    const budgetText = budgetEl ? budgetEl.value : '';
    if (budgetEl && budgetEl.validity && budgetEl.validity.badInput) {
      values.contextBudgetChars = '__BAD_INPUT__';
    } else if (budgetText.trim()) {
      const budget = Number(budgetText);
      values.contextBudgetChars = Number.isFinite(budget) ? budget : budgetText.trim();
    }
    const composerEl = el('a9-provider-composer-max');
    const composerText = composerEl ? composerEl.value : '';
    if (composerEl && composerEl.validity && composerEl.validity.badInput) {
      values.composerMaxChars = '__BAD_INPUT__';
    } else if (composerText.trim()) {
      const composerMaxChars = Number(composerText);
      values.composerMaxChars = Number.isFinite(composerMaxChars) ? composerMaxChars : composerText.trim();
    }
    const thinkingMode = el('a9-provider-thinking').value;
    if (thinkingMode === 'auto') {
      if (provider.thinkingEnabled !== undefined) values.thinkingEnabled = null;
    } else {
      values.thinkingEnabled = thinkingMode === 'enabled';
    }
    const effortMode = el('a9-provider-effort').value;
    if (effortMode === 'auto') {
      if (provider.reasoningEffort !== undefined) values.reasoningEffort = null;
    } else {
      values.reasoningEffort = effortMode;
    }
    const apiKey = el('a9-provider-key').value;
    if (apiKey) values.apiKey = apiKey;
    const caBundle = el('a9-provider-ca').value.trim();
    if (caBundle !== String(provider.caBundle || '')) values.caBundle = caBundle || null;
    const headerName = el('a9-provider-header-name').value.trim();
    const headerValue = el('a9-provider-header-value').value;
    const existingHeaderNames = Array.isArray(provider.customHeaderNames) ? provider.customHeaderNames : [];
    if (headerName && headerValue) {
      values.customHeaders = existingHeaderNames.includes(headerName)
        ? Object.fromEntries(existingHeaderNames.map((name) => [name, name === headerName ? headerValue : null]))
        : { [headerName]: headerValue };
    } else if (!headerName && existingHeaderNames.length > 0) {
      values.customHeaders = {};
    }
    const proxyHost = el('a9-provider-proxy-host').value.trim();
    const proxyPort = Number(el('a9-provider-proxy-port').value || 0);
    const existingProxy = provider.proxy || null;
    if (proxyHost && proxyPort > 0) {
      if (!existingProxy || proxyHost !== existingProxy.host || proxyPort !== Number(existingProxy.port)) {
        values.proxy = { host: proxyHost, port: proxyPort };
      }
    } else if (existingProxy) {
      values.proxy = null;
    }
    return values;
  }

  async function applyProvider() {
    if (state.browse && browseBlocked('修改模型设置')) return null;
    const values = providerValues();
    setFieldError('a9-provider-error', '');
    if (!values.baseUrl || !values.model) {
      setFieldError('a9-provider-error', 'Base URL 与模型 ID 都必须填写。');
      return;
    }
    if (Object.prototype.hasOwnProperty.call(values, 'contextBudgetChars')
      && (!Number.isSafeInteger(values.contextBudgetChars) || values.contextBudgetChars < 16000 || values.contextBudgetChars > 1000000)) {
      setFieldError('a9-provider-error', '上下文预算必须是 16000～1000000 的整数。');
      return;
    }
    if (Object.prototype.hasOwnProperty.call(values, 'composerMaxChars')
      && (!Number.isSafeInteger(values.composerMaxChars) || values.composerMaxChars < 1000 || values.composerMaxChars > 1000000)) {
      setFieldError('a9-provider-error', '输入框上限必须是 1000～1000000 的整数。');
      return;
    }
    const headerName = el('a9-provider-header-name').value.trim();
    const headerValue = el('a9-provider-header-value').value;
    const existingHeaderName = state.snapshot && state.snapshot.provider &&
      Array.isArray(state.snapshot.provider.customHeaderNames)
      ? state.snapshot.provider.customHeaderNames[0] || ''
      : '';
    if ((!headerName && headerValue) || (headerName && !headerValue && headerName !== existingHeaderName)) {
      setFieldError('a9-provider-error', '新的自定义 Header 名和值必须同时填写；已保存的同名值可留空以保留。');
      return;
    }
    const proxyHost = el('a9-provider-proxy-host').value.trim();
    const proxyPortText = el('a9-provider-proxy-port').value;
    if ((proxyHost && !proxyPortText) || (!proxyHost && proxyPortText)) {
      setFieldError('a9-provider-error', '代理主机与端口必须同时填写，或同时清空。');
      return;
    }
    const button = el('a9-provider-apply');
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    try {
      const response = await a9.configureProvider(values);
      if (!response || response.ok !== true) {
        setFieldError('a9-provider-error', errorMessage(response, 'Provider 配置失败。'));
        return;
      }
      el('a9-provider-key').value = '';
      el('a9-provider-header-value').value = '';
      await refreshSnapshot();
    } catch (error) {
      setFieldError('a9-provider-error', errorMessage(error, 'Provider 配置失败。'));
    } finally {
      button.disabled = false;
      button.removeAttribute('aria-busy');
    }
  }

  async function probeProvider() {
    if (state.browse && browseBlocked('修改模型设置')) return null;
    const button = el('a9-provider-probe');
    button.disabled = true;
    try {
      const response = await a9.probeProvider();
      text('a9-provider-probe-state', response && response.ok === true
        ? (response.probe.hasToolCalling ? 'tool_calling' : 'chat_only')
        : 'unavailable');
      await refreshSnapshot();
    } finally {
      button.disabled = false;
    }
  }

  function shellValues() {
    const kind = el('a9-shell-kind').value;
    const envOverlay = {};
    for (const rawLine of el('a9-shell-env').value.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const separator = line.indexOf('=');
      if (separator <= 0) throw new Error('环境覆盖必须使用 NAME=value，每行一项。');
      const name = line.slice(0, separator).trim();
      if (Object.prototype.hasOwnProperty.call(envOverlay, name)) throw new Error(`环境变量重复：${name}`);
      envOverlay[name] = line.slice(separator + 1);
    }
    return { kind, envOverlay };
  }

  async function applyShell() {
    if (state.browse && browseBlocked('修改 Shell 设置')) return null;
    setFieldError('a9-shell-settings-error', '');
    const button = el('a9-shell-apply');
    button.disabled = true;
    try {
      const values = shellValues();
      const response = await a9.configureShell(values);
      if (!response || response.ok !== true) {
        setFieldError('a9-shell-settings-error', errorMessage(response, 'Shell 设置失败。'));
        return;
      }
      // 环境值不通过 snapshot/回执重新展示；再次修改时需输入完整覆盖。
      el('a9-shell-env').value = '';
      await refreshSnapshot();
    } catch (error) {
      setFieldError('a9-shell-settings-error', errorMessage(error, 'Shell 设置失败。'));
    } finally {
      button.disabled = false;
    }
  }

  function selectTab(name, focus) {
    if (!TAB_IDS.includes(name)) return;
    TAB_IDS.forEach((tabName) => {
      const tab = el(`inspector-tab-${tabName}`);
      const panel = el(`inspector-panel-${tabName}`);
      const active = tabName === name;
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
      panel.hidden = !active;
    });
    if (focus) el(`inspector-tab-${name}`).focus();
    if (name === 'environment') void refreshGit();
    if (name === 'files' && state.snapshot) void ensureExplorerSession(state.snapshot.workspaceRoot).catch((error) => showGlobalError(errorMessage(error, '文件列表加载失败。')));
  }

  function inspectorIsDrawer() { return root.innerWidth < 1200; }
  function navigationIsDrawer() { return root.innerWidth < 800; }
  /**
   * A9-19（Win7 探索性运行发现）：对话切换/新建与工作区选择后只收起窄屏抽屉；桌面宽度下保持用户当前的
   * 左栏开合状态，不再因这些操作把桌面左栏折叠（A9-16 U05）。
   */
  function dismissNavigationDrawer() {
    if (navigationIsDrawer() && el('navigation-rail').classList.contains('open')) closeNavigation();
  }
  function workbenchRoot() { return document.querySelector('.workbench'); }
  function setWorkbenchPaneClass(name, on) {
    const wb = workbenchRoot();
    if (!wb || !wb.classList || typeof wb.classList.toggle !== 'function') return;
    wb.classList.toggle(name, on);
  }
  function paneContainsFocus(pane) {
    return Boolean(pane && pane.contains && document.activeElement && pane.contains(document.activeElement));
  }
  function openInspector(tabName) {
    if (tabName) selectTab(tabName, false);
    if (!inspectorIsDrawer()) {
      // A9-16 U03/U04/U05：桌面四态只切换状态类，不重建 DOM，保留滚动与焦点上下文。
      setWorkbenchPaneClass('inspector-closed', false);
      el('inspector').classList.remove('open');
      el('inspector-backdrop').hidden = true;
      el('open-inspector').setAttribute('aria-expanded', 'true');
      return;
    }
    setWorkbenchPaneClass('inspector-closed', false);
    state.lastFocused = document.activeElement;
    el('inspector').classList.add('open');
    el('inspector-backdrop').hidden = false;
    el('open-inspector').setAttribute('aria-expanded', 'true');
    el('close-inspector').focus();
  }
  function closeInspector() {
    if (!inspectorIsDrawer()) {
      setWorkbenchPaneClass('inspector-closed', true);
      el('open-inspector').setAttribute('aria-expanded', 'false');
      if (paneContainsFocus(el('inspector'))) el('open-inspector').focus();
      return;
    }
    el('inspector').classList.remove('open');
    el('inspector-backdrop').hidden = true;
    el('open-inspector').setAttribute('aria-expanded', 'false');
    if (state.lastFocused && typeof state.lastFocused.focus === 'function') state.lastFocused.focus();
    state.lastFocused = null;
  }
  function toggleInspector() {
    if (inspectorIsDrawer()) {
      if (el('inspector').classList.contains('open')) closeInspector();
      else openInspector();
      return;
    }
    const wb = workbenchRoot();
    if (wb && wb.classList && wb.classList.contains('inspector-closed')) openInspector();
    else closeInspector();
  }
  function toggleNavigation() {
    if (navigationIsDrawer()) {
      if (el('navigation-rail').classList.contains('open')) closeNavigation();
      else openNavigation();
      return;
    }
    const wb = workbenchRoot();
    if (wb && wb.classList && wb.classList.contains('rail-closed')) openNavigation();
    else closeNavigation();
  }
  function openNavigation() {
    if (!navigationIsDrawer()) {
      setWorkbenchPaneClass('rail-closed', false);
      el('navigation-rail').classList.remove('open');
      el('navigation-backdrop').hidden = true;
      el('open-navigation').setAttribute('aria-expanded', 'true');
      return;
    }
    setWorkbenchPaneClass('rail-closed', false);
    state.lastFocused = document.activeElement;
    el('navigation-rail').classList.add('open');
    el('navigation-backdrop').hidden = false;
    el('open-navigation').setAttribute('aria-expanded', 'true');
    el('close-navigation').focus();
  }
  function closeNavigation() {
    if (!navigationIsDrawer()) {
      setWorkbenchPaneClass('rail-closed', true);
      el('open-navigation').setAttribute('aria-expanded', 'false');
      if (paneContainsFocus(el('navigation-rail'))) el('open-navigation').focus();
      return;
    }
    el('navigation-rail').classList.remove('open');
    el('navigation-backdrop').hidden = true;
    el('open-navigation').setAttribute('aria-expanded', 'false');
    if (state.lastFocused && typeof state.lastFocused.focus === 'function') state.lastFocused.focus();
    state.lastFocused = null;
  }
  /**
   * A9-16 U06：抽屉态（`.open` + backdrop）与桌面折叠态（`.rail-closed` /
   * `.inspector-closed`）是两个互不复用的状态机。本函数是两者唯一的收敛点：
   * 跨断点缩放时只清理失效的一方并重新推导 `aria-expanded`，**不**在桌面断点上
   * 主动折叠侧栏——那会覆盖用户显式打开的侧栏并破坏 U05 的状态保持。
   */
  function syncPaneState() {
    const wb = workbenchRoot();
    const rail = el('navigation-rail');
    const inspector = el('inspector');
    if (!wb || !wb.classList || typeof wb.classList.contains !== 'function' || !rail || !inspector) return;
    const inspectorDrawer = inspectorIsDrawer();
    const navigationDrawer = navigationIsDrawer();
    if (inspectorDrawer) {
      if (!inspector.classList.contains('open')) el('inspector-backdrop').hidden = true;
    } else {
      inspector.classList.remove('open');
      el('inspector-backdrop').hidden = true;
    }
    if (navigationDrawer) {
      if (!rail.classList.contains('open')) el('navigation-backdrop').hidden = true;
    } else {
      rail.classList.remove('open');
      el('navigation-backdrop').hidden = true;
    }
    el('open-inspector').setAttribute('aria-expanded',
      String(inspectorDrawer ? inspector.classList.contains('open') : !wb.classList.contains('inspector-closed')));
    el('open-navigation').setAttribute('aria-expanded',
      String(navigationDrawer ? rail.classList.contains('open') : !wb.classList.contains('rail-closed')));
  }

  function openDrawer(id) {
    const drawer = el(id);
    if (!drawer) return;
    // 设置为全应用操作；只读查看期间暂时关闭入口，返回执行对话后恢复。
    if (id === 'settings-drawer' && state.browse && browseBlocked('打开设置')) return;
    state.lastFocused = document.activeElement;
    drawer.hidden = false;
    el('navigation-rail').classList.remove('open');
    el('navigation-backdrop').hidden = true;
    syncPaneState();
    const workbench = document.querySelector('.workbench');
    if (workbench) workbench.inert = true;
    const focusTarget = drawer.querySelector('input:not(:disabled), button:not(:disabled)');
    if (focusTarget) focusTarget.focus();
  }
  function closeDrawer(id) {
    const drawer = el(id);
    if (!drawer) return;
    drawer.hidden = true;
    const workbench = document.querySelector('.workbench');
    if (workbench) workbench.inert = false;
    if (state.lastFocused && typeof state.lastFocused.focus === 'function') {
      // A drawer may have closed the narrow navigation containing its trigger.
      // Return to the visible navigation toggle rather than a hidden control.
      const target = navigationIsDrawer() && el('navigation-rail').contains(state.lastFocused)
        && !el('navigation-rail').classList.contains('open') ? el('open-navigation') : state.lastFocused;
      target.focus();
    }
    state.lastFocused = null;
  }

  function trapFocus(container, event) {
    const focusable = Array.from(container.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex]:not([tabindex="-1"])'))
      .filter((node) => !node.hidden && node.getAttribute('aria-hidden') !== 'true' && node.getClientRects().length > 0);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  async function refreshDiagnostics() {
    const response = await api.getDiagnostics();
    const target = el('diagnostics');
    target.textContent = '';
    const rows = [
      ['Product', response.product], ['Version', response.version],
      ['Electron', response.runtime && response.runtime.electron], ['Node', response.runtime && response.runtime.node],
      ['Chrome', response.runtime && response.runtime.chrome], ['Architecture', response.runtime && response.runtime.arch],
      ['Platform', response.runtime && response.runtime.platform],
    ];
    const log = response.diagnosticLog || {};
    rows.push(['诊断日志目录', log.directory || '尚未取得']);
    for (const [key, label] of [['writeFailureCount', '日志写入失败'], ['droppedCount', '日志丢弃'], ['suppressedCount', '被抑制的异常']]) {
      if (log[key] > 0) rows.push([label, String(log[key])]);
    }
    if (log.ipcWaitSuspended) rows.push(['IPC 诊断等待', '熔断中']);
    if (state.snapshot) {
      (state.snapshot.persistenceDiagnostics || []).forEach(diagnostic => {
        rows.push(['持久化诊断', `${diagnostic.code}: ${diagnostic.detail}`]);
      });
      rows.push(['A9 Runtime status', state.snapshot.status || '-']);
      rows.push(['A9 Runtime diagnostic', state.snapshot.status === 'ready' ? 'ready' : runtimeDiagnostic(state.snapshot)]);
      rows.push(['上下文预算', String(state.snapshot.contextWindow?.budgetChars || '-')]);
      if (state.snapshot.contextBudgetDiagnostics) {
        rows.push(['上下文预算诊断', `${state.snapshot.contextBudgetDiagnostics.code}: ${state.snapshot.contextBudgetDiagnostics.detail}`]);
      }
      if (state.inboxVisitDiagnostic) {
        rows.push(['收件箱记录查看', `${state.inboxVisitDiagnostic.code} · ${state.inboxVisitDiagnostic.at}`]);
      }
      (state.snapshot.recoveryIgnoreDiagnostics || []).forEach((diagnostic) => {
        rows.push(['恢复区忽略规则', `${diagnostic.code}: ${diagnostic.detail}`]);
      });
    }
    rows.forEach(([label, value]) => {
      const dt = document.createElement('dt');
      const dd = document.createElement('dd');
      dt.textContent = label;
      dd.textContent = value || '-';
      target.appendChild(dt);
      target.appendChild(dd);
    });
  }

  // A9-55：所有目录动作只使用捕获的 preload scope。
  function workdirError(response) {
    const code = response?.error?.code || response?.code;
    return ({
      A9_WORKDIR_NOT_CREATED: '目录尚未创建。',
      A9_WORKDIR_NOT_AUTO: '关联目录不能重命名。',
      A9_CONVERSATION_BUSY: '对话正在运行或仍有后台进程，请结束后重试。',
      A9_WORKDIR_NAME_INVALID: '目录名无效，请使用不超过 20 个字符的有效名称。',
      A9_WORKDIR_NAME_CONFLICT: '目录名已存在或已被预留，请换一个名称。',
      A9_WORKDIR_IDENTITY_CHANGED: '目录身份已变化。请关联已有目录后继续。',
      A9_MODE_SELECTION_REQUIRED: '请先选择此对话的权限模式，再发送保留的消息。',
      A9_WORKSPACE_OVERLAP: '所选目录与已打开的工作区重叠，请选择其他目录。',
      A9_WORKSPACE_LIMIT: '已打开的工作区已达上限，请先关闭其他工作区。',
      A9_SCOPE_STALE: '当前对话目标已变化，请刷新后重试。',
      A9_DRAFT_SAVE_FAILED: '草稿保存失败，请保留输入后重试。',
    })[code] || `目录操作失败${code ? `（${String(code).slice(0, 80)}）` : ''}，请刷新后重试。`;
  }

  function renderWorkdir(snapshot) {
    const info = snapshot && snapshot.workdir;
    const host = el('workdir-control');
    if (!host) return;
    host.hidden = !info;
    if (state.workdirDisplayPath !== (info && info.path)) {
      state.workdirDisplayPath = info && info.path;
      setWorkdirMenu(false);
      el('workdir-path').hidden = true;
      text('workdir-result', '');
    }
    if (!info) { setWorkdirMenu(false); return; }
    text('workdir-label', info.identityChanged ? '目录身份已变化' : info.created ? pathName(info.path) : '未创建');
    el('workdir-label').title = info.path;
    text('workdir-path', info.path);
    text('workdir-warning', info.identityChanged ? '目录身份已变化，已禁用打开与重命名。请关联已有目录。' : '');
    el('workdir-warning').hidden = !info.identityChanged;
    el('workdir-open').disabled = state.workdirBusy || !info.created || info.identityChanged === true;
    el('workdir-rename').disabled = state.workdirBusy || !info.created || info.identityChanged === true || info.origin !== 'auto';
    el('workdir-link').disabled = state.workdirBusy;
  }

  function setWorkdirMenu(open) {
    const menu = el('workdir-menu');
    if (!menu) return;
    menu.hidden = !open;
    el('workdir-label').setAttribute('aria-expanded', String(open));
    if (open) el('workdir-view').focus();
  }

  function bindWorkdirScope(response) {
    state.defaultConversationPending = false;
    state.snapshotGeneration += 1;
    state.snapshot = { ...state.snapshot, scope: response.scope, activeConversationId: response.scope.conversationId,
      workspaceRoot: response.workdir?.path || '', workdir: response.workdir || null };
    state.activeConversationId = response.scope.conversationId;
    state.draftHydratedConversationId = null;
    state.conversationSignature = null;
    resetConversationEvents();
    state.explorerSessionId = null;
    state.explorerRequest += 1;
    state.explorerPath = '';
    state.viewer = null;
    el('workspace-tree').textContent = '';
    el('viewer-panel').hidden = true;
    el('code-viewer').textContent = '';
    setWorkdirMenu(false);
    renderWorkdir(state.snapshot);
  }

  // A9-56（ADR-0324）：只用于“不选目录，直接开始”的新对话首轮；其他工作区的已保存模式不受影响。
  const DEFAULT_CONVERSATION_MODE = 'full_access';

  async function prepareDefaultConversation() {
    if (state.browse && browseBlocked('新建对话')) return;
    if (state.workspaceOperation) return;
    state.workspaceOperation = true;
    try {
      const saved = await saveDraftNow();
      if (saved && !saved.ok) { setFieldError('conversation-new-error', '草稿保存失败，请保留输入后重试。'); return; }
      state.snapshotGeneration += 1;
      state.defaultConversationPending = true;
      state.defaultPreviousScope = state.snapshot && state.snapshot.scope;
      if (state.snapshot) renderConversationDirectory({ ...state.snapshot, activeConversationId: null });
      state.snapshot = null;
      state.activeConversationId = null;
      state.renderedConversationId = null;
      state.running = false;
      state.localRequest = null;
      state.explorerSessionId = null;
      state.explorerRequest += 1;
      state.draftHydratedConversationId = null;
      stopLiveTracking();
      resetConversationEvents();
      clearGlobalError();
      closeDialog(el('conversation-new-dialog'));
      closeDialog(el('a9-mode-dialog'));
      ['a9-managed-processes', 'a9-template-samples', 'a9-approval-card', 'a9-question-host', 'a9-empty-state', 'viewer-panel'].forEach((id) => { if (el(id)) el(id).hidden = true; });
      // A9-56（ADR-0324）：本入口的新对话首轮使用 Full Access，发送前即在权限标签可见；创建后可照常切换。
      const modeButton = el('a9-mode-open');
      modeButton.hidden = false;
      modeButton.disabled = true;
      modeButton.textContent = '权限：Full Access';
      modeButton.title = '新对话首条消息以 Full Access 启动；创建后可在此切换权限。';
      el('workspace-tree').textContent = '';
      el('task-prompt').value = '';
      text('draft-status', '');
      text('workbench-title', '新对话');
      text('workspace-label', '默认工作目录');
      renderComposerWorkspace(null);
      renderWorkdir(null);
      setTaskState('待发送', 'idle');
    } finally {
      state.workspaceOperation = false;
      syncComposer();
      el('task-prompt').focus();
    }
  }

  async function submitDefaultPrompt() {
    if (state.browse && browseBlocked('发送消息')) return null;
    const prompt = el('task-prompt').value.trim();
    if (!prompt || !canSubmit()) return null;
    const providerMax = state.snapshot && state.snapshot.provider && state.snapshot.provider.composerMaxChars;
    const promptNode = el('task-prompt');
    const maxPromptChars = (Number.isSafeInteger(providerMax) && providerMax >= 1000)
      ? providerMax
      : (promptNode && Number.isSafeInteger(promptNode.maxLength) && promptNode.maxLength >= 1000 ? promptNode.maxLength : 128000);
    if (prompt.length > maxPromptChars) {
      setFieldError('a9-turn-error', `输入长度超过当前上限（${maxPromptChars} 字符），请精简或调高设置后重试。`);
      return null;
    }
    state.workspaceOperation = true;
    state.snapshotGeneration += 1;
    state.snapshotPollingPauses += 1;
    syncSnapshotPolling();
    syncComposer();
    clearGlobalError();
    let response;
    try {
      // A9-56（ADR-0324）：不沿用旧工作区的权限；本入口显式以 Full Access 提交首轮，不再发送后补选。
      response = await api.a9.startDefaultConversation(prompt, DEFAULT_CONVERSATION_MODE);
      if (response?.scope) {
        bindWorkdirScope(response);
        if (response.ok === true) el('task-prompt').value = '';
        await refreshSnapshot();
        if (response.ok !== true) {
          el('task-prompt').value = prompt;
          await saveDraftNow();
        }
        await loadConversationEvents();
      }
      if (!response?.ok) showGlobalError(workdirError(response));
      return response;
    } catch (error) {
      showGlobalError(workdirError(error));
      return null;
    } finally {
      state.workspaceOperation = false;
      state.snapshotPollingPauses -= 1;
      syncSnapshotPolling();
      resizeComposer();
    }
  }

  function openWorkdirRename() {
    if (state.browse && browseBlocked('修改工作目录')) return;
    if (el('workdir-rename').disabled) return;
    state.workdirRenameScope = state.snapshot.scope;
    el('workdir-rename-input').value = pathName(state.snapshot.workdir.path);
    setFieldError('workdir-rename-error', '');
    setWorkdirMenu(false);
    openDialog(el('workdir-rename-dialog'));
    el('workdir-rename-input').focus();
    el('workdir-rename-input').select();
  }

  async function runWorkdirAction(action) {
    if (state.browse && browseBlocked('修改或打开工作目录')) return null;
    const scope = action === 'rename' ? state.workdirRenameScope : state.snapshot?.scope;
    if (!scope || state.workspaceOperation || state.workdirBusy) return null;
    if (scope.workspaceId !== state.snapshot?.scope?.workspaceId || scope.conversationId !== state.activeConversationId) {
      setFieldError('workdir-rename-error', '当前对话目标已变化，请关闭后重新打开。'); return null;
    }
    state.workspaceOperation = true;
    state.workdirBusy = true;
    syncComposer();
    state.snapshotGeneration += 1;
    state.snapshotPollingPauses += 1;
    syncSnapshotPolling();
    renderWorkdir(state.snapshot);
    el('workdir-rename-apply').disabled = true;
    setFieldError('workdir-rename-error', '');
    clearGlobalError();
    let response;
    try {
      const saved = await saveDraftNow();
      if (saved && !saved.ok) throw { code: 'A9_DRAFT_SAVE_FAILED' };
      const target = api.a9.forScope(scope);
      response = action === 'rename' ? await target.renameWorkdir(el('workdir-rename-input').value.trim())
        : action === 'link' ? await target.linkWorkdir() : await target.openWorkdir();
      if (response?.cancelled) return response;
      if (!response?.ok) {
        if (action === 'rename') setFieldError('workdir-rename-error', workdirError(response));
        else showGlobalError(workdirError(response));
        return response;
      }
      if (response.scope && response.workdir) bindWorkdirScope(response);
      if (action === 'rename') closeDialog(el('workdir-rename-dialog'));
      await refreshSnapshot();
      if (response.scope) await loadConversationEvents();
      return response;
    } catch (error) {
      if (action === 'rename') setFieldError('workdir-rename-error', workdirError(error));
      else showGlobalError(workdirError(error));
      return null;
    } finally {
      state.workspaceOperation = false;
      state.workdirBusy = false;
      syncComposer();
      state.snapshotPollingPauses -= 1;
      el('workdir-rename-apply').disabled = false;
      renderWorkdir(state.snapshot);
      syncSnapshotPolling();
    }
  }

  function appendWorkdirBoundaryAction(container, data) {
    const scope = state.snapshot?.scope;
    if (state.snapshot?.workdir?.origin !== 'auto' || !scope) return;
    let code = data.error && typeof data.error === 'object' ? data.error.code : data.error;
    if (typeof data.result === 'string') {
      try { code = JSON.parse(data.result)?.error?.code || code; } catch (_error) { /* 有界结果可能被截断；只识别错误信封。 */
        if (/^\s*\{\s*"error"\s*:\s*\{\s*"code"\s*:\s*"WORKSPACE_BOUNDARY_VIOLATION"/.test(data.result)) code = 'WORKSPACE_BOUNDARY_VIOLATION';
      }
    }
    if (!/^WORKSPACE_BOUNDARY_VIOLATION(?::|$)/.test(String(code || ''))) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = '关联已有目录…';
    button.addEventListener('click', () => {
      if (state.snapshot?.scope?.workspaceId === scope.workspaceId && state.activeConversationId === scope.conversationId) void runWorkdirAction('link');
    });
    container.appendChild(button);
  }

  function copyOutput() {
    const output = el('a9-shell-output');
    const selection = root.getSelection();
    const range = document.createRange();
    range.selectNodeContents(output);
    selection.removeAllRanges();
    selection.addRange(range);
    let copied = false;
    try { copied = document.execCommand('copy'); } catch (_error) { copied = false; }
    selection.removeAllRanges();
    text('a9-output-note', copied ? '已复制当前可见输出。' : '复制不可用，请手工选择输出。');
  }

  function copyText(value) {
    const input = document.createElement('textarea');
    input.value = String(value);
    input.setAttribute('readonly', '');
    input.style.position = 'fixed';
    input.style.left = '-9999px';
    document.body.appendChild(input);
    input.select();
    let copied = false;
    try { copied = document.execCommand('copy'); } catch (_error) { copied = false; }
    document.body.removeChild(input);
    return copied;
  }

  // ------------------------------------------------------------------
  // A9-57（ADR-0325）：运行中只读浏览同工作区其他对话。
  // 执行快照、state.activeConversationId、scoped API、事件缓存、草稿、模型与队列继续绑定执行对话 A；
  // state.browse 只保存捕获的 A scope、目标 B、分页、错误与代次，内容放在独立只读容器 #browse-panel。
  // 请求统一经 api.a9.forScope(A scope).browseConversation；B 从不成为任何写 API 的 scope。
  // ------------------------------------------------------------------
  const BROWSE_FACT_PAGE = 20;
  const BROWSE_FACT_WINDOW = 100;
  const BROWSE_EVENT_PAGE = 150;
  const BROWSE_EVENT_WINDOW = 600;
  // 执行侧区域：A 的正文、输入/队列/审批/回答、后台进程处置、目录与权限菜单、检查器。返回后恢复并按快照重绘。
  const BROWSE_HIDDEN_IDS = ['conversation', 'composer-wrap', 'a9-managed-processes', 'a9-template-samples', 'conversation-find', 'workdir-control',
    'a9-mode-open', 'a9-provider-open', 'a9-surface', 'conversation-current-actions', 'workspace-menu', 'conversation-row-menu'];
  const BROWSE_DISABLED_IDS = ['conversation-new', 'conversation-more', 'conversation-filter', 'conversation-find-open',
    'open-settings', 'workspace-select'];
  const BROWSE_ERROR_TEXT = Object.freeze({
    A9_CONVERSATION_MISMATCH: '该对话不属于当前工作区或已不存在',
    A9_SCOPE_STALE: '执行对话或工作区已变化，请返回后重新打开',
    A9_SCOPE_REQUIRED: '当前没有可用的执行对话，无法只读查看',
    A9_SCOPE_INVALID: '查看目标与执行对话不一致，请返回后重新打开',
    A9_PAYLOAD_INVALID: '分页参数无效，请回到最新后再试',
    A9_ACTION_UNAVAILABLE: '当前运行时不提供只读查看',
    ELECTRON_SQLITE_UNAVAILABLE: '当前运行时不提供只读查看',
    A9_DIAGNOSTICS_MODE: '诊断模式不提供只读查看',
  });

  function browseScopeMatches(browse, snapshot) {
    const scope = snapshot && snapshot.scope;
    return Boolean(browse && scope && scope.workspaceId === browse.scope.workspaceId
      && scope.conversationId === browse.scope.conversationId
      && snapshot.activeConversationId === browse.scope.conversationId);
  }

  /** 入口守卫：浏览期间所有写入口（含快捷键与旧 DOM）在此停下，只留可见说明，不派发任何请求。 */
  function browseBlocked(label) {
    if (!state.browse) return false;
    const note = el('browse-guard-note');
    if (note) {
      note.textContent = `只读查看中不能${label}。请先“返回执行对话”。`;
      note.hidden = false;
    }
    return true;
  }

  function newBrowseSection() {
    return { items: [], cursor: null, hasMore: false, loading: false, loaded: false, error: '', failedMode: null, newerReleased: false };
  }

  function applyBrowseChrome() {
    const browsing = Boolean(state.browse);
    setWorkbenchPaneClass('browsing', browsing);
    el('browse-panel').hidden = !browsing;
    el('browse-inspector-note').hidden = !browsing;
    const searching = Boolean(state.browse && state.browse.search);
    if (el('history-search')) el('history-search').hidden = !searching;
    ['browse-facts-section', 'browse-events-section'].forEach(id => { if (el(id)) el(id).hidden = searching; });
    if (!browsing) return;
    BROWSE_HIDDEN_IDS.forEach((id) => { const node = el(id); if (node) node.hidden = true; });
    BROWSE_DISABLED_IDS.forEach((id) => { const node = el(id); if (node) node.disabled = true; });
  }

  function enterBrowseChrome() {
    const prompt = el('task-prompt');
    state.browseReturn = {
      value: prompt.value,
      draftSavePending: Boolean(state.draftTimer),
      selectionStart: prompt.selectionStart,
      selectionEnd: prompt.selectionEnd,
      selectionDirection: prompt.selectionDirection || 'none',
      scrollTop: el('conversation').scrollTop,
      follow: state.streamFollow,
    };
    if (state.draftTimer) {
      root.clearTimeout(state.draftTimer);
      state.draftTimer = null;
    }
    // 菜单与查找属于执行视图；先收起，再记录各入口原值供返回时恢复。
    if (!el('conversation-find').hidden) {
      el('conversation-find').hidden = true;
      el('conversation-find-open').setAttribute('aria-expanded', 'false');
      state.findMatches = [];
      state.findIndex = -1;
    }
    setWorkspaceMenu(false);
    setConversationMenu(false);
    setWorkdirMenu(false);
    closeRowMenu(false);
    cancelPendingUndo();
    state.browseSaved = BROWSE_HIDDEN_IDS.concat(BROWSE_DISABLED_IDS)
      .map((id) => { const node = el(id); return node ? [id, node.hidden, node.disabled] : null; })
      .filter(Boolean);
  }

  /** 打开或切换只读查看。只在执行 scope 与当前快照一致、目标属于当前工作区时生效。 */
  function openBrowse(targetId, options = {}) {
    const snapshot = state.snapshot;
    const scope = snapshot && snapshot.scope;
    if (!scope || typeof scope.workspaceId !== 'string' || typeof scope.conversationId !== 'string'
      || scope.conversationId !== snapshot.activeConversationId) return false;
    if (!api || !api.a9 || typeof api.a9.forScope !== 'function') return false;
    if (state.workspaceOperation || state.defaultConversationPending) return false;
    if (!targetId || (targetId === scope.conversationId && !options.search)) return false;
    const target = (snapshot.conversations || []).find((item) => item.sessionId === targetId);
    if (!target) return false;
    if (state.browse && state.browse.targetId === targetId && Boolean(state.browse.search) === Boolean(options.search) && browseScopeMatches(state.browse, snapshot)) return true;
    const focused = document.activeElement;
    const fromDirectory = Boolean(focused && ['conversation-list', 'conversation-archive-list']
      .some((id) => el(id) && typeof el(id).contains === 'function' && el(id).contains(focused)));
    if (!state.browse) enterBrowseChrome();
    state.browseGeneration += 1;
    state.browse = {
      generation: state.browseGeneration,
      scope: { workspaceId: scope.workspaceId, conversationId: scope.conversationId },
      targetId,
      title: target.title || '新对话',
      archived: target.state === 'archived',
      executionSignature: null,
      facts: newBrowseSection(),
      events: newBrowseSection(),
      search: options.search ? { generation: 0, query: '', results: [], loading: false, nextBefore: null, error: '', navigation: 0 } : null,
    };
    el('browse-guard-note').hidden = true;
    applyBrowseChrome();
    renderBrowseHeader();
    renderBrowseExecution(snapshot);
    renderBrowseSection('facts');
    renderBrowseSection('events');
    el('browse-stream').scrollTop = 0;
    renderConversationDirectory(snapshot);
    if (fromDirectory) focusDirectoryRow({ workspaceId: scope.workspaceId, conversationId: targetId });
    else el('browse-return').focus();
    if (options.search) { renderHistorySearch(); el('history-query').value = ''; el('history-query').focus(); }
    else { void loadBrowsePage('facts', 'initial'); void loadBrowsePage('events', 'initial'); }
    return true;
  }

  /** 退出浏览：作废代次、释放只读 DOM、恢复执行视图入口；用户主动返回时恢复输入草稿的焦点与选区。 */
  function exitBrowse(options = {}) {
    if (!state.browse) return false;
    state.browse = null;
    state.browseGeneration += 1;
    (state.browseSaved || []).forEach(([id, hidden, disabled]) => {
      const node = el(id);
      if (node) { node.hidden = hidden; node.disabled = disabled; }
    });
    state.browseSaved = null;
    ['facts', 'events'].forEach((kind) => renderBrowseSection(kind));
    text('browse-execution-status', '');
    el('browse-guard-note').hidden = true;
    applyBrowseChrome();
    const back = state.browseReturn;
    state.browseReturn = null;
    if (options.rerender !== false && state.snapshot) renderSnapshot(state.snapshot);
    if (options.restoreFocus && back) {
      restoreBrowseReturn(back);
      if (back.draftSavePending && el('task-prompt').value === back.value) scheduleDraftSave();
    }
    return true;
  }

  function restoreBrowseReturn(back) {
    state.streamFollow = back.follow;
    if (back.follow) scrollToLatest();
    else el('conversation').scrollTop = back.scrollTop;
    const prompt = el('task-prompt');
    if (prompt && !prompt.disabled && typeof prompt.focus === 'function') {
      prompt.focus({ preventScroll: true });
      if (prompt.value === back.value && typeof prompt.setSelectionRange === 'function'
        && Number.isInteger(back.selectionStart) && Number.isInteger(back.selectionEnd)) {
        prompt.setSelectionRange(back.selectionStart, back.selectionEnd, back.selectionDirection);
      }
      return;
    }
    const scope = state.snapshot && state.snapshot.scope;
    if (scope) focusDirectoryRow({ workspaceId: scope.workspaceId, conversationId: scope.conversationId });
  }

  function renderBrowseHeader() {
    const browse = state.browse;
    if (!browse) return;
    text('browse-title', browse.search ? '只读历史搜索' : `只读查看：${browse.title}${browse.archived ? '（已归档）' : ''}`);
  }

  function browseExecutionState(snapshot) {
    const managed = activeManagedProcesses(snapshot).length;
    if (snapshot.pendingApproval || snapshot.agentStatus === 'needs_approval') {
      return { label: '等待批准', kind: 'attention', hint: '执行对话有待批准的操作，请返回执行对话处理；此处不显示也不能处理审批。' };
    }
    if (snapshot.pendingQuestion || snapshot.agentStatus === 'needs_input') {
      return { label: '等待回答', kind: 'attention', hint: '执行对话在等待你的回答，请返回执行对话处理。' };
    }
    if (snapshot.agentStatus === 'cancelling') return { label: '正在停止', kind: 'running', hint: '' };
    if (snapshot.agentStatus === 'running') return { label: '运行中', kind: 'running', hint: '继续执行，完成后不会自动切回。' };
    if (managed > 0) return { label: `后台进程运行中 ${managed}`, kind: 'running', hint: '停止后台进程需返回执行对话。' };
    if (root.win7AgentStatus.isFailure(snapshot.agentStatus)) return { label: '失败', kind: 'error', hint: '返回执行对话查看详情。' };
    return { label: '空闲', kind: 'idle', hint: '返回后可继续正常操作。' };
  }

  /** 轮询时只更新执行状态摘要；内容不变时不改 DOM，避免读屏重复播报或打断选区。 */
  function renderBrowseExecution(snapshot) {
    const browse = state.browse;
    const node = el('browse-execution-status');
    if (!browse || !node || !snapshot) return;
    const current = (snapshot.conversations || []).find((item) => item.sessionId === browse.scope.conversationId);
    const status = browseExecutionState(snapshot);
    const title = (current && current.title) || '当前对话';
    const signature = JSON.stringify([title, status.label, status.hint]);
    if (browse.executionSignature === signature) return;
    browse.executionSignature = signature;
    node.textContent = '';
    node.dataset.state = status.kind;
    const label = document.createElement('span');
    label.textContent = '执行对话';
    const name = document.createElement('strong');
    name.textContent = title;
    const tag = document.createElement('span');
    tag.className = `status-tag ${status.kind === 'attention' ? 'denied' : status.kind === 'running' ? 'running' : status.kind === 'error' ? 'failed' : 'stopped'}`;
    tag.textContent = status.label;
    node.appendChild(label);
    node.appendChild(name);
    node.appendChild(tag);
    if (status.hint) {
      const hint = document.createElement('span');
      hint.className = 'browse-execution-hint';
      hint.textContent = status.hint;
      node.appendChild(hint);
    }
  }

  function browseErrorText(error) {
    const code = error && error.error ? error.error.code : error && error.code;
    const safe = typeof code === 'string' && /^[A-Z0-9_]{1,64}$/.test(code) ? code : '';
    // 传输层 message 未必经过脱敏，只显示固定中文与错误码。
    return `${BROWSE_ERROR_TEXT[safe] || '读取失败'}${safe ? `（${safe}）` : ''}，可重试。`;
  }

  function mergeBrowsePage(section, kind, response, mode) {
    if (kind === 'facts') {
      const page = (Array.isArray(response.facts) ? response.facts : [])
        .filter((fact) => fact && typeof fact.taskId === 'string');
      const known = new Set(section.items.map((fact) => fact.taskId));
      section.items = mode === 'older' ? page.filter((fact) => !known.has(fact.taskId)).concat(section.items) : page;
      section.hasMore = response.hasMore === true && Boolean(response.nextBefore);
      section.cursor = section.hasMore ? response.nextBefore : null;
    } else {
      const page = (Array.isArray(response.events) ? response.events : []).map(normalizeQueriedEvent).filter(Boolean);
      const known = new Set(section.items.map((event) => event.eventId));
      section.items = (mode === 'older' ? page.filter((event) => !known.has(event.eventId)).concat(section.items) : page)
        .sort((a, b) => a.eventId - b.eventId);
      section.hasMore = response.hasMore === true && section.items.length > 0;
      section.cursor = section.items.length ? section.items[0].eventId : null;
    }
    // 窗口上限：继续向更早翻页时释放最新一端，保持 DOM 与内存有界；“回到最新”重新读取首页。
    const windowSize = kind === 'facts' ? BROWSE_FACT_WINDOW : BROWSE_EVENT_WINDOW;
    if (section.items.length > windowSize) {
      section.items = section.items.slice(0, windowSize);
      section.newerReleased = true;
    }
  }

  async function loadBrowsePage(kind, mode) {
    const browse = state.browse;
    if (!browse || !browse[kind]) return null;
    const section = browse[kind];
    if (section.loading || (mode === 'older' && (!section.hasMore || section.cursor === null))) return null;
    if (!browseScopeMatches(browse, state.snapshot)) { exitBrowse({ restoreFocus: false }); return null; }
    const generation = browse.generation;
    const isCurrent = () => state.browse === browse && state.browseGeneration === generation
      && browseScopeMatches(browse, state.snapshot);
    const payload = { conversationId: browse.targetId, kind, limit: kind === 'facts' ? BROWSE_FACT_PAGE : BROWSE_EVENT_PAGE };
    if (mode === 'older' && kind === 'facts') payload.before = { createdAt: section.cursor.createdAt, taskId: section.cursor.taskId };
    if (mode === 'older' && kind === 'events') payload.beforeEventId = section.cursor;
    if (mode === 'initial') Object.assign(section, newBrowseSection());
    section.loading = true;
    section.error = '';
    section.failedMode = null;
    renderBrowseSection(kind);
    try {
      const target = api.a9.forScope({ workspaceId: browse.scope.workspaceId, conversationId: browse.scope.conversationId });
      const response = await target.browseConversation(payload);
      if (!isCurrent()) return null;
      if (!response || response.ok !== true || response.conversationId !== browse.targetId) throw response || new Error('A9_BROWSE_FAILED');
      if (typeof response.title === 'string' && response.title) {
        browse.title = response.title.slice(0, 200);
        renderBrowseHeader();
      }
      mergeBrowsePage(section, kind, response, mode);
      section.loaded = true;
      return response;
    } catch (error) {
      if (!isCurrent()) return null;
      section.error = browseErrorText(error);
      section.failedMode = mode;
      return null;
    } finally {
      // 迟到回复（含错误）不改动新目标或执行视图。
      if (isCurrent()) {
        section.loading = false;
        renderBrowseSection(kind);
      }
    }
  }

  function buildBrowseFact(fact) {
    const item = document.createElement('li');
    item.className = 'turn-block browse-fact';
    item.dataset.taskId = fact.taskId;
    const request = document.createElement('div');
    request.className = 'turn-request';
    const head = document.createElement('div');
    head.className = 'turn-request-head';
    const label = document.createElement('strong');
    label.textContent = '请求';
    const time = document.createElement('span');
    time.textContent = fact.createdAt ? new Date(fact.createdAt).toLocaleString() : '';
    head.appendChild(label);
    head.appendChild(time);
    const body = document.createElement('div');
    body.className = 'turn-request-body';
    body.textContent = fact.requestPrompt ? clampText(fact.requestPrompt, NOTE_LIMIT) : '（继续执行的轮次，没有新的请求文本）';
    request.appendChild(head);
    request.appendChild(body);
    const outcome = document.createElement('div');
    const tone = ['failed', 'blocked'].includes(fact.outcome) ? ' fail'
      : ['completed_with_warnings', 'cancelled', 'interrupted'].includes(fact.outcome) ? ' warn' : '';
    outcome.className = `outcome-card${tone}`;
    const outcomeHead = document.createElement('div');
    outcomeHead.className = 'outcome-head';
    const outcomeLabel = document.createElement('strong');
    outcomeLabel.textContent = '最终答复';
    const outcomeState = document.createElement('span');
    outcomeState.textContent = OUTCOME_LABELS[fact.outcome] || String(fact.outcome || '状态未知').slice(0, 40);
    outcomeHead.appendChild(outcomeLabel);
    outcomeHead.appendChild(outcomeState);
    const outcomeBody = document.createElement('div');
    outcomeBody.className = 'outcome-body';
    outcomeBody.textContent = fact.finalMessage ? clampText(fact.finalMessage, NOTE_LIMIT)
      : TERMINAL_OUTCOMES.has(fact.outcome) ? '（没有保存最终答复）' : '（尚未完成，没有最终答复）';
    outcome.appendChild(outcomeHead);
    outcome.appendChild(outcomeBody);
    item.appendChild(request);
    item.appendChild(outcome);
    if (fact.turnId && state.browse) item.appendChild(buildDeliveryCard(state.browse.targetId, fact.turnId, true));
    return item;
  }

  /** 已保存过程记录：只读文本与既有的计划/审批留痕样式，不复用可触发执行、撤销或恢复的卡片。 */
  function buildBrowseEvent(event) {
    const item = document.createElement('li');
    item.className = 'browse-event';
    item.dataset.eventId = String(event.eventId);
    const data = event.data || {};
    if (event.type === 'plan_updated') {
      const card = buildPlanCard(data);
      if (typeof data.plan === 'string') {
        const body = document.createElement('p');
        body.className = 'note-line';
        body.textContent = clampText(data.plan, NOTE_LIMIT);
        card.insertBefore(body, card.children[1] || null);
      }
      item.appendChild(card);
      return item;
    }
    if (event.type === 'approval_invalidated') {
      item.appendChild(buildApprovalRecord('denied', `审批已失效：${String(data.toolName || 'operation').slice(0, 80)}`,
        data.invalidatedAt ? new Date(data.invalidatedAt).toLocaleString() : ''));
      return item;
    }
    if (event.type === 'approval_required' || event.type === 'approval_resolved') {
      const approved = data.decision === 'approved';
      item.appendChild(event.type === 'approval_required'
        ? buildApprovalRecord('pending', `当时请求批准：${String(data.toolName || 'operation').slice(0, 80)}`,
          clampText(data.summary || data.reason || '', 2000))
        : buildApprovalRecord(approved ? 'approved' : 'denied', `${approved ? '已批准' : '已拒绝'}：${String(data.toolName || 'operation').slice(0, 80)}`,
          data.decidedAt ? new Date(data.decidedAt).toLocaleString() : ''));
      return item;
    }
    const head = document.createElement('div');
    head.className = 'browse-event-head';
    const label = document.createElement('span');
    label.className = 'browse-event-label';
    label.textContent = String(event.type === 'tool_start' ? `开始${toolHeadline(data)}`
      : event.type === 'tool_output' ? `${data.stream === 'stderr' ? 'stderr' : 'stdout'} 输出片段` : timelineEntryLabel(event)).slice(0, 300);
    head.appendChild(label);
    if (event.type === 'tool_end' && data.toolName) {
      const [status, statusLabel] = toolEndStatus(data);
      const tag = document.createElement('span');
      tag.className = `status-tag ${status}`;
      tag.textContent = statusLabel;
      head.appendChild(tag);
    }
    const time = document.createElement('time');
    time.textContent = event.timestamp ? new Date(event.timestamp).toLocaleString() : '';
    head.appendChild(time);
    item.appendChild(head);
    const detail = event.type === 'model_note' ? clampText(data.content, NOTE_LIMIT)
      : event.type === 'tool_end' ? clampText(toolDetailText(data), TOOL_OUTPUT_LIMIT)
        : event.type === 'tool_output' && typeof data.text === 'string' ? clampText(data.text, TOOL_OUTPUT_LIMIT) : '';
    if (detail) {
      const pre = document.createElement(event.type === 'model_note' ? 'p' : 'pre');
      pre.className = event.type === 'model_note' ? 'note-line' : 'activity-detail';
      pre.textContent = detail;
      item.appendChild(pre);
    }
    return item;
  }

  function renderBrowseSection(kind) {
    const browse = state.browse;
    const section = browse ? browse[kind] : null;
    const list = el(`browse-${kind}`);
    const older = el(`browse-${kind}-older`);
    const retry = el(`browse-${kind}-retry`);
    const latest = el(`browse-${kind}-latest`);
    if (!list) return;
    if (!section) {
      list.textContent = '';
      list.dataset.signature = '';
      [older, retry, latest].forEach((button) => { button.hidden = true; });
      text(`browse-${kind}-status`, '');
      text(`browse-${kind}-count`, '');
      return;
    }
    const facts = kind === 'facts';
    const items = section.items;
    const key = (entry) => (facts ? entry.taskId : entry.eventId);
    const signature = items.length ? `${browse.generation}:${items.length}:${key(items[0])}:${key(items[items.length - 1])}` : `${browse.generation}:0`;
    // 只在数据真正变化时重建列表；仅加载状态变化不打断用户的文本选择。
    if (list.dataset.signature !== signature) {
      list.dataset.signature = signature;
      list.textContent = '';
      items.forEach((entry) => list.appendChild(facts ? buildBrowseFact(entry) : buildBrowseEvent(entry)));
    }
    retry.hidden = !section.error;
    retry.disabled = section.loading;
    older.hidden = !section.hasMore || Boolean(section.error);
    older.disabled = section.loading;
    older.textContent = section.loading ? '正在加载…' : facts ? '加载更早请求' : '加载更早记录';
    latest.hidden = !section.newerReleased || Boolean(section.error);
    latest.disabled = section.loading;
    const windowSize = facts ? BROWSE_FACT_WINDOW : BROWSE_EVENT_WINDOW;
    text(`browse-${kind}-count`, items.length ? `${items.length}${section.hasMore ? '+' : ''}` : '');
    text(`browse-${kind}-status`, section.error
      || (section.loading && !section.loaded ? '正在读取已保存历史…'
        : section.loaded && !items.length ? (facts ? '这个对话还没有已保存的请求。' : '这个对话没有已保存的过程记录。')
          : section.newerReleased ? `为控制内存只保留 ${windowSize} 条；较新的条目已释放，可“回到最新”重新读取。`
            : section.hasMore ? '只显示最近部分；更早内容仍完整保存在本机，可逐页加载。' : ''));
  }

  // Search lives inside the A9-57 read-only chrome, including for the current
  // conversation. Execution scope and composer state never become search state.
  function openHistorySearch() {
    const snapshot = state.snapshot;
    if (!snapshot || !snapshot.scope) return;
    if (openBrowse(snapshot.activeConversationId, { search: true })) {
      el('history-query').focus();
    }
  }
  function currentHistorySearch() { return state.browse && state.browse.search; }
  function invalidateHistorySearch() {
    const search = currentHistorySearch();
    if (!search) return;
    search.generation += 1; search.navigation += 1; search.loading = false;
    search.results = []; search.nextBefore = null; search.error = ''; search.query = '';
    search.page = 0; search.failedNext = false;
    el('history-source').hidden = true; el('history-source').textContent = '';
    renderHistorySearch();
  }
  function renderHistorySearch() {
    const search = currentHistorySearch();
    if (!search) return;
    text('history-status', search.error || (search.loading ? '正在查询本机保留历史…'
      : search.query ? search.results.length ? `第 ${search.page || 1} 页 · ${search.results.length} 条结果` : '没有匹配的保留历史。'
        : '输入原文后按 Enter 搜索。'));
    el('history-submit').disabled = search.loading;
    el('history-retry').hidden = !search.error;
    el('history-retry').disabled = search.loading;
    el('history-next').hidden = !search.nextBefore || Boolean(search.error);
    el('history-next').disabled = search.loading;
    el('history-first').hidden = !(search.page > 1);
    el('history-first').disabled = search.loading;
    // A loading/error state alone must not replace focused result buttons.
    Array.from(el('history-results').children).forEach(item => { if (item.children[0]) item.children[0].disabled = search.loading; });
    if (search.renderedResults === search.results) return;
    search.renderedResults = search.results;
    const list = el('history-results'); list.textContent = '';
    search.results.forEach(result => {
      const li = document.createElement('li'), button = document.createElement('button');
      button.type = 'button'; button.className = 'history-result'; button.disabled = search.loading;
      button.dataset.source = result.source; button.dataset.id = result.id;
      const head = document.createElement('strong');
      head.textContent = `${result.title || '新对话'}${result.conversationState === 'archived' ? '（已归档）' : ''} · ${result.kind === 'reply' ? '请求 / 答复' : result.kind === 'conversation.request' ? '请求' : '工具 / 错误'}`;
      const time = document.createElement('time'); time.textContent = String(result.createdAt || '');
      const snippet = document.createElement('span'); snippet.textContent = result.snippet;
      button.appendChild(head); button.appendChild(time); button.appendChild(snippet);
      button.addEventListener('click', () => { void locateHistoryResult(result, button); });
      li.appendChild(button); list.appendChild(li);
    });
  }
  async function searchHistoryPage(next) {
    const browse = state.browse, search = currentHistorySearch();
    if (!browse || !search || search.loading || !browseScopeMatches(browse, state.snapshot)) return;
    const query = el('history-query').value;
    if (!query.trim()) { invalidateHistorySearch(); return; }
    const before = next ? search.nextBefore : null;
    if (next && !before) return;
    const generation = ++search.generation; search.navigation += 1;
    const isCurrent = () => state.browse === browse && search.generation === generation && browseScopeMatches(browse, state.snapshot);
    search.query = query; search.loading = true; search.error = ''; search.failedNext = next;
    el('history-source').hidden = true; el('history-source').textContent = '';
    renderHistorySearch();
    try {
      const response = await api.a9.forScope(browse.scope).searchHistory({ query, limit: 20, ...(before ? { before } : {}) });
      if (!isCurrent()) return;
      if (!response || response.ok !== true || !Array.isArray(response.results)) throw response;
      search.results = response.results; search.nextBefore = response.nextBefore || null;
      search.page = next ? (search.page || 1) + 1 : 1;
      el('browse-stream').scrollTop = 0;
    } catch (error) { if (isCurrent()) search.error = browseErrorText(error); }
    finally { if (isCurrent()) { search.loading = false; renderHistorySearch(); } }
  }
  async function locateHistoryResult(result, returnButton) {
    const browse = state.browse, search = currentHistorySearch();
    if (!browse || !search || search.loading || !search.query || !search.results.includes(result) || !browseScopeMatches(browse, state.snapshot)) return;
    const navigation = ++search.navigation, generation = search.generation;
    const isCurrent = () => state.browse === browse && search.generation === generation && search.navigation === navigation && browseScopeMatches(browse, state.snapshot);
    const source = el('history-source'), scrollTop = el('browse-stream').scrollTop;
    source.hidden = false; source.textContent = '正在定位原始消息…';
    source.focus({ preventScroll: true });
    if (typeof source.scrollIntoView === 'function') source.scrollIntoView({ block: 'start' });
    try {
      const response = await api.a9.forScope(browse.scope).locateHistory({ conversationId: result.conversationId, source: result.source, id: result.id, query: search.query });
      if (!isCurrent()) return;
      if (!response || response.ok !== true || response.conversationId !== result.conversationId || !response.message) throw response;
      const message = response.message; source.textContent = '';
      const back = document.createElement('button'); back.type = 'button'; back.textContent = '返回搜索结果';
      back.addEventListener('click', () => { if (!isCurrent()) return; source.hidden = true; search.navigation += 1; el('browse-stream').scrollTop = scrollTop; if (returnButton.isConnected) returnButton.focus({ preventScroll: true }); });
      source.appendChild(back);
      const heading = document.createElement('h3'); heading.textContent = `${message.title || '新对话'} · 原始保留消息（只读）`; source.appendChild(heading);
      const identity = document.createElement('p'); identity.className = 'quiet';
      identity.textContent = `${message.createdAt} · ${message.kind} · task=${message.taskId || 'UNKNOWN'} · turn=${message.turnId || 'UNKNOWN'} · ${message.source}:${message.id}`;
      source.appendChild(identity);
      const body = document.createElement('pre'); body.className = 'history-source-text'; body.textContent = message.text; source.appendChild(body);
      if (message.textOffset > 1 || message.textLength > 24000) {
        const note = document.createElement('p'); note.className = 'quiet'; note.textContent = `原文有界显示：从字符 ${message.textOffset} 起，最多 24000 字符；已截断。`; source.appendChild(note);
      }
      if (message.turnId) source.appendChild(buildDeliveryCard(result.conversationId, message.turnId, true));
      source.focus({ preventScroll: true });
      if (typeof source.scrollIntoView === 'function') source.scrollIntoView({ block: 'start' });
    } catch (error) {
      if (!isCurrent()) return;
      source.textContent = browseErrorText(error);
      source.focus({ preventScroll: true });
      const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = '重试定位';
      retry.addEventListener('click', () => { void locateHistoryResult(result, returnButton); }); source.appendChild(retry);
    }
  }

  function buildDeliveryCard(conversationId, turnId, readOnly, initialOutcome) {
    const card = document.createElement('details'); card.className = 'delivery-card'; card.dataset.turnId = turnId;
    const summary = document.createElement('summary'); summary.textContent = `本轮交付 · ${OUTCOME_LABELS[initialOutcome] || '改动 / 检查 / 未解决 / 撤销'}`; card.appendChild(summary);
    const body = document.createElement('div'); body.className = 'delivery-body'; card.appendChild(body);
    const scope = state.snapshot && state.snapshot.scope, browse = readOnly ? state.browse : null;
    const search = browse && browse.search, searchGeneration = search && search.generation, searchNavigation = search && search.navigation;
    let loading = false, loaded = false, revision = 0;
    card.deliveryStale = true;
    const isCurrent = () => scope && state.snapshot && state.snapshot.scope
      && scope.workspaceId === state.snapshot.scope.workspaceId && scope.conversationId === state.snapshot.scope.conversationId
      && (readOnly ? state.browse === browse && (!search || (search.generation === searchGeneration && search.navigation === searchNavigation)) : !state.browse);
    function line(value, className = '') { const node = document.createElement('p'); node.className = className; node.textContent = value; body.appendChild(node); }
    function button(label, handler) { const node = document.createElement('button'); node.type = 'button'; node.textContent = label; node.addEventListener('click', handler); body.appendChild(node); return node; }
    card.loadDelivery = async () => {
      if (loading || !isCurrent() || (loaded && !card.deliveryStale)) return;
      loading = true; const request = ++revision; const stamp = card.dataset.stamp;
      if (!loaded) { body.textContent = ''; line('正在读取持久化交付事实…', 'quiet'); }
      try {
        const response = await api.a9.forScope(scope).getDelivery({ conversationId, turnId });
        if (!isCurrent() || revision !== request) return;
        if (!response || response.ok !== true || !response.card || response.card.turnId !== turnId || response.card.conversationId !== conversationId) throw response;
        const value = response.card;
        // Polling does not replace details/summary or focus. Unchanged facts do
        // not rebuild even the inner body (expanded state and selection survive).
        const signature = JSON.stringify(value);
        loaded = true; card.deliveryStale = card.dataset.stamp !== stamp;
        if (card.dataset.signature === signature) { if (card.syncDeliveryActions) card.syncDeliveryActions(); return; }
        const focused = document.activeElement;
        const focusLabel = focused && body.contains(focused) ? focused.textContent : null;
        const scroller = el(readOnly ? 'browse-stream' : 'conversation'), scrollTop = scroller.scrollTop;
        card.dataset.signature = signature; body.textContent = '';
        summary.textContent = `本轮交付 · ${OUTCOME_LABELS[value.outcome] || value.outcome || 'UNKNOWN'}`;
        if (value.liveOutcome) line(`当前执行状态：${OUTCOME_LABELS[value.liveOutcome] || value.liveOutcome}；以下为已保存事实。`);
        line(`已保存结果：${OUTCOME_LABELS[value.outcome] || value.outcome || 'UNKNOWN'} · 验证：${value.verification || 'UNKNOWN'}`);
        const changes = value.changes || { evidence: 'UNKNOWN' };
        if (changes.evidence !== 'checkpoint_metadata') line(`改动：UNKNOWN · checkpoint 证据不可用（${changes.diagnostic || 'UNKNOWN'}）。`, 'quiet');
        else {
          line(`改动：checkpoint 记录 ${changes.total} 项${changes.incomplete ? '；轮后收集未完成，清单不完整' : ''}。`);
          (changes.files || []).forEach(file => line(`${file.action} · ${file.path}${file.undone ? ' · 已记录撤销' : ''}${file.warning ? ` · ${file.warning}` : ''}${file.textTruncated ? ' · 文本已截断' : ''}`));
          if (changes.remaining) line(`另有 ${changes.remaining} 项未展开。`, 'quiet');
        }
        line('检查：以下是实际命令观察；退出 0 本身不表示测试已验证。');
        if (!(value.checks || []).length) line('命令观察：UNKNOWN / NOT_PERFORMED（没有保留的执行观察）。', 'quiet');
        (value.checks || []).forEach(check => line(`${check.command}\nexit=${check.exitCode === null ? 'UNKNOWN' : check.exitCode} · ${check.status}${check.timedOut ? ' · 超时' : ''}${check.commandTruncated ? ' · 命令文本已截断' : ''} · event=${check.eventId}`, 'delivery-command'));
        if (value.checksRemaining) line(`另有 ${value.checksRemaining} 条命令观察未展开。`, 'quiet');
        if (value.verificationEvidence) line(`精确验证证据：${value.verificationEvidence.command}\nexit=${value.verificationEvidence.exitCode}${value.verificationEvidence.commandTruncated ? ' · 命令文本已截断' : ''} · event=${value.verificationEvidence.eventId}`, 'delivery-command');
        else line('精确验证证据：UNKNOWN / NOT_PERFORMED（未保留）。', 'quiet');
        const outstanding = ['failed', 'blocked', 'cancelled', 'interrupted', 'completed_with_warnings', 'needs_input', 'needs_approval'].includes(value.outcome);
        line(`未解决：${outstanding ? (OUTCOME_LABELS[value.outcome] || value.outcome) + '；请核对本轮原始过程。' : 'UNKNOWN（没有独立的问题关闭清单）。'}`);
        (value.issues || []).forEach(issue => line(`event=${issue.eventId} · ${issue.text}${issue.textTruncated ? ' · 问题文本已截断' : ''}`));
        if (value.auditTruncated || value.issueLimitReached) line('审计摘要已截断：最多最近 100 条终态 / 工具记录和 20 个问题；更早观察未纳入。', 'quiet');
        if (readOnly) line('撤销 / Diff：只读历史不可操作。请返回执行对话使用原有入口。', 'quiet');
        else {
          line('撤销：沿用当前执行对话的 Diff、倒计时与确认守卫。', 'quiet');
          const canAct = () => isCurrent() && !state.running && !state.snapshot.pendingApproval && !state.snapshot.pendingQuestion
            && value.checkpointAvailable === true && TERMINAL_OUTCOMES.has(value.outcome)
            && activeManagedProcesses(state.snapshot).length === 0;
          const diff = button('查看 Diff', () => { if (canAct()) void showDiff(turnId); });
          const undo = button('撤销入口（先审阅 Diff）', () => { if (canAct()) void showDiff(turnId); });
          const htmlFiles = changes.evidence === 'checkpoint_metadata'
            ? (changes.files || []).filter(file => !file.undone && file.action === 'create' && /\.html?$/i.test(file.path))
            : [];
          htmlFiles.forEach((file) => {
            button(`受限预览 HTML：${file.path}`, async () => {
              if (typeof a9.previewHtmlReport !== 'function') return;
              try {
                const resp = await a9.previewHtmlReport(file.path);
                if (!resp || resp.ok !== true) showGlobalError(errorMessage(resp, 'HTML 受限预览打开失败。'));
              } catch (err) {
                showGlobalError(errorMessage(err, 'HTML 受限预览打开失败。'));
              }
            });
          });
          card.syncDeliveryActions = () => { diff.disabled = undo.disabled = !canAct(); };
          card.syncDeliveryActions();
          if (!canAct()) line('当前轮次仍在执行、等待处理或缺少当前 checkpoint；入口不可用。', 'quiet');
          if (changes.evidence === 'checkpoint_metadata' && changes.total > 0) {
            line(`恢复状态：${changes.incomplete ? '部分记录待核对（仅记录项可校验后撤销）' : '已记录 checkpoint（撤销前核验文件未 drift）'}`, 'quiet');
          }
        }
        button('重新读取交付事实', () => { card.deliveryStale = true; void card.loadDelivery(); });
        if (focusLabel) {
          const replacement = Array.from(body.children).find(node => node.tagName.toLowerCase() === 'button' && node.textContent === focusLabel);
          if (replacement) replacement.focus({ preventScroll: true });
        }
        scroller.scrollTop = scrollTop;
      } catch (error) {
        if (!isCurrent() || revision !== request) return;
        card.deliveryStale = true; body.textContent = ''; line(`交付事实读取失败：${browseErrorText(error)}`, 'quiet');
        button('重试交付摘要', () => { void card.loadDelivery(); });
      } finally { loading = false; }
    };
    card.addEventListener('toggle', () => { if (card.open) void card.loadDelivery(); });
    return card;
  }

  function bind() {
    if (typeof root.addEventListener === 'function') root.addEventListener('beforeunload', () => {
      state.browseGeneration += 1;
      state.snapshotPollingClosed = true;
      state.snapshotGeneration += 1;
      syncSnapshotPolling();
      stopLiveTracking();
      if (state.findObserver) state.findObserver.disconnect();
      root.clearTimeout(state.findTimer);
      root.clearTimeout(state.inboxSettleTimer);
      state.inboxSettleTimer = null;
      cancelPendingUndo();
    });
    el('workdir-label').addEventListener('click', () => {
      const open = el('workdir-menu').hidden;
      setWorkdirMenu(open);
      if (open) void refreshSnapshot();
    });
    el('workdir-view').addEventListener('click', () => { el('workdir-path').hidden = !el('workdir-path').hidden; });
    el('workdir-copy').addEventListener('click', () => {
      const info = state.snapshot && state.snapshot.workdir;
      if (info) text('workdir-result', copyText(info.path) ? '已复制路径。' : '复制失败，请手工选择路径。');
    });
    el('workdir-open').addEventListener('click', () => { void runWorkdirAction('open'); });
    el('workdir-rename').addEventListener('click', openWorkdirRename);
    el('workdir-link').addEventListener('click', () => { void runWorkdirAction('link'); });
    el('workdir-rename-apply').addEventListener('click', () => { void runWorkdirAction('rename'); });
    el('workdir-rename-cancel').addEventListener('click', () => closeDialog(el('workdir-rename-dialog')));
    el('workdir-menu').addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { setWorkdirMenu(false); el('workdir-label').focus(); }
    });
    document.addEventListener('click', (event) => {
      if (!el('workdir-menu').hidden && !el('workdir-control').contains(event.target)) setWorkdirMenu(false);
    });
    el('workspace-select').addEventListener('click', () => { void chooseWorkspace(); });
    if (el('history-open')) {
      // Keep the composer's selection until browse guards are installed.
      // Native mouse focus normally blurs the composer before click runs.
      el('history-open').addEventListener('mousedown', event => event.preventDefault());
      el('history-open').addEventListener('click', openHistorySearch);
    }
    if (el('history-form')) el('history-form').addEventListener('submit', event => { event.preventDefault(); void searchHistoryPage(false); });
    if (el('history-query')) el('history-query').addEventListener('input', invalidateHistorySearch);
    if (el('history-clear')) el('history-clear').addEventListener('click', () => { el('history-query').value = ''; invalidateHistorySearch(); el('history-query').focus(); });
    if (el('history-next')) el('history-next').addEventListener('click', () => { void searchHistoryPage(true); });
    if (el('history-first')) el('history-first').addEventListener('click', () => { void searchHistoryPage(false); });
    if (el('history-retry')) el('history-retry').addEventListener('click', () => { void searchHistoryPage(Boolean(state.browse && state.browse.search && state.browse.search.failedNext)); });
    if (el('history-search')) el('history-search').addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); exitBrowse({ restoreFocus: true }); }
    });
    // A9-57：只读查看的返回、分页与重试。
    el('browse-return').addEventListener('click', () => { exitBrowse({ restoreFocus: true }); });
    ['facts', 'events'].forEach((kind) => {
      el(`browse-${kind}-older`).addEventListener('click', () => { void loadBrowsePage(kind, 'older'); });
      el(`browse-${kind}-latest`).addEventListener('click', () => { void loadBrowsePage(kind, 'initial'); });
      el(`browse-${kind}-retry`).addEventListener('click', () => {
        const section = state.browse && state.browse[kind];
        if (section) void loadBrowsePage(kind, section.failedMode || 'initial');
      });
    });
    el('task-prompt').addEventListener('input', () => { resizeComposer(); scheduleDraftSave(); });
    el('task-prompt').addEventListener('blur', event => {
      if (event.relatedTarget === el('history-open')) return;
      void saveDraftNow();
    });
    el('task-prompt').addEventListener('keydown', (event) => {
      if (!state.running && event.key === 'Enter' && !event.shiftKey && event.isComposing !== true && event.keyCode !== 229) {
        event.preventDefault();
        void submitPrompt();
      }
    });
    el('run-task').addEventListener('click', () => { void submitPrompt(); });
    el('queue-task').addEventListener('click', () => { void updateQueue('add'); });
    el('queue-toggle').addEventListener('click', () => {
      const queue = state.snapshot && state.snapshot.queue;
      if (queue) void updateQueue(queue.paused ? 'resume' : 'pause');
    });
    el('cancel-task').addEventListener('click', () => { void stopTurn(); });
    el('rail-stop').addEventListener('click', () => { void stopTurn(); });
    el('conversation-new').addEventListener('click', () => { void createConversation(); });
    el('conversation-filter').addEventListener('click', (event) => {
      event.stopPropagation();
      setWorkspaceMenu(el('workspace-menu').hidden);
    });
    el('workspace-menu').addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { setWorkspaceMenu(false); el('conversation-filter').focus(); }
    });
    document.addEventListener('click', (event) => {
      const menu = el('workspace-menu');
      if (!menu.hidden && !menu.contains(event.target) && !el('conversation-filter').contains(event.target)) setWorkspaceMenu(false);
    });
    el('conversation-workspace-search').addEventListener('keydown', handlePickerKey);
    el('conversation-pin').addEventListener('click', () => { setConversationMenu(false); togglePinnedConversation(state.activeConversationId); });
    el('workspace-close-cancel').addEventListener('click', () => closeDialog(el('workspace-close-dialog')));
    el('workspace-close-confirm').addEventListener('click', () => { void confirmWorkspaceClose(); });
    el('conversation-new-cancel').addEventListener('click', () => closeDialog(el('conversation-new-dialog')));
    el('conversation-workspace-search').addEventListener('input', () => { state.pickerIndex = 0; renderProjectPicker(); });
    el('conversation-rename').addEventListener('click', () => { setConversationMenu(false); openRenameConversation(); });
    el('conversation-archive').addEventListener('click', () => { setConversationMenu(false); void archiveCurrentConversation(); });
    el('conversation-more').addEventListener('click', () => {
      setConversationMenu(el('conversation-more').getAttribute('aria-expanded') !== 'true');
    });
    el('conversation-current-actions').addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { setConversationMenu(false); el('conversation-more').focus(); }
    });
    document.addEventListener('click', (event) => {
      const menu = el('conversation-current-actions');
      const toggle = el('conversation-more');
      if (!menu.hidden && !menu.contains(event.target) && !toggle.contains(event.target)) setConversationMenu(false);
    });
    el('conversation-rename-cancel').addEventListener('click', () => closeDialog(el('conversation-rename-dialog')));
    el('conversation-rename-apply').addEventListener('click', () => { void applyConversationRename(); });
    // ADR-0114：目录搜索（含已归档，按标题过滤）。
    el('conversation-search').addEventListener('input', (event) => {
      state.searchQuery = String(event.target.value || '').trim().toLocaleLowerCase();
      if (state.snapshot) renderConversationDirectory(state.snapshot);
    });
    el('conversation-find-open').addEventListener('click', openConversationFind);
    el('conversation-find-close').addEventListener('click', closeConversationFind);
    el('conversation-find-input').addEventListener('input', () => {
      state.findIndex = -1;
      refreshConversationFind(true);
    });
    el('conversation-find-prev').addEventListener('click', () => moveConversationMatch(-1));
    el('conversation-find-next').addEventListener('click', () => moveConversationMatch(1));
    el('conversation-find').addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeConversationFind(); }
      if (event.key === 'Enter' && event.target === el('conversation-find-input')) {
        event.preventDefault();
        moveConversationMatch(event.shiftKey ? -1 : 1);
      }
    });
    if (typeof root.MutationObserver === 'function') {
      state.findObserver = new root.MutationObserver(() => {
        if (el('conversation-find').hidden) return;
        root.clearTimeout(state.findTimer);
        state.findTimer = root.setTimeout(() => refreshConversationFind(), 80);
      });
      state.findObserver.observe(el('a9-task-stream'), { childList: true, characterData: true, subtree: true });
    }
    document.querySelectorAll('[data-prompt]').forEach((button) => button.addEventListener('click', () => {
      el('task-prompt').value = button.dataset.prompt;
      resizeComposer();
      scheduleDraftSave();
      el('task-prompt').focus();
    }));
    // ADR-0114：流内滚动与“回到最新”。
    el('conversation').addEventListener('scroll', () => {
      const node = el('conversation');
      state.streamFollow = node.scrollHeight - node.scrollTop - node.clientHeight < 80;
      const jump = el('jump-latest');
      if (jump && state.running) jump.hidden = state.streamFollow;
    });
    el('jump-latest').addEventListener('click', () => {
      state.streamFollow = true;
      scrollToLatest();
      const jump = el('jump-latest');
      if (jump) jump.hidden = true;
    });
    const managedDismissForm = el('a9-managed-dismiss-form');
    if (managedDismissForm) {
      managedDismissForm.addEventListener('submit', (event) => { event.preventDefault(); void confirmManagedDismiss(); });
      el('a9-managed-dismiss-cancel').addEventListener('click', closeManagedDismiss);
      el('a9-managed-dismiss-dialog').addEventListener('cancel', (event) => { event.preventDefault(); closeManagedDismiss(); });
      el('a9-managed-dismiss-dialog').addEventListener('keydown', (event) => {
        if (event.key === 'Escape') { event.preventDefault(); closeManagedDismiss(); }
        if (event.key === 'Tab' && !state.managedDismissBusy) {
          const first = el('a9-managed-dismiss-cancel'), last = el('a9-managed-dismiss-confirm');
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        }
      });
    }
    el('a9-mode-open').addEventListener('click', () => { if (state.snapshot) configureModeDialog(state.snapshot, true); });
    el('a9-mode-apply').addEventListener('click', () => { void chooseMode(); });
    el('a9-mode-cancel').addEventListener('click', () => closeDialog(el('a9-mode-dialog')));
    el('a9-mode-dialog').addEventListener('cancel', (event) => { if (el('a9-mode-dialog').dataset.required === 'true') event.preventDefault(); });
    el('a9-provider-open').addEventListener('click', () => openDrawer('settings-drawer'));
    el('open-settings').addEventListener('click', () => openDrawer('settings-drawer'));
    el('open-diagnostics').addEventListener('click', () => { openDrawer('diagnostics-drawer'); void refreshDiagnostics(); });
    document.querySelectorAll('[data-close]').forEach((button) => button.addEventListener('click', () => closeDrawer(button.dataset.close)));
    ['a9-provider-url', 'a9-provider-model'].forEach((id) => el(id).addEventListener('input', () => { el('a9-provider-images').checked = false; }));
    el('a9-provider-apply').addEventListener('click', () => { void applyProvider(); });
    el('a9-provider-probe').addEventListener('click', () => { void probeProvider(); });
    el('a9-shell-path').readOnly = true;
    el('a9-shell-path').placeholder = '应用后由系统文件选择器确定';
    const shellVersion = el('a9-shell-version');
    shellVersion.disabled = true;
    shellVersion.placeholder = '选择后由文件身份自动测量';
    const shellVersionLabel = document.querySelector('label[for="a9-shell-version"]');
    if (shellVersionLabel) shellVersionLabel.textContent = '测量版本（不可编辑）';
    el('a9-shell-apply').addEventListener('click', () => { void applyShell(); });
    el('a9-approval-approve').addEventListener('click', () => { void decideApproval('approved'); });
    el('a9-approval-deny').addEventListener('click', () => { void decideApproval('denied'); });
    if (el('a9-approval-select-apply')) el('a9-approval-select-apply').addEventListener('click', () => { void applyOfficeSelection(); });
    if (el('a9-office-install-skills')) el('a9-office-install-skills').addEventListener('click', openOfficeSkillsConfirm);
    if (el('a9-office-skills-confirm-btn')) el('a9-office-skills-confirm-btn').addEventListener('click', () => { void installOfficeSkills(); });
    if (el('a9-office-skills-cancel-btn')) el('a9-office-skills-cancel-btn').addEventListener('click', closeOfficeSkillsConfirm);
    el('a9-git-refresh').addEventListener('click', () => { void refreshGit(); });
    el('workspace-refresh').addEventListener('click', () => { void refreshWorkspace(state.explorerPath); });
    el('changes-refresh').addEventListener('click', () => { void refreshSnapshot(); });
    ['activity-refresh', 'file-activity-refresh'].forEach((id) => el(id).addEventListener('click', () => { void loadConversationEvents(); }));
    el('a9-output-copy').addEventListener('click', copyOutput);
    el('workspace-up').addEventListener('click', () => { const parts = state.explorerPath.split(/[\\/]+/).filter(Boolean); parts.pop(); void refreshWorkspace(parts.join('/')); });
    el('viewer-search').addEventListener('input', renderViewer);
    el('viewer-encoding').addEventListener('change', () => { void openWorkspaceFile(state.viewer && state.viewer.path, 1, el('viewer-encoding').value); });
    el('viewer-jump-go').addEventListener('click', () => { const line = Number(el('viewer-jump').value || 1); void openWorkspaceFile(state.viewer && state.viewer.path, line); });
    TAB_IDS.forEach((name, index) => {
      const tab = el(`inspector-tab-${name}`);
      tab.addEventListener('click', () => selectTab(name, false));
      tab.addEventListener('keydown', (event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        const offset = event.key === 'ArrowRight' ? 1 : -1;
        selectTab(TAB_IDS[(index + offset + TAB_IDS.length) % TAB_IDS.length], true);
      });
    });
    el('open-inspector').addEventListener('click', () => toggleInspector());
    el('close-inspector').addEventListener('click', closeInspector);
    el('inspector-backdrop').addEventListener('click', closeInspector);
    el('open-navigation').addEventListener('click', toggleNavigation);
    el('close-navigation').addEventListener('click', closeNavigation);
    el('navigation-backdrop').addEventListener('click', closeNavigation);
    syncPaneState();
    el('refresh-diagnostics').addEventListener('click', () => { void refreshDiagnostics(); });
    const managedDetails = el('a9-managed-details');
    if (managedDetails) {
      // 用户主动收起后记住意图，后续轮询不再自动展开；重新展开则恢复自动展开。
      managedDetails.addEventListener('toggle', () => {
        state.managedUserCollapsed = !managedDetails.open;
      });
    }
    document.addEventListener('keydown', (event) => {
      // ADR-0114：Ctrl+K 聚焦目录搜索；Ctrl+I 切换检查器（A9-16 桌面四态/抽屉）。
      const key = String(event.key || '').toLowerCase();
      if (event.ctrlKey && !event.altKey && !event.shiftKey && key === 'f'
        && !document.querySelector('.drawer:not([hidden]), dialog[open]')) {
        event.preventDefault();
        openConversationFind();
        return;
      }
      if (event.ctrlKey && !event.altKey && !event.shiftKey && key === 'k') {
        event.preventDefault();
        // 搜索框位于左侧导航内；桌面折叠态和窄屏抽屉态都必须先让容器可见，
        // 否则浏览器会接受 focus() 调用却仍把焦点留在原控件。
        openNavigation();
        const search = el('conversation-search');
        search.focus();
        if (typeof search.select === 'function') search.select();
        return;
      }
      if (event.ctrlKey && !event.altKey && !event.shiftKey && key === 'n'
        && !document.querySelector('.drawer:not([hidden]), dialog[open]') && (state.browse || !el('conversation-new').disabled)) {
        event.preventDefault();
        openNavigation();
        void createConversation();
        return;
      }
      if (event.ctrlKey && !event.altKey && !event.shiftKey && key === 'i') {
        event.preventDefault();
        toggleInspector();
        return;
      }
      if (event.key === 'Tab') {
        const drawer = Array.from(document.querySelectorAll('.drawer:not([hidden])')).pop();
        if (drawer) { trapFocus(drawer, event); return; }
        if (inspectorIsDrawer() && el('inspector').classList.contains('open')) { trapFocus(el('inspector'), event); return; }
        if (navigationIsDrawer() && el('navigation-rail').classList.contains('open')) { trapFocus(el('navigation-rail'), event); return; }
      }
      if (event.key !== 'Escape') return;
      const drawer = Array.from(document.querySelectorAll('.drawer:not([hidden])')).pop();
      if (drawer) { event.preventDefault(); closeDrawer(drawer.id); return; }
      if (!el('conversation-find').hidden) { event.preventDefault(); closeConversationFind(); return; }
      if (el('inspector').classList.contains('open')) { event.preventDefault(); closeInspector(); return; }
      if (el('navigation-rail').classList.contains('open')) { event.preventDefault(); closeNavigation(); }
    });
    // A9-16 U06：跨断点只做收敛（清理失效的抽屉/桌面机制 + 重推 aria），
    // 不再在桌面断点调用 closeInspector/closeNavigation——那会在任何一次
    // 窗口缩放时把用户打开的左右栏一起折叠。
    root.addEventListener('resize', syncPaneState);
  }

  async function initialize() {
    if (!api || !a9) {
      showGlobalError('可信 Preload API 不可用。', null, null);
      return;
    }
    bind();
    await refreshSnapshot();
    // History details yield to the first interactive paint. Git/diagnostics load on demand.
    root.setTimeout(() => { void loadConversationEvents(); }, 0);
    text('a9-git-status', 'Git 状态尚未读取，点击刷新。');
    if (!state.snapshot) el('workspace-select').focus();
    api.signalReady();
  }

  root.win7AgentA9Workbench = Object.freeze({
    refreshSnapshot,
    submitPrompt,
    stopTurn,
    continueInterruptedTask,
    decideApproval,
    replyQuestion,
    chooseMode,
    applyProvider,
    selectTab,
  });
  document.addEventListener('DOMContentLoaded', initialize, { once: true });
}(window));
