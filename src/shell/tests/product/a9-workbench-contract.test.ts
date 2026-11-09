import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

function createRendererDomHarness() {
  class FakeNode {
    children: FakeNode[] = [];
    parentNode: FakeNode | null = null;
    dataset: Record<string, string> = {};
    className = '';
    hidden = false;
    disabled = false;
    open = false;
    type = '';
    title = '';
    scrollTop = 0;
    scrollHeight = 0;
    private ownText = '';

    constructor(readonly tagName = 'div') {}

    get textContent() { return this.ownText + this.children.map((child) => child.textContent).join(''); }
    set textContent(value: string) {
      this.ownText = String(value == null ? '' : value);
      this.children.forEach((child) => { child.parentNode = null; });
      this.children = [];
    }
    get firstChild() { return this.children[0] || null; }
    appendChild(child: FakeNode) { child.parentNode = this; this.children.push(child); return child; }
    insertBefore(child: FakeNode, before: FakeNode | null) {
      child.parentNode = this;
      const index = before ? this.children.indexOf(before) : -1;
      if (index >= 0) this.children.splice(index, 0, child); else this.children.push(child);
      return child;
    }
    remove() {
      if (!this.parentNode) return;
      this.parentNode.children = this.parentNode.children.filter((child) => child !== this);
      this.parentNode = null;
    }
    addEventListener() {}
    attributes: Record<string, string> = {};
    setAttribute(name: string, value: string) { this.attributes[name] = String(value); }
    querySelectorAll(selector: string) {
      const matches: FakeNode[] = [];
      const visit = (node: FakeNode) => {
        node.children.forEach((child) => {
          if (selector === 'details' && child.tagName === 'details') matches.push(child);
          if (selector === 'details[open]' && child.tagName === 'details' && child.open) matches.push(child);
          visit(child);
        });
      };
      visit(this);
      return matches;
    }
  }
  const nodes = new Map<string, FakeNode>();
  const node = (id: string, tagName = 'div') => {
    const value = new FakeNode(tagName);
    nodes.set(id, value);
    return value;
  };
  ['a9-task-stream', 'a9-turn-outcome', 'a9-empty-state', 'a9-timeline', 'file-count',
    'file-activity', 'file-empty', 'a9-shell-output'].forEach((id) => node(id, id === 'a9-timeline' || id === 'file-activity' ? 'ul' : 'div'));
  return {
    FakeNode,
    nodes,
    document: {
      getElementById: (id: string) => nodes.get(id) || null,
      createElement: (tagName: string) => new FakeNode(tagName),
    },
  };
}

describe('A9 unified desktop workbench contract', () => {
  const productRoot = path.join(__dirname, '../../product');
  const html = fs.readFileSync(path.join(productRoot, 'renderer/workbench.html'), 'utf8');
  const css = fs.readFileSync(path.join(productRoot, 'renderer/a9-workbench.css'), 'utf8');
  const script = fs.readFileSync(path.join(productRoot, 'renderer/a9-workbench.js'), 'utf8');
  // VM 切片必须带入生产依赖；不为测试的截取边界改写产品实现。
  const outcomeLabels = script.slice(script.indexOf('  const OUTCOME_LABELS ='), script.indexOf('  const state ='));
  const errorFormatter = script.slice(script.indexOf('  function errorMessage('), script.indexOf('  /** ADR-0114 显示上限'));
  const main = fs.readFileSync(path.join(productRoot, 'main.js'), 'utf8');
  const smokeDriver = fs.readFileSync(path.join(__dirname, 'a9-06-driver-entry.cjs'), 'utf8');

  it('loads the unified workbench for the product while preserving the historical A8 smoke entry', () => {
    expect(main).toContain("const legacyRendererEntry = path.join(rendererRoot, 'index.html');");
    expect(main).toContain(": path.join(rendererRoot, 'workbench.html');");
    expect(main).toContain("item.indexOf('--a8-review-smoke-') === 0");
    expect(main).toContain("item.indexOf('--a8-boundary-smoke-') === 0");
    expect(main).toContain("readArgument('--a9-workbench-screenshot=')");
    expect(main).toContain('mainWindow.setContentSize(1366, 768);');
    expect(main).toContain('mainWindow.webContents.setZoomFactor(a9WorkbenchZoom);');
    expect(main).toContain("document.getElementById('workspace-select').focus()");
    expect(main).toContain('mainWindow.webContents.capturePage()');
  });

  it('has one visible A9 task entry and one central approval action area', () => {
    expect((html.match(/id="task-prompt"/g) || [])).toHaveLength(1);
    expect((html.match(/id="run-task"/g) || [])).toHaveLength(1);
    expect((html.match(/id="cancel-task"/g) || [])).toHaveLength(1);
    expect((html.match(/id="a9-approval-card"/g) || [])).toHaveLength(1);
    expect(html).not.toContain('id="a9-prompt"');
    expect(html.indexOf('id="a9-approval-card"')).toBeLessThan(html.indexOf('id="task-prompt"'));
    expect(script).toContain('await a9.submitTurn(prompt)');
    expect(script).toContain("snapshot.provider.probe.classification === 'tool_calling'");
    expect(script).not.toContain('api.submitTask');
    expect(script).toContain('activeManagedProcesses(snapshot)');
    expect(script).toContain('snapshot.controls && snapshot.controls.canStop');
    expect(script).toContain("stopKind === 'turn' ? '停止任务' : stopKind === 'managed_process' ? '停止后台进程' : '停止'");
    expect(script).toContain('应用不会发送终止信号');
    expect(script).toContain('function renderConversation(snapshot)');
    expect((html.match(/id="rail-stop"/g) || [])).toHaveLength(1);
    expect(script).toContain("el('rail-stop').addEventListener('click'");
  });

  it('provides isolated conversation navigation and per-conversation encrypted drafts', () => {
    ['conversation-new', 'conversation-list', 'conversation-rename', 'conversation-archive', 'conversation-archive-list'].forEach((id) => {
      expect(html).toContain(`id="${id}"`);
    });
    expect(script).toContain('function renderConversationDirectory(snapshot)');
    expect(script).toContain('a9.createConversation()');
    expect(script).toContain('a9.activateConversation(conversationId)');
    expect(script).toContain('a9.archiveConversation(state.activeConversationId)');
    expect(script).toContain('a9.restoreConversation(conversationId)');
    expect(script).toContain("root.setTimeout(() => { void saveDraftNow(); }, 450)");
    expect(script).toContain('a9.saveDraft(draftText)');
    expect(css).toContain('.conversation-directory');
    expect(css).toContain('.conversation-list');
  });

  it('shows complete checkpoint identities and rebuilds persisted conversation cards', () => {
    expect(script).toContain('identity.textContent = String(checkpoint.turnId);');
    expect(script).toContain('identity.title = String(checkpoint.turnId);');
    expect(script).not.toContain('String(checkpoint.turnId).slice(0, 16)');
    expect(script).toContain("copy.textContent = '复制 ID';");
    expect(script).toContain('copyText(String(checkpoint.turnId))');
    expect(script).toContain('const facts = snapshot.conversation || [];');
    expect(css).toContain('.checkpoint-id');
    expect(css).toContain('overflow-wrap: anywhere');
  });

  it('waits for A9 managed-process cleanup before Electron quits', () => {
    expect(main).toContain("app.on('before-quit', beginA9ShutdownBeforeQuit)");
    expect(main).toContain('await a9Workspaces.shutdown()');
    expect(main).toContain('A9_SHUTDOWN_RESIDUE');
    expect(main).toContain("dialog.showErrorBox('无法确认安全退出'");
    expect(main).toContain("window.on('close', (event) => {");
    expect(main).toContain('窗口与工作区锁保持可用');
    expect(main).toContain('runnerHelperPath: a9PackageRuntime.runnerHelper');
    expect(main).toContain('requireRunnerHelper: true');
    expect(main).toContain('selectShellExecutable: async (kind) =>');
    expect(main).toContain("properties: ['openFile']");
    expect(main).toContain('Array.isArray(leftToSystem)');
    expect(main).toContain("residueLines.join('\\n')");
    expect(main).not.toContain('String(leftToSystem || []).slice(0, 20).join');
  });

  it('binds approvals to conversation/task/turn and disables both actions while processing', () => {
    expect(script).toContain('card.dataset.conversationId = pending.conversationId');
    expect(script).toContain('card.dataset.taskId = pending.taskId');
    expect(script).toContain('card.dataset.turnId = pending.turnId');
    expect(script).toContain('a9.resumeApproval(approvalId, decision, bindingDigest, conversationId, taskId, turnId)');
    expect(script).toContain("button.textContent = busy ? '处理中…' : label");
    expect(script).toContain("setTaskState('运行中', 'running', '审批已提交");
    expect(script).toContain('const finishPolling = beginSnapshotPolling();');
  });

  it('drives the production workbench contract in the formal Electron smoke', () => {
    expect(smokeDriver).toContain("includes('renderer/workbench.html')");
    expect(smokeDriver).toContain("getElementById('task-prompt')");
    expect(smokeDriver).toContain("getElementById('run-task')");
    expect(smokeDriver).toContain("getElementById(\"cancel-task\")");
    expect(smokeDriver).toContain('A9F0-MAIN-COMPOSER-A9-BOUNDARY');
    expect(smokeDriver).toContain('A9F1-VIEWER-EXPLICIT-GBK');
    expect(smokeDriver).toContain('A9F1-FORMAL-EXPLORER-SESSION');
    expect(smokeDriver).toContain('A9F1-VIEWER-ENCODING-PER-FILE');
    expect(smokeDriver).toContain('A9F1-SHELL-EVENT-DTO-UI');
    expect(smokeDriver).toContain("mode === 'workspace_select' || mode === 'first' || mode === 'stop'");
    expect(smokeDriver).not.toContain('getElementById("a9-prompt")');
    expect(smokeDriver).not.toContain('getElementById("a9-submit")');
    expect(smokeDriver).not.toContain('getElementById("a9-stop")');
  });

  it('limits Alpha 1 mode selection to Full Access and Read Only', () => {
    expect(html).toContain('name="a9-mode-choice" value="full_access"');
    expect(html).toContain('name="a9-mode-choice" value="read_only"');
    expect(html).not.toContain('value="review"');
    expect(html).toContain('Full Access 直接写入工作区，完成后可在“改动”中审阅和撤销文件');
    expect(script).toContain("const SUPPORTED_MODES = new Set(['full_access', 'read_only']);");
    expect(script).toContain("snapshot.mode === 'review'");
  });

  it('uses contextual Inspector tabs instead of a long duplicate control stack', () => {
    ['files', 'changes', 'activity', 'environment'].forEach((name) => {
      expect(html).toContain(`id="inspector-tab-${name}"`);
      expect(html).toContain(`id="inspector-panel-${name}"`);
    });
    expect(html).not.toContain('Provider 配置（任意 Base URL');
    expect(html).not.toContain('A8 历史能力');
    expect(script).toContain("const TAB_IDS = ['files', 'changes', 'activity', 'environment'];");
  });

  it('uses the A9 bounded reader with visible encoding recovery for the code Viewer', () => {
    expect(html).toContain('id="viewer-encoding"');
    expect(html).toContain('value="gbk"');
    expect(html).toContain('value="utf-16le"');
    expect(script).toContain('await a9.readWorkspaceFile(filePath');
    expect(script).not.toContain('api.readWorkspaceFile(state.explorerSessionId');
    expect(script).toContain('无法自动识别为文本');
    expect(script).toContain("el('viewer-encoding').addEventListener('change'");
    expect(script).toContain('const sameFile = Boolean(state.viewer && state.viewer.path === filePath);');
    expect(script).toContain("? (sameFile ? el('viewer-encoding').value : '')");
    expect(css).toContain('grid-template-columns: 104px minmax(0, 1fr) 64px 52px');
  });

  it('renders versioned Shell events and refreshes activity while a Turn is running', () => {
    expect(script).toContain('data.shell && data.shell.schemaVersion === 1');
    expect(script).toContain('shell && shell.stdout');
    expect(script).toContain('root.setInterval(() => {');
    expect(script).toContain('snapshotRefreshInFlight = Promise.resolve(refreshSnapshot())');
    expect(script).toContain('if (snapshotRefreshInFlight) await snapshotRefreshInFlight;');
    expect(script).toContain('root.clearInterval(pollId);');
  });

  it('keeps Provider secrets in one progressive Settings surface with mandatory TLS verification', () => {
    expect((html.match(/id="a9-provider-key"/g) || [])).toHaveLength(1);
    expect((html.match(/id="a9-provider-apply"/g) || [])).toHaveLength(1);
    expect(html).toContain('<summary>企业网络</summary>');
    expect(html).toContain('TLS 证书与主机名验证始终开启');
    expect(html).not.toContain('a9-provider-insecure');
    expect(html).not.toContain('a9-insecure-dialog');
    expect(script).not.toContain('allowInsecureTLS');
    expect(script).toContain("el('a9-provider-key').value = '';");
    expect(script).toContain("el('a9-provider-header-value').value = '';");
    expect(script).toContain("setFieldError('a9-provider-diagnostics'");
    expect(script).toContain('provider.customHeaderNames || []');
    expect(script).toContain("el('a9-provider-ca').value = provider.caBundle || '';");
    expect(script).toContain('headerName !== existingHeaderName');
  });

  it('exposes user-explicit Shell settings without echoing saved environment values', () => {
    ['a9-shell-kind', 'a9-shell-path', 'a9-shell-version', 'a9-shell-env', 'a9-shell-apply'].forEach((id) => {
      expect(html).toContain(`id="${id}"`);
    });
    expect(html).toContain('每行 NAME=value');
    expect(html).toContain('已保存的值不会回显');
    expect(script).toContain('await a9.configureShell(values)');
    expect(script).toContain("el('a9-shell-env').value = '';");
    expect(script).toContain("el('a9-shell-path').readOnly = true;");
    expect(script).toContain('shellVersion.disabled = true;');
    expect(script).toContain("shellVersionLabel.textContent = '测量版本（不可编辑）';");
    expect(script).not.toContain("const version = el('a9-shell-version').value.trim();");
    expect(script).toContain('shell.envKeys.join');
  });

  it('preserves the local CSP and Renderer isolation boundary', () => {
    expect(html).toContain("default-src 'none'");
    expect(html).toContain("connect-src 'none'");
    expect(html).toContain("frame-src 'none'");
    expect(script).not.toMatch(/require\(|child_process|\bfetch\(|WebSocket\(|XMLHttpRequest/);
    expect(script).toContain('const api = root.win7Agent;');
  });

  it('shows bounded A9 initialization diagnostics instead of misreporting a mode-selection problem', () => {
    expect(script).toContain('function runtimeDiagnostic(snapshot)');
    expect(script).toContain("setFieldError('a9-runtime-error', runtimeError)");
    expect(script).toContain('Runtime 初始化受限：${runtimeDiagnostic(snapshot)}');
    expect(script).toContain("rows.push(['A9 Runtime diagnostic'");
  });

  it('does not submit Enter while a Chinese IME composition is active, including legacy keyCode 229', () => {
    const listeners: Record<string, Array<(event?: any) => any>> = {};
    const nodes = new Map<string, any>();
    class FakeNode {
      value = '';
      hidden = false;
      disabled = false;
      readOnly = false;
      dataset: Record<string, string> = {};
      style: Record<string, string> = {};
      className = '';
      classList = { add() {}, remove() {}, contains() { return false; } };
      addEventListener(type: string, handler: (event: any) => any) {
        (listeners[`${(this as any).id}:${type}`] ||= []).push(handler);
      }
      setAttribute() {}
      removeAttribute() {}
      appendChild() {}
      querySelectorAll() { return []; }
      querySelector() { return null; }
      focus() {}
      getClientRects() { return [{}]; }
    }
    const idPattern = /id="([^"]+)"/g;
    let idMatch: RegExpExecArray | null;
    while ((idMatch = idPattern.exec(html)) !== null) {
      const id = idMatch[1];
      const node: any = new FakeNode();
      node.id = id;
      nodes.set(id, node);
    }
    const documentStub: any = {
      getElementById: (id: string) => nodes.get(id),
      addEventListener: (type: string, handler: (event?: any) => any) => { (listeners[`document:${type}`] ||= []).push(handler); },
      querySelectorAll: () => [],
      querySelector: () => null,
      createElement: () => new FakeNode(),
      createTextNode: () => new FakeNode(),
      body: new FakeNode(),
    };
    const windowStub: any = {
      win7Agent: {
        a9: { snapshot: () => new Promise(() => {}) },
        signalReady: jest.fn(),
      },
      addEventListener: jest.fn(),
      setInterval,
      clearInterval,
      setTimeout,
      clearTimeout,
    };
    vm.runInNewContext(script, { window: windowStub, document: documentStub, console, Promise, Set, Map, Object, Array, String, Number, Date });
    listeners['document:DOMContentLoaded'][0]();
    const keydown = listeners['task-prompt:keydown'][0];
    const composingPrevented = jest.fn();
    keydown({ key: 'Enter', shiftKey: false, isComposing: true, keyCode: 13, preventDefault: composingPrevented });
    expect(composingPrevented).not.toHaveBeenCalled();
    const legacyPrevented = jest.fn();
    keydown({ key: 'Enter', shiftKey: false, isComposing: false, keyCode: 229, preventDefault: legacyPrevented });
    expect(legacyPrevented).not.toHaveBeenCalled();
    const ordinaryPrevented = jest.fn();
    keydown({ key: 'Enter', shiftKey: false, isComposing: false, keyCode: 13, preventDefault: ordinaryPrevented });
    expect(ordinaryPrevented).toHaveBeenCalledTimes(1);
  });

  it('defines semantic light tokens, stable targets, responsive drawers and reduced motion', () => {
    expect(css).toContain('color-scheme: light');
    expect(css).toContain('--bg: #f4f3ef');
    expect(css).toContain('--bg-canvas:');
    expect(css).toContain('--text-primary:');
    expect(css).toContain('--accent: #0f766e');
    expect(css).toContain('--muted: #59616b');
    expect(css).toContain('--font-ui: "Microsoft YaHei", "Microsoft YaHei UI", "Segoe UI", sans-serif');
    expect(css).toContain('font: 15px/1.55 var(--font-ui)');
    expect(css).not.toMatch(/font(?:-size)?:[^;]*(?:9|10)px/);
    expect(css).toContain('min-height: 44px');
    expect(css).toContain('@media (max-width: 1199px)');
    expect(css).toContain('@media (max-width: 799px)');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).toContain('grid-template-columns: 232px minmax(500px, 1fr) 360px');
    expect(script).toContain('function trapFocus(container, event)');
  });

  it('renders ADR-0114 turn process events with bounded text and renderer-safe DOM', () => {
    // 新 HTML 结构：目录搜索（含已归档）、运行状态行与“回到最新”。
    ['conversation-search', 'live-status', 'live-elapsed', 'jump-latest'].forEach((id) => {
      expect(html).toContain(`id="${id}"`);
    });
    expect(html).toContain('role="status"');
    expect(html).toContain('搜索对话标题，包含已归档');
    // 事件数据层：eventId 去重增量并入 + 有界历史回看（截断以 hasMore 明示）。
    expect(script).toContain('function normalizeTimelineEvent(raw)');
    expect(script).toContain('function ingestEvents(events, explicitOlder = false)');
    expect(script).toContain('state.inspectorEvents');
    expect(script).toContain('eventsForInspector().slice(-60)');
    expect(script).toContain('state.turnEvents');
    expect(script).toContain('beforeEventId: state.eventsBeforeId');
    expect(script).toContain('state.eventsTruncated = response.hasMore === true || state.releasedEventCount > 0');
    expect(script).toContain('加载更早记录');
    // 轮次过程渲染：说明行 / 计划条 / 工具活动组（callId 配对）/ 审批留痕。
    ["case 'model_note':", "case 'plan_updated':", "case 'approval_required':",
      "case 'approval_resolved':", "case 'tool_start':", "case 'tool_end':"].forEach((fragment) => {
      expect(script).toContain(fragment);
    });
    expect(script).toContain('function toolHeadline(data)');
    expect(script).toContain("const key = data.callId ? String(data.callId) : '__last__';");
    expect(script).toContain('历史记录未包含过程。');
    // 搜索与键盘：Ctrl+K 聚焦搜索、Ctrl+I 切换检查器；空结果如实提示。
    expect(script).toContain("el('conversation-search').addEventListener('input'");
    expect(script).toContain('state.searchQuery');
    expect(script).toContain('没有匹配的对话。');
    expect(script).toContain("key === 'k'");
    expect(script).toContain("key === 'i'");
    // 等待反馈：本地计时 + >10s 空闲检测；无百分比、无虚构动作。
    expect(script).toContain('function startLiveTracking()');
    expect(script).toContain('function tickLiveStatus()');
    expect(script).toContain('idleMs >= 10000');
    expect(script).toContain('等待模型响应…');
    // 显示上限（ADR-0114）：单条说明 16 KB、单条工具输出 8 KB，截断必须明示。
    expect(script).toContain('const NOTE_LIMIT = 16 * 1024');
    expect(script).toContain('const TOOL_OUTPUT_LIMIT = 8 * 1024');
    expect(script).toContain('已截断；完整内容见持久化事件与日志');
    // 渲染安全：唯一 innerHTML 为静态状态图标，不可信文本一律 textContent。
    expect((script.match(/innerHTML/g) || [])).toHaveLength(1);
    expect(script).toContain("runtimeStatus.innerHTML = '<i aria-hidden=\"true\"></i>'");
    expect(script).toContain('clampText(data.content, NOTE_LIMIT)');
  });

  it('classifies actual tool failure, cancellation and uncertain cleanup without claiming success', () => {
    const source = script.slice(script.indexOf('  function toolEndStatus('), script.indexOf('  function timelineEntryLabel('));
    const context: any = {};
    vm.runInNewContext(source + ';this.classify = toolEndStatus;', context);
    expect(context.classify({ shell: { exitCode: 1 } })[0]).toBe('failed');
    expect(context.classify({ result: 'Tool execution error: file not found' })[0]).toBe('failed');
    // A9-46 real tool_end: execution exceptions are serialized into result,
    // while cancelling ask_user emits a top-level cancelled flag.
    expect(context.classify({ toolName: 'read', result: JSON.stringify({ error: { code: 'ENOENT', message: 'missing file' } }) }))
      .toEqual(['failed', '失败']);
    expect(context.classify({ toolName: 'read', result: JSON.stringify({ error: { code: 'ENOENT', message: 'x'.repeat(1200) } }).slice(0, 1000) })[0])
      .toBe('failed');
    expect(context.classify({ toolName: 'ask_user', cancelled: true, sideEffects: 0 }))
      .toEqual(['stopped', '已停止']);
    expect(context.classify({ toolName: 'read', result: JSON.stringify({ content: '{"error":{"message":"user text"},"cancelled":true}' }) }))
      .toEqual(['success', '已读取']);
    expect(context.classify({ residueRisk: true })[1]).toBe('清理未确认');
    expect(context.classify({ shell: { status: 'cancelled' } })[0]).toBe('stopped');
    expect(context.classify({ denied: true })).toEqual(['denied', '已拒绝']);
    expect(context.classify({ toolName: 'read', result: '文件内容' })).toEqual(['success', '已读取']);
    expect(context.classify({ toolName: 'read', error: '读取失败' })[0]).toBe('failed');
    expect(context.classify({ shell: { exitCode: null, status: 'unknown' } })[0]).toBe('interrupted');
    expect(context.classify({ shell: { exitCode: 0, status: 'completed' } })[0]).toBe('success');
  });

  it('A9-47 separates drafting from sending and retains approval, question and runtime blocks', () => {
    const nodes: any = new Map();
    const node = (id: string) => {
      if (!nodes.has(id)) nodes.set(id, { value: 'next draft', dataset: {}, hidden: false, disabled: false,
        classList: { toggle: jest.fn() }, setAttribute: jest.fn() });
      return nodes.get(id);
    };
    const ready = { status: 'ready', mode: 'read_only', agentStatus: 'running',
      provider: { configured: true, probe: { classification: 'tool_calling' } } };
    const context: any = { root: { win7AgentComposerController: require('../../product/renderer/a9-composer-controller') }, renderQueue: () => {}, state: { snapshot: ready, running: true }, el: node,
      text: (id: string, value: string) => { node(id).textContent = value; },
      SUPPORTED_MODES: new Set(['read_only', 'full_access']), activeManagedProcesses: () => [], runtimeDiagnostic: () => 'restricted' };
    const source = script.slice(script.indexOf('  function canSubmit('), script.indexOf('  function activeManagedProcesses('))
      + script.slice(script.indexOf('  function syncComposer('), script.indexOf('  function resizeComposer('));
    vm.runInNewContext(source + ';this.sync = syncComposer;this.sendable = canSubmit;', context);
    context.sync();
    expect(node('task-prompt').disabled).toBe(false);
    expect(node('run-task').hidden).toBe(true);
    expect(context.sendable()).toBe(false);
    expect(node('cancel-task').hidden).toBe(false);
    expect(node('composer-draft-guidance').hidden).toBe(false);
    for (const blocked of [{ pendingApproval: {} }, { pendingQuestion: {} }, { status: 'diagnostics' }, { mode: 'needs_selection' }]) {
      context.state.snapshot = { ...ready, ...blocked };
      context.sync();
      expect(node('task-prompt').disabled).toBe(true);
    }
    context.state.snapshot = { ...ready, agentStatus: 'idle' };
    context.state.running = false;
    context.sync();
    expect(node('task-prompt').value).toBe('next draft');
    expect(node('run-task').hidden).toBe(false);
    expect(context.sendable()).toBe(true);
    expect(node('composer-draft-guidance').hidden).toBe(true);
  });

  it('A9-47 reports a rejected draft save without clearing input or applying a stale acknowledgement', async () => {
    const nodes: any = { 'task-prompt': { value: 'first' }, 'draft-status': { dataset: {}, textContent: '' } };
    let finish: (value: any) => void = () => {};
    const context: any = { state: { activeConversationId: 'conversation-a', draftTimer: null },
      el: (id: string) => nodes[id], text: (id: string, value: string) => { nodes[id].textContent = value; },
      a9: { saveDraft: jest.fn(() => new Promise((resolve) => { finish = resolve; })) }, root: {} };
    const source = script.slice(script.indexOf('  async function saveDraftNow('), script.indexOf('  function scheduleDraftSave('));
    vm.runInNewContext(source + ';this.save = saveDraftNow;', context);
    const pending = context.save();
    nodes['task-prompt'].value = 'newer draft';
    nodes['draft-status'].textContent = '正在保存当前对话草稿…';
    finish({ ok: true, persistence: 'dpapi' });
    await pending;
    expect(nodes['draft-status'].textContent).toBe('正在保存当前对话草稿…');
    context.a9.saveDraft = async () => { throw new Error('transport unavailable'); };
    await expect(context.save()).resolves.toEqual({ ok: false });
    expect(nodes['task-prompt'].value).toBe('newer draft');
    expect(nodes['draft-status'].textContent).toContain('草稿保存失败');
    expect(nodes['draft-status'].dataset.tone).toBe('error');
    expect(context.state.draftSaving).toBe(false);
  });

  it('loads persisted session events into the Inspector in order without duplicates or cross-session residue', async () => {
    const { document, nodes } = createRendererDomHarness();
    const eventsByConversation: Record<string, any[]> = {
      'conversation-a': [
        { eventId: 15, eventType: 'turn_completed', turnId: 'turn-a', payload: { data: { outcome: 'completed' } } },
        { eventId: 11, eventType: 'provider.configure', turnId: null, payload: {} },
        { eventId: 13, eventType: 'tool_start', turnId: 'turn-a', payload: { data: { toolName: 'shell', args: { command: 'echo ok' } } } },
        { eventId: 12, eventType: 'turn_started', turnId: 'turn-a', payload: {} },
        { eventId: 13, eventType: 'tool_start', turnId: 'turn-a', payload: { data: { toolName: 'shell', args: { command: 'echo ok' } } } },
        { eventId: 14, eventType: 'tool_end', turnId: 'turn-a', payload: { data: { toolName: 'shell', shell: { schemaVersion: 1, exitCode: 0, stdout: 'session-a-output' } } } },
      ],
      'conversation-b': [
        { eventId: 21, eventType: 'turn_started', turnId: 'turn-b', payload: {} },
        { eventId: 22, eventType: 'model_note', turnId: 'turn-b', payload: { data: { content: 'session-b-only' } } },
      ],
    };
    const state: any = {
      activeConversationId: 'conversation-a', inspectorEvents: new Map(), eventBytes: 0,
      releasedEventCount: 0, lowestLoadedEventId: null, evictedThroughId: 0, turnEvents: new Map(),
      turnIdToFactTask: new Map(), eventMaxId: 0, activeTurnId: null, pendingToolLabel: null,
      lastEventAt: 0, eventsBeforeId: null, snapshot: {}, eventsLoading: false,
      eventsTruncated: false, eventsError: '', streamDom: new Map(), truncatedNote: null,
    };
    const queryEvents = jest.fn(async ({ conversationId }: any) => ({
      ok: true, events: eventsByConversation[conversationId], hasMore: false,
    }));
    const normalizeAndLoad = script.slice(script.indexOf('  function normalizeTimelineEvent('), script.indexOf('  /** 事实'));
    const labels = script.slice(script.indexOf('  function toolHeadline('), script.indexOf('  // ------------------------------------------------------------------\n  // 轮次渲染'));
    const timeline = script.slice(script.indexOf('  function renderTimeline('), script.indexOf('  function renderCheckpoints('));
    const context: any = {
      state, document, a9: { queryEvents }, Date,
      EVENT_GLOBAL_LIMIT: 2000, EVENT_BYTE_LIMIT: 4 * 1024 * 1024,
      EVENT_TURN_LIMIT: 500, EVENT_TRIM_RATIO: 0.9,
      el: (id: string) => nodes.get(id),
      text: (id: string, value: any) => { const target = nodes.get(id); if (target) target.textContent = String(value == null ? '' : value); },
      renderConversation: jest.fn(), openWorkspaceFile: jest.fn(),
    };
    vm.runInNewContext(`${outcomeLabels}\n${errorFormatter}\n${labels}\n${normalizeAndLoad}\n${timeline};this.load = loadConversationEvents;this.reset = resetConversationEvents;`, context);

    await context.load();
    const firstTimeline = nodes.get('a9-timeline')!;
    expect(Array.from(state.inspectorEvents.keys()).sort((a: any, b: any) => a - b)).toEqual([11, 12, 13, 14, 15]);
    expect(firstTimeline.children).toHaveLength(5);
    expect(firstTimeline.children.map((item: any) => item.textContent)).toEqual([
      'provider.configure', '任务开始', '正在运行命令 echo ok', '运行命令  · 执行成功 · exit=0', '任务完成',
    ]);
    expect(nodes.get('a9-shell-output')!.textContent).toContain('session-a-output');

    state.activeConversationId = 'conversation-b';
    context.reset();
    await context.load();
    expect(Array.from(state.inspectorEvents.keys())).toEqual([21, 22]);
    expect(nodes.get('a9-timeline')!.textContent).toContain('模型说明');
    expect(nodes.get('a9-timeline')!.textContent).not.toContain('session-a-output');
    expect(queryEvents.mock.calls.map((call) => call[0].conversationId)).toEqual(['conversation-a', 'conversation-b']);
  });

  it('keeps the latest verified outcome through a real incremental rerender and rejects the old side effect', () => {
    const rendererFunctions = [
      script.slice(script.indexOf('  function resolveTurnId('), script.indexOf('  // ------------------------------------------------------------------\n  // 友好文案')),
      script.slice(script.indexOf('  function toolHeadline('), script.indexOf('  function timelineEntryLabel(')),
      script.slice(script.indexOf('  function ensureTurnBlock('), script.indexOf('  function startLiveTracking(')),
    ].join('\n');

    const runScenario = (source: string) => {
      const { document, nodes } = createRendererDomHarness();
      const state: any = {
        eventMaxId: 0, eventsTruncated: false, eventsError: '', eventsLoading: false,
        localRequest: null, conversationSignature: null, renderedConversationId: 'conversation-a',
        streamDom: new Map(), turnEvents: new Map(), turnIdToFactTask: new Map(),
        inspectorEvents: new Map(), releasedEventCount: 0,
        activeTurnId: null, truncatedNote: null, streamFollow: false,
      };
      const context: any = {
        state, document, Date, Map, Set, Array, String, JSON,
        NOTE_LIMIT: 16 * 1024, TOOL_OUTPUT_LIMIT: 8 * 1024, EVENT_GLOBAL_LIMIT: 2000,
        TERMINAL_OUTCOMES: new Set(['completed', 'failed']),
        OUTCOME_LABELS: { completed: '完成', failed: '失败' },
        clampText: (value: any, limit: number) => String(value == null ? '' : value).slice(0, limit),
        el: (id: string) => nodes.get(id),
        text: (id: string, value: any) => { const target = nodes.get(id); if (target) target.textContent = String(value == null ? '' : value); },
        eventsForTurn: (turnId: string) => state.turnEvents.get(turnId)?.events || [],
        resetConversationEvents: jest.fn(), loadConversationEvents: jest.fn(), scrollToLatest: jest.fn(),
      };
      vm.runInNewContext(`${source};this.render = renderConversation;`, context);
      const snapshot = {
        activeConversationId: 'conversation-a',
        conversation: [
          { taskId: 'task-old', turnId: 'turn-old', outcome: 'failed', verification: 'not_applicable', finalMessage: 'old fact' },
          { taskId: 'task-new', turnId: 'turn-new', outcome: 'completed', verification: 'verified', finalMessage: 'latest success' },
        ],
      };
      context.render(snapshot);
      const latestSignatureBefore = state.streamDom.get('task-new').outcomeSig;
      state.turnEvents.set('turn-old', { ids: new Set([101]), events: [
        { eventId: 101, type: 'turn_failed', turnId: 'turn-old', data: { error: 'older persisted failure detail' } },
      ] });
      state.eventMaxId = 101;
      context.render(snapshot);
      return {
        displayed: nodes.get('a9-turn-outcome')!.textContent,
        latestSignatureBefore,
        latestSignatureAfter: state.streamDom.get('task-new').outcomeSig,
      };
    };

    const fixed = runScenario(rendererFunctions);
    expect(fixed).toEqual(expect.objectContaining({
      displayed: 'completed · verified',
      latestSignatureAfter: fixed.latestSignatureBefore,
    }));

    const oldSideEffect = "    block.outcomeBodyEl.textContent = clampText(message || '任务已返回结果。', NOTE_LIMIT);";
    const globalProjection = "    text('a9-turn-outcome', latestProjection\n      ? `${latestProjection.outcome} · ${latestProjection.verification}`\n      : '');";
    expect(rendererFunctions).toContain(oldSideEffect);
    expect(rendererFunctions).toContain(globalProjection);
    const faultRestored = rendererFunctions
      .replace(oldSideEffect, `${oldSideEffect}\n    text('a9-turn-outcome', \`${'${outcome}'} · ${'${verification}'}\`);`)
      .replace(globalProjection, '    void latestProjection;');
    expect(runScenario(faultRestored).displayed).toBe('failed · not_applicable');
  });

  it('A9-19 F1/P02/P05: renders a running turn (persisted as active) live with its tool card, elapsed time and preview', () => {
    const rendererFunctions = [
      script.slice(script.indexOf('  function resolveTurnId('), script.indexOf('  // ------------------------------------------------------------------\n  // 友好文案')),
      script.slice(script.indexOf('  function toolHeadline('), script.indexOf('  function timelineEntryLabel(')),
      script.slice(script.indexOf('  function ensureTurnBlock('), script.indexOf('  function startLiveTracking(')),
    ].join('\n');
    const runScenario = (source: string, outcome: string, preview: any) => {
      const { document, nodes } = createRendererDomHarness();
      const turnEvents = new Map([['turn-live', { ids: new Set([1, 2]), events: [
        { eventId: 1, type: 'turn_started', turnId: 'turn-live', timestamp: new Date().toISOString(), data: {} },
        { eventId: 2, type: 'tool_start', turnId: 'turn-live', timestamp: new Date(Date.now() - 3000).toISOString(),
          data: { toolName: 'shell', callId: 'c1', args: { command: 'ping -n 30 127.0.0.1' } } },
      ] }]]);
      const state: any = {
        eventMaxId: 2, eventsTruncated: false, eventsError: '', eventsLoading: false, localRequest: null,
        conversationSignature: null, renderedConversationId: 'c', streamDom: new Map(), turnEvents,
        inspectorEvents: new Map(), releasedEventCount: 0,
        turnIdToFactTask: new Map(), activeTurnId: 'turn-live', truncatedNote: null, streamFollow: false,
        running: true, runningItems: new Set(), liveModelPreview: preview,
      };
      const context: any = {
        state, document, Date, Map, Set, Array, String, JSON, Number,
        NOTE_LIMIT: 16 * 1024, TOOL_OUTPUT_LIMIT: 8 * 1024, EVENT_GLOBAL_LIMIT: 2000,
        TERMINAL_OUTCOMES: new Set(['completed', 'completed_with_warnings', 'blocked', 'failed', 'cancelled', 'interrupted']),
        OUTCOME_LABELS: {},
        clampText: (value: any, limit: number) => String(value == null ? '' : value).slice(0, limit),
        formatElapsed: (ms: number) => `${Math.floor(ms / 1000)}秒`,
        el: (id: string) => nodes.get(id),
        text: (id: string, value: any) => { const target = nodes.get(id); if (target) target.textContent = String(value == null ? '' : value); },
        eventsForTurn: (turnId: string) => turnEvents.get(turnId)?.events || [],
        resetConversationEvents: jest.fn(), loadConversationEvents: jest.fn(), scrollToLatest: jest.fn(),
      };
      vm.runInNewContext(`${source};this.render = renderConversation;`, context);
      context.render({ activeConversationId: 'c', conversation: [{ taskId: 'task-1', turnId: null, outcome, requestPrompt: 'run the long shell task' }] });
      const block = state.streamDom.get('task-1');
      return { rendered: block.renderedEvents, stream: nodes.get('a9-task-stream')!.textContent };
    };

    for (const outcome of ['active', 'running', 'needs_approval']) {
      const live = runScenario(rendererFunctions, outcome, { turnId: 'turn-live', text: '正在分析日志输出…', updatedAt: 'x' });
      expect(live.rendered).toBe(2);
      expect(live.stream).toContain('运行命令 ping -n 30 127.0.0.1');
      expect(live.stream).toContain('执行中');
      expect(live.stream).toMatch(/已运行 \d+秒/);
      expect(live.stream).toContain('命令运行中；收到输出后会在此显示，可随时停止。');
      expect(live.stream).not.toContain('输出将在命令结束后显示');
      expect(live.stream).toContain('模型正在输出');
      expect(live.stream).toContain('正在分析日志输出…');
    }
    // 预览只属于其轮次：其他轮次的预览不得出现在本轮。
    expect(runScenario(rendererFunctions, 'active', { turnId: 'turn-other', text: '别的轮次', updatedAt: 'x' }).stream).not.toContain('别的轮次');
    // 负向对照：恢复 A9-16 的非终态判定后，active 轮次在运行中拿不到任何过程事件。
    const oldBinding = rendererFunctions.replace(
      "!TERMINAL_OUTCOMES.has(fact.outcome) && state.activeTurnId\n      && !state.turnIdToFactTask.has(state.activeTurnId)",
      "(fact.outcome === 'running' || fact.outcome === 'needs_approval') && state.activeTurnId",
    );
    expect(oldBinding).not.toBe(rendererFunctions);
    expect(runScenario(oldBinding, 'active', null).rendered).toBe(0);
  });

  it('A9-19: switching or creating a conversation and choosing a workspace keep the desktop rail open (U05)', () => {
    const start = script.indexOf('  function dismissNavigationDrawer() {');
    const source = script.slice(start, script.indexOf('\n  }\n', start) + 4);
    const run = (width: number, drawerOpen: boolean) => {
      const closeNavigation = jest.fn();
      const rail = { classList: { contains: (name: string) => name === 'open' && drawerOpen } };
      const context: any = { closeNavigation, el: () => rail, navigationIsDrawer: () => width < 800 };
      vm.runInNewContext(`${source};this.dismiss = dismissNavigationDrawer;`, context);
      context.dismiss();
      return closeNavigation.mock.calls.length;
    };
    expect(run(1079, false)).toBe(0); // 桌面宽度：保持左栏状态
    expect(run(1366, false)).toBe(0);
    expect(run(760, true)).toBe(1); // 窄屏抽屉打开时照常收起
    expect(run(760, false)).toBe(0);
    // 两处操作后的调用都改为只收抽屉；负向对照：旧写法在桌面宽度下无条件折叠。
    expect((script.match(/\n      dismissNavigationDrawer\(\);/g) || [])).toHaveLength(2);
    const oldCall = source.replace("if (navigationIsDrawer() && el('navigation-rail').classList.contains('open')) closeNavigation();", 'closeNavigation();');
    expect(oldCall).not.toBe(source);
    const closeNavigation = jest.fn();
    const oldContext: any = { closeNavigation, el: () => null, navigationIsDrawer: () => false };
    vm.runInNewContext(`${oldCall};this.dismiss = dismissNavigationDrawer;`, oldContext);
    oldContext.dismiss();
    expect(closeNavigation).toHaveBeenCalledTimes(1);
  });

  it('A9-19 L01: conversation rows keep the title and show only a short time', () => {
    const source = script.slice(script.indexOf('  function conversationStatusLabel('), script.indexOf('  function appendConversationGroup('));
    const context: any = { Date, String, Number };
    vm.runInNewContext(`${source};this.short = shortConversationTime;`, context);
    const now = new Date();
    expect(context.short(new Date(now.getTime() - 10 * 1000).toISOString())).toBe('刚刚');
    expect(context.short(new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 5).toISOString())).toMatch(/^(00:05|刚刚)$/);
    expect(context.short(new Date(now.getFullYear() - 1, 2, 9, 10, 0).toISOString())).toBe(`${now.getFullYear() - 1}/3/9`);
    expect(context.short('')).toBe('');
    expect(script).toContain('meta.textContent = shortConversationTime(conversation.updatedAt);');
    expect(css).toContain('.conversation-list button { grid-template-columns: minmax(0, 1fr) auto; }');
  });

  it('retries bounded fact pages without losing facts and discards results after switching conversations', async () => {
    const source = script.slice(script.indexOf('  function sortedConversationFacts('), script.indexOf('  function renderSnapshot('));
    const { document, nodes, FakeNode } = createRendererDomHarness();
    nodes.set('conversation', new FakeNode());
    const cursor = { createdAt: '2', taskId: 'new' };
    const state: any = { activeConversationId: 'c', conversationPage: { hasMore: true, nextBefore: cursor },
      conversationFacts: new Map([['new', { taskId: 'new', createdAt: '2' }]]), snapshot: {},
      streamDom: new Map(), historyLoading: false, historyError: '', streamFollow: true };
    let resolvePage: any;
    const queryConversation = jest.fn().mockRejectedValueOnce(new Error('failed'))
      .mockResolvedValueOnce({ ok: true, conversationId: 'c', facts: [{ taskId: 'old', createdAt: '1' }], hasMore: true, nextBefore: { createdAt: '1', taskId: 'old' } })
      .mockImplementationOnce(() => new Promise(resolve => { resolvePage = resolve; }));
    const context: any = { state, document, Array, a9: { queryConversation },
      el: (id: string) => nodes.get(id), renderConversation: jest.fn(), errorMessage: () => '加载失败，请重试' };
    vm.runInNewContext(source + ';this.load = loadOlderConversation;', context);
    await context.load();
    expect(state.historyError).toContain('重试');
    expect(state.conversationFacts.size).toBe(1);
    expect(state.conversationPage.nextBefore).toEqual(cursor);
    await context.load();
    expect(queryConversation.mock.calls[1][0]).toEqual({ conversationId: 'c', before: cursor, limit: 20 });
    expect(state.snapshot.conversation.map((x: any) => x.taskId)).toEqual(['old', 'new']);
    expect(state.streamFollow).toBe(true);
    const pending = context.load();
    state.activeConversationId = 'other';
    resolvePage({ ok: true, conversationId: 'c', facts: [{ taskId: 'wrong', createdAt: '0' }] });
    await pending;
    expect(state.conversationFacts.has('wrong')).toBe(false);
  });

  it('signals initial readiness before optional history, Git and diagnostics work', async () => {
    const source = script.slice(script.indexOf('  async function initialize('), script.indexOf('  root.win7AgentA9Workbench'));
    const order: string[] = [];
    const deferred: Function[] = [];
    const context: any = { api: { signalReady: () => order.push('ready') }, a9: {}, state: { snapshot: {} },
      bind: () => order.push('bind'), refreshSnapshot: async () => { order.push('snapshot'); },
      root: { setTimeout: (fn: Function) => deferred.push(fn) }, text: () => {},
      loadConversationEvents: () => order.push('history'), refreshGit: () => { throw new Error('eager git'); },
      refreshDiagnostics: () => { throw new Error('eager diagnostics'); } };
    vm.runInNewContext(source + ';this.initialize = initialize;', context);
    await context.initialize();
    expect(order).toEqual(['bind', 'snapshot', 'ready']);
    deferred[0]();
    expect(order[3]).toBe('history');
  });

  it('pages older history and exposes recoverable query errors without losing loaded events', async () => {
    const source = script.slice(script.indexOf('  async function loadConversationEvents('), script.indexOf('  /** 事实'));
    const queryEvents = jest.fn()
      .mockResolvedValueOnce({ ok: true, events: [{ eventId: 301 }], hasMore: true })
      .mockRejectedValueOnce(new Error('private failure detail'))
      .mockResolvedValueOnce({ ok: true, events: [{ eventId: 1 }], hasMore: false });
    const state: any = { activeConversationId: 'c', eventsBeforeId: null, snapshot: {}, eventsLoading: false,
      inspectorEvents: new Map(), historyGeneration: 0 };
    const ingested: any[] = [];
    const render = jest.fn();
    const renderTimeline = jest.fn();
    const context: any = { a9: { queryEvents }, state, normalizeQueriedEvent: (x: any) => x,
      ingestEvents: (xs: any[]) => ingested.push(...xs), renderConversation: render, renderTimeline,
      eventsForInspector: () => ingested.slice().sort((a, b) => a.eventId - b.eventId),
      EVENT_GLOBAL_LIMIT: 2000 };
    vm.runInNewContext(errorFormatter + source + ';this.load = loadConversationEvents;', context);
    await context.load();
    expect(state.eventsBeforeId).toBe(301);
    await context.load(true);
    expect(state.eventsError).toContain('加载失败');
    expect(state.eventsError).not.toContain('private');
    expect(ingested).toHaveLength(1);
    await context.load(true);
    expect(queryEvents.mock.calls[2][0].beforeEventId).toBe(301);
    expect(ingested.map(x => x.eventId)).toEqual([301, 1]);
    expect(state.eventsError).toBe('');
    expect(state.eventsTruncated).toBe(false);
    expect(render).toHaveBeenCalledTimes(6); // start and terminal state for each request
    expect(renderTimeline).toHaveBeenCalledTimes(3);
  });

  function createPaneHarness() {
    class PaneNode {
      children: PaneNode[] = [];
      parentNode: PaneNode | null = null;
      attrs = new Map<string, string>();
      classes = new Set<string>();
      nodeListeners = new Map<string, Array<() => void>>();
      dataset: Record<string, string> = {};
      style: Record<string, string> = {};
      hidden = false;
      disabled = false;
      open = false;
      scrollTop = 0;
      scrollHeight = 0;
      value = '';
      private ownText = '';
      constructor(public tagName = 'div') {}
      get textContent() { return this.ownText + this.children.map((c) => c.textContent).join(''); }
      set textContent(v: string) { this.ownText = String(v == null ? '' : v); this.children.forEach((c) => { c.parentNode = null; }); this.children = []; }
      get className() { return Array.from(this.classes).join(' '); }
      set className(v: string) { this.classes = new Set(String(v).split(/\s+/).filter(Boolean)); }
      get classList() {
        const self = this;
        return {
          add: (...names: string[]) => names.forEach((n) => self.classes.add(n)),
          remove: (...names: string[]) => names.forEach((n) => self.classes.delete(n)),
          contains: (n: string) => self.classes.has(n),
          toggle: (n: string, on?: boolean) => {
            const target = on === undefined ? !self.classes.has(n) : Boolean(on);
            if (target) self.classes.add(n); else self.classes.delete(n);
            return target;
          },
        };
      }
      appendChild(child: PaneNode) { child.parentNode = this; this.children.push(child); return child; }
      setAttribute(name: string, value: string) { this.attrs.set(name, String(value)); }
      getAttribute(name: string) { return this.attrs.has(name) ? String(this.attrs.get(name)) : null; }
      addEventListener(type: string, handler: () => void) {
        const list = this.nodeListeners.get(type) || [];
        list.push(handler);
        this.nodeListeners.set(type, list);
      }
      fire(type: string) { (this.nodeListeners.get(type) || []).forEach((h) => h()); }
      focus() { this.attrs.set('data-focused', 'true'); documentStub.activeElement = this; }
      select() { this.attrs.set('data-selected', 'true'); }
      contains(node: PaneNode | null) {
        let cur: PaneNode | null = node;
        while (cur) { if (cur === this) return true; cur = cur.parentNode; }
        return false;
      }
      remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((c) => c !== this); this.parentNode = null; }
    }
    const nodes = new Map<string, PaneNode>();
    const listeners: Record<string, Array<(event?: unknown) => void>> = {};
    const workbench = new PaneNode('main');
    const windowListeners: Record<string, Array<() => void>> = {};
    const windowStub: any = {
      win7Agent: { a9: { snapshot: () => new Promise(() => {}) }, signalReady: jest.fn() },
      addEventListener: (type: string, handler: () => void) => { (windowListeners[type] ||= []).push(handler); },
      innerWidth: 1366,
      setInterval, clearInterval, setTimeout, clearTimeout,
    };
    const documentStub: any = {
      getElementById: (id: string) => { if (!nodes.has(id)) nodes.set(id, new PaneNode()); return nodes.get(id); },
      querySelector: (selector: string) => (selector === '.workbench' ? workbench : null),
      querySelectorAll: () => [],
      createElement: (tagName?: string) => new PaneNode(String(tagName || 'div')),
      createTextNode: (t: string) => { const n = new PaneNode('#text'); n.textContent = t; return n; },
      addEventListener: (type: string, handler: (event?: unknown) => void) => { (listeners[`document:${type}`] ||= []).push(handler); },
      body: new PaneNode('body'),
      activeElement: null,
    };
    const sink: any = {};
    return {
      nodes, listeners, workbench, windowStub, sink,
      document: documentStub,
      run(source: string, extra?: string) {
        vm.runInNewContext(source + (extra || ''), { window: windowStub, document: documentStub, console, Promise, Set, Map, Object, Array, String, Number, Date, sink });
      },
      ready() { (listeners['document:DOMContentLoaded'] || []).forEach((h) => h()); },
      fireWindow(type: string) { (windowListeners[type] || []).forEach((h) => h()); },
    };
  }

  it('implements the A9-16 four-state responsive shell and dense conversation directory (U01-U06)', () => {
    expect(css).toContain('@media (min-width: 1200px)');
    expect(css).toContain('.workbench.rail-closed');
    expect(css).toContain('.workbench.inspector-closed');
    expect(css).toContain('.workbench.rail-closed.inspector-closed');
    expect(css).toContain('.rail-inner {');
    expect(css).toContain('.inspector-inner {');
    expect(css).toContain('.workbench.rail-closed .rail-inner');
    expect(css).toMatch(/@media \(max-width: 1199px\)[\s\S]*\.workbench\.rail-closed/);
    expect(css).toContain('.conversation-list button { display: grid');
    expect(css).toContain('.conversation-list .conversation-group-head');
    expect(html).toContain('class="rail-inner"');
    expect(html).toContain('class="inspector-inner"');
    expect(html).toContain('id="trust-note"');
    expect(html).toContain('aria-label="开关左侧导航"');
    expect(html).toContain('aria-label="开关检查器"');
    expect(script).toContain("setWorkbenchPaneClass('inspector-closed', true)");
    expect(script).toContain('function appendConversationGroup(');
    expect(script).toContain('function syncPaneState()');
    expect(script).toContain("root.addEventListener('resize', syncPaneState)");
    expect(script).toContain('function toggleNavigation()');
    // U06：≤799px 的抽屉断点必须把桌面折叠类压回单列，否则主对话区会落进 0 宽列。
    expect(css).toMatch(/@media \(max-width: 799px\)[\s\S]*\.workbench\.rail-closed \{ grid-template-columns: minmax\(0, 1fr\); \}/);
    // U02 密度：行与组头是左栏高度预算的两个乘数。
    expect(css).toContain('.conversation-list li { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 5px; margin: 1px 0; }');
    expect(css).toContain('.conversation-list .conversation-group-head { display: flex; align-items: baseline; justify-content: space-between; min-height: 20px;');
  });

  it('keeps the A9-16 rail height budget above the U02 floor of four visible conversation rows', () => {
    // 静态预算模型：U02 要求 1366x768 / 100% DPI 默认工作台至少完整显示 4 条普通对话行。
    // 无法在契约测试里跑真实布局时，把「左栏固定 chrome 合计」钉住，任何把
    // chrome 撑大或把行/组头撑高的改动都会在这里失败并给出新行数。
    const rule = (selector: string): string => {
      const pattern = selector.split(/\s+/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
      const match = css.match(new RegExp(`${pattern}\\s*\\{([^}]*)\\}`));
      expect(match).not.toBeNull();
      return match![1];
    };
    const px = (selector: string, property: string): number => {
      const match = rule(selector).match(new RegExp(`(?:^|;)\\s*${property}:\\s*(-?[\\d.]+)px`));
      expect(match).not.toBeNull();
      return Number.parseFloat(match![1]);
    };
    const box = (selector: string, property: string): number[] => {
      const match = rule(selector).match(new RegExp(`(?:^|;)\\s*${property}:\\s*([^;]+)`));
      expect(match).not.toBeNull();
      const values = Array.from(match![1].matchAll(/(-?[\d.]+)px/g)).map((m) => Number.parseFloat(m[1]));
      if (values.length === 1) return [values[0], values[0], values[0], values[0]];
      if (values.length === 2) return [values[0], values[1], values[0], values[1]];
      if (values.length === 3) return [values[0], values[1], values[2], values[1]];
      return values;
    };
    const LINE = (fontSize: number, lineHeight: number) => fontSize * lineHeight;

    const chrome = 2 * box('.rail-inner', 'padding')[0]
      + Math.max(px('.brand-mark', 'height'), LINE(14, 1.55) + LINE(11, 1.4)) + box('.brand', 'padding')[2]
      // A9-52：有工作区（即有对话可列）时左上角选择卡片隐藏，不计入列表预算。
      + 2 * 44 + 4 + 2 * box('.product-nav', 'margin')[0]
      + 2 * box('.rail-task', 'padding')[0] + 2 + LINE(11, 1.4)
      + (px('.rail-task-state', 'margin-top') + LINE(13, 1.55)) + (box('.rail-task p', 'margin')[0] + LINE(11, 1.45))
      + px('.trust-note summary', 'min-height') + 2 + box('.trust-note', 'margin')[2]
      + 40;
    const directory = (768 - chrome) - box('.conversation-directory', 'margin')[2] - 2;
    const overhead = px('.conversation-directory > header', 'min-height')
      + box('.conversation-search', 'padding')[0] + box('.conversation-search', 'padding')[2] + px('.conversation-search input', 'min-height')
      + px('.conversation-current-actions button', 'min-height') + 1
      // 最坏情况还包含可见的归档区折叠摘要（有已归档对话时必然出现）。
      + px('.conversation-archive-section summary', 'min-height') + 2
      + (2 * box('.conversation-directory-note', 'padding')[0] + LINE(11, 1.55));
    const list = directory - overhead;
    const step = (selector: string) => px(selector, 'min-height') + 2 * box('.conversation-list li', 'margin')[0];
    const rowStep = step('.conversation-list button');
    const headStep = step('.conversation-list .conversation-group-head');

    expect(list).toBeGreaterThan(0);
    // 最坏情况是「进行中 / 更早」两个组头都出现。
    const rows = Math.floor((list - 2 * headStep) / rowStep);
    expect(rows).toBeGreaterThanOrEqual(4);
  });

  it('binds directory-note layout selectors to the real HTML node (static-green/real-red guard)', () => {
    // WIN7-35 根因：预算模型读的是 `.conversation-directory-note`，但 workbench.html
    // 上该节点只有 `class="quiet"`。选择器未命中时 UA 默认 p 外边距（1em×2）会多吃约 28px，
    // 静态预算仍绿、真实 1079×540 几何只剩 3 行。这里把「选择器必须命中真实节点」钉死。
    const noteTag = html.match(/<p id="conversation-directory-note"([^>]*)>/);
    expect(noteTag).not.toBeNull();
    const classAttr = noteTag![1].match(/class="([^"]*)"/);
    expect(classAttr).not.toBeNull();
    const classes = classAttr![1].split(/\s+/);
    expect(classes).toContain('conversation-directory-note');
    // 紧凑层必须同时用 class 与 id 覆盖，避免再次漏绑。
    const compactStart = css.indexOf('@media (max-height: 650px)');
    const compactCss = css.slice(compactStart);
    expect(compactCss).toMatch(/#conversation-directory-note\s*\{[^}]*margin:\s*0/);
    expect(compactCss).toMatch(/#conversation-directory-note\s*\{[^}]*white-space:\s*nowrap/);
    // 列表禁止横向滚动条：Win7 经典滚动条会吃掉 clientHeight，制造「模型 4 行、实机 3 行」。
    expect(css).toMatch(/\.conversation-list\s*\{[^}]*overflow-x:\s*hidden/);
  });

  it('keeps four conversation rows visible in the real 125% DPI worst-form height budget (U02/U07)', () => {
    // WIN7-35 实机：1366x768、120 DPI、可用内容视口 1079x540 CSS px（不是被最小窗口
    // 钳大的 1080x584）。最坏形态同时出现 Stop、两个组头、归档摘要与目录状态。
    // 本模型必须按「已绑定到真实节点」的声明值计高；未绑定选择器不得再假装生效。
    const compactStart = css.indexOf('@media (max-height: 650px)');
    const compactEnd = css.indexOf('@media (prefers-reduced-motion: reduce)');
    expect(compactStart).toBeGreaterThanOrEqual(0);
    expect(compactEnd).toBeGreaterThan(compactStart);
    const compactCss = css.slice(compactStart, compactEnd);
    const noteTag = html.match(/<p id="conversation-directory-note"([^>]*)>/);
    expect(noteTag).not.toBeNull();
    expect(noteTag![1]).toMatch(/class="[^"]*\bconversation-directory-note\b/);

    const rule = (selector: string): string => {
      const pattern = selector.split(/\s+/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
      const match = compactCss.match(new RegExp(`${pattern}\\s*\\{([^}]*)\\}`));
      expect(match).not.toBeNull();
      return match![1];
    };
    const px = (selector: string, property: string): number => {
      const match = rule(selector).match(new RegExp(`(?:^|;)\\s*${property}:\\s*(-?[\\d.]+)px`));
      expect(match).not.toBeNull();
      return Number.parseFloat(match![1]);
    };
    const box = (selector: string, property: string): number[] => {
      const match = rule(selector).match(new RegExp(`(?:^|;)\\s*${property}:\\s*([^;]+)`));
      expect(match).not.toBeNull();
      const values = Array.from(match![1].matchAll(/(-?[\d.]+)px/g)).map((item) => Number.parseFloat(item[1]));
      if (values.length === 1) return [values[0], values[0], values[0], values[0]];
      if (values.length === 2) return [values[0], values[1], values[0], values[1]];
      if (values.length === 3) return [values[0], values[1], values[2], values[1]];
      return values;
    };
    const LINE = (fontSize: number, lineHeight: number) => fontSize * lineHeight;
    const baseBox = (selector: string, property: string): number[] => {
      const pattern = selector.split(/\s+/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
      const match = css.slice(0, compactStart).match(new RegExp(`${pattern}\\s*\\{([^}]*)\\}`));
      expect(match).not.toBeNull();
      const declaration = match![1].match(new RegExp(`(?:^|;)\\s*${property}:\\s*([^;]+)`));
      expect(declaration).not.toBeNull();
      const values = Array.from(declaration![1].matchAll(/(-?[\d.]+)px/g)).map((item) => Number.parseFloat(item[1]));
      if (values.length === 1) return [values[0], values[0], values[0], values[0]];
      if (values.length === 2) return [values[0], values[1], values[0], values[1]];
      if (values.length === 3) return [values[0], values[1], values[2], values[1]];
      return values;
    };

    expect(rule('.product-nav')).toContain('grid-template-columns: minmax(0, 1fr) minmax(0, 1fr)');
    expect(rule('.nav-item i')).toContain('display: none');
    // 行高合同不可借紧凑模式缩小。
    expect(compactCss).not.toMatch(/\.conversation-list button\s*\{[^}]*min-height:/);
    // 注记必须单行，否则 Win7 字体度量换行会再次吃掉列表高度。
    expect(rule('#conversation-directory-note')).toContain('white-space: nowrap');
    expect(rule('#conversation-directory-note')).toContain('margin: 0');

    // 真实视口/DPR/行数由白名单内可重放探针读取；本静态模型不得用常量比较假装已验证。
    // 失败式回归门是 verify-geometry-probe.mjs（不符非零退出），Jest 只锁定探针合同存在。
    const probeDir = path.join(__dirname, '../../../../docs/reports/2026-09/a9-16-ui-evidence/win7-35-capacity-repair');
    const probeJs = fs.readFileSync(path.join(probeDir, 'probe/probe.js'), 'utf8');
    const probeHtml = fs.readFileSync(path.join(probeDir, 'probe/index.html'), 'utf8');
    const verifyGate = fs.readFileSync(path.join(probeDir, 'verify-geometry-probe.mjs'), 'utf8');
    // 根目录不得再承载探针入口（保持 C14 白名单外零实现文件）。
    expect(fs.existsSync(path.join(__dirname, '../../../../index.html'))).toBe(false);
    expect(fs.existsSync(path.join(__dirname, '../../../../probe.js'))).toBe(false);
    expect(probeHtml).toContain('id="conversation-list"');
    expect(probeHtml).toContain('id="conversation-directory-note"');
    expect(probeHtml).not.toContain('probe-banner');
    expect(probeHtml).not.toContain('AI生成');
    expect(probeJs).toContain('CLAMPED_HEIGHT = 584');
    expect(probeJs).toContain('TARGET = { width: 1079, height: 540 }');
    expect(probeJs).toContain('devicePixelRatio');
    expect(probeJs).toContain('INVALID_VIEWPORT_CLAMPED_584');
    expect(probeJs).toContain('INVALID_VIEWPORT_UNEXPECTED');
    expect(probeJs).toMatch(/innerHeight !== TARGET\.height|vh !== TARGET\.height/);
    expect(probeJs).toContain('fully_visible_rows');
    expect(probeJs).toContain('fully_in_viewport');
    expect(probeJs).toContain('stop_in_viewport');
    expect(probeJs).toContain('workbench_origin_ok');
    expect(probeJs).toContain('applySelectorMissSimulation');
    expect(probeJs).toContain('vh === CLAMPED_HEIGHT');
    expect(verifyGate).toContain('requireWorkbenchOrigin');
    // 失败式门：解析三组实测结果，不符必须非零退出。
    expect(verifyGate).toContain('A9_GEOMETRY_VERIFY_FAIL');
    expect(verifyGate).toContain('process.exit(1)');
    expect(verifyGate).toContain('INVALID_VIEWPORT_CLAMPED_584');
    expect(verifyGate).toContain('simulate=selector-miss');
    expect(verifyGate).toContain('stop_in_viewport');
    // 静态预算仍按物理可用 540 计算；584 是探针的无效视口，不是第二目标。
    const PHYSICAL_CONTENT_HEIGHT = 540;

    const chrome = 2 * box('.rail-inner', 'padding')[0]
      + Math.max(px('.brand-mark', 'height'), px('.navigation-close', 'height'), px('.brand', 'min-height'))
      // A9-52：有对话时工作区选择卡片隐藏，不占列表高度。
      // 两个产品入口在紧凑高度下横排，因此只占一行。
      + px('.nav-item', 'min-height')
      // 运行中状态与 Stop 横排；边框在 border-box 高度外只计 rail-task 自身的上下边框。
      + 2 * box('.rail-task', 'padding')[0] + 2
      + Math.max(LINE(12, 1.55), px('.rail-stop', 'min-height'))
      + px('.trust-note summary', 'min-height') + 2 + px('.trust-note', 'margin-bottom')
      + px('.utility', 'min-height');
    const directory = PHYSICAL_CONTENT_HEIGHT - chrome - px('.conversation-directory', 'margin-bottom');
    const noteDecl = rule('#conversation-directory-note');
    // 已绑定 + nowrap + margin:0 时，注记只占一行；若缺 nowrap，按 2 行计入以使模型变红。
    const noteLines = /white-space:\s*nowrap/.test(noteDecl) ? 1 : 2;
    const noteFont = (noteDecl.match(/font-size:\s*([\d.]+)px/) || [])[1];
    const noteLh = (noteDecl.match(/line-height:\s*([\d.]+)/) || [])[1];
    expect(noteFont).toBeTruthy();
    expect(noteLh).toBeTruthy();
    const noteHeight = noteLines * LINE(Number(noteFont), Number(noteLh)) + 1;
    const overhead = 2
      + px('.conversation-directory > header', 'min-height')
      + box('.conversation-search', 'padding')[0] + box('.conversation-search', 'padding')[2]
      + px('.conversation-search input', 'min-height')
      + px('.conversation-current-actions button', 'min-height') + 1
      + px('.conversation-archive-section summary', 'min-height') + 1
      + noteHeight
      + 2 * baseBox('.conversation-list', 'padding')[0];
    const listClientHeight = directory - (overhead - 2 * baseBox('.conversation-list', 'padding')[0]);
    const listContent = directory - overhead;
    // 与 measure3 探针同口径：按钮边框盒必须完整落在 list 的 border-box 内。
    // 相邻 li 外边距折叠为 1px，组头 20px；行高取基础样式声明（A9-52 两行式为 44px）。最坏序列是 H1 R1 H2 R2 R3 R4。
    const listPad = baseBox('.conversation-list', 'padding')[0];
    const baseRow = css.slice(0, compactStart).match(/\.conversation-list button\s*\{[^}]*min-height:\s*([\d.]+)px/);
    expect(baseRow).not.toBeNull();
    const rowStep = Number(baseRow![1]) + 1;
    const headStep = 20 + 1;
    const fourthButtonBottom = listPad + 2 * headStep + 4 * rowStep;
    expect(listContent).toBeGreaterThan(0);
    expect(listClientHeight).toBeGreaterThanOrEqual(fourthButtonBottom);
    // 同时用整除模型给出可读行数，便于失败时对照。
    const rows = Math.floor((listContent - 2 * headStep) / rowStep);
    expect(rows).toBeGreaterThanOrEqual(4);
  });

  it('drives desktop four-state panes through state classes without rebuilding conversation DOM (U03-U05)', () => {
    const h = createPaneHarness();
    h.run(script);
    h.ready();
    const openInspectorBtn = h.nodes.get('open-inspector')!;
    const openNavigationBtn = h.nodes.get('open-navigation')!;
    const conversationList = h.nodes.get('conversation-list')!;
    expect(h.workbench.classList.contains('rail-closed')).toBe(false);
    expect(h.workbench.classList.contains('inspector-closed')).toBe(false);
    expect(openInspectorBtn.getAttribute('aria-expanded')).toBe('true');
    openInspectorBtn.fire('click');
    expect(h.workbench.classList.contains('inspector-closed')).toBe(true);
    expect(openInspectorBtn.getAttribute('aria-expanded')).toBe('false');
    openNavigationBtn.fire('click');
    expect(h.workbench.classList.contains('rail-closed')).toBe(true);
    expect(h.workbench.classList.contains('inspector-closed')).toBe(true);
    expect(h.nodes.get('conversation-list')).toBe(conversationList);
    openNavigationBtn.fire('click');
    expect(h.workbench.classList.contains('rail-closed')).toBe(false);
    expect(h.workbench.classList.contains('inspector-closed')).toBe(true);
    openInspectorBtn.fire('click');
    expect(h.workbench.classList.contains('inspector-closed')).toBe(false);
    h.windowStub.innerWidth = 1100;
    openInspectorBtn.fire('click');
    expect(h.workbench.classList.contains('inspector-closed')).toBe(false);
    expect(h.nodes.get('inspector')!.classList.contains('open')).toBe(true);
    expect(h.nodes.get('inspector-backdrop')!.hidden).toBe(false);
    expect(openInspectorBtn.getAttribute('aria-expanded')).toBe('true');
    h.nodes.get('close-inspector')!.fire('click');
    expect(h.nodes.get('inspector')!.classList.contains('open')).toBe(false);
    expect(h.nodes.get('inspector-backdrop')!.hidden).toBe(true);
    h.windowStub.innerWidth = 760;
    openNavigationBtn.fire('click');
    expect(h.nodes.get('navigation-rail')!.classList.contains('open')).toBe(true);
    h.nodes.get('close-navigation')!.fire('click');
    expect(h.nodes.get('navigation-rail')!.classList.contains('open')).toBe(false);
  });

  it('opens a collapsed navigation pane before Ctrl+K focuses and selects search (U03/U14)', () => {
    const h = createPaneHarness();
    h.run(script);
    h.ready();
    const navBtn = h.nodes.get('open-navigation')!;
    const search = h.nodes.get('conversation-search')!;
    navBtn.fire('click');
    expect(h.workbench.classList.contains('rail-closed')).toBe(true);

    const preventDefault = jest.fn();
    (h.listeners['document:keydown'] || []).forEach((handler) => handler({
      key: 'k', ctrlKey: true, altKey: false, shiftKey: false, preventDefault,
    }));

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(h.workbench.classList.contains('rail-closed')).toBe(false);
    expect(h.document.activeElement).toBe(search);
    expect(search.getAttribute('data-selected')).toBe('true');
    expect(navBtn.getAttribute('aria-expanded')).toBe('true');
  });

  it.each([780, 900, 1366])('returns settings focus to a visible control at %ipx (A9-41)', (width) => {
    const h = createPaneHarness();
    h.windowStub.innerWidth = width;
    const node = (id: string) => h.document.getElementById(id);
    const rail = node('navigation-rail');
    const settings = node('open-settings');
    const drawer = node('settings-drawer');
    const close = node('settings-close');
    close.dataset.close = 'settings-drawer';
    rail.appendChild(settings);
    drawer.appendChild(close);
    drawer.querySelector = () => close;
    h.document.querySelectorAll = (selector: string) => selector === '[data-close]' ? [close] : [];
    h.run(script);
    h.ready();
    if (width < 800) node('open-navigation').fire('click');
    settings.focus();
    settings.fire('click');
    expect(drawer.hidden).toBe(false);
    expect(h.document.activeElement).toBe(close);
    expect((h.workbench as any).inert).toBe(true);
    expect(rail.classList.contains('open')).toBe(false);
    close.fire('click');
    expect(drawer.hidden).toBe(true);
    expect((h.workbench as any).inert).toBe(false);
    expect(h.document.activeElement).toBe(width < 800 ? node('open-navigation') : settings);
    expect(node('open-navigation').getAttribute('aria-expanded')).toBe(String(width >= 800));
  });

  it('re-syncs drawer and desktop pane state across breakpoints without collapsing open sidebars (U06)', () => {
    const h = createPaneHarness();
    h.run(script);
    h.ready();
    const wb = h.workbench;
    const rail = h.nodes.get('navigation-rail')!;
    const inspector = h.nodes.get('inspector')!;
    const navBtn = h.nodes.get('open-navigation')!;
    const inspectorBtn = h.nodes.get('open-inspector')!;

    // 桌面默认左右均开。
    expect(navBtn.getAttribute('aria-expanded')).toBe('true');
    expect(inspectorBtn.getAttribute('aria-expanded')).toBe('true');

    // 回归（U06/U05）：桌面断点上的任何 resize 都不得折叠用户打开的侧栏。
    h.fireWindow('resize');
    expect(wb.classList.contains('inspector-closed')).toBe(false);
    expect(wb.classList.contains('rail-closed')).toBe(false);
    expect(navBtn.getAttribute('aria-expanded')).toBe('true');
    expect(inspectorBtn.getAttribute('aria-expanded')).toBe('true');

    // 用户显式折叠两侧后，resize 也不得把折叠翻转回展开。
    inspectorBtn.fire('click');
    navBtn.fire('click');
    expect(wb.classList.contains('inspector-closed')).toBe(true);
    expect(wb.classList.contains('rail-closed')).toBe(true);
    h.fireWindow('resize');
    expect(wb.classList.contains('inspector-closed')).toBe(true);
    expect(wb.classList.contains('rail-closed')).toBe(true);
    expect(navBtn.getAttribute('aria-expanded')).toBe('false');
    expect(inspectorBtn.getAttribute('aria-expanded')).toBe('false');

    // 缩到 ≤799px：导航变抽屉，折叠类不再表达可见性，aria 跟随抽屉状态。
    h.windowStub.innerWidth = 700;
    h.fireWindow('resize');
    expect(navBtn.getAttribute('aria-expanded')).toBe('false');
    expect(rail.classList.contains('open')).toBe(false);

    // 打开抽屉：先清掉残留的桌面折叠类，再进入抽屉态。
    navBtn.fire('click');
    expect(rail.classList.contains('open')).toBe(true);
    expect(wb.classList.contains('rail-closed')).toBe(false);
    expect(h.nodes.get('navigation-backdrop')!.hidden).toBe(false);
    expect(navBtn.getAttribute('aria-expanded')).toBe('true');

    // 放大回桌面：抽屉机制退场，桌面态是「展开」而不是被 resize 折叠。
    h.windowStub.innerWidth = 1366;
    h.fireWindow('resize');
    expect(rail.classList.contains('open')).toBe(false);
    expect(h.nodes.get('navigation-backdrop')!.hidden).toBe(true);
    expect(wb.classList.contains('rail-closed')).toBe(false);
    expect(navBtn.getAttribute('aria-expanded')).toBe('true');

    // 800–1199px：导航仍是可关的列，Inspector 才是抽屉。
    h.windowStub.innerWidth = 1100;
    h.fireWindow('resize');
    expect(inspectorBtn.getAttribute('aria-expanded')).toBe('false');
    navBtn.fire('click');
    expect(wb.classList.contains('rail-closed')).toBe(true);
    expect(navBtn.getAttribute('aria-expanded')).toBe('false');
    navBtn.fire('click');
    expect(wb.classList.contains('rail-closed')).toBe(false);
    inspectorBtn.fire('click');
    expect(inspector.classList.contains('open')).toBe(true);
    expect(inspectorBtn.getAttribute('aria-expanded')).toBe('true');
    h.nodes.get('close-inspector')!.fire('click');
    expect(inspector.classList.contains('open')).toBe(false);
    h.windowStub.innerWidth = 1366;
    h.fireWindow('resize');
    // 抽屉关闭后回到桌面，Inspector 是列，必须自报展开。
    expect(inspectorBtn.getAttribute('aria-expanded')).toBe('true');
  });

  it('renders the A9-52 inbox: live rows first, settled rows collapsed, rows from every resident workspace (U01/A-3)', () => {
    const h = createPaneHarness();
    const source = script.slice(script.indexOf('  function conversationStatusLabel('), script.indexOf('  function hydrateDraft('));
    const el = (id: string) => h.document.getElementById(id) as any;
    const switchConversation = jest.fn();
    const activateWorkspace = jest.fn();
    const visitConversation = jest.fn(async () => ({ ok: true }));
    const context: any = {
      Date, document: h.document,
      state: { searchQuery: '' },
      el,
      text: (id: string, value: unknown) => { const node = el(id); if (node) node.textContent = String(value); },
      pathName: (value: string) => String(value || '').split(/[\\/]+/).filter(Boolean).pop() || '',
      switchConversation, activateWorkspace,
      api: { a9: { forScope: () => ({ visitConversation }) } },
      root: { localStorage: { getItem: () => null, setItem: () => {} }, console: { warn: jest.fn() }, ...inboxTimers() },
    };
    // A9-54：已结束由保存的时间戳决定；s2 空闲已满 7 天，b2 同样久但有草稿。
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    vm.runInNewContext(source + ';this.renderDirectory = renderConversationDirectory;', context);
    const a = 'a'.repeat(64);
    const b = 'b'.repeat(64);
    const snapshot: any = {
      workspaceRoot: 'C:\\work\\alpha',
      scope: { workspaceId: a, conversationId: 's1' },
      activeConversationId: 's1',
      agentStatus: 'running',
      conversationControls: { canSwitch: true, maxActive: 16 },
      conversations: [
        // 数据库仍记为 idle；当前对话以运行时实时状态为准（缺陷 2）。
        { sessionId: 's1', title: '运行中对话', state: 'active', activity: 'idle', updatedAt: '2026-11-07T10:00:00.000Z' },
        { sessionId: 's2', title: '空闲对话', state: 'active', activity: 'idle', updatedAt: '2026-11-07T09:00:00.000Z', lastActivityAt: eightDaysAgo },
        { sessionId: 's3', title: '已归档对话', state: 'archived', activity: 'idle' },
      ],
      workspaces: [
        { workspaceId: a, workspaceRoot: 'C:\\work\\alpha', displayName: 'alpha', opened: true, active: true, status: 'running', activeConversationId: 's1', canSwitch: true, conversations: [] },
        { workspaceId: b, workspaceRoot: 'C:\\work\\beta', displayName: 'beta', opened: true, active: false, status: 'needs_approval', activeConversationId: 'b1', canSwitch: false,
          conversations: [{ sessionId: 'b1', title: '待审批对话', activity: 'idle', updatedAt: '2026-11-07T08:00:00.000Z', hasDraft: false },
            { sessionId: 'b2', title: '另一对话', activity: 'idle', updatedAt: '2026-11-07T07:00:00.000Z', hasDraft: true, lastActivityAt: eightDaysAgo }] },
      ],
    };
    context.renderDirectory(snapshot);
    const list = h.nodes.get('conversation-list')!;
    const heads = list.children.filter((c) => c.classList.contains('conversation-group-head'));
    expect(heads.map((head) => head.textContent)).toEqual(['活跃3', '已结束1']);
    const rows = list.children.filter((c) => !c.classList.contains('conversation-group-head')).map((li) => li.children[0]);
    // 需要处理的排在运行中前面；有草稿的对话保持在活跃组；已结束组默认折叠。
    expect(rows.map((row: any) => String(row.getAttribute('aria-label')).split('，').slice(0, 3).join('，'))).toEqual([
      '待审批对话，beta，待审批', '运行中对话，alpha，运行中', '另一对话，beta，空闲']);
    expect(rows[1].getAttribute('aria-current')).toBe('true');
    // beta 有任务未结束：可回到它绑定的对话，不能切到同工作区的其他对话。
    expect(rows[0].disabled).toBe(false);
    expect(rows[2].disabled).toBe(true);
    rows[0].fire('click');
    expect(activateWorkspace).toHaveBeenCalledWith({ workspaceId: b, conversationId: 'b1' });
    expect(h.nodes.get('conversation-archive-count')!.textContent).toBe('1');
  });

  // A9-54 §3.4 / §5 第 4 行：分组、7 天边界、“已完成”提示、按钮可用性、悬停置顶与记录查看。
  const DAY = 24 * 60 * 60 * 1000;
  // 收件箱自动结束重绘定时器：调用时取全局（假时钟生效时即为假定时器）；真实定时器不阻止 Jest 退出。
  function inboxTimers() {
    return {
      setTimeout: (fn: () => void, ms: number) => {
        const timer: any = setTimeout(fn, ms);
        if (timer && typeof timer.unref === 'function') timer.unref();
        return timer;
      },
      clearTimeout: (timer: any) => clearTimeout(timer),
    };
  }
  function createInboxHarness() {
    const h = createPaneHarness();
    const source = script.slice(script.indexOf('  function conversationStatusLabel('), script.indexOf('  function hydrateDraft('));
    const el = (id: string) => h.document.getElementById(id) as any;
    const storage = new Map<string, string>();
    const calls: Array<[string, any, string]> = [];
    const responses: Record<string, any> = {};
    const method = (name: string, scope: any) => jest.fn(async (conversationId: string) => {
      calls.push([name, { ...scope }, conversationId]);
      const response = responses[name];
      if (response instanceof Error) throw response;
      return response || { ok: true };
    });
    const forScope = jest.fn((scope: any) => ({
      settleConversation: method('settle', scope),
      reopenConversation: method('reopen', scope),
      visitConversation: method('visit', scope),
    }));
    const warn = jest.fn();
    const context: any = {
      Date, document: h.document, state: { searchQuery: '' }, el,
      text: (id: string, value: unknown) => { const node = el(id); if (node) node.textContent = String(value); },
      pathName: (value: string) => String(value || '').split(/[\\/]+/).filter(Boolean).pop() || '',
      switchConversation: jest.fn(), activateWorkspace: jest.fn(), restoreConversation: jest.fn(),
      refreshSnapshot: jest.fn(async () => null),
      api: { a9: { forScope } },
      root: {
        localStorage: {
          getItem: (key: string) => (storage.has(key) ? storage.get(key) : null),
          setItem: (key: string, value: string) => { storage.set(key, String(value)); },
        },
        console: { warn },
        ...inboxTimers(),
      },
    };
    vm.runInNewContext(`${source};this.renderDirectory = renderConversationDirectory;this.classify = classifyInbox;`, context);
    const list = () => h.nodes.get('conversation-list')!;
    const render = (snapshot: any) => { context.state.snapshot = snapshot; context.renderDirectory(snapshot); };
    const groups = () => {
      const out: Record<string, string[]> = {};
      let current = '';
      list().children.forEach((li: any) => {
        if (li.classList.contains('conversation-group-head')) { current = li.textContent.replace(/\d+$/, ''); out[current] = []; }
        else if (li.children[0] && li.children[0].dataset.conversationId) out[current].push(li.children[0].dataset.conversationId);
      });
      return out;
    };
    const row = (id: string) => list().children.find((li: any) => li.children[0] && li.children[0].dataset.conversationId === id) as any;
    const actions = (id: string) => {
      const container = row(id).children.find((child: any) => child.className === 'conversation-row-actions');
      return container ? container.children : [];
    };
    const action = (id: string, name: string) => actions(id).find((button: any) => button.dataset.action === name);
    const rowError = (id: string) => row(id).children.find((child: any) => child.className === 'conversation-action-error');
    const flush = async () => { for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
    return { h, context, storage, calls, responses, forScope, warn, render, groups, row, actions, action, rowError, flush };
  }

  function inboxSnapshot() {
    const a = 'a'.repeat(64);
    const b = 'b'.repeat(64);
    const now = Date.now();
    const iso = (ms: number) => new Date(now - ms).toISOString();
    const snapshot: any = {
      workspaceRoot: 'C:\\work\\alpha',
      scope: { workspaceId: a, conversationId: 'a1' },
      activeConversationId: 'a1', agentStatus: 'running',
      conversationControls: { canSwitch: true, maxActive: 16 },
      conversations: [
        { sessionId: 'a1', title: '运行中', state: 'active', activity: 'idle', updatedAt: iso(0), lastActivityAt: iso(0) },
        { sessionId: 'a2', title: '空闲', state: 'active', activity: 'idle', updatedAt: iso(DAY), lastActivityAt: iso(4 * DAY + 1000) },
        { sessionId: 'a3', title: '已结束', state: 'active', activity: 'idle', updatedAt: iso(DAY), lastActivityAt: iso(DAY), settledAt: iso(DAY) },
      ],
      workspaces: [
        { workspaceId: a, workspaceRoot: 'C:\\work\\alpha', displayName: 'alpha', opened: true, status: 'running', activeConversationId: 'a1', canSwitch: true, conversations: [] },
        { workspaceId: b, workspaceRoot: 'C:\\work\\beta', displayName: 'beta', opened: true, status: 'needs_input', activeConversationId: 'b1', canSwitch: false,
          conversations: [
            { sessionId: 'b1', title: '待回答', activity: 'idle', updatedAt: iso(0), lastActivityAt: iso(0) },
            { sessionId: 'b2', title: '后台空闲', activity: 'idle', updatedAt: iso(DAY), lastActivityAt: iso(DAY), lastCompletedAt: iso(DAY) },
            { sessionId: 'b3', title: '后台已结束', activity: 'idle', updatedAt: iso(2 * DAY), lastActivityAt: iso(9 * DAY) },
          ] },
      ],
    };
    return { a, b, snapshot };
  }

  it('A9-54 groups by saved timestamps: pinned first, live and drafts never auto-settle, 7-day boundary is inclusive', () => {
    const { context, storage } = createInboxHarness();
    storage.set('a9.pinnedConversations.v1', JSON.stringify(['pinned-settled', 'pinned-old']));
    const now = Date.parse('2026-11-09T12:00:00.000Z');
    const ago = (ms: number) => new Date(now - ms).toISOString();
    const item = (sessionId: string, fields: any) => ({ key: `w:${sessionId}`, sessionId, activity: 'idle', hasDraft: false,
      settledAt: null, lastActivityAt: ago(DAY), viewed: false, ...fields });
    const items = [
      item('pinned-settled', { settledAt: ago(DAY) }),
      item('pinned-old', { lastActivityAt: ago(30 * DAY) }),
      ...['running', 'needs_approval', 'needs_input', 'failed', 'interrupted']
        .map((activity) => item(`live-${activity}`, { activity, settledAt: ago(DAY), lastActivityAt: ago(30 * DAY) })),
      item('draft-old', { hasDraft: true, lastActivityAt: ago(30 * DAY) }),
      item('draft-settled', { hasDraft: true, settledAt: ago(DAY) }),
      item('manual', { settledAt: ago(1000), lastActivityAt: ago(1000) }),
      item('almost', { lastActivityAt: ago(7 * DAY - 1) }),
      item('exact', { lastActivityAt: ago(7 * DAY) }),
      item('unknown', { lastActivityAt: null }),
      item('fresh', { lastActivityAt: ago(4 * DAY + 1) }),
    ];
    const buckets = Object.fromEntries(context.classify(items, now).map((x: any) => [x.sessionId, x.bucket]));
    expect(buckets).toEqual({
      'pinned-settled': 'pinned', 'pinned-old': 'pinned',
      'live-running': 'active', 'live-needs_approval': 'active', 'live-needs_input': 'active', 'live-failed': 'active', 'live-interrupted': 'active',
      'draft-old': 'active', 'draft-settled': 'settled', manual: 'settled',
      almost: 'active', exact: 'settled', unknown: 'active', fresh: 'active',
    });
    const days = Object.fromEntries(items.map((x: any) => [x.sessionId, x.settleInDays]));
    expect(days.almost).toBe(1);
    expect(days.fresh).toBe(3);
    expect(days['draft-old']).toBeNull();
    expect(days['live-running']).toBeNull();
    expect(days.exact).toBeNull();
    // state.inboxUnread 与基于内存的推断已删除。
    expect(script).not.toContain('inboxUnread');
    expect(script).not.toContain('inboxSeen');
  });

  it('A9-54 an idle row crosses the 7-day boundary with polling stopped and moves to 已结束 without any other action', () => {
    jest.useFakeTimers({ now: Date.parse('2026-11-09T12:00:00.000Z') });
    try {
      const t = createInboxHarness();
      const a = 'a'.repeat(64);
      const now = Date.now();
      const iso = (ms: number) => new Date(now - ms).toISOString();
      t.context.state.inboxSettledOpen = true;
      t.render({
        workspaceRoot: 'C:\\work\\alpha', scope: { workspaceId: a, conversationId: 'a1' },
        activeConversationId: 'a1', agentStatus: 'idle', conversationControls: { canSwitch: true, maxActive: 16 },
        conversations: [
          { sessionId: 'a1', title: '正在查看', state: 'active', activity: 'idle', updatedAt: iso(0), lastActivityAt: iso(30 * DAY) },
          { sessionId: 'a2', title: '将到期', state: 'active', activity: 'idle', updatedAt: iso(DAY), lastActivityAt: iso(7 * DAY - 1) },
          { sessionId: 'a3', title: '有草稿', state: 'active', activity: 'idle', updatedAt: iso(DAY), lastActivityAt: iso(30 * DAY), hasDraft: true },
        ],
        workspaces: [],
      });
      expect(t.groups()).toEqual({ 活跃: ['a1', 'a2', 'a3'] });
      expect(jest.getTimerCount()).toBe(1);
      jest.advanceTimersByTime(1);
      expect(t.groups()).toEqual({ 活跃: ['a1', 'a3'], 已结束: ['a2'] });
      // 剩余行都不会自动结束：不再设定时器。
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('A9-54 shows “已完成” only when lastCompletedAt is later than lastVisitedAt (null = earliest) and not while viewing', () => {
    const { context } = createInboxHarness();
    const now = Date.parse('2026-11-09T12:00:00.000Z');
    const item = (sessionId: string, fields: any) => ({ key: `w:${sessionId}`, sessionId, activity: 'idle', hasDraft: false,
      settledAt: null, lastActivityAt: new Date(now).toISOString(), viewed: false, lastVisitedAt: null, lastCompletedAt: null, ...fields });
    const t1 = '2026-11-09T10:00:00.000Z';
    const t2 = '2026-11-09T11:00:00.000Z';
    const items = context.classify([
      item('never-visited', { lastCompletedAt: t1 }),
      item('newer', { lastCompletedAt: t2, lastVisitedAt: t1 }),
      item('older', { lastCompletedAt: t1, lastVisitedAt: t2 }),
      item('equal', { lastCompletedAt: t1, lastVisitedAt: t1 }),
      item('never-completed', {}),
      item('viewing', { lastCompletedAt: t2, lastVisitedAt: t1, viewed: true }),
      item('running', { lastCompletedAt: t2, lastVisitedAt: t1, activity: 'running' }),
    ], now);
    expect(Object.fromEntries(items.map((x: any) => [x.sessionId, x.unread]))).toEqual({
      'never-visited': true, newer: true, older: false, equal: false, 'never-completed': false, viewing: false, running: false,
    });
  });

  it('A9-54 row actions: no 结束对话 on live rows, background rows use their own scope, rejection shows a Chinese reason', async () => {
    const t = createInboxHarness();
    const { a, b, snapshot } = inboxSnapshot();
    t.context.state.inboxSettledOpen = true;
    t.render(snapshot);
    expect(t.groups()).toEqual({ 活跃: ['b1', 'a1', 'b2', 'a2'], 已结束: ['a3', 'b3'] });
    // 运行中、待回答：只有置顶，没有“结束对话”。
    for (const id of ['a1', 'b1']) expect(t.actions(id).map((x: any) => x.textContent)).toEqual(['置顶']);
    expect(t.actions('a2').map((x: any) => x.textContent)).toEqual(['结束对话', '置顶']);
    expect(t.actions('b3').map((x: any) => x.textContent)).toEqual(['恢复到活跃', '置顶']);
    expect(t.action('a2', 'settle').getAttribute('aria-label')).toBe('结束对话：空闲');
    // 活跃组空闲行显示剩余天数；后台完成未查看显示“已完成”。
    expect(t.row('a2').children[0].textContent).toContain('3 天后结束');
    expect(t.row('a2').children[0].getAttribute('aria-label')).toContain('3 天后结束');
    expect(t.row('b2').children[0].getAttribute('aria-label')).toContain('，已完成');
    // 操作按钮是 <li> 内行按钮的兄弟节点，不嵌套在行按钮里。
    expect(t.row('a2').children[0].children.some((child: any) => child.className === 'conversation-row-actions')).toBe(false);

    t.action('b2', 'settle').fire('click');
    await t.flush();
    t.action('b3', 'reopen').fire('click');
    await t.flush();
    t.action('a3', 'reopen').fire('click');
    await t.flush();
    const actionCalls = t.calls.filter(([name]) => name !== 'visit');
    expect(actionCalls).toEqual([
      ['settle', { workspaceId: b, conversationId: 'b2' }, 'b2'],
      ['reopen', { workspaceId: b, conversationId: 'b3' }, 'b3'],
      ['reopen', { workspaceId: a, conversationId: 'a3' }, 'a3'],
    ]);
    actionCalls.forEach(([, scope, conversationId]) => expect(scope.conversationId).toBe(conversationId));
    expect(t.context.refreshSnapshot).toHaveBeenCalledTimes(3);

    t.responses.settle = { ok: false, error: { code: 'A9_CONVERSATION_BUSY' } };
    t.action('a2', 'settle').fire('click');
    await t.flush();
    expect(t.rowError('a2').textContent).toBe('对话正在运行、待审批或待回答，暂不能结束。');
    expect(t.rowError('a2').getAttribute('role')).toBe('alert');
    t.responses.reopen = new Error('transport closed');
    t.action('b3', 'reopen').fire('click');
    await t.flush();
    expect(t.rowError('a2')).toBeUndefined();
    expect(t.rowError('b3').textContent).toBe('恢复到活跃失败，请刷新后重试。');

    // 没有 snapshot.scope：当前工作区的行不显示结束、恢复，置顶仍在；后台工作区仍有自己的 scope。
    const bare = createInboxHarness();
    bare.context.state.inboxSettledOpen = true;
    bare.render({ ...snapshot, scope: undefined, workspaces: [snapshot.workspaces[1]] });
    expect(bare.actions('a2').map((x: any) => x.textContent)).toEqual(['置顶']);
    expect(bare.actions('a3').map((x: any) => x.textContent)).toEqual(['置顶']);
    expect(bare.actions('b2').map((x: any) => x.textContent)).toEqual(['结束对话', '置顶']);
    expect(bare.calls.filter(([name]) => name === 'visit')).toEqual([]);
  });

  it('A9-54 hover pin writes a9.pinnedConversations.v1 and moves the row to the pinned group', () => {
    const t = createInboxHarness();
    const { snapshot } = inboxSnapshot();
    t.render(snapshot);
    t.action('b2', 'pin').fire('click');
    expect(JSON.parse(t.storage.get('a9.pinnedConversations.v1')!)).toEqual(['b2']);
    expect(t.groups().置顶).toEqual(['b2']);
    expect(t.groups().活跃).not.toContain('b2');
    expect(t.actions('b2').map((x: any) => x.textContent)).toEqual(['取消置顶']);
    t.action('b2', 'pin').fire('click');
    expect(JSON.parse(t.storage.get('a9.pinnedConversations.v1')!)).toEqual([]);
    expect(t.groups().活跃).toContain('b2');
    // “…”菜单里的置顶入口保留，写同一个键。
    expect(script).toContain("el('conversation-pin').addEventListener('click', () => { setConversationMenu(false); togglePinnedConversation(state.activeConversationId); });");
  });

  it('A9-54 records a visit when a conversation is opened and when the viewed run completes; failures only leave diagnostics', async () => {
    const t = createInboxHarness();
    const { a, snapshot } = inboxSnapshot();
    const visits = () => t.calls.filter(([name]) => name === 'visit');
    t.render(snapshot);
    await t.flush();
    expect(visits()).toEqual([['visit', { workspaceId: a, conversationId: 'a1' }, 'a1']]);
    t.render(snapshot);
    await t.flush();
    expect(visits()).toHaveLength(1);
    // 正在查看的对话运行完成：lastCompletedAt 晚于 lastVisitedAt。
    const finished = { ...snapshot, agentStatus: 'idle', conversations: snapshot.conversations.map((item: any) => (item.sessionId === 'a1'
      ? { ...item, lastCompletedAt: new Date().toISOString(), lastVisitedAt: new Date(Date.now() - DAY).toISOString() } : item)) };
    t.render(finished);
    await t.flush();
    expect(visits()).toHaveLength(2);
    // 正在查看且已完成：不显示“已完成”，也不折叠。
    expect(t.row('a1').children[0].getAttribute('aria-label')).not.toContain('已完成');
    expect(t.groups().活跃).toContain('a1');
    t.render(finished);
    await t.flush();
    expect(visits()).toHaveLength(2);
    // 打开另一对话记录一次查看；失败只留诊断，不显示错误、不抛出。
    t.responses.visit = { ok: false, error: { code: 'A9_CONVERSATION_ARCHIVED' } };
    t.render({ ...finished, activeConversationId: 'a2', scope: { workspaceId: a, conversationId: 'a2' } });
    await t.flush();
    expect(visits()[2]).toEqual(['visit', { workspaceId: a, conversationId: 'a2' }, 'a2']);
    expect(t.context.state.inboxVisitDiagnostic).toEqual(expect.objectContaining({ code: 'A9_CONVERSATION_ARCHIVED', conversationId: 'a2' }));
    expect(t.warn).toHaveBeenCalledWith('A9_INBOX_VISIT_FAILED', 'A9_CONVERSATION_ARCHIVED');
    expect(t.context.state.inboxActionError || null).toBeNull();
  });

  it('A9-54 keeps the viewed conversation active while idle and after leaving, until settled or 7 days pass', () => {
    const t = createInboxHarness();
    const { a, snapshot } = inboxSnapshot();
    const now = Date.now();
    const visitedNow = { ...snapshot, agentStatus: 'idle', conversations: snapshot.conversations.map((item: any) => (item.sessionId === 'a1'
      ? { ...item, lastVisitedAt: new Date(now).toISOString(), lastActivityAt: new Date(now).toISOString() } : item)) };
    t.render(visitedNow);
    expect(t.groups().活跃).toContain('a1');
    // 离开后由保存的 lastVisitedAt 继续留在活跃组。
    t.render({ ...visitedNow, activeConversationId: 'a2', scope: { workspaceId: a, conversationId: 'a2' } });
    expect(t.groups().活跃).toContain('a1');
    // 首次渲染即正在查看、快照还是 8 天前的旧时间（记录查看尚未回读）：不折叠。
    const stale = { ...visitedNow, activeConversationId: 'a2', scope: { workspaceId: a, conversationId: 'a2' },
      conversations: visitedNow.conversations.map((item: any) => (item.sessionId === 'a2'
        ? { ...item, lastActivityAt: new Date(now - 8 * DAY).toISOString() } : item)) };
    const fresh = createInboxHarness();
    fresh.render(stale);
    expect(fresh.groups().活跃).toContain('a2');
    t.render(stale);
    expect(t.groups().活跃).toContain('a2');
    // 离开后快照仍是 8 天前（记录查看失败的情形）：按保存的时间戳归入已结束。
    fresh.context.state.inboxSettledOpen = true;
    fresh.render({ ...stale, activeConversationId: 'a1', scope: { workspaceId: a, conversationId: 'a1' } });
    expect(fresh.groups().已结束).toContain('a2');
    // 手动结束立即生效。
    t.context.state.inboxSettledOpen = true;
    t.render({ ...stale, conversations: stale.conversations.map((item: any) => (item.sessionId === 'a2'
      ? { ...item, settledAt: new Date(now).toISOString() } : item)) });
    expect(t.groups().已结束).toContain('a2');
  });
  // A9-55：用真实管理/首条消息函数驱动 DOM；IPC 与无关的全台刷新由夹具提供。
  function createWorkdirHarness() {
    const h = createPaneHarness();
    const el = (id: string): any => h.document.getElementById(id);
    const state: any = { snapshot: { scope: { workspaceId: 'old', conversationId: 'c' }, activeConversationId: 'c',
      workdir: { path: 'C:\\我的文档\\任务_1109', origin: 'auto', created: true } },
      activeConversationId: 'c', snapshotGeneration: 0, snapshotPollingPauses: 0, workspaceDirectory: [], explorerRequest: 0, workdirBusy: false, workspaceOperation: false };
    const methods = { renameWorkdir: jest.fn(), linkWorkdir: jest.fn(), openWorkdir: jest.fn() };
    const forScope = jest.fn(() => methods);
    const startDefaultConversation = jest.fn();
    const errors: string[] = [];
    const refreshSnapshot = jest.fn(async () => null);
    const context: any = { state, document: h.document, el, api: { a9: { forScope, startDefaultConversation } },
      root: {}, refreshSnapshot, loadConversationEvents: jest.fn(async () => {}),
      saveDraftNow: jest.fn(async () => ({ ok: true })), syncSnapshotPolling: jest.fn(),
      syncComposer: jest.fn(), resizeComposer: jest.fn(), stopLiveTracking: jest.fn(), resetConversationEvents: jest.fn(),
      renderComposerWorkspace: jest.fn(), renderConversationDirectory: jest.fn(), setTaskState: jest.fn(),
      canSubmit: () => !state.workspaceOperation && Boolean(el('task-prompt').value.trim()),
      pathName: (value: string) => String(value || '').split(/[\\/]+/).filter(Boolean).pop() || '',
      text: (id: string, value: string) => { el(id).textContent = value; },
      setFieldError: (id: string, value: string) => { el(id).textContent = value; el(id).hidden = !value; },
      openDialog: (node: any) => { node.hidden = false; }, closeDialog: (node: any) => { node.hidden = true; },
      clearGlobalError: () => { errors.length = 0; }, showGlobalError: (message: string) => errors.push(message),
    };
    const source = script.slice(script.indexOf('  function workdirError('), script.indexOf('  function copyOutput('));
    vm.runInNewContext(source + ';this.workdir = { renderWorkdir, prepareDefaultConversation, submitDefaultPrompt, runWorkdirAction, openWorkdirRename, appendWorkdirBoundaryAction };', context);
    return { h, el, state, methods, forScope, startDefaultConversation, refreshSnapshot, context, errors, ...context.workdir };
  }

  it('A9-55 offers no-directory before all workspace sections and selecting it only prepares the composer', async () => {
    const t = createWorkdirHarness();
    const list = t.el('conversation-workspace-list');
    const descendants = (node: any): any[] => node.children.flatMap((child: any) => [child, ...descendants(child)]);
    list.querySelectorAll = () => descendants(list).filter((node: any) => node.classList.contains('project-picker-item'));
    t.context.workspaceBadgeNode = () => t.h.document.createElement('span');
    t.context.workspaceSummary = () => ({});
    t.context.chooseWorkspaceFromPicker = t.context.workdir.prepareDefaultConversation;
    const source = script.slice(script.indexOf('  function pickerOption('), script.indexOf('  function createConversation('));
    vm.runInNewContext(source + ';this.renderPicker = renderProjectPicker;', t.context);
    t.state.workspaceDirectory = [{ workspaceId: 'old', displayName: '现有目录', workspaceRoot: 'C:\\old', opened: true }];
    t.context.renderPicker();
    const options = list.querySelectorAll();
    expect(options[0].dataset.value).toBe('__default__');
    expect(list.children[0].textContent).toContain('不选目录，直接开始');
    expect(list.children[1].textContent).toBe('已打开的工作区');
    expect(options[1].textContent).toContain('现有目录');
    expect(script).toContain("if (value === '__default__') return prepareDefaultConversation();");
    await t.prepareDefaultConversation();
    expect(t.state.defaultConversationPending).toBe(true);
    expect(t.state.snapshot).toBeNull();
    expect(t.startDefaultConversation).not.toHaveBeenCalled();
    expect(t.el('task-prompt').value).toBe('');
    expect(t.el('a9-empty-state').hidden).toBe(true);
    expect(t.el('a9-mode-open').hidden).toBe(true);
    expect(t.el('conversation-new-dialog').hidden).toBe(true);
  });

  it.each([
    { ok: true, accepted: true },
    { ok: false, error: { code: 'A9_MODE_SELECTION_REQUIRED' } },
  ])('A9-55 first message calls startDefaultConversation once and binds returned scope: %j', async (result) => {
    const t = createWorkdirHarness();
    t.state.defaultConversationPending = true;
    t.el('task-prompt').value = '分析日志';
    const scope = { workspaceId: 'new', conversationId: 'new-c' };
    const workdir = { path: 'C:\\我的文档\\日志_1109', origin: 'auto', created: false };
    t.startDefaultConversation.mockResolvedValue({ ...result, scope, workdir });
    t.refreshSnapshot.mockImplementation(async () => {
      expect(t.state.snapshot.scope).toEqual(scope);
      expect(t.state.activeConversationId).toBe('new-c');
      return null;
    });
    const submit = script.slice(script.indexOf('  async function submitPrompt('), script.indexOf('  /**\n   * 任务结束后把焦点交还输入框'));
    vm.runInNewContext(submit + ';this.send = submitPrompt;', t.context);
    await t.context.send();
    expect(t.startDefaultConversation).toHaveBeenCalledTimes(1);
    expect(t.startDefaultConversation).toHaveBeenCalledWith('分析日志'); // 不自动传 Full Access
    expect(t.state.defaultConversationPending).toBe(false);
    expect(t.state.snapshot.workdir).toEqual(workdir);
    expect(t.refreshSnapshot).toHaveBeenCalledTimes(1);
    expect(t.el('task-prompt').value).toBe(result.ok ? '' : '分析日志');
    if (!result.ok) expect(t.errors[0]).toContain('选择此对话的权限模式');
    expect(t.state.snapshotPollingPauses).toBe(0);
  });

  it('A9-55 pending composer can draft without a workspace, cannot submit empty/busy input and never saves to an old scope', async () => {
    const t = createWorkdirHarness();
    t.state.defaultConversationPending = true;
    t.state.activeConversationId = null;
    t.state.snapshot = null;
    const functions = script.slice(script.indexOf('  function canSubmit('), script.indexOf('  function activeManagedProcesses('))
      + script.slice(script.indexOf('  function syncComposer('), script.indexOf('  function resizeComposer('))
      + script.slice(script.indexOf('  async function saveDraftNow('), script.indexOf('  async function runConversationOperation('));
    vm.runInNewContext(functions + ';this.sync = syncComposer;this.sendable = canSubmit;this.save = saveDraftNow;this.schedule = scheduleDraftSave;', t.context);
    t.context.sync();
    expect(t.el('task-prompt').disabled).toBe(false);
    expect(t.context.sendable()).toBe(false);
    t.el('task-prompt').value = '未发送消息';
    t.context.sync();
    expect(t.context.sendable()).toBe(true);
    expect(t.el('run-task').disabled).toBe(false);
    expect(t.el('queue-task').hidden).toBe(true);
    await expect(t.context.save()).resolves.toBeNull();
    t.context.schedule(); // 无 root.setTimeout 桩：待发送消息不写旧对话，也不调 IPC。
    t.state.workspaceOperation = true;
    t.context.sync();
    expect(t.context.sendable()).toBe(false);
    expect(t.el('task-prompt').disabled).toBe(true);
  });

  it('A9-55 binds a rejected first message even when only scope is returned, and blocks duplicate starts', async () => {
    const t = createWorkdirHarness();
    t.state.defaultConversationPending = true;
    t.el('task-prompt').value = '首条消息';
    let finish: (value: any) => void = () => {};
    t.startDefaultConversation.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const pending = t.submitDefaultPrompt();
    await t.submitDefaultPrompt();
    expect(t.startDefaultConversation).toHaveBeenCalledTimes(1);
    const scope = { workspaceId: 'new', conversationId: 'new-c' };
    finish({ ok: false, scope, error: { code: 'A9_MODE_SELECTION_REQUIRED' } });
    await pending;
    expect(t.state.snapshot.scope).toEqual(scope);
    expect(t.el('task-prompt').value).toBe('首条消息');
  });

  it.each([
    [false, false, 'auto', '未创建', true, true],
    [true, false, 'auto', '任务_1109', false, false],
    [false, true, 'auto', '目录身份已变化', true, true],
    [true, false, 'linked', '任务_1109', false, true],
  ])('A9-55 directory state created=%s identityChanged=%s origin=%s', (created, identityChanged, origin, label, openDisabled, renameDisabled) => {
    const t = createWorkdirHarness();
    t.state.snapshot.workdir = { ...t.state.snapshot.workdir, created, identityChanged, origin };
    t.renderWorkdir(t.state.snapshot);
    expect(t.el('workdir-label').textContent).toBe(label);
    expect(t.el('workdir-open').disabled).toBe(openDisabled);
    expect(t.el('workdir-rename').disabled).toBe(renameDisabled);
    expect(t.el('workdir-link').disabled).toBe(false);
    expect(t.el('workdir-warning').hidden).toBe(!identityChanged);
    expect(t.el('workdir-path').textContent).toBe(t.state.snapshot.workdir.path);
  });

  it.each(['rename', 'link'])('A9-55 %s success replaces scope before refresh and invalidates the explorer', async (action) => {
    const t = createWorkdirHarness();
    t.state.workdirRenameScope = t.state.snapshot.scope;
    t.el('workdir-rename-input').value = '新目录';
    const scope = { workspaceId: 'renamed', conversationId: 'c' };
    const workdir = { path: 'C:\\我的文档\\新目录', origin: action === 'link' ? 'linked' : 'auto', created: true };
    t.methods.renameWorkdir.mockResolvedValue({ ok: true, scope, workdir });
    t.methods.linkWorkdir.mockResolvedValue({ ok: true, scope, workdir });
    t.refreshSnapshot.mockImplementation(async () => { expect(t.state.snapshot.scope).toEqual(scope); return null; });
    await t.runWorkdirAction(action);
    expect(t.forScope).toHaveBeenCalledWith({ workspaceId: 'old', conversationId: 'c' });
    expect(t.state.snapshot.workdir).toEqual(workdir);
    expect(t.state.explorerRequest).toBe(1);
    expect(t.refreshSnapshot).toHaveBeenCalledTimes(1);
    if (action === 'rename') expect(t.methods.renameWorkdir).toHaveBeenCalledWith('新目录');
    else expect(t.methods.linkWorkdir).toHaveBeenCalledWith();
  });

  it('A9-55 linking cancellation keeps scope and shows no error; rename refusal shows a Chinese reason', async () => {
    const t = createWorkdirHarness();
    const scope = t.state.snapshot.scope;
    t.methods.linkWorkdir.mockResolvedValue({ ok: false, cancelled: true });
    await t.runWorkdirAction('link');
    expect(t.errors).toEqual([]);
    expect(t.state.snapshot.scope).toBe(scope);
    expect(t.refreshSnapshot).not.toHaveBeenCalled();
    t.state.workdirRenameScope = scope;
    for (const [code, reason] of [['A9_WORKDIR_NAME_CONFLICT', '已存在'], ['A9_WORKDIR_NAME_INVALID', '无效'],
      ['A9_CONVERSATION_BUSY', '正在运行'], ['A9_WORKDIR_NOT_AUTO', '关联目录不能重命名']]) {
      t.methods.renameWorkdir.mockResolvedValue({ ok: false, error: { code } });
      await t.runWorkdirAction('rename');
      expect(t.el('workdir-rename-error').textContent).toContain(reason);
      expect(t.el('workdir-rename-error').hidden).toBe(false);
    }
  });

  it('A9-55 boundary denial offers a scoped link action only for auto directories, never file content', async () => {
    const t = createWorkdirHarness();
    const container = t.h.document.createElement('li');
    t.methods.linkWorkdir.mockResolvedValue({ ok: false, cancelled: true });
    t.appendWorkdirBoundaryAction(container, { result: JSON.stringify({ error: { code: 'WORKSPACE_BOUNDARY_VIOLATION' } }) });
    expect(container.children[0].textContent).toBe('关联已有目录…');
    container.children[0].fire('click');
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
    expect(t.methods.linkWorkdir).toHaveBeenCalledTimes(1);
    for (const origin of ['linked', undefined]) {
      t.state.snapshot.workdir = origin ? { origin } : null;
      const other = t.h.document.createElement('li');
      t.appendWorkdirBoundaryAction(other, { error: 'WORKSPACE_BOUNDARY_VIOLATION' });
      expect(other.children).toHaveLength(0);
    }
    t.state.snapshot.workdir = { origin: 'auto' };
    const content = t.h.document.createElement('li');
    t.appendWorkdirBoundaryAction(content, { result: JSON.stringify({ content: 'WORKSPACE_BOUNDARY_VIOLATION' }) });
    expect(content.children).toHaveLength(0);
  });

  it('A9-55 sidebar shows 默认 and directory name for both viewed and background auto workspaces', () => {
    const t = createInboxHarness();
    const { snapshot } = inboxSnapshot();
    snapshot.workdir = { origin: 'auto', path: 'C:\\任务_1109' };
    snapshot.workspaces[1].workdir = { origin: 'auto', path: 'C:\\后台_1109' };
    t.render(snapshot);
    expect(t.row('a1').children[0].textContent).toContain('默认任务_1109');
    expect(t.row('b1').children[0].textContent).toContain('默认后台_1109');
    snapshot.workdir = { origin: 'linked', path: 'C:\\任务_1109' };
    t.render(snapshot);
    expect(t.row('a1').children[0].textContent).not.toContain('默认');
  });

  it('A9-55 file browsing uses the scoped preload while a default directory has not been created', async () => {
    const t = createWorkdirHarness();
    t.state.snapshot.workdir.created = false;
    const listWorkspaceDirectory = jest.fn(async () => ({ ok: true, result: { entries: [], truncated: false } }));
    t.context.a9 = { listWorkspaceDirectory };
    const source = script.slice(script.indexOf('  async function refreshWorkspace('), script.indexOf('  async function openWorkspaceFile('));
    vm.runInNewContext(source + ';this.browse = refreshWorkspace;', t.context);
    await t.context.browse('');
    expect(listWorkspaceDirectory).toHaveBeenCalledWith('');
    expect(t.el('workspace-tree').children).toHaveLength(0);
    expect(t.errors).toEqual([]);
  });

});


describe('A9-30 streamed activity cards', () => {
  const script = fs.readFileSync(path.join(__dirname, '../../product/renderer/a9-workbench.js'), 'utf8');
  function scenario() {
    const { document, FakeNode } = createRendererDomHarness();
    const item: any = { li: new FakeNode('li'), tag: new FakeNode('span') };
    const block: any = { pendingItems: new Map([['call', item]]) };
    const context: any = { document, TOOL_OUTPUT_LIMIT: 8192, Number, String, Date, state: {},
      clampText: (s: string, n: number) => s.slice(0, n),
      toolDetailText: (d: any) => d.shell.stdout, appendWorkdirBoundaryAction: jest.fn(),
      settleItem: jest.fn(), toolEndStatus: () => ['success', '已完成'],
    };
    const source = script.slice(script.indexOf('  function attachActivityDetail('), script.indexOf('  function buildPlanCard('));
    vm.runInNewContext(source + ';this.append = appendEventNode;', context);
    const emit = (seq: number, stream: string, text: string) => context.append(block, { type: 'tool_output', data: {
      schemaVersion: 1, toolCallId: 'call', outputSeq: seq, stream, text,
    } });
    return { context, block, item, emit };
  }
  it('merges stdout/stderr by stable sequence and does not repeat the terminal output', () => {
    const { context, block, item, emit } = scenario();
    emit(1, 'stdout', 'tick-first'); emit(1, 'stdout', 'tick-first'); emit(2, 'stderr', 'problem');
    expect(item.li.textContent.match(/tick-first/g)).toHaveLength(1);
    expect(item.li.textContent).toContain('stderr:\nproblem');
    context.append(block, { type: 'tool_end', data: { toolName: 'shell', callId: 'call', shell: { exitCode: 0, stdout: 'tick-first' } } });
    expect(item.li.textContent.match(/tick-first/g)).toHaveLength(1);
    expect(item.li.textContent).toContain('退出：0');
  });
  it('caps output and reports gaps without interpreting child HTML', () => {
    const { item, emit } = scenario();
    emit(2, 'stdout', '<img src=x onerror=alert(1)>' + 'x'.repeat(10000));
    expect(item.streamOutput.stdout.length).toBe(8192);
    expect(item.li.textContent).toContain('输出已截断或存在缺口');
    expect(item.outputEl.children).toHaveLength(0);
  });
});

describe('A9-32 recovery card uses production DOM and preserves node identity', () => {
  it('renders bounded facts and blocks the button with a visible reason, then updates the same node', () => {
    const harness = createRendererDomHarness();
    const script = fs.readFileSync(path.join(__dirname, '../../product/renderer/a9-workbench.js'), 'utf8');
    const fragment = script.slice(script.indexOf('  function updateContinuationCard('), script.indexOf('  function renderTurnDropped('));
    const state = { running: false, continuingTaskId: null as string | null }; const click = jest.fn();
    const box: any = { document: harness.document, state, continueInterruptedTask: click };
    vm.runInNewContext(fragment + ';this.render = updateContinuationCard;', box);
    const block: any = { root: new harness.FakeNode() };
    const recovery = { taskId: 'task', originalGoal: '原目标', confirmedSteps: ['read: recorded'], changedPaths: ['中文.txt'], verification: 'not_verified', unknownResults: [{ status: 'result_unknown' }], canContinue: false, blockedReason: 'A9_MANAGED_PROCESS_CLEANUP_UNCONFIRMED' };
    box.render(block, recovery); const card = block.continueEl;
    expect(card.textContent).toContain('原目标'); expect(card.textContent).toContain('副作用结果未知'); expect(card.textContent).toContain('A9_MANAGED_PROCESS_CLEANUP_UNCONFIRMED'); expect(block.continueButton.disabled).toBe(true);
    card.scrollTop = 80; recovery.canContinue = true; recovery.blockedReason = ''; state.continuingTaskId = 'task'; box.render(block, recovery);
    expect(block.continueEl).toBe(card); expect(card.scrollTop).toBe(80); expect(block.continueButton.textContent).toBe('正在继续'); expect(block.continueButton.disabled).toBe(true);
    state.continuingTaskId = null; box.render(block, recovery); expect(block.continueButton.disabled).toBe(false);
    box.render(block, null); expect(block.continueEl).toBeNull();
  });
});

describe('A9-34 recovered cleanup disposition DOM contract', () => {
  const script = fs.readFileSync(path.join(__dirname, '../../product/renderer/a9-workbench.js'), 'utf8');
  const managedHtml = fs.readFileSync(path.join(__dirname, '../../product/renderer/workbench.html'), 'utf8');
  // 任务书 §8 Q3 选项 A 原文（ADR-0294 已批准）。
  const Q3_TITLE = '解除重启恢复记录';
  const Q3_COPY = '我已在系统中检查该进程及其残留，并确认解除此记录。应用未证实进程树已清理。本操作不停止任何进程。';
  const Q3_CONFIRM = '确认解除记录';
  const Q3_CANCEL = '取消';

  it('loads every disposition node from the default product entry', () => {
    const main = fs.readFileSync(path.join(__dirname, '../../product/main.js'), 'utf8');
    expect(main).toContain(": path.join(rendererRoot, 'workbench.html');");
    expect(managedHtml).toContain('src="a9-workbench.js"');
    const ids = ['a9-managed-processes', 'a9-managed-cards', 'a9-managed-result',
      'a9-managed-dismiss-dialog', 'a9-managed-dismiss-form', 'a9-managed-dismiss-title',
      'a9-managed-dismiss-copy', 'a9-managed-dismiss-identity', 'a9-managed-dismiss-error',
      'a9-managed-dismiss-cancel', 'a9-managed-dismiss-confirm'];
    for (const id of ids) expect(managedHtml.match(new RegExp(`id="${id}"`, 'g'))).toHaveLength(1);
  });

  // 契约 DOM 由实现声明（#a9-managed-*）；本 harness 注入与声明一致的节点，
  // 以驱动 a9-workbench.js 的托管处置逻辑层（renderManagedProcesses /
  // closeManagedDismiss / confirmManagedDismiss 及其 bind 绑定）。
  function createManagedDismissHarness() {
    const nodes = new Map<string, ManagedNode>();
    const listeners = new WeakMap<ManagedNode, Array<{ type: string; handler: (event?: any) => void }>>();
    let activeElement: ManagedNode | null = null;
    class ManagedNode {
      children: ManagedNode[] = [];
      parentNode: ManagedNode | null = null;
      dataset: Record<string, string> = {};
      attrs = new Map<string, string>();
      hidden = false;
      disabled = false;
      open = false;
      className = '';
      private ownText = '';
      constructor(public tagName: string, public id = '') {}
      get textContent() { return this.ownText + this.children.map((child) => child.textContent).join(''); }
      set textContent(value: any) {
        this.ownText = String(value == null ? '' : value);
        this.children.forEach((child) => { child.parentNode = null; });
        this.children = [];
      }
      appendChild(child: ManagedNode) { child.parentNode = this; this.children.push(child); return child; }
      append(...children: ManagedNode[]) { children.forEach((child) => this.appendChild(child)); }
      remove() {
        if (!this.parentNode) return;
        this.parentNode.children = this.parentNode.children.filter((child) => child !== this);
        this.parentNode = null;
      }
      get isConnected() {
        let current: ManagedNode | null = this.parentNode;
        while (current) { if (current === documentStub.body) return true; current = current.parentNode; }
        return false;
      }
      addEventListener(type: string, handler: (event?: any) => void) {
        const list = listeners.get(this) || [];
        list.push({ type, handler });
        listeners.set(this, list);
      }
      fire(type: string, event?: any) {
        (listeners.get(this) || []).filter((entry) => entry.type === type).forEach((entry) => entry.handler(event));
      }
      focus() { activeElement = this; }
      setAttribute(name: string, value: string) { this.attrs.set(name, String(value)); }
      removeAttribute(name: string) { this.attrs.delete(name); }
      getAttribute(name: string) { return this.attrs.has(name) ? String(this.attrs.get(name)) : null; }
      querySelectorAll() { return []; }
      querySelector() { return null; }
    }
    const documentStub: any = {
      body: new ManagedNode('body'),
      activeElement: null,
      getElementById: (id: string) => {
        if (!managedHtml.includes(`id="${id}"`)) return null;
        if (!nodes.has(id)) nodes.set(id, new ManagedNode('div', id));
        return nodes.get(id);
      },
      createElement: (tagName: string) => new ManagedNode(String(tagName || 'div')),
      querySelectorAll: () => [],
      querySelector: () => null,
    };
    // 契约容器与确认框节点（含 button/input 常用属性）。
    const sections: Array<[string, string]> = [
      ['a9-managed-processes', 'section'], ['a9-managed-cards', 'div'], ['a9-managed-result', 'p'],
      ['a9-managed-dismiss-dialog', 'dialog'], ['a9-managed-dismiss-form', 'form'],
      ['a9-managed-dismiss-title', 'h2'], ['a9-managed-dismiss-copy', 'p'],
      ['a9-managed-dismiss-identity', 'p'], ['a9-managed-dismiss-error', 'p'],
      ['a9-managed-dismiss-cancel', 'button'], ['a9-managed-dismiss-confirm', 'button'],
    ];
    sections.forEach(([id, tagName]) => {
      const node = documentStub.getElementById(id);
      node.tagName = tagName;
      node.id = id;
      if (id === 'a9-managed-dismiss-confirm') node.type = 'submit';
      if (id === 'a9-managed-dismiss-cancel' || id === 'a9-managed-dismiss-confirm') node.type = node.type || 'button';
    });
    documentStub.body.appendChild(documentStub.getElementById('a9-managed-processes'));
    documentStub.getElementById('a9-managed-processes').appendChild(documentStub.getElementById('a9-managed-cards'));
    documentStub.body.appendChild(documentStub.getElementById('a9-managed-dismiss-dialog'));
    // openDialog / closeDialog / errorMessage / setFieldError 与生产实现一致。
    const dialogHelpers = {
      openDialog(dialog: ManagedNode) {
        if (!dialog) return;
        dialog.hidden = false;
        if (!dialog.open) {
          if (typeof (dialog as any).showModal === 'function') (dialog as any).showModal();
          else dialog.setAttribute('open', '');
        }
      },
      closeDialog(dialog: ManagedNode) {
        if (!dialog) return;
        if (dialog.open && typeof (dialog as any).close === 'function') (dialog as any).close();
        else dialog.removeAttribute('open');
        dialog.hidden = true;
      },
      errorMessage(response: any, fallback: string) {
        const error = response && response.error ? response.error : response;
        return error && (error.message || error.detail || error.reason)
          ? String(error.message || error.detail || error.reason)
          : fallback;
      },
      setFieldError(id: string, message: string) {
        const node = documentStub.getElementById(id);
        if (!node) return;
        node.textContent = message || '';
        node.hidden = !message;
      },
    };
    const el = (id: string) => documentStub.getElementById(id);
    const text = (id: string, value: any) => { const node = el(id); if (node) node.textContent = String(value == null ? '' : value); };
    // 生产脚本片段：托管处置三函数 + bind() 中的托管绑定块。
    const managedFunctions = script.slice(
      script.indexOf('  function renderManagedProcesses('),
      script.indexOf('  function syncComposer('),
    );
    const managedBind = script.slice(
      script.indexOf("    const managedDismissForm = el('a9-managed-dismiss-form');"),
      script.indexOf("    el('a9-mode-open').addEventListener('click', () => { if (state.snapshot) configureModeDialog(state.snapshot, true); });"),
    );
    const fireSubmit = () => el('a9-managed-dismiss-form').fire('submit', { preventDefault: jest.fn() });
    const fireCancelClick = () => el('a9-managed-dismiss-cancel').fire('click', {});
    const fireEscape = () => el('a9-managed-dismiss-dialog').fire('keydown', { key: 'Escape', preventDefault: jest.fn() });
    return {
      ManagedNode,
      document: documentStub,
      nodes,
      get activeElement() { return activeElement; },
      flush: async () => { for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve)); },
      fireSubmit,
      fireCancelClick,
      fireEscape,
      triggerDismiss: () => {
        const cards = nodes.get('a9-managed-cards');
        const card = cards && cards.children[0];
        const button = card && card.children[card.children.length - 1];
        if (!button) throw new Error('managed dismiss trigger button 未渲染');
        button.fire('click');
        return button;
      },
      run(overrides: { state?: any; dismissRecovered?: jest.Mock; refreshSnapshot?: jest.Mock; snapshot?: jest.Mock } = {}) {
        const state = overrides.state || { managedRenderSignature: null, managedConfirmation: null, managedDismissBusy: false };
        const dismissRecovered = overrides.dismissRecovered || jest.fn(async () => ({ ok: true }));
        const refreshSnapshot = overrides.refreshSnapshot || jest.fn(async () => {});
        const context: any = {
          state, document: documentStub, a9: { dismissRecovered, snapshot: overrides.snapshot || jest.fn(async () => ({ ok: true, snapshot: { managedProcesses: [] } })) },
          refreshSnapshot, el, text, Promise, Object, Array, String, Number, Date, JSON, console,
          ...dialogHelpers,
        };
        vm.runInNewContext(`${managedFunctions}\n${managedBind}\n;this.__a9_34 = { render: renderManagedProcesses, close: closeManagedDismiss, confirm: confirmManagedDismiss };`, context);
        return {
          state, dismissRecovered, refreshSnapshot,
          render: (snapshot: any) => context.__a9_34.render(snapshot),
          close: () => context.__a9_34.close(),
          confirm: () => context.__a9_34.confirm(),
          el,
        };
      },
    };
  }

  const RECOVERY_RECORD = {
    handleId: 'handle-9f3c2a',
    pid: 4812,
    startedAt: '2026-10-27T08:00:00.000Z',
    command: 'ping -n 3 127.0.0.1',
    lastProbeStatus: 'exited',
    cleanupRequired: true,
    recoveryRevision: 'a'.repeat(64),
    canDismissRecovered: true,
    owner: { conversationId: 'conversation-a9' },
  };
  const SNAPSHOT = { activeConversationId: 'conversation-a9', workspaceRoot: 'C:\\work', managedProcesses: [RECOVERY_RECORD] };

  it.each([
    ['取消按钮', (h: ReturnType<typeof createManagedDismissHarness>) => h.fireCancelClick()],
    ['Escape', (h: ReturnType<typeof createManagedDismissHarness>) => h.fireEscape()],
  ])('A9-34 契约1：%s 关闭确认框且 dismissRecovered 调用 0 次', async (_name, close) => {
    const h = createManagedDismissHarness();
    const box = h.run();
    box.render(SNAPSHOT);
    h.triggerDismiss();
    expect(h.nodes.get('a9-managed-dismiss-dialog')!.hidden).toBe(false);
    close(h);
    await h.flush();
    expect(box.dismissRecovered).not.toHaveBeenCalled();
    expect(h.nodes.get('a9-managed-dismiss-dialog')!.hidden).toBe(true);
  });

  it('A9-34 契约2：确认后仅调用一次，参数与卡片三个 data 属性完全一致', async () => {
    const h = createManagedDismissHarness();
    const box = h.run();
    box.render(SNAPSHOT);
    const card = h.nodes.get('a9-managed-cards')!.children[0];
    h.triggerDismiss();
    h.fireSubmit();
    await h.flush();
    expect(box.dismissRecovered).toHaveBeenCalledTimes(1);
    expect(box.dismissRecovered).toHaveBeenCalledWith(
      card.dataset.conversationId,
      card.dataset.handleId,
      card.dataset.recoveryRevision,
    );
    expect(card.dataset.handleId).toBe(RECOVERY_RECORD.handleId);
    expect(card.dataset.conversationId).toBe('conversation-a9');
    expect(card.dataset.recoveryRevision).toBe(RECOVERY_RECORD.recoveryRevision);
    expect(box.refreshSnapshot).toHaveBeenCalledTimes(1);
  });

  it('A9-34 契约3：提交进行中再次提交不产生第二次调用', async () => {
    const h = createManagedDismissHarness();
    let resolveDismiss: (value: any) => void = () => {};
    const dismissRecovered = jest.fn(() => new Promise((resolve) => { resolveDismiss = resolve; }));
    const box = h.run({ dismissRecovered });
    box.render(SNAPSHOT);
    h.triggerDismiss();
    h.fireSubmit();
    h.fireSubmit(); // 进行中重复提交
    await h.flush();
    expect(box.dismissRecovered).toHaveBeenCalledTimes(1);
    resolveDismiss({ ok: true });
    await h.flush();
    expect(box.dismissRecovered).toHaveBeenCalledTimes(1);
  });

  it('A9-34 契约4：成功显示未证实清理文案；失败保持确认框打开并显示错误', async () => {
    // 成功路径
    const ok = createManagedDismissHarness();
    const okBox = ok.run();
    okBox.render(SNAPSHOT);
    ok.triggerDismiss();
    ok.fireSubmit();
    await ok.flush();
    expect(ok.nodes.get('a9-managed-result')!.textContent).toBe('用户确认处置，应用未证实清理');
    expect(ok.nodes.get('a9-managed-dismiss-dialog')!.hidden).toBe(true);

    // 失败路径：ok !== true
    const fail = createManagedDismissHarness();
    const failBox = fail.run({ dismissRecovered: jest.fn(async () => ({ ok: false, error: { message: 'A9_REVISION_MISMATCH' } })) });
    failBox.render(SNAPSHOT);
    fail.triggerDismiss();
    fail.fireSubmit();
    await fail.flush();
    expect(fail.nodes.get('a9-managed-dismiss-dialog')!.hidden).toBe(false);
    expect(fail.nodes.get('a9-managed-dismiss-error')!.hidden).toBe(false);
    expect(fail.nodes.get('a9-managed-dismiss-error')!.textContent).toContain('A9_REVISION_MISMATCH');

    // 失败路径：抛异常
    const boom = createManagedDismissHarness();
    const boomBox = boom.run({ dismissRecovered: jest.fn(async () => { throw new Error('A9_DISMISS_BOOM'); }) });
    boomBox.render(SNAPSHOT);
    boom.triggerDismiss();
    boom.fireSubmit();
    await boom.flush();
    expect(boom.nodes.get('a9-managed-dismiss-dialog')!.hidden).toBe(false);
    expect(boom.nodes.get('a9-managed-dismiss-error')!.textContent).toContain('A9_DISMISS_BOOM');
  });

  it('A9-34 契约5：确认框文案与 §8 Q3 选项 A 原文一致，界面文字不宣称已清理/已停止', () => {
    // 标题、正文、两个按钮与 Q3 选项 A 原文一致。
    const titleTag = managedHtml.match(/<h2 id="a9-managed-dismiss-title">([^<]+)<\/h2>/);
    const copyTag = managedHtml.match(/<p id="a9-managed-dismiss-copy">([^<]+)<\/p>/);
    const confirmTag = managedHtml.match(/id="a9-managed-dismiss-confirm"[^>]*>([^<]+)<\/button>/);
    const cancelTag = managedHtml.match(/id="a9-managed-dismiss-cancel"[^>]*>([^<]+)<\/button>/);
    expect(titleTag).not.toBeNull();
    expect(copyTag).not.toBeNull();
    expect(confirmTag).not.toBeNull();
    expect(cancelTag).not.toBeNull();
    expect(titleTag![1]).toBe(Q3_TITLE);
    expect(copyTag![1]).toBe(Q3_COPY);
    expect(confirmTag![1]).toBe(Q3_CONFIRM);
    expect(cancelTag![1]).toBe(Q3_CANCEL);
    // 界面渲染文案不出现“已停止”，也不出现独立宣称“已清理”的状态/结果/按钮文字。
    const managedFragment = script.slice(script.indexOf('  function renderManagedProcesses('), script.indexOf('  function syncComposer('));
    expect(managedFragment).not.toContain('已停止');
    expect(managedFragment).not.toContain('已清理');
    // 契约要求“未证实清理”语义明确可见。
    expect(managedFragment).toContain('用户确认处置，应用未证实清理');
    expect(managedFragment).toContain('清理未确认');
  });

  it('A9-34 契约6：关闭后焦点回到触发按钮', async () => {
    const h = createManagedDismissHarness();
    const box = h.run();
    box.render(SNAPSHOT);
    const button = h.triggerDismiss();
    expect(h.activeElement).toBe(h.nodes.get('a9-managed-dismiss-cancel'));
    h.fireCancelClick();
    await h.flush();
    expect(h.activeElement).toBe(button);
    // 确认成功后关闭同样把焦点还给触发按钮。
    h.triggerDismiss();
    h.fireSubmit();
    await h.flush();
    expect(h.activeElement).toBe(button);
  });
});
