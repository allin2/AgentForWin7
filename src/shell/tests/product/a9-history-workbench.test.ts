import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

// A9-57 / ADR-0325：执行完整产品 Renderer。只有 DOM 与冻结的 preload 边界是夹具。
const rendererRoot = path.resolve(__dirname, '../../product/renderer');
const source = fs.readFileSync(path.join(rendererRoot, 'a9-workbench.js'), 'utf8');
const html = fs.readFileSync(path.join(rendererRoot, 'workbench.html'), 'utf8');

const WS = 'w'.repeat(64);
const OTHER_WS = 'o'.repeat(64);
const scopeA = { workspaceId: WS, conversationId: 'conv-a' };
const READ_METHODS = new Set(['snapshot', 'queryEvents', 'browseConversation', 'listWorkspaces', 'listCheckpoints', 'searchHistory', 'locateHistory', 'getDelivery']);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

const factA = { taskId: 'task-a', turnId: 'turn-a', requestPrompt: 'A 的请求正文', outcome: 'running',
  finalMessage: '', createdAt: '2026-11-09T09:00:00Z', updatedAt: '2026-11-09T09:00:00Z' };

function snapshot(overrides: any = {}) {
  const running = (overrides.agentStatus || 'running') !== 'idle';
  return {
    status: 'ready', workspaceRoot: 'C:\\中文 空格\\project', mode: 'full_access', agentStatus: 'running',
    scope: scopeA, activeConversationId: 'conv-a',
    provider: { configured: true, model: 'fixture', baseUrl: 'https://example.invalid', probe: { classification: 'tool_calling' } },
    conversations: [
      { sessionId: 'conv-a', state: 'active', title: '执行 A', activity: 'running', updatedAt: '2026-11-09T09:00:00Z' },
      { sessionId: 'conv-b', state: 'active', title: '历史 B', activity: 'idle', updatedAt: '2026-11-09T08:00:00Z' },
      { sessionId: 'conv-c', state: 'active', title: '历史 C', activity: 'idle', updatedAt: '2026-11-09T07:00:00Z' },
      { sessionId: 'conv-d', state: 'archived', title: '归档 D', activity: 'idle', updatedAt: '2026-11-01T07:00:00Z' },
    ],
    conversationControls: { canSwitch: !running, reason: '当前任务尚未结束', maxActive: 16 },
    controls: { canStop: running, stopKind: running ? 'turn' : 'none' },
    workspaces: [
      { workspaceId: WS, workspaceRoot: 'C:\\中文 空格\\project', displayName: 'project', opened: true, active: true,
        status: running ? 'running' : 'idle', activeConversationId: 'conv-a', canSwitch: !running, conversations: [] },
      { workspaceId: OTHER_WS, workspaceRoot: 'C:\\other', displayName: 'other', opened: true, active: false,
        status: 'idle', activeConversationId: 'conv-x', canSwitch: true,
        conversations: [{ sessionId: 'conv-x', title: '其他工作区', activity: 'idle', updatedAt: '2026-11-09T06:00:00Z' }] },
    ],
    conversation: [factA], timeline: [], managedProcesses: [], interruptions: [],
    checkpoints: [{ turnId: 'turn-old', createdAt: '2026-11-08T09:00:00Z', outcome: 'completed' }],
    queue: { paused: true, items: [{ id: 'q1', text: 'A 的排队消息' }] },
    ...overrides,
  };
}

const factsPage = (conversationId: string, label: string, extra: any = {}) => ({
  ok: true, conversationId, title: `${label} 标题`,
  facts: [{ taskId: `${label}-t1`, turnId: `${label}-turn`, requestPrompt: `${label} 的请求`, outcome: 'completed',
    finalMessage: `${label} 的最终答复 <script>纯文本</script>`, createdAt: '2026-11-08T08:00:00Z', updatedAt: '2026-11-08T08:01:00Z' }],
  hasMore: false, nextBefore: null, ...extra,
});
const eventsPage = (conversationId: string, label: string, extra: any = {}) => ({
  ok: true, conversationId, title: `${label} 标题`, hasMore: false,
  events: [
    { eventId: 10, turnId: `${label}-turn`, kind: 'tool', eventType: 'tool_end', createdAt: '2026-11-08T08:00:30Z',
      payload: { data: { toolName: 'shell', args: { command: 'npm test' }, result: `${label} 工具输出`, shell: { status: 'completed', exitCode: 0 } } } },
    { eventId: 11, turnId: `${label}-turn`, kind: 'model', eventType: 'model_note', createdAt: '2026-11-08T08:00:40Z',
      payload: { data: { content: `${label} 的过程说明` } } },
  ],
  ...extra,
});

function workbench(initial: any = snapshot()) {
  const registry = new Map<string, Array<(event?: any) => any>>();
  const register = (key: string, listener: (event?: any) => any) => {
    const list = registry.get(key) || []; list.push(listener); registry.set(key, list);
  };
  let document: any;
  class Node {
    children: Node[] = [];
    parentNode: Node | null = null;
    dataset: any = {};
    style: any = {};
    attributes = new Map<string, string>();
    listeners = new Map<string, Array<(event?: any) => any>>();
    className = '';
    hidden = false;
    disabled = false;
    open = false;
    value = '';
    placeholder = '';
    type = '';
    title = '';
    tabIndex = 0;
    readOnly = false;
    checked = false;
    selectionStart = 0;
    selectionEnd = 0;
    selectionDirection = 'none';
    scrollTop = 0;
    scrollHeight = 1000;
    clientHeight = 300;
    private ownText = '';
    constructor(readonly tagName = 'div', readonly id = '') {}
    classList = {
      contains: (name: string) => this.className.split(/\s+/).includes(name),
      add: (name: string) => { if (!this.classList.contains(name)) this.className += ` ${name}`; },
      remove: (name: string) => { this.className = this.className.split(/\s+/).filter((item) => item !== name).join(' '); },
      toggle: (name: string, force?: boolean) => {
        const on = force === undefined ? !this.classList.contains(name) : force;
        if (on) this.classList.add(name); else this.classList.remove(name);
        return on;
      },
    };
    get textContent(): string { return this.ownText + this.children.map((child) => child.textContent).join(''); }
    set textContent(value: string) {
      this.ownText = String(value == null ? '' : value);
      this.children.forEach((child) => { child.parentNode = null; }); this.children = [];
    }
    set innerHTML(value: string) { this.textContent = value; }
    get firstChild() { return this.children[0] || null; }
    get isConnected() { return true; }
    appendChild(child: Node) { child.remove(); child.parentNode = this; this.children.push(child); return child; }
    append(...children: Node[]) { children.forEach((child) => this.appendChild(child)); }
    insertBefore(child: Node, before: Node | null) {
      child.remove(); child.parentNode = this;
      const index = before ? this.children.indexOf(before) : -1;
      if (index < 0) this.children.push(child); else this.children.splice(index, 0, child);
      return child;
    }
    replaceChildren(...children: Node[]) { this.textContent = ''; children.forEach((child) => this.appendChild(child)); }
    remove() {
      if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((node) => node !== this);
      this.parentNode = null;
    }
    setAttribute(name: string, value: string) { this.attributes.set(name, String(value)); }
    getAttribute(name: string) { return this.attributes.has(name) ? this.attributes.get(name)! : null; }
    removeAttribute(name: string) { this.attributes.delete(name); }
    addEventListener(type: string, listener: (event?: any) => any) {
      const list = this.listeners.get(type) || []; list.push(listener); this.listeners.set(type, list);
    }
    fire(type: string, event: any = {}) {
      return Promise.all((this.listeners.get(type) || []).map((listener) => listener({ preventDefault() {}, stopPropagation() {}, target: this, ...event })));
    }
    querySelectorAll(selector: string): Node[] {
      const nodes: Node[] = [];
      for (const child of this.children) {
        if (selector === 'details' && child.tagName === 'details') nodes.push(child);
        nodes.push(...child.querySelectorAll(selector));
      }
      return nodes;
    }
    querySelector(selector: string) { return this.querySelectorAll(selector)[0] || null; }
    focus() { document.activeElement = this; }
    blur() { if (document.activeElement === this) document.activeElement = null; }
    select() {}
    setSelectionRange(start: number, end: number, direction?: string) {
      this.selectionStart = start; this.selectionEnd = end; this.selectionDirection = direction || 'none';
    }
    contains(node: Node | null): boolean { return node === this || this.children.some((child) => child.contains(node)); }
    getClientRects() { return [{}]; }
    getBoundingClientRect() { return { left: 0, top: 0, bottom: 20, right: 100 }; }
    close() { this.open = false; }
    showModal() { this.open = true; }
  }
  const nodes = new Map<string, Node>();
  for (const match of html.matchAll(/id="([^"]+)"/g)) nodes.set(match[1], new Node('div', match[1]));
  const main = new Node('main');
  document = {
    activeElement: null,
    body: new Node('body'),
    getElementById: (id: string) => nodes.get(id) || null,
    createElement: (tag: string) => new Node(tag),
    createTextNode: (value: string) => { const node = new Node('#text'); node.textContent = value; return node; },
    querySelectorAll: () => [], querySelector: (selector: string) => selector === '.workbench' ? main : null,
    addEventListener: (type: string, listener: (event?: any) => any) => register(`document:${type}`, listener),
  };
  let current = initial;
  const calls: Array<{ method: string; scope: any; args: any[] }> = [];
  const label = (conversationId: string) => ({ 'conv-c': 'C', 'conv-d': 'D' } as any)[conversationId] || 'B';
  const handlers: Record<string, (...args: any[]) => any> = {
    snapshot: async () => ({ ok: true, snapshot: current }),
    queryEvents: async () => ({ ok: true, events: [], hasMore: false }),
    saveDraft: async () => ({ ok: true, persistence: 'dpapi' }),
    listWorkspaces: async () => ({ ok: true, workspaces: current.workspaces }),
    searchHistory: async () => ({ ok: true, results: [], hasMore: false, nextBefore: null }),
    locateHistory: async () => ({ ok: false, error: { code: 'A9_HISTORY_SOURCE_UNAVAILABLE' } }),
    getDelivery: async (payload: any) => ({ ok: true, card: deliveryCard(payload) }),
    browseConversation: async (payload: any) => payload.kind === 'facts'
      ? factsPage(payload.conversationId, label(payload.conversationId))
      : eventsPage(payload.conversationId, label(payload.conversationId)),
  };
  const invoke = (method: string, scope: any) => (...args: any[]) => {
    calls.push({ method, scope, args });
    return (handlers[method] || (async () => ({ ok: true })))(...args);
  };
  const scoped = (scope: any) => new Proxy({}, { get: (_target, key) => key === 'then' ? undefined : invoke(String(key), scope) });
  const a9 = new Proxy({}, {
    get: (_target, key) => key === 'then' ? undefined : key === 'forScope' ? (scope: any) => scoped(scope) : invoke(String(key), null),
  });
  const api: any = { a9, signalReady: jest.fn(),
    selectWorkspace: jest.fn(async () => ({ selected: null })),
    createSession: jest.fn(async () => ({ session: { sessionId: 'explorer' } })),
    listSessions: jest.fn(async () => ({ sessions: [] })),
    listWorkspace: jest.fn(async () => ({ result: { entries: [] } })),
  };
  const storage = new Map<string, string>();
  const window: any = { win7Agent: api, innerWidth: 1366, innerHeight: 900, setInterval, clearInterval, setTimeout, clearTimeout, console,
    localStorage: { getItem: (key: string) => storage.get(key) || null, setItem: (key: string, value: string) => { storage.set(key, value); } },
    A9QuestionCard: { create: () => ({ update: jest.fn() }) },
    getSelection: () => ({ anchorNode: null, removeAllRanges() {}, addRange() {} }),
    addEventListener: (type: string, listener: (event?: any) => any) => register(`window:${type}`, listener) };
  window.win7AgentComposerController = require('../../product/renderer/a9-composer-controller');
  vm.runInNewContext(source, { window, document, console }, { filename: 'a9-workbench.js' });
  const fire = (key: string, event: any = {}) => Promise.all((registry.get(key) || []).map((listener) => listener({ preventDefault() {}, stopPropagation() {}, ...event })));
  const node = (id: string) => nodes.get(id)!;
  const row = (conversationId: string) => {
    for (const listId of ['conversation-list', 'conversation-archive-list']) {
      for (const li of node(listId).children) {
        const button = li.children[0];
        if (button && button.dataset && button.dataset.conversationId === conversationId) return button;
      }
    }
    throw new Error(`row ${conversationId} not rendered`);
  };
  let baseline = 0;
  const settle = async () => { for (let i = 0; i < 5; i += 1) await jest.advanceTimersByTimeAsync(0); };
  return {
    api, calls, handlers, ui: window.win7AgentA9Workbench, document, node, row, fire, settle,
    get current() { return current; }, set current(value) { current = value; },
    // 只统计初始加载之后的写调用（初次渲染会为执行对话 A 记录一次查看）。
    writes: () => calls.slice(baseline).filter((call) => !READ_METHODS.has(call.method)),
    browseCalls: () => calls.filter((call) => call.method === 'browseConversation'),
    async ready() { await fire('document:DOMContentLoaded'); await settle(); baseline = calls.length; },
  };
}

type View = ReturnType<typeof workbench>;
async function openB(view: View, id = 'conv-b') { await view.row(id).fire('click'); await view.settle(); }
const browsing = (view: View) => !view.node('browse-panel').hidden;

function deliveryCard(payload: any, extra: any = {}) {
  return { ...payload, taskId: 'task-a', outcome: 'completed', verification: 'UNKNOWN', verificationEvidence: null,
    changes: { evidence: 'UNKNOWN', diagnostic: 'A9_CHECKPOINT_EVIDENCE_UNAVAILABLE' }, checks: [], checksRemaining: 0,
    issues: [], ...extra };
}
const result = (id = '1', conversationId = 'conv-a') => ({ conversationId, source: 'event', id, title: '原始对话',
  kind: 'conversation.request', createdAt: '2026-11-01T00:00:00Z', snippet: '中文 %_ 原始消息' });
const page = (items: any[], more = false) => ({ ok: true, results: items, hasMore: more,
  nextBefore: more ? { source: 'event', id: items[items.length - 1].id, createdAt: '2026-11-01T00:00:00Z' } : null });
function all(node: any): any[] { return [node, ...node.children.flatMap(all)]; }
function button(node: any, label: string) {
  const found = all(node).find((entry: any) => entry.tagName === 'button' && entry.textContent === label);
  if (!found) throw new Error(`missing button: ${label}`); return found;
}
async function openSearch(view: View) { await view.node('history-open').fire('click'); await view.settle(); }
async function searchFor(view: View, query = '中文 %_') {
  view.node('history-query').value = query; await view.node('history-query').fire('input');
  await view.node('history-form').fire('submit'); await view.settle();
}
describe('A9-58 full history search and factual delivery renderer', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });
  it('searches current conversation in read-only chrome and restores unsaved draft, selection, scroll and focus', async () => {
    const view = workbench(); await view.ready();
    const prompt = view.node('task-prompt'); prompt.value = 'unsaved draft'; prompt.setSelectionRange(2, 7); prompt.focus();
    await prompt.fire('input'); view.node('conversation').scrollTop = 123; await view.node('conversation').fire('scroll');
    view.handlers.searchHistory = async () => page([result()]);
    view.handlers.locateHistory = async (payload: any) => ({ ok: true, conversationId: payload.conversationId,
      message: { ...payload, title: '原始对话', text: '<script>原始消息</script>', createdAt: '2026-11-01', kind: 'conversation.request', taskId: 'task-a', turnId: 'turn-a', textOffset: 1, textLength: 20 } });
    await view.node('history-open').fire('mousedown', { preventDefault: jest.fn() });
    await prompt.fire('blur', { relatedTarget: view.node('history-open') });
    await openSearch(view); expect(browsing(view)).toBe(true); expect(view.node('composer-wrap').hidden).toBe(true);
    expect(view.document.activeElement).toBe(view.node('history-query'));
    await prompt.fire('blur'); await jest.advanceTimersByTimeAsync(2000);
    await searchFor(view);
    expect(view.node('history-results').textContent).toContain('中文 %_ 原始消息');
    const hit = view.node('history-results').children[0].children[0]; await hit.fire('click'); await view.settle();
    expect(view.node('history-source').textContent).toContain('<script>原始消息</script>');
    expect(view.document.activeElement).toBe(view.node('history-source'));
    const card = all(view.node('history-source')).find((node: any) => node.className === 'delivery-card');
    card.open = true; await card.fire('toggle'); await view.settle();
    expect(card.textContent).toContain('只读历史不可操作');
    expect(all(card).some((node: any) => node.textContent === '查看 Diff')).toBe(false);
    await view.ui.submitPrompt(); await view.ui.stopTurn(); await prompt.fire('keydown', { key: 'Enter' });
    expect(view.writes()).toEqual([]);
    expect(view.calls.filter(call => ['searchHistory', 'locateHistory', 'getDelivery'].includes(call.method)).every(call => JSON.stringify(call.scope) === JSON.stringify(scopeA))).toBe(true);
    await view.node('browse-return').fire('click'); await view.settle();
    expect(prompt.value).toBe('unsaved draft'); expect(prompt.selectionStart).toBe(2); expect(prompt.selectionEnd).toBe(7);
    expect(view.node('conversation').scrollTop).toBe(123); expect(view.document.activeElement).toBe(prompt);
  });
  it('drops late query, page, source, cleared and closed responses; retries the same failed page', async () => {
    const view = workbench(); await view.ready(); await openSearch(view);
    const old = deferred<any>(); view.handlers.searchHistory = () => old.promise;
    await searchFor(view, 'old');
    view.handlers.searchHistory = async () => page([result('2')], true);
    await searchFor(view, 'new'); old.resolve(page([result('1')])); await view.settle();
    expect(view.node('history-results').children[0].children[0].dataset.id).toBe('2');
    view.handlers.searchHistory = async () => ({ ok: false, error: { code: 'A9_HISTORY_SQL_UNAVAILABLE' } });
    await view.node('history-next').fire('click'); await view.settle();
    expect(view.node('history-retry').hidden).toBe(false);
    const failed = view.calls.filter(call => call.method === 'searchHistory').pop()!;
    view.handlers.searchHistory = async () => page([result('3')]);
    await view.node('history-retry').fire('click'); await view.settle();
    expect(view.calls.filter(call => call.method === 'searchHistory').pop()!.args).toEqual(failed.args);
    const source = deferred<any>(); view.handlers.locateHistory = () => source.promise;
    const staleButton = view.node('history-results').children[0].children[0];
    await staleButton.fire('click');
    await view.node('history-clear').fire('click');
    source.resolve({ ok: true, conversationId: 'conv-a', message: { text: 'LATE SOURCE' } }); await view.settle();
    expect(view.node('history-source').hidden).toBe(true); expect(view.node('history-source').textContent).not.toContain('LATE SOURCE');
    const locateCount = view.calls.filter(call => call.method === 'locateHistory').length;
    // Detached old result handlers cannot revive a cleared search.
    await staleButton.fire('click'); await view.settle();
    expect(view.calls.filter(call => call.method === 'locateHistory')).toHaveLength(locateCount);
    const closed = deferred<any>(); view.handlers.searchHistory = () => closed.promise;
    await searchFor(view, 'closed'); await view.node('browse-return').fire('click');
    closed.resolve(page([result('9')])); await view.settle(); expect(browsing(view)).toBe(false);
    expect(view.writes()).toEqual([]);
  });
  it('drops cross-workspace search and navigation replies and supports keyboard Escape without dispatching writes', async () => {
    const view = workbench(); await view.ready(); await openSearch(view);
    const pending = deferred<any>(); view.handlers.searchHistory = () => pending.promise;
    await searchFor(view); view.current = snapshot({ scope: { workspaceId: OTHER_WS, conversationId: 'conv-x' }, activeConversationId: 'conv-x', conversation: [], checkpoints: [] });
    await view.ui.refreshSnapshot(); pending.resolve(page([result()])); await view.settle(); expect(browsing(view)).toBe(false);
    await openSearch(view); await view.node('history-search').fire('keydown', { key: 'Escape' }); await view.settle();
    expect(browsing(view)).toBe(false);
    expect(view.calls.filter(call => ['activateConversation', 'submitTurn', 'replyQuestion', 'undoTurn', 'updateQueue'].includes(call.method))).toEqual([]);
  });
  it.each(['needs_approval', 'needs_input'])('keeps search read-only while execution is %s', async agentStatus => {
    const view = workbench(snapshot({ agentStatus, ...(agentStatus === 'needs_approval' ? { pendingApproval: { approvalId: 'a' } } : { pendingQuestion: { questionId: 'q' } }) }));
    await view.ready(); await openSearch(view); await searchFor(view);
    expect(view.node('browse-execution-status').textContent).toContain(agentStatus === 'needs_approval' ? '等待批准' : '等待回答');
    expect(view.writes()).toEqual([]);
  });
  it('preserves expanded delivery DOM, focus and scroll during polling; distinguishes ordinary commands and exact evidence', async () => {
    const fact = { ...factA, outcome: 'completed' };
    const view = workbench(snapshot({ agentStatus: 'idle', conversation: [fact], checkpoints: [{ turnId: 'turn-a', createdAt: fact.createdAt }] })); await view.ready();
    view.handlers.getDelivery = async (payload: any) => ({ ok: true, card: deliveryCard(payload, { verification: 'verified',
      checks: [{ command: 'echo okay', exitCode: 0, status: 'completed', eventId: 10 }, { command: 'npm test', exitCode: 1, status: 'failed', eventId: 11 }],
      verificationEvidence: { command: 'npm test before later failure', exitCode: 0, eventId: 12 },
      changes: { evidence: 'checkpoint_metadata', total: 55, remaining: 54, files: [{ path: '<script>.ts', action: 'modify' }] },
      outcome: 'completed_with_warnings', issues: [{ eventId: 11, text: 'observed failure' }], auditTruncated: true }) });
    const card = all(view.node('a9-task-stream')).find((node: any) => node.className === 'delivery-card');
    card.open = true; await card.fire('toggle'); await view.settle();
    expect(card.textContent).toContain('退出 0 本身不表示测试已验证'); expect(card.textContent).toContain('exit=1');
    expect(card.textContent).toContain('event=12'); expect(card.textContent).toContain('另有 54 项'); expect(card.textContent).toContain('已截断');
    const focus = button(card, '重新读取交付事实'); focus.focus(); view.node('conversation').scrollTop = 333;
    await view.ui.refreshSnapshot(); await view.settle();
    expect(card.open).toBe(true); expect(view.document.activeElement).toBe(focus); expect(view.node('conversation').scrollTop).toBe(333);
    // Old execution DOM click handlers cannot dispatch Diff or Undo while browsing.
    const diff = button(card, '查看 Diff'); await openSearch(view);
    const count = view.calls.filter(call => call.method === 'getDiff').length;
    await diff.fire('click'); await view.settle(); expect(view.calls.filter(call => call.method === 'getDiff')).toHaveLength(count);
  });
  it('retries missing card data in historical browse without an undo channel', async () => {
    const view = workbench(); await view.ready(); await openB(view);
    const card = all(view.node('browse-facts')).find((node: any) => node.className === 'delivery-card');
    view.handlers.getDelivery = async () => ({ ok: false, error: { code: 'A9_HISTORY_SOURCE_UNAVAILABLE' } });
    card.open = true; await card.fire('toggle'); await view.settle();
    expect(card.textContent).toContain('读取失败');
    view.handlers.getDelivery = async (payload: any) => ({ ok: true, card: deliveryCard(payload) });
    await button(card, '重试交付摘要').fire('click'); await view.settle();
    expect(card.textContent).toContain('改动：UNKNOWN'); expect(card.textContent).toContain('精确验证证据：UNKNOWN / NOT_PERFORMED');
    expect(card.textContent).toContain('只读历史不可操作'); expect(view.writes()).toEqual([]);
  });
});
