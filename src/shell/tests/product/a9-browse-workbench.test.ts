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
const READ_METHODS = new Set(['snapshot', 'queryEvents', 'browseConversation', 'listWorkspaces', 'listCheckpoints']);

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

describe('A9-57 read-only browsing while the execution conversation runs', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

  it('keeps an unflushed A draft in memory while browsing and saves it after returning', async () => {
    const view = workbench(); await view.ready();
    const prompt = view.node('task-prompt');
    prompt.value = 'A 尚未保存的草稿';
    await prompt.fire('input');
    await openB(view);
    await prompt.fire('blur');
    await prompt.fire('input');
    await jest.advanceTimersByTimeAsync(1500);
    expect(view.writes()).toEqual([]);
    expect(prompt.value).toBe('A 尚未保存的草稿');
    await view.node('browse-return').fire('click');
    await jest.advanceTimersByTimeAsync(600);
    expect(view.writes().map((call) => [call.method, call.scope, call.args]))
      .toEqual([['saveDraft', scopeA, ['A 尚未保存的草稿']]]);
  });

  it('retains A completion as unread until the user returns from B', async () => {
    const view = workbench(); await view.ready();
    await openB(view);
    view.current = snapshot({ agentStatus: 'completed', conversations: snapshot().conversations.map((item: any) =>
      item.sessionId === 'conv-a' ? { ...item, activity: 'idle', lastCompletedAt: '2026-11-09T10:00:00Z' } : item) });
    await jest.advanceTimersByTimeAsync(600);
    expect(view.row('conv-a').classList.contains('unread')).toBe(true);
    expect(view.row('conv-a').textContent).toContain('已完成');
    expect(view.writes()).toEqual([]);
    await view.node('browse-return').fire('click'); await view.settle();
    expect(view.row('conv-a').classList.contains('unread')).toBe(false);
    expect(view.writes().map((call) => [call.method, call.scope, call.args]))
      .toEqual([['visitConversation', scopeA, ['conv-a']]]);
  });

  it('renders saved string plans as bounded untrusted text in B', async () => {
    const view = workbench(); await view.ready();
    view.handlers.browseConversation = (payload: any) => payload.kind === 'facts'
      ? factsPage('conv-b', 'B') : eventsPage('conv-b', 'B', { events: [{
        eventId: 12, turnId: 'B-turn', eventType: 'plan_updated', kind: 'agent',
        payload: { data: { plan: '核对文件\n<script>只读计划</script>', explanation: '保存的说明' } },
      }] });
    await openB(view);
    expect(view.node('browse-events').textContent).toContain('核对文件');
    expect(view.node('browse-events').textContent).toContain('<script>只读计划</script>');
    expect(view.node('browse-events').textContent).toContain('保存的说明');
    expect(view.writes()).toEqual([]);
  });

  it('opens B from the busy workspace without rebinding the execution snapshot, events or scoped API to B', async () => {
    const view = workbench(); await view.ready();
    expect(view.row('conv-b').disabled).toBe(false);
    expect(view.row('conv-a').disabled).toBe(true);
    const before = view.calls.length;
    await openB(view);
    expect(browsing(view)).toBe(true);
    expect(view.node('browse-title').textContent).toBe('只读查看：B 标题');
    expect(view.node('browse-execution-status').textContent).toContain('执行 A');
    expect(view.node('browse-execution-status').textContent).toContain('运行中');
    expect(view.node('browse-facts').textContent).toContain('B 的请求');
    // 不可信文本按纯文本显示。
    expect(view.node('browse-facts').textContent).toContain('<script>纯文本</script>');
    expect(view.node('browse-events').textContent).toContain('B 工具输出');
    expect(view.node('browse-events').textContent).toContain('B 的过程说明');
    expect(view.browseCalls().map((call) => [call.scope, call.args[0]])).toEqual([
      [scopeA, { conversationId: 'conv-b', kind: 'facts', limit: 20 }],
      [scopeA, { conversationId: 'conv-b', kind: 'events', limit: 150 }],
    ]);
    // 执行侧视图隐藏，A 的事实与事件缓存不含 B。
    for (const id of ['conversation', 'composer-wrap', 'a9-surface', 'a9-mode-open', 'workdir-control', 'a9-managed-processes']) {
      expect(view.node(id).hidden).toBe(true);
    }
    expect(view.node('browse-inspector-note').hidden).toBe(false);
    expect(view.node('a9-task-stream').textContent).toContain('A 的请求正文');
    expect(view.node('a9-task-stream').textContent).not.toContain('B 的');
    await jest.advanceTimersByTimeAsync(1500);
    const later = view.calls.slice(before);
    expect(later.every((call) => call.scope === null || call.scope.conversationId === 'conv-a')).toBe(true);
    expect(later.filter((call) => call.method === 'snapshot').length).toBeGreaterThanOrEqual(3);
    expect(later.filter((call) => call.method === 'queryEvents').every((call) => call.args[0].conversationId === 'conv-a')).toBe(true);
    expect(view.writes()).toEqual([]);
    // B 行为当前查看目标，A 行可返回。
    expect(view.row('conv-b').getAttribute('aria-current')).toBe('true');
    expect(view.row('conv-a').disabled).toBe(false);
  });

  it('keeps browsing when A completes and never steals focus or scroll back', async () => {
    const view = workbench(snapshot({ agentStatus: 'idle', conversation: [] })); await view.ready();
    const turn = deferred<any>();
    view.handlers.submitTurn = () => turn.promise;
    view.node('task-prompt').value = '开始任务';
    const request = view.ui.submitPrompt();
    view.current = snapshot();
    await jest.advanceTimersByTimeAsync(600);
    await openB(view);
    view.node('browse-stream').scrollTop = 40;
    view.node('browse-facts-heading').focus();
    const factNode = view.node('browse-facts').children[0];
    view.current = snapshot({ agentStatus: 'idle', conversations: snapshot().conversations.map((item: any) =>
      item.sessionId === 'conv-a' ? { ...item, activity: 'idle' } : item) });
    turn.resolve({ ok: true });
    await request; await view.settle();
    expect(browsing(view)).toBe(true);
    expect(view.node('browse-execution-status').textContent).toContain('空闲');
    expect(view.document.activeElement).toBe(view.node('browse-facts-heading'));
    expect(view.node('browse-stream').scrollTop).toBe(40);
    expect(view.node('browse-facts').children[0]).toBe(factNode);
    await view.row('conv-c').fire('click'); await view.settle();
    expect(browsing(view)).toBe(true);
    expect(view.node('browse-title').textContent).toContain('C 标题');
    expect(view.writes().map((call) => call.method)).toEqual(['submitTurn']);
  });

  it('switches B to C quickly and discards late B replies, including late errors', async () => {
    const view = workbench(); await view.ready();
    const lateFacts = deferred<any>(); const lateEvents = deferred<any>();
    const original = view.handlers.browseConversation;
    view.handlers.browseConversation = (payload: any) => payload.conversationId === 'conv-b'
      ? (payload.kind === 'facts' ? lateFacts.promise : lateEvents.promise) : original(payload);
    await openB(view);
    expect(view.node('browse-facts-status').textContent).toContain('正在读取');
    await openB(view, 'conv-c');
    expect(view.node('browse-title').textContent).toBe('只读查看：C 标题');
    lateFacts.resolve(factsPage('conv-b', 'B'));
    lateEvents.resolve({ ok: false, error: { code: 'A9_SCOPE_STALE', message: 'late failure' } });
    await view.settle();
    expect(view.node('browse-title').textContent).toBe('只读查看：C 标题');
    expect(view.node('browse-facts').textContent).toContain('C 的请求');
    expect(view.node('browse-facts').textContent).not.toContain('B 的');
    expect(view.node('browse-events-status').textContent).not.toContain('A9_SCOPE_STALE');
    expect(view.node('browse-events-retry').hidden).toBe(true);
    expect(view.row('conv-c').getAttribute('aria-current')).toBe('true');
  });

  it('returns to A restoring draft text, focus and selection; late replies after return change nothing', async () => {
    const view = workbench(); await view.ready();
    const prompt = view.node('task-prompt');
    prompt.value = '尚未发送的草稿';
    prompt.setSelectionRange(2, 5, 'forward');
    view.node('conversation').scrollTop = 120;
    view.node('conversation').fire('scroll');
    const late = deferred<any>();
    view.handlers.browseConversation = () => late.promise;
    await openB(view);
    prompt.selectionStart = 0; prompt.selectionEnd = 0; // 隐藏后浏览器可能丢失选区；返回时按记录恢复。
    view.node('conversation').scrollTop = 0;
    await view.node('browse-return').fire('click');
    expect(browsing(view)).toBe(false);
    expect(view.node('conversation').hidden).toBe(false);
    expect(view.node('composer-wrap').hidden).toBe(false);
    expect(prompt.value).toBe('尚未发送的草稿');
    expect(view.document.activeElement).toBe(prompt);
    expect([prompt.selectionStart, prompt.selectionEnd, prompt.selectionDirection]).toEqual([2, 5, 'forward']);
    expect(view.node('conversation').scrollTop).toBe(120);
    late.resolve(factsPage('conv-b', 'B'));
    await view.settle();
    expect(browsing(view)).toBe(false);
    expect(view.node('browse-facts').children).toHaveLength(0);
    expect(view.calls.filter((call) => call.method === 'saveDraft' && call.scope && call.scope.conversationId !== 'conv-a')).toEqual([]);
    expect(view.writes()).toEqual([]);
  });

  it('the execution row also returns, and A row click is still guarded against stale DOM after exit', async () => {
    const view = workbench(); await view.ready();
    await openB(view);
    const executionRow = view.row('conv-a');
    await executionRow.fire('click');
    expect(browsing(view)).toBe(false);
    await executionRow.fire('click');
    expect(browsing(view)).toBe(false);
    expect(view.writes()).toEqual([]);
  });

  it('exits when the real execution conversation or workspace changes, and never calls the old scope again', async () => {
    const view = workbench(); await view.ready();
    const late = deferred<any>();
    view.handlers.browseConversation = (payload: any) => payload.kind === 'facts' ? late.promise : eventsPage('conv-b', 'B', { hasMore: true });
    await openB(view);
    const browseCount = view.browseCalls().length;
    view.current = snapshot({ scope: { workspaceId: WS, conversationId: 'conv-c' }, activeConversationId: 'conv-c' });
    await jest.advanceTimersByTimeAsync(600);
    expect(browsing(view)).toBe(false);
    late.resolve(factsPage('conv-b', 'B'));
    await view.settle();
    await view.node('browse-events-older').fire('click');
    await view.node('browse-facts-retry').fire('click');
    await view.settle();
    expect(view.browseCalls()).toHaveLength(browseCount);
    expect(view.node('browse-facts').children).toHaveLength(0);
  });

  it('exits on workspace close and before a cross-workspace activation keeps its original flow', async () => {
    const view = workbench(); await view.ready();
    await openB(view);
    view.handlers.activateWorkspace = async () => ({ ok: true });
    await view.row('conv-x').fire('click');
    await view.settle();
    expect(browsing(view)).toBe(false);
    expect(view.calls.filter((call) => call.method === 'activateWorkspace').map((call) => call.args[0]))
      .toEqual([{ workspaceId: OTHER_WS, conversationId: 'conv-x' }]);
    await openB(view);
    expect(browsing(view)).toBe(true);
    view.handlers.snapshot = async () => ({ ok: false, error: { code: 'A9_WORKSPACE_REQUIRED' } });
    await jest.advanceTimersByTimeAsync(600);
    expect(browsing(view)).toBe(false);
  });

  it('pages facts and events with exact cursors, retries failures without leaking messages, and keeps a bounded window', async () => {
    const view = workbench(); await view.ready();
    let eventPage = 0;
    let factsFail = true;
    view.handlers.browseConversation = async (payload: any) => {
      if (payload.kind === 'facts') {
        if (factsFail) { factsFail = false; return { ok: false, error: { code: 'A9_CONVERSATION_MISMATCH', message: 'token=fixture-secret' } }; }
        return payload.before
          ? { ok: true, conversationId: 'conv-b', title: 'B 标题', facts: [{ taskId: 'old', requestPrompt: '更早的请求', outcome: 'completed', finalMessage: '更早答复', createdAt: '2026-11-01T00:00:00Z' }], hasMore: false, nextBefore: null }
          : factsPage('conv-b', 'B', { hasMore: true, nextBefore: { createdAt: '2026-11-08T08:00:00Z', taskId: 'B-t1' } });
      }
      eventPage += 1;
      const top = 10000 - (eventPage - 1) * 150;
      const events = Array.from({ length: 150 }, (_, index) => ({ eventId: top - 149 + index, turnId: 't', eventType: 'model_note',
        createdAt: '2026-11-08T08:00:00Z', payload: { data: { content: `说明 ${top - 149 + index} ${'长'.repeat(index === 0 ? 20000 : 1)}` } } }));
      return { ok: true, conversationId: 'conv-b', title: 'B 标题', events, hasMore: true };
    };
    await openB(view);
    expect(view.node('browse-facts-status').textContent).toBe('该对话不属于当前工作区或已不存在（A9_CONVERSATION_MISMATCH），可重试。');
    expect(view.node('browse-panel').textContent).not.toContain('fixture-secret');
    expect(view.node('browse-facts-retry').hidden).toBe(false);
    await view.node('browse-facts-retry').fire('click'); await view.settle();
    expect(view.node('browse-facts-retry').hidden).toBe(true);
    expect(view.node('browse-facts-older').hidden).toBe(false);
    await view.node('browse-facts-older').fire('click'); await view.settle();
    const factPayloads = view.browseCalls().filter((call) => call.args[0].kind === 'facts').map((call) => call.args[0]);
    expect(factPayloads[2]).toEqual({ conversationId: 'conv-b', kind: 'facts', limit: 20, before: { createdAt: '2026-11-08T08:00:00Z', taskId: 'B-t1' } });
    expect(view.node('browse-facts').children[0].textContent).toContain('更早的请求');
    expect(view.node('browse-facts-older').hidden).toBe(true);
    // 单条超长文本有界截断并明示。
    expect(view.node('browse-events').children[0].textContent).toContain('[已截断；完整内容见持久化事件与日志]');
    for (let page = 0; page < 4; page += 1) { await view.node('browse-events-older').fire('click'); await view.settle(); }
    const eventPayloads = view.browseCalls().filter((call) => call.args[0].kind === 'events').map((call) => call.args[0]);
    expect(eventPayloads[1]).toEqual({ conversationId: 'conv-b', kind: 'events', limit: 150, beforeEventId: 9851 });
    expect(eventPayloads[4].beforeEventId).toBe(9401);
    expect(view.node('browse-events').children).toHaveLength(600);
    expect(view.node('browse-events').children[0].dataset.eventId).toBe(String(10000 - 5 * 150 + 1));
    expect(view.node('browse-events-latest').hidden).toBe(false);
    expect(view.node('browse-events-status').textContent).toContain('只保留 600 条');
    await view.node('browse-events-latest').fire('click'); await view.settle();
    expect(view.node('browse-events').children).toHaveLength(150);
    expect(view.writes()).toEqual([]);
  });

  it('shows explicit empty states for a conversation without saved history', async () => {
    const view = workbench(); await view.ready();
    view.handlers.browseConversation = async (payload: any) => payload.kind === 'facts'
      ? { ok: true, conversationId: 'conv-b', title: 'B 标题', facts: [], hasMore: false, nextBefore: null }
      : { ok: true, conversationId: 'conv-b', title: 'B 标题', events: [], hasMore: false };
    await openB(view);
    expect(view.node('browse-facts-status').textContent).toBe('这个对话还没有已保存的请求。');
    expect(view.node('browse-events-status').textContent).toBe('这个对话没有已保存的过程记录。');
  });

  it('dispatches zero writes from send, Enter, queue, approval, question, stop, undo, settings, mode, directory and conversation entries', async () => {
    const pendingApproval = { approvalId: 'ap-1', bindingDigest: 'digest', conversationId: 'conv-a', taskId: 'task-a', turnId: 'turn-a',
      toolName: 'shell', summary: 'A 的审批摘要：git push' };
    const view = workbench(snapshot({ workdir: { path: 'C:\\work\\dir', origin: 'auto' },
      managedProcesses: [{ handleId: 'h1', lastProbeStatus: 'exited', cleanupRequired: true, canDismissRecovered: true, recoveryRevision: 'r1', pid: 7, startedAt: 'x' }] }));
    await view.ready();
    // 旧 DOM：进入浏览前已渲染的执行侧控件。
    const queueRemove = view.node('queue-items').children[0].children[1];
    const undo = view.node('a9-checkpoint-list').children[0].children[1].children[1];
    const dismiss = view.node('a9-managed-cards').children[0].children[4];
    view.current = snapshot({ agentStatus: 'needs_approval', pendingApproval });
    await jest.advanceTimersByTimeAsync(600);
    expect(view.node('a9-approval-card').dataset.approvalId).toBe('ap-1');
    await openB(view);
    expect(view.node('browse-execution-status').textContent).toContain('等待批准');
    expect(view.node('browse-execution-status').textContent).toContain('请返回执行对话处理');
    expect(view.node('browse-panel').textContent).not.toContain('git push');
    expect(view.node('composer-wrap').hidden).toBe(true);
    view.node('task-prompt').value = '不应发送';
    const key = (event: any) => view.fire('document:keydown', event);
    await view.ui.submitPrompt();
    await view.node('task-prompt').fire('keydown', { key: 'Enter' });
    await view.node('run-task').fire('click');
    await view.node('queue-task').fire('click');
    await view.node('queue-toggle').fire('click');
    await queueRemove.fire('click');
    await view.node('a9-approval-approve').fire('click');
    await view.ui.decideApproval('approved');
    await view.ui.replyQuestion({ decision: 'answered', answer: 'x' });
    await view.node('cancel-task').fire('click');
    await view.ui.stopTurn();
    await undo.fire('click');
    await dismiss.fire('click');
    await view.node('a9-managed-dismiss-form').fire('submit');
    await view.node('open-settings').fire('click');
    await view.node('a9-provider-open').fire('click');
    await view.node('a9-provider-apply').fire('click');
    await view.ui.applyProvider();
    await view.node('a9-provider-probe').fire('click');
    await view.node('a9-shell-apply').fire('click');
    await view.node('a9-mode-open').fire('click');
    await view.ui.chooseMode();
    await view.node('workdir-open').fire('click');
    await view.node('workdir-link').fire('click');
    await view.node('workdir-rename').fire('click');
    await view.node('workdir-rename-apply').fire('click');
    await view.node('conversation-new').fire('click');
    await key({ key: 'n', ctrlKey: true });
    await view.node('conversation-archive').fire('click');
    await view.node('conversation-pin').fire('click');
    await view.node('conversation-rename-apply').fire('click');
    await view.node('workspace-close-confirm').fire('click');
    await view.row('conv-d').parentNode!.children[1].fire('click');
    await view.row('conv-c').parentNode!.fire('contextmenu', { clientX: 5, clientY: 5 });
    await jest.advanceTimersByTimeAsync(10000);
    expect(view.writes()).toEqual([]);
    expect(view.calls.every((call) => !call.scope || call.scope.conversationId === 'conv-a')).toBe(true);
    expect(view.node('conversation-row-menu').hidden).toBe(true);
    // 设置抽屉未打开：openDrawer 打开时会把工作台设为 inert。
    expect(view.document.querySelector('.workbench').inert).not.toBe(true);
    expect(view.node('task-prompt').value).toBe('不应发送');
    expect(view.node('browse-guard-note').hidden).toBe(false);
    expect(view.node('browse-guard-note').textContent).toContain('返回执行对话');
    expect(view.row('conv-d').parentNode!.children[1].disabled).toBe(true);
    expect(view.node('open-settings').disabled).toBe(true);
    // 查找：不把 A 的匹配当作 B，明确停用并提示。
    await key({ key: 'f', ctrlKey: true });
    expect(view.node('conversation-find').hidden).toBe(true);
    expect(view.node('browse-guard-note').textContent).toContain('查找');
    // 返回后原入口恢复，审批仍在 A。
    await view.node('browse-return').fire('click');
    expect(view.node('open-settings').disabled).toBe(false);
    expect(view.node('composer-wrap').hidden).toBe(false);
    expect(view.node('a9-approval-card').hidden).toBe(false);
  });

  it('browses archived history read-only without restoring it, and keeps the original activation flow when A is idle', async () => {
    const view = workbench(snapshot({ agentStatus: 'idle' })); await view.ready();
    expect(view.row('conv-d').disabled).toBe(false);
    await openB(view, 'conv-d');
    expect(view.node('browse-title').textContent).toBe('只读查看：D 标题（已归档）');
    expect(view.writes()).toEqual([]);
    await view.node('browse-return').fire('click');
    await view.row('conv-b').fire('click');
    await view.settle();
    expect(browsing(view)).toBe(false);
    expect(view.calls.filter((call) => call.method === 'activateConversation').map((call) => [call.scope, call.args]))
      .toEqual([[scopeA, ['conv-b']]]);
    expect(view.writes().map((call) => call.method)).toEqual(['saveDraft', 'activateConversation']);
  });

  it('guards send, Enter, undo and conversation writes even when A is idle and those entries would otherwise dispatch', async () => {
    const view = workbench(snapshot({ agentStatus: 'idle', conversation: [] })); await view.ready();
    const undo = view.node('a9-checkpoint-list').children[0].children[1].children[1];
    await openB(view, 'conv-d');
    expect(browsing(view)).toBe(true);
    view.node('task-prompt').value = '空闲时也不能从只读查看发送';
    view.node('conversation-rename-input').value = '新名称';
    const actions: Array<[string, () => Promise<unknown>]> = [
      ['submitPrompt', () => view.ui.submitPrompt()],
      ['Enter', () => view.node('task-prompt').fire('keydown', { key: 'Enter' })],
      ['run-task', () => view.node('run-task').fire('click')],
      ['undo', () => undo.fire('click')],
      ['archive', () => view.node('conversation-archive').fire('click')],
      ['rename', () => view.node('conversation-rename-apply').fire('click')],
      ['pin', () => view.node('conversation-pin').fire('click')],
    ];
    for (const [name, action] of actions) {
      await action();
      await jest.advanceTimersByTimeAsync(6000);
      expect([name, view.writes()]).toEqual([name, []]);
    }
    expect(view.node('task-prompt').value).toBe('空闲时也不能从只读查看发送');
    expect(view.node('a9-undo-state').textContent).not.toContain('撤销');
  });

  it('keeps focus on a directory row across polling redraws while browsing', async () => {
    const view = workbench(); await view.ready();
    await openB(view);
    view.row('conv-c').focus();
    await jest.advanceTimersByTimeAsync(1500);
    expect(view.document.activeElement).toBe(view.row('conv-c'));
    expect(browsing(view)).toBe(true);
    expect(view.node('browse-title').textContent).toBe('只读查看：B 标题');
  });

  it('shows a pending question as a return prompt instead of rendering it inside B', async () => {
    const pendingQuestion = { conversationId: 'conv-a', questionId: 'q', revision: 1, prompt: 'A 的问题内容' };
    const view = workbench(snapshot({ agentStatus: 'needs_input', pendingQuestion })); await view.ready();
    await openB(view);
    expect(view.node('browse-execution-status').textContent).toContain('等待回答');
    expect(view.node('browse-panel').textContent).not.toContain('A 的问题内容');
    await view.ui.replyQuestion({ decision: 'answered', answer: '不应提交' });
    expect(view.writes()).toEqual([]);
  });
});
