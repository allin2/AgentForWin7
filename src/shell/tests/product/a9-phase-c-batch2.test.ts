/// <reference path="./better-sqlite3.d.ts" />
/**
 * Phase C 批次 2：C2（强制转态 + fail-closed）与 C3（事件驱动快照推送）。
 */
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as vm from 'vm';
import Database from 'better-sqlite3';

const status = require('../../product/renderer/a9-agent-status');
const { createA9AgentRuntime } = require('../../product/a9-agent-runtime');
const { createSnapshotPushNotifier, SNAPSHOT_UPDATED_CHANNEL } = require('../../product/a9-snapshot-push');
const productFile = (file: string) => path.join(__dirname, '../../product', file);
const read = (file: string) => fs.readFileSync(productFile(file), 'utf8');

describe('C2 strict agent status transition table', () => {
  const ALL: string[] = status.STATUSES;
  const RESTING = ['idle', 'completed', 'completed_with_warnings', 'cancelled', 'failed', 'blocked', 'stuck', 'budget_exceeded', 'interrupted'];
  const OUTCOMES = ['completed', 'completed_with_warnings', 'cancelled', 'needs_approval', 'needs_input', 'failed', 'blocked', 'stuck', 'budget_exceeded'];

  test('the table is explicit and closed over the known vocabulary', () => {
    expect(Object.keys(status.TRANSITIONS).sort()).toEqual([...ALL].sort());
    for (const [from, targets] of Object.entries<string[]>(status.TRANSITIONS)) {
      expect(Object.isFrozen(targets)).toBe(true);
      for (const to of targets) expect(ALL).toContain(to);
      expect(targets).not.toContain(from);
      expect(new Set(targets).size).toBe(targets.length);
    }
    expect(Object.isFrozen(status.TRANSITIONS)).toBe(true);
  });

  test('IDLE -> RUNNING -> WAITING_APPROVAL / WAITING_USER_INPUT -> COMPLETED / FAILED / CANCELLED is the main line', () => {
    expect(status.canTransition('idle', 'running')).toBe(true);
    expect(status.canTransition('running', 'needs_approval')).toBe(true);
    expect(status.canTransition('running', 'needs_input')).toBe(true);
    expect(status.canTransition('needs_approval', 'running')).toBe(true);
    expect(status.canTransition('needs_input', 'running')).toBe(true);
    for (const end of ['completed', 'failed', 'cancelled']) expect(status.canTransition('running', end)).toBe(true);
  });

  test('exhaustive edge set equals the contract: nothing outside it is legal', () => {
    const expected = new Set<string>();
    for (const from of RESTING) for (const to of ['running', 'failed', 'interrupted']) if (from !== to) expected.add(`${from}>${to}`);
    for (const to of [...OUTCOMES, 'cancelling', 'interrupted']) if (to !== 'running') expected.add(`running>${to}`);
    for (const to of [...OUTCOMES, 'interrupted']) expected.add(`cancelling>${to}`);
    for (const from of ['needs_approval', 'needs_input']) {
      for (const to of ['running', 'cancelling', 'cancelled', 'needs_approval', 'needs_input', 'failed', 'interrupted']) expected.add(`${from}>${to}`);
    }
    const actual = new Set<string>();
    for (const from of ALL) for (const to of ALL) if (from !== to && status.canTransition(from, to)) actual.add(`${from}>${to}`);
    expect([...actual].sort()).toEqual([...expected].filter((edge) => { const [f, t] = edge.split('>'); return f !== t; }).sort());
  });

  test('illegal edges: no silent jump from resting to an outcome, from cancelling back to running, or to idle', () => {
    for (const from of RESTING) {
      for (const to of ['cancelling', 'needs_approval', 'needs_input', 'completed_with_warnings']) {
        if (from !== to) expect(status.canTransition(from, to)).toBe(false);
      }
    }
    expect(status.canTransition('cancelling', 'running')).toBe(false);
    expect(status.canTransition('running', 'idle')).toBe(false);
    expect(status.canTransition('needs_input', 'completed')).toBe(false);
    expect(status.canTransition('completed', 'cancelled')).toBe(false);
  });

  test('unknown vocabulary is never legal on either side', () => {
    expect(status.canTransition('running', 'WAITING')).toBe(false);
    expect(status.canTransition('closed', 'running')).toBe(false);
    expect(status.canTransition(undefined, 'running')).toBe(false);
    expect(status.allowedTargets('closed')).toEqual([]);
  });

  test('assertTransition throws a structured error that preserves the scene', () => {
    expect(() => status.assertTransition('idle', 'running')).not.toThrow();
    let caught: any;
    try { status.assertTransition('completed', 'cancelling', { activeController: true }); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(Error);
    expect(caught.code).toBe('A9_AGENT_STATUS_TRANSITION_ILLEGAL');
    expect(caught.diagnostics).toEqual({
      from: 'completed', to: 'cancelling', fromKnown: true, toKnown: true,
      allowed: ['running', 'failed', 'interrupted'], activeController: true,
    });
  });
});

describe('C2 setAgentStatus enforces the table fail-closed', () => {
  function harness(initial = 'idle', overrides: any = {}) {
    const diagnostics: Array<[string, any]> = [];
    const observed: any[] = [];
    const pushes: string[] = [];
    const context: any = {
      agentStatusModel: status, activeController: null, currentPendingApproval: null, currentPendingQuestion: null, activeLifecycle: null,
      config: { agentStatusObserver: (t: any) => observed.push(t), onSnapshotChanged: (c: any) => pushes.push(c.reason), ...overrides },
      recordRuntimeDiagnostic: (code: string, error: any) => diagnostics.push([code, error]),
      Object, Error, String, Boolean,
    };
    const source = read('a9-agent-runtime.js');
    const start = source.indexOf("  let agentStatus = 'idle';");
    const end = source.indexOf('  function markCancelling()');
    vm.runInNewContext(source.slice(start, end).replace("let agentStatus = 'idle';", `let agentStatus = ${JSON.stringify(initial)};`)
      + '\nthis.set = setAgentStatus; this.get = () => agentStatus;', context);
    return { set: context.set as (n: string, o?: any) => void, get: context.get as () => string, diagnostics, observed, pushes, context };
  }

  test('a legal transition commits, notifies the observer and pushes a snapshot signal', () => {
    const h = harness('idle');
    h.set('running');
    expect(h.get()).toBe('running');
    expect(h.observed).toEqual([{ from: 'idle', to: 'running', resync: false, legal: true }]);
    expect(h.pushes).toEqual(['status:running']);
    expect(h.diagnostics).toEqual([]);
  });

  test('an illegal transition throws, keeps the current status and records a diagnostic with the scene', () => {
    const h = harness('completed');
    h.context.activeController = {};
    h.context.currentPendingQuestion = { questionId: 'q' };
    let caught: any;
    try { h.set('cancelling'); } catch (error) { caught = error; }
    expect(caught.code).toBe('A9_AGENT_STATUS_TRANSITION_ILLEGAL');
    expect(caught.diagnostics).toMatchObject({ from: 'completed', to: 'cancelling', activeController: true, pendingApproval: false, pendingQuestion: true, lifecycleOpen: false });
    expect(h.get()).toBe('completed');
    expect(h.observed).toEqual([{ from: 'completed', to: 'cancelling', resync: false, legal: false }]);
    expect(h.pushes).toEqual([]);
    expect(h.diagnostics).toHaveLength(1);
    expect(h.diagnostics[0][0]).toBe('A9_AGENT_STATUS_TRANSITION_ILLEGAL');
    expect(h.diagnostics[0][1].code).toBe('A9_AGENT_STATUS_TRANSITION_ILLEGAL');
    expect(h.diagnostics[0][1].message).toContain('completed -> cancelling');
  });

  test('an illegal transition is rejected even when the observer throws; the observer failure stays visible', () => {
    const h = harness('idle', { agentStatusObserver: () => { throw new Error('observer boom'); } });
    expect(() => h.set('needs_approval')).toThrow(expect.objectContaining({ code: 'A9_AGENT_STATUS_TRANSITION_ILLEGAL' }));
    expect(h.get()).toBe('idle');
    expect(h.diagnostics.map(([code]) => code)).toEqual(['A9_STATUS_OBSERVER_FAILED', 'A9_AGENT_STATUS_TRANSITION_ILLEGAL']);
  });

  test('unknown statuses keep throwing A9_AGENT_STATUS_INVALID and never reach the table', () => {
    const h = harness('idle');
    expect(() => h.set('WAITING_APPROVAL')).toThrow(expect.objectContaining({ code: 'A9_AGENT_STATUS_INVALID' }));
    expect(h.get()).toBe('idle');
  });

  test('durable resynchronization bypasses the table and still signals the renderer', () => {
    const h = harness('completed');
    h.set('needs_input', { resync: true });
    expect(h.get()).toBe('needs_input');
    expect(h.observed[0]).toMatchObject({ resync: true, legal: true });
    expect(h.pushes).toEqual(['status:needs_input']);
  });

  test('a self transition is idempotent and does not push', () => {
    const h = harness('running');
    h.set('running');
    expect(h.get()).toBe('running');
    expect(h.pushes).toEqual([]);
  });

  test('a throwing push hook is recorded and never changes the committed status', () => {
    const h = harness('idle', { onSnapshotChanged: () => { throw new Error('push boom'); } });
    h.set('running');
    expect(h.get()).toBe('running');
    expect(h.diagnostics.map(([code]) => code)).toEqual(['A9_SNAPSHOT_NOTIFY_FAILED']);
  });

  test('Stop/shutdown cannot turn an already-effective abort into an error, but the illegal edge stays diagnosed', () => {
    const source = read('a9-agent-runtime.js');
    const start = source.indexOf('  function markCancelling()');
    const body = source.slice(start, source.indexOf('  function statusForConversationActivity', start));
    expect(body).toContain("error.code !== 'A9_AGENT_STATUS_TRANSITION_ILLEGAL'");
    expect(body).toContain('throw error');
    expect((source.match(/setAgentStatus\('cancelling'\)/g) || [])).toHaveLength(1);
  });
});

describe('C3 snapshot push notifier', () => {
  function fakeTimers() {
    const queue: Array<() => void> = [];
    return { setTimer: (fn: () => void) => { queue.push(fn); return queue.length; }, clearTimer: () => { queue.length = 0; }, run: () => { const fns = queue.splice(0); fns.forEach((fn) => fn()); }, size: () => queue.length };
  }

  test('coalesces a burst per workspace into one message with de-duplicated reasons', () => {
    const t = fakeTimers(); const sent: any[] = [];
    const n = createSnapshotPushNotifier({ send: (c: string, p: any) => sent.push([c, p]), setTimer: t.setTimer, clearTimer: t.clearTimer, now: () => 42 });
    for (let i = 0; i < 50; i += 1) n.notify({ workspaceId: 'w1', reason: i % 2 ? 'model_chunk' : 'status:running' });
    n.notify({ workspaceId: 'w2', reason: 'approval_pending' });
    expect(sent).toEqual([]);
    expect(t.size()).toBe(1);
    t.run();
    expect(sent).toEqual([
      [SNAPSHOT_UPDATED_CHANNEL, { schemaVersion: 1, workspaceId: 'w1', reasons: ['status:running', 'model_chunk'], at: 42 }],
      [SNAPSHOT_UPDATED_CHANNEL, { schemaVersion: 1, workspaceId: 'w2', reasons: ['approval_pending'], at: 42 }],
    ]);
    expect(SNAPSHOT_UPDATED_CHANNEL).toBe('a9:snapshot:updated');
    expect(n.stats()).toMatchObject({ notified: 51, sent: 2, failed: 0 });
  });

  test('idle means zero messages; the next change after a flush schedules again', () => {
    const t = fakeTimers(); const sent: any[] = [];
    const n = createSnapshotPushNotifier({ send: (_c: string, p: any) => sent.push(p), setTimer: t.setTimer, clearTimer: t.clearTimer });
    t.run();
    expect(sent).toEqual([]);
    n.notify({ workspaceId: 'w', reason: 'a' }); t.run();
    n.notify({ workspaceId: 'w', reason: 'b' }); t.run();
    expect(sent.map((p) => p.reasons)).toEqual([['a'], ['b']]);
  });

  test('payload is bounded and carries no content fields', () => {
    const t = fakeTimers(); const sent: any[] = [];
    const n = createSnapshotPushNotifier({ send: (_c: string, p: any) => sent.push(p), setTimer: t.setTimer, clearTimer: t.clearTimer });
    for (let i = 0; i < 30; i += 1) n.notify({ workspaceId: 'w', reason: `r${i}-${'x'.repeat(200)}`, secret: 'sk-leak', path: 'C:\\secret' } as any);
    t.run();
    expect(sent[0].reasons).toHaveLength(8);
    for (const reason of sent[0].reasons) expect(reason.length).toBeLessThanOrEqual(64);
    expect(Object.keys(sent[0]).sort()).toEqual(['at', 'reasons', 'schemaVersion', 'workspaceId']);
  });

  test('a failing sender is reported, counted and does not block other workspaces or later pushes', () => {
    const t = fakeTimers(); const errors: any[] = []; let calls = 0;
    const n = createSnapshotPushNotifier({ send: () => { calls += 1; if (calls === 1) throw new Error('window gone'); }, setTimer: t.setTimer, clearTimer: t.clearTimer, onError: (e: Error) => errors.push(e.message) });
    n.notify({ workspaceId: 'a', reason: 'x' }); n.notify({ workspaceId: 'b', reason: 'x' });
    t.run();
    expect(errors).toEqual(['window gone']);
    expect(calls).toBe(2);
    expect(n.stats()).toMatchObject({ sent: 1, failed: 1 });
  });

  test('close drops pending work and ignores later changes', () => {
    const t = fakeTimers(); const sent: any[] = [];
    const n = createSnapshotPushNotifier({ send: (_c: string, p: any) => sent.push(p), setTimer: t.setTimer, clearTimer: t.clearTimer });
    n.notify({ workspaceId: 'w', reason: 'a' });
    n.close();
    n.notify({ workspaceId: 'w', reason: 'b' });
    t.run();
    expect(sent).toEqual([]);
    expect(() => createSnapshotPushNotifier({})).toThrow('A9_SNAPSHOT_PUSH_SEND_REQUIRED');
  });
});

describe('C3 preload bridge and registry wiring', () => {
  function loadPreload() {
    const listeners = new Map<string, Array<(event: any, message: any) => void>>();
    let exposed: any;
    const electron = {
      contextBridge: { exposeInMainWorld: (_name: string, api: any) => { exposed = api; } },
      ipcRenderer: {
        on: (channel: string, fn: any) => { listeners.set(channel, [...(listeners.get(channel) || []), fn]); },
        removeListener: (channel: string, fn: any) => { listeners.set(channel, (listeners.get(channel) || []).filter((item) => item !== fn)); },
        invoke: async () => ({}), send() {},
      },
    };
    const context: any = { require: (name: string) => name === 'electron' ? electron : require(name), process: { argv: [] }, setTimeout, clearTimeout, setInterval, clearInterval, Date, Symbol, Map, Set, Object, Array, Number, String, JSON, Promise, TypeError, Error };
    vm.runInNewContext(read('preload.js'), context, { filename: productFile('preload.js') });
    return { api: exposed, listeners };
  }

  test('onA9SnapshotUpdated delivers only sanitized, versioned payloads and unsubscribes cleanly', () => {
    const { api, listeners } = loadPreload();
    const received: any[] = [];
    const off = api.onA9SnapshotUpdated((payload: any) => received.push(payload));
    const [listener] = listeners.get('a9:snapshot:updated') || [];
    expect(listener).toBeDefined();
    listener({}, { schemaVersion: 1, workspaceId: 'w', reasons: ['status:running', 7, 'event:tool_end'], at: 5, path: 'C:\\x', apiKey: 'sk-1' });
    listener({}, { schemaVersion: 2, workspaceId: 'w', reasons: [] });
    listener({}, { schemaVersion: 1, workspaceId: 9 });
    listener({}, null);
    expect(received).toEqual([{ workspaceId: 'w', reasons: ['status:running', 'event:tool_end'], at: 5 }]);
    off();
    expect(listeners.get('a9:snapshot:updated')).toEqual([]);
    expect(() => api.onA9SnapshotUpdated('nope')).toThrow(TypeError);
  });

  test('the registry stamps each runtime push with its own workspace id', () => {
    const { createA9WorkspaceRegistry } = require('../../product/a9-workspace-registry');
    const changes: any[] = [];
    const runtimes: any[] = [];
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a9-c3-reg-'));
    try {
      const registry = createA9WorkspaceRegistry({
        createRuntime: (_root: string, host: any) => { const runtime = { status: 'ready', host, getSnapshot: () => ({}) }; runtimes.push(runtime); return runtime; },
        getDocumentsPath: () => dir, getDataRoot: () => dir,
        onSnapshotChanged: (change: any) => changes.push(change),
      });
      const wsA = path.join(dir, 'a'); const wsB = path.join(dir, 'b'); fs.mkdirSync(wsA); fs.mkdirSync(wsB);
      const a = registry.open(wsA); const b = registry.open(wsB);
      runtimes[0].host.onSnapshotChanged({ reason: 'status:running', at: 1 });
      runtimes[1].host.onSnapshotChanged({ reason: 'status:completed', at: 2 });
      expect(changes).toEqual([
        { reason: 'status:running', at: 1, workspaceId: a.workspaceId },
        { reason: 'status:completed', at: 2, workspaceId: b.workspaceId },
      ]);
      expect(a.workspaceId).not.toBe(b.workspaceId);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('main wires the notifier to the window and registry', () => {
    const main = read('main.js');
    expect(main).toContain("require('./a9-snapshot-push')");
    expect(main).toContain('onSnapshotChanged: change => a9SnapshotPush.notify(change)');
    expect(main).toContain('mainWindow.webContents.send(channel, payload)');
  });
});

describe('C3 renderer is event driven with a low-frequency keepalive', () => {
  const source = read('renderer/a9-workbench.js');
  function pollingHarness(stateOverrides: any) {
    const intervals: Array<{ id: number; ms: number; fn: () => void }> = [];
    const cleared: number[] = [];
    let nextId = 1;
    const refreshes: number[] = [];
    const state: any = { snapshot: null, workspaceDirectory: [], snapshotPollingRequests: 0, snapshotPollingPauses: 0, snapshotPollingClosed: false,
      stopSnapshotPolling: null, snapshotPollingMs: 0, snapshotPushActive: false, snapshotRequest: null, ...stateOverrides };
    const root = { setInterval: (fn: () => void, ms: number) => { const id = nextId++; intervals.push({ id, ms, fn }); return id; }, clearInterval: (id: number) => { cleared.push(id); },
      win7AgentStatus: status };
    const context: any = { root, state, refreshSnapshot: () => { refreshes.push(1); return Promise.resolve(null); }, showSnapshotError() {}, Promise, Boolean,
      SNAPSHOT_POLL_LEGACY_MS: 500, SNAPSHOT_POLL_MANAGED_MS: 5000, SNAPSHOT_KEEPALIVE_ACTIVE_MS: 30000, SNAPSHOT_KEEPALIVE_IDLE_MS: 60000 };
    const start = source.indexOf('  function syncSnapshotPolling() {');
    const end = source.indexOf('  // C3：事件响应式刷新');
    vm.runInNewContext(source.slice(start, end) + '\nthis.sync = syncSnapshotPolling;', context);
    return { sync: context.sync as () => void, intervals, cleared, state, refreshes };
  }
  const activeSnapshot = { status: 'ready', agentStatus: 'running', workspaces: [], managedProcesses: [], queue: { paused: true, items: [] } };

  test('constants: 30–60 s keepalive, 5 s only for live managed processes, 500 ms legacy fallback', () => {
    expect(source).toContain('const SNAPSHOT_POLL_LEGACY_MS = 500;');
    expect(source).toContain('const SNAPSHOT_POLL_MANAGED_MS = 5000;');
    expect(source).toContain('const SNAPSHOT_KEEPALIVE_ACTIVE_MS = 30000;');
    expect(source).toContain('const SNAPSHOT_KEEPALIVE_IDLE_MS = 60000;');
  });

  test('without push capability the historic 500 ms poll is unchanged and idle runs no timer', () => {
    const active = pollingHarness({ snapshot: activeSnapshot });
    active.sync();
    expect(active.intervals.map((i) => i.ms)).toEqual([500]);
    const idle = pollingHarness({ snapshot: { ...activeSnapshot, agentStatus: 'idle' } });
    idle.sync();
    expect(idle.intervals).toEqual([]);
  });

  test('with push: active turn keeps only a 30 s keepalive, idle keeps a 60 s keepalive', () => {
    const active = pollingHarness({ snapshot: activeSnapshot, snapshotPushActive: true });
    active.sync(); active.sync();
    expect(active.intervals.map((i) => i.ms)).toEqual([30000]);
    const idle = pollingHarness({ snapshot: { ...activeSnapshot, agentStatus: 'idle' }, snapshotPushActive: true });
    idle.sync();
    expect(idle.intervals.map((i) => i.ms)).toEqual([60000]);
  });

  test('the cadence follows the state: idle -> active replaces the timer; live managed process uses 5 s', () => {
    const h = pollingHarness({ snapshot: { ...activeSnapshot, agentStatus: 'idle' }, snapshotPushActive: true });
    h.sync();
    h.state.snapshot = activeSnapshot; h.sync();
    h.state.snapshot = { ...activeSnapshot, agentStatus: 'idle', managedProcesses: [{ lastProbeStatus: 'running', ownershipState: 'owned' }] }; h.sync();
    expect(h.intervals.map((i) => i.ms)).toEqual([60000, 30000, 5000]);
    expect(h.cleared).toEqual([1, 2]);
  });

  test('pauses and close stop the timer even with push enabled', () => {
    const h = pollingHarness({ snapshot: activeSnapshot, snapshotPushActive: true });
    h.sync();
    h.state.snapshotPollingPauses = 1; h.sync();
    expect(h.cleared).toEqual([1]);
    expect(h.state.stopSnapshotPolling).toBeNull();
  });

  test('a tick still refreshes through refreshSnapshot', () => {
    const h = pollingHarness({ snapshot: activeSnapshot, snapshotPushActive: true });
    h.sync(); h.intervals[0].fn();
    expect(h.refreshes).toHaveLength(1);
  });

  test('push handler refreshes through the coalescing refreshSnapshot and respects pauses/close', () => {
    const start = source.indexOf('function onSnapshotPushed');
    const end = source.indexOf('  function subscribeSnapshotPush() {');
    const refreshes: number[] = [];
    const state: any = { snapshotPollingClosed: false, snapshotPollingPauses: 0, snapshotPushDirty: false };
    const context: any = { state, refreshSnapshot: () => { refreshes.push(1); return Promise.resolve(null); }, showSnapshotError() {}, Promise };
    vm.runInNewContext(source.slice(start, end) + '\nthis.push = onSnapshotPushed;', context);
    context.push(); context.push();
    expect(refreshes).toHaveLength(2);
    state.snapshotPollingPauses = 1; context.push();
    expect(state.snapshotPushDirty).toBe(true);
    state.snapshotPollingPauses = 0; state.snapshotPollingClosed = true; context.push();
    expect(refreshes).toHaveLength(2);
  });

  test('bind subscribes (before initialize reads the first snapshot) and unload unsubscribes', () => {
    const bindBody = source.slice(source.indexOf('  function bind() {'), source.indexOf('  async function initialize() {'));
    expect(bindBody).toContain('subscribeSnapshotPush();');
    const init = source.slice(source.indexOf('  async function initialize() {'));
    expect(init.indexOf('bind();')).toBeLessThan(init.indexOf('await refreshSnapshot();'));
    expect(source).toContain("api.onA9SnapshotUpdated(onSnapshotPushed)");
    expect(source).toContain('if (state.stopSnapshotPush) { state.stopSnapshotPush(); state.stopSnapshotPush = null; }');
  });
});

describe('C2/C3 real runtime: transitions stay legal and every lifecycle change is pushed', () => {
  type Step = 'text' | 'ask' | 'hang';
  async function fixture(steps: Step[]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a9-c-b2-'));
    const workspaceRoot = path.join(root, 'ws'); const dataRoot = path.join(root, 'data');
    fs.mkdirSync(workspaceRoot); fs.mkdirSync(dataRoot);
    const hanging: http.ServerResponse[] = [];
    let notifyHang: (() => void) | undefined;
    const hung = new Promise<void>((resolve) => { notifyHang = resolve; });
    let index = 0;
    const server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        const step = steps[index++] || 'text';
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        if (step === 'hang') { res.write(': waiting\n\n'); hanging.push(res); notifyHang?.(); return; }
        const delta = step === 'ask'
          ? { tool_calls: [{ index: 0, id: `q-${index}`, type: 'function', function: { name: 'ask_user', arguments: JSON.stringify({ prompt: 'which?' }) } }] }
          : { content: 'done' };
        res.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: step === 'ask' ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const transitions: any[] = []; const pushes: string[] = []; const databases: any[] = [];
    const runtime = createA9AgentRuntime({
      workspaceRoot, dataRoot, ownerId: `a9-c-b2-${process.pid}`,
      openDatabase: (file: string, options: any = {}) => { const db = new Database(file, options); databases.push(db); return db; },
      agentStatusObserver: (t: any) => transitions.push(t),
      onSnapshotChanged: (change: any) => pushes.push(change.reason),
    });
    runtime.setMode('read_only');
    await runtime.configureProvider({ baseUrl: `http://127.0.0.1:${(server.address() as any).port}`, model: 'fixture', skipProbe: true });
    const close = async () => {
      try { await runtime.shutdown(); } finally {
        hanging.forEach((res) => res.destroy());
        for (const db of databases) if (db.open) db.close();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        fs.rmSync(root, { recursive: true, force: true });
      }
    };
    return { runtime, transitions, pushes, hung, close };
  }

  test('complete, ask/answer and Stop: all transitions legal, status/question/event pushes emitted, no diagnostics', async () => {
    const f = await fixture(['text', 'ask', 'text', 'hang']);
    try {
      expect((await f.runtime.submitTurn('hello')).result.outcome).toBe('completed');
      expect(f.pushes).toEqual(expect.arrayContaining(['status:running', 'status:completed', 'event:turn_completed']));
      const asked = await f.runtime.submitTurn('ask me');
      expect(asked.result.outcome).toBe('needs_input');
      expect(f.pushes).toEqual(expect.arrayContaining(['question_pending', 'status:needs_input']));
      const q = asked.result.pendingQuestion;
      expect((await f.runtime.answerQuestion({ conversationId: q.conversationId, questionId: q.questionId, revision: q.revision, decision: 'answered', answer: 'this one' })).ok).toBe(true);
      const stopped = f.runtime.submitTurn('wait then stop');
      await f.hung;
      expect(f.runtime.stop().ok).toBe(true);
      expect((await stopped).result.outcome).toBe('cancelled');
      expect(f.pushes).toEqual(expect.arrayContaining(['status:cancelling', 'status:cancelled']));
      expect(f.transitions.filter((t) => !t.legal)).toEqual([]);
      expect(f.runtime.getSnapshot().persistenceDiagnostics || []).toEqual([]);
    } finally { await f.close(); }
  }, 30_000);

  test('a push hook that throws cannot change a turn', async () => {
    const f = await fixture(['text']);
    try {
      (f.pushes as any).push = () => { throw new Error('push boom'); };
      expect((await f.runtime.submitTurn('hello')).result.outcome).toBe('completed');
      expect(f.runtime.getSnapshot().agentStatus).toBe('completed');
      expect(f.runtime.getSnapshot().persistenceDiagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'A9_SNAPSHOT_NOTIFY_FAILED' }),
      ]));
    } finally { await f.close(); }
  }, 30_000);

  test('P1-1: cancelling status with pending approval recovers to needs_approval so resumeApproval is legal', () => {
    // When selectOfficeActions is interrupted by Stop, agentStatus becomes cancelling.
    // The finally block restores status to needs_approval when currentPendingApproval is active.
    expect(status.canTransition('needs_approval', 'cancelling')).toBe(true);
    expect(status.canTransition('cancelling', 'needs_approval')).toBe(true);
    expect(status.canTransition('needs_approval', 'running')).toBe(true);
    expect(status.canTransition('cancelling', 'running')).toBe(false);
  });
});
