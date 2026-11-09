/// <reference path="./better-sqlite3.d.ts" />
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vm from 'vm';
import Database from 'better-sqlite3';
const { normalizeConversationTitle } = require('../../../state/dist');
const { createA9AgentRuntime, openA9RuntimePersistence } = require('../../product/a9-agent-runtime');
const { createA9WorkspaceRegistry } = require('../../product/a9-workspace-registry');
const { createA9ProductRequestHandler } = require('../../product/a9-product-ipc');
const { defaultWorkdirName, reserveWorkdir } = require('../../product/a9-default-workdir');
const date = new Date(2026, 10, 9, 12);
const done = { id: 'done', content: 'done', finishReason: 'stop' };

async function until(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('WORKDIR_CONDITION_TIMEOUT');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

describe('A9-55 default workdir real State/runtime/IPC', () => {
  let root: string, documents: string, dataRoot: string, registry: any, handler: any, databases: any[], store: any;
  let steps: any[], chosen: string | null, opened: string[];
  const scope = () => { const e = registry.getActive(); return { workspaceId: e.workspaceId, conversationId: e.runtime.getSnapshot().activeConversationId }; };
  const runtime = () => registry.getActive().runtime;
  const call = (action: string, payload = {}, target: any = scope()) => handler({}, { schemaVersion: 9, action: `a9.${action}`, payload, ...(target ? { scope: target } : {}) });
  const make = () => {
    const options = { dataRoot, openDatabase: (file: string, flags: any) => { const db = new Database(file, flags); databases.push(db); return db; } };
    registry = createA9WorkspaceRegistry({ getDocumentsPath: () => documents, now: () => date, normalizeConversationTitle,
      openPersistence: () => { const result = openA9RuntimePersistence(options); store = result.manager; return result; },
      createRuntime: (workspaceRoot: string, host: any) => createA9AgentRuntime({ ...options, ...host, workspaceRoot,
        ownerId: `main-${process.pid}`, wrapProvider: () => ({ sendStreamRequest: async () => {
          const step = steps.shift(); return typeof step === 'function' ? step() : step || done;
        } }),
      }) });
    handler = createA9ProductRequestHandler({ workspaceRegistry: registry, isValidRendererSender: (e: any) => e.trusted !== false,
      getA9Runtime: () => registry.getActive()?.runtime, chooseWorkspace: async () => chosen, openWorkdir: async (value: string) => { opened.push(value); } });
  };
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'w7ca-a9-55-'));
    documents = path.join(root, '我的 文档'); dataRoot = path.join(root, 'data'); fs.mkdirSync(documents);
    databases = []; steps = []; chosen = null; opened = []; make();
  });
  afterEach(async () => {
    try { if (registry) await registry.shutdown(); }
    finally { try { for (const db of databases) if (db.open) db.close(); }
      finally { fs.rmSync(root, { recursive: true, force: true }); } }
  });
  async function start(prompt = '告警日志分析') { return call('workdir.start', { prompt }, null); }
  async function configure() {
    runtime().setMode('full_access');
    await runtime().configureProvider({ baseUrl: 'https://fixture.invalid', model: 'fixture', skipProbe: true });
  }
  function tool(name: string, args: any) { steps.push({ id: 'tool', content: '', finishReason: 'tool_calls', toolCalls: [{ id: 'call', name, arguments: JSON.stringify(args) }] }, done); }

  it('normalizes illegal characters, devices, empty titles and twelve Unicode characters', () => {
    for (const value of ['', '  ', 'CON', 'prn', 'AUX', 'nul', 'com1', 'LPT9']) expect(defaultWorkdirName(value, date, normalizeConversationTitle)).toBe('新任务_1109');
    expect(defaultWorkdirName('<a>:"/\\|?*... ', date, normalizeConversationTitle)).toBe('a_1109');
    expect(defaultWorkdirName('一二三四五六七八九十甲乙丙', date, normalizeConversationTitle)).toBe('一二三四五六七八九十甲乙_1109');
    expect(Array.from(defaultWorkdirName('😀'.repeat(15), date, normalizeConversationTitle)).length).toBe(17);
  });

  it('checks disk case-insensitively and both unbounded persisted reservation sources through _99', async () => {
    await start('Alpha'); const baseRoot = path.join(documents, 'Win7CodingAgent');
    fs.mkdirSync(path.join(baseRoot, 'ALPHA_1109_02'));
    store.setWorkspaceMode(path.join(baseRoot, 'alpha_1109_03'), 'read_only');
    store.saveSession('reserved', path.join(baseRoot, 'ALPHA_1109_04'));
    expect(reserveWorkdir(baseRoot, 'Alpha', date, normalizeConversationTitle, store.listReservedWorkspacePaths())).toBe(path.join(baseRoot, 'Alpha_1109_05'));
    const reserved = Array.from({ length: 99 }, (_, i) => path.join(baseRoot, i ? `Alpha_1109_${String(i + 1).padStart(2, '0')}` : 'Alpha_1109'));
    expect(() => reserveWorkdir(baseRoot, 'Alpha', date, normalizeConversationTitle, reserved)).toThrow(expect.objectContaining({ code: 'A9_WORKDIR_NAME_EXHAUSTED' }));
    expect(Array.from(path.basename(reserveWorkdir(baseRoot, '一'.repeat(30), date, normalizeConversationTitle, [path.join(baseRoot, `${'一'.repeat(12)}_1109`)]))).length).toBe(20);
  });

  it('keeps chat and viewers empty, creates before file tools, recreates, and reopens the reserved path after restart', async () => {
    const initial = await start(); expect(initial.scope).toEqual(scope());
    const reserved = initial.workdir.path; const id = scope().conversationId;
    expect(initial).toMatchObject({ ok: false, scope: scope(), error: { code: 'A9_MODE_SELECTION_REQUIRED' } });
    await configure(); expect((await runtime().submitTurn('普通问答')).ok).toBe(true);
    expect(fs.existsSync(reserved)).toBe(false);
    expect((await call('workspace.browse', { path: '' })).result.entries).toEqual([]);
    expect((await call('git.status')).projection.entries).toEqual([]);
    expect((await call('workdir.open')).error.code).toBe('A9_WORKDIR_NOT_CREATED');
    expect((await call('diff.get', { turnId: 'absent' })).diff).toEqual([]);
    expect(fs.existsSync(reserved)).toBe(false);
    tool('list', { path: '.' }); expect((await runtime().submitTurn('读取文件')).ok).toBe(true);
    expect(fs.statSync(reserved).isDirectory()).toBe(true);
    const createdAt = store.getConversationMetadata(id).workdir.createdAt;
    expect(createdAt).toEqual(expect.any(String));
    fs.rmSync(reserved, { recursive: true });
    expect((await runtime().submitTurn('仍然问答')).ok).toBe(true); expect(fs.existsSync(reserved)).toBe(false);
    tool('list', { path: '.' }); await runtime().submitTurn('再次读取');
    expect(store.getConversationMetadata(id).workdir.createdAt).toBe(createdAt);
    const events = runtime().queryEvents({ conversationId: id }).events.filter((e: any) => e.eventType === 'workdir.created');
    expect(events).toHaveLength(2); expect(events[1].payload.data.message).toContain('已重建');
    await registry.shutdown(); for (const db of databases) if (db.open) db.close(); make(); registry.activate(reserved);
    expect(scope().conversationId).toBe(id); expect(runtime().getWorkdirInfo().path).toBe(reserved);
    expect((await call('workdir.open')).ok).toBe(true); expect(opened).toEqual([reserved]);
  });

  it('submits the first chat in the same action using the explicitly selected mode and shared Provider', async () => {
    const seed = path.join(root, 'seed'); fs.mkdirSync(seed); fs.mkdirSync(path.join(seed, '.git'));
    registry.activate(seed); await configure();
    const result = await call('workdir.start', { prompt: '第一条消息', mode: 'read_only' }, null);
    expect(result).toMatchObject({ ok: true, accepted: true, scope: scope() });
    expect(result.result).toBeUndefined();
    await until(() => runtime().getSnapshot().conversation[0]?.outcome === 'completed');
    expect(runtime().getSnapshot().mode).toBe('read_only');
    expect(fs.existsSync(result.workdir.path)).toBe(false);
    expect(runtime().getSnapshot().conversation[0].requestPrompt).toBe('第一条消息');
    expect(store.getConversationMetadata(result.scope.conversationId).workdir).toEqual({ version: 1, origin: 'auto', createdAt: null });
  });

  it('releases both selection locks before first-turn execution and keeps approval alive across workspace activation', async () => {
    const seed = path.join(root, 'seed'); fs.mkdirSync(seed); fs.mkdirSync(path.join(seed, '.git'));
    registry.activate(seed); await configure(); const seedScope = scope();
    let release!: (value: any) => void;
    const held = new Promise(resolve => { release = resolve; });
    let requested = false;
    steps.push(() => { requested = true; return held; });
    try {
      const started = await call('workdir.start', { prompt: '首轮需要审批', mode: 'full_access' }, null);
      expect(started).toMatchObject({ ok: true, accepted: true });
      const first = runtime();
      await until(() => requested);
      first.ensureWorkdir(); fs.writeFileSync(path.join(started.workdir.path, 'keep.txt'), 'keep', 'utf8');
      // Keep this workspace independent even if the machine's temp root is in Git.
      fs.mkdirSync(path.join(started.workdir.path, '.git'));
      const switched = await call('workspace.activate', { workspaceId: seedScope.workspaceId }, null);
      expect(switched).toMatchObject({ ok: true, scope: seedScope });
      expect(first.getSnapshot().agentStatus).toBe('running');
      release({ id: 'approval', content: '', finishReason: 'tool_calls', toolCalls: [{ id: 'delete', name: 'delete', arguments: '{"path":"keep.txt","permanent":true}' }] });
      await until(() => Boolean(first.getSnapshot().pendingApproval));
      const approval = first.getSnapshot().pendingApproval;
      // The registry creation lock must also be free while the first turn awaits approval.
      const second = await call('workdir.start', { prompt: '另一个默认对话', mode: 'read_only' }, null);
      expect(second.error).toBeUndefined();
      expect(second).toMatchObject({ ok: true, accepted: true });
      expect(second.scope.workspaceId).not.toBe(started.scope.workspaceId);
      expect((await call('workspace.activate', { workspaceId: seedScope.workspaceId }, null)).ok).toBe(true);
      expect(first.getSnapshot().pendingApproval).toEqual(approval);
      expect(fs.readFileSync(path.join(started.workdir.path, 'keep.txt'), 'utf8')).toBe('keep');
    } finally { release(done); }
  });

  it('refuses the default root or an ordinary ancestor already resident', async () => {
    const baseRoot = path.join(documents, 'Win7CodingAgent'); fs.mkdirSync(baseRoot);
    registry.activate(documents);
    expect((await start()).error.code).toBe('A9_WORKSPACE_OVERLAP');
    expect(fs.readdirSync(baseRoot)).toEqual([]);
  });

  it('archives without deleting or allocating another conversation in the same default directory', async () => {
    await start(); runtime().ensureWorkdir(); const target = runtime().getWorkdirInfo().path;
    const id = scope().conversationId;
    expect((await call('conversation.create')).error.code).toBe('A9_WORKDIR_CONVERSATION_BOUND');
    expect((await call('conversation.archive', { conversationId: id })).archived).toBe(true);
    expect(fs.existsSync(target)).toBe(true); expect(store.listConversations(target)).toHaveLength(1);
    expect((await runtime().submitTurn('archived')).error.code).toBe('A9_CONVERSATION_ARCHIVED');
    await registry.close(scope().workspaceId); registry.activate(target);
    expect(scope().conversationId).toBe(id);
    expect((await call('conversation.restore', { conversationId: id })).ok).toBe(true);
    expect(store.listConversations(target)).toHaveLength(1);
  });

  it('refuses a symlink substituted for the reserved root without touching its target', async () => {
    const result = await start(); const outside = path.join(root, 'outside'); fs.mkdirSync(outside);
    fs.symlinkSync(outside, result.workdir.path, process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => runtime().ensureWorkdir()).toThrow(expect.objectContaining({ code: 'A9_WORKDIR_IDENTITY_CHANGED' }));
    expect((await call('workdir.get', {}, result.scope)).error.code).toBe('A9_WORKDIR_IDENTITY_CHANGED');
    expect(fs.readdirSync(outside)).toEqual([]);
    // Shutdown reads no workspace files; remove only this fixture link.
    fs.unlinkSync(result.workdir.path);
  });

  it('lists both resident workspaces after one default identity changes while file, command, Git and browse access stay refused', async () => {
    const seed = path.join(root, 'seed'); fs.mkdirSync(seed); fs.mkdirSync(path.join(seed, '.git'));
    registry.activate(seed); await configure(); const seedScope = scope();
    const result = await call('workdir.start', { prompt: '身份变化', mode: 'full_access' }, null);
    const first = runtime(); await until(() => first.getSnapshot().conversation[0]?.outcome === 'completed');
    const outside = path.join(root, 'outside'); fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'keep.txt'), 'untouched', 'utf8');
    fs.symlinkSync(outside, result.workdir.path, process.platform === 'win32' ? 'junction' : 'dir');
    const listed = await call('workspace.list', {}, null);
    expect(listed.ok).toBe(true); expect(listed.workspaces).toHaveLength(2);
    expect(listed.workspaces.find((w: any) => w.workspaceId === result.scope.workspaceId).workdir)
      .toMatchObject({ path: result.workdir.path, origin: 'auto', created: false, identityChanged: true });
    expect(listed.workspaces.find((w: any) => w.workspaceId === seedScope.workspaceId).workdir.identityChanged).toBeUndefined();
    expect((await call('snapshot.get', {}, null)).snapshot.workdir.identityChanged).toBe(true);
    for (const [action, payload] of [
      ['workspace.read', { path: 'keep.txt', startLine: 1, maxLines: 10 }],
      ['workspace.browse', { path: '' }], ['git.status', {}], ['turn.submit', { prompt: 'run a command' }],
    ] as const) expect((await call(action, payload, result.scope)).error.code).toBe('A9_WORKDIR_IDENTITY_CHANGED');
    expect((await first.submitTurn('run a command')).error.code).toBe('A9_WORKDIR_IDENTITY_CHANGED');
    await expect(first.gitStatus()).rejects.toMatchObject({ code: 'A9_WORKDIR_IDENTITY_CHANGED' });
    expect(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8')).toBe('untouched');
    expect(fs.readdirSync(outside)).toEqual(['keep.txt']);
  });

  it('allows target-bound native relinking after root substitution while retaining the old link', async () => {
    const result = await start(); const outside = path.join(root, 'outside'); fs.mkdirSync(outside);
    fs.symlinkSync(outside, result.workdir.path, process.platform === 'win32' ? 'junction' : 'dir');
    chosen = path.join(root, 'new target'); fs.mkdirSync(chosen); fs.mkdirSync(path.join(chosen, '.git'));
    expect((await call('workdir.link', {}, result.scope)).workdir).toMatchObject({ origin: 'linked', path: chosen });
    expect(fs.lstatSync(result.workdir.path).isSymbolicLink()).toBe(true);
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it('renames disk then three State tables; rolls disk back on a State failure', async () => {
    const result = await start(); runtime().ensureWorkdir(); runtime().setMode('read_only');
    const oldScope = scope(); const old = result.workdir.path;
    fs.writeFileSync(path.join(old, '保留.txt'), 'keep', 'utf8');
    store.mergeConversationMetadata(scope().conversationId, { keep: 'metadata' });
    const rename = await call('workdir.rename', { name: '新 名称' });
    expect(rename.ok).toBe(true); const next = rename.workdir.path;
    expect(fs.existsSync(old)).toBe(false); expect(fs.readFileSync(path.join(next, '保留.txt'), 'utf8')).toBe('keep');
    for (const table of ['a9_workspaces', 'a9_sessions', 'a9_workspace_conversation_state']) expect(store.db.prepare(`SELECT workspace_path FROM ${table}`).all().every((r: any) => r.workspace_path === next)).toBe(true);
    expect(store.getConversationMetadata(scope().conversationId).keep).toBe('metadata');
    expect((await call('workdir.get', {}, oldScope)).error.code).toBe('A9_SCOPE_STALE');
    store.db.exec("CREATE TRIGGER fail_workdir BEFORE UPDATE ON a9_workspace_conversation_state BEGIN SELECT RAISE(ABORT, 'injected'); END");
    try { expect((await call('workdir.rename', { name: '回滚目标' })).error.code).toBe('SQLITE_CONSTRAINT_TRIGGER'); }
    finally { store.db.exec('DROP TRIGGER fail_workdir'); }
    for (const table of ['a9_workspaces', 'a9_sessions', 'a9_workspace_conversation_state']) expect(store.db.prepare(`SELECT workspace_path FROM ${table}`).get().workspace_path).toBe(next);
    expect(runtime().getWorkdirInfo().path).toBe(next); expect(fs.existsSync(next)).toBe(true);
    expect(fs.existsSync(path.join(path.dirname(next), '回滚目标'))).toBe(false);
  });

  it('links an existing directory and preserves the old files and unrelated metadata', async () => {
    const result = await start(); runtime().ensureWorkdir();
    fs.writeFileSync(path.join(result.workdir.path, 'old.txt'), 'keep', 'utf8');
    const id = scope().conversationId; store.mergeConversationMetadata(id, { keep: true });
    chosen = path.join(root, '关联 中文'); fs.mkdirSync(chosen); fs.mkdirSync(path.join(chosen, '.git'));
    const response = await call('workdir.link');
    expect(response).toMatchObject({ ok: true, scope: { conversationId: id }, workdir: { path: chosen, origin: 'linked', created: true } });
    expect(fs.readFileSync(path.join(result.workdir.path, 'old.txt'), 'utf8')).toBe('keep');
    expect(store.getConversationMetadata(id)).toMatchObject({ keep: true, workdir: { version: 1, origin: 'linked', createdAt: null } });
    expect((await call('workdir.rename', { name: '拒绝' })).error.code).toBe('A9_WORKDIR_NOT_AUTO');
    expect((await call('workspace.read', { path: path.join(root, 'outside'), startLine: 1, maxLines: 10 })).error.code).toBe('WORKSPACE_BOUNDARY_VIOLATION');
  });

  it('rejects busy, managed, conflicting, invalid, overlapping and full targets before closing the source', async () => {
    await start(); runtime().ensureWorkdir(); const initialScope = scope();
    const id = initialScope.conversationId;
    store.upsertTask('busy', id, 'active');
    expect((await call('workdir.rename', { name: 'CON' })).error.code).toBe('A9_CONVERSATION_BUSY');
    store.upsertTask('busy', id, 'completed');
    store.recordManagedProcess({ handleId: 'managed', workspacePath: runtime().getWorkdirInfo().path, command: 'test', cwd: '.', startedAt: new Date().toISOString(), lastProbeStatus: 'running' });
    expect((await call('workdir.rename', { name: 'anything' })).error.code).toBe('A9_CONVERSATION_BUSY');
    store.db.prepare("UPDATE a9_managed_processes SET last_probe_status='stopped'").run();
    const parent = path.dirname(runtime().getWorkdirInfo().path); fs.mkdirSync(path.join(parent, 'EXISTS'));
    expect((await call('workdir.rename', { name: 'exists' })).error.code).toBe('A9_WORKDIR_NAME_CONFLICT');
    for (const name of ['../escape', 'CON', 'tail.', 'x'.repeat(21)]) expect((await call('workdir.rename', { name })).error.code).toBe('A9_WORKDIR_NAME_INVALID');
    chosen = path.join(root, 'full'); fs.mkdirSync(chosen); fs.mkdirSync(path.join(chosen, '.git'));
    for (let i = 0; i < 16; i++) store.createConversation(`full-${i}`, chosen);
    expect((await call('workdir.link')).error.code).toBe('A9_CONVERSATION_LIMIT');
    chosen = path.join(root, 'other'); fs.mkdirSync(chosen); fs.mkdirSync(path.join(chosen, '.git'));
    registry.open(chosen); const child = path.join(chosen, 'child'); fs.mkdirSync(child); chosen = child;
    expect((await call('workdir.link')).error.code).toBe('A9_WORKSPACE_OVERLAP');
    expect(scope()).toEqual(initialScope);
  });

  it('retains WORKSPACE_BOUNDARY_VIOLATION for outside file paths and rejects unscoped/forged IPC', async () => {
    await start(); await configure();
    const outside = path.join(root, 'secret.txt'); fs.writeFileSync(outside, 'outside', 'utf8');
    tool('read', { path: outside }); const result = await runtime().submitTurn('read');
    expect(result.ok).toBe(true);
    const events = runtime().queryEvents({ conversationId: scope().conversationId }).events;
    expect(JSON.stringify(events)).toContain('WORKSPACE_BOUNDARY_VIOLATION');
    expect(JSON.stringify(events)).not.toContain('"content":"outside"');
    expect((await call('workspace.read', { path: outside, startLine: 1, maxLines: 10 })).error.code).toBe('WORKSPACE_BOUNDARY_VIOLATION');
    expect((await call('workdir.get', {}, null)).error.code).toBe('A9_SCOPE_REQUIRED');
    expect((await call('workdir.link', { path: root })).error.code).toBe('A9_PAYLOAD_INVALID');
    expect((await handler({ trusted: false }, { schemaVersion: 9, action: 'a9.workdir.start', payload: { prompt: 'test' } })).error.code).toBe('RENDERER_CAPABILITY_DENIED');
  });

  it('preload exposes only narrow version-nine requests with captured scope', async () => {
    const requests: any[] = []; let api: any;
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../product/preload.js'), 'utf8'), {
      require: (name: string) => { expect(name).toBe('electron'); return {
        contextBridge: { exposeInMainWorld: (_name: string, value: any) => { api = value.a9; } },
        ipcRenderer: { invoke: async (_channel: string, request: any) => { requests.push(request); }, on() {}, send() {} },
      }; }, process: { argv: [] },
    });
    const captured = { workspaceId: 'a'.repeat(64), conversationId: 'target' }; const bound = api.forScope(captured);
    await api.startDefaultConversation('first'); await bound.getWorkdir(); await bound.openWorkdir(); await bound.renameWorkdir('new'); await bound.linkWorkdir(); await bound.listWorkspaceDirectory('');
    expect(requests.map(r => r.action)).toEqual(['a9.workdir.start', 'a9.workdir.get', 'a9.workdir.open', 'a9.workdir.rename', 'a9.workdir.link', 'a9.workspace.browse']);
    expect(requests.every(r => r.schemaVersion === 9)).toBe(true);
    expect(requests.slice(1).every(r => r.scope === captured)).toBe(true);
    expect(bound.copyWorkdir).toBeUndefined();
  });
});
