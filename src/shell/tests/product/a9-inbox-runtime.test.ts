/// <reference path="./better-sqlite3.d.ts" />
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vm from 'vm';
import Database from 'better-sqlite3';
const { createA9AgentRuntime } = require('../../product/a9-agent-runtime');
const { createA9WorkspaceRegistry, workspaceId } = require('../../product/a9-workspace-registry');
const { createA9ProductRequestHandler } = require('../../product/a9-product-ipc');
const old = '2000-01-01T00:00:00.000Z';
const done = { id: 'done', content: 'done', finishReason: 'stop' };

describe('A9-54 real SQLite, runtime, scoped IPC and preload', () => {
  let root: string, a: string, b: string, registry: any, handler: any, runtime: any, db: any;
  let databases: any[], response: () => Promise<any>;
  const scope = () => ({ workspaceId: registry.getActive().workspaceId, conversationId: registry.getActive().runtime.getSnapshot().activeConversationId });
  const call = (action: string, payload: any, target = scope(), schemaVersion = 9) => handler({}, { schemaVersion, action: `a9.conversation.${action}`, payload, scope: target });
  const row = (rt = runtime) => rt.getSnapshot().conversations.find((item: any) => item.sessionId === rt.getSnapshot().activeConversationId);
  const seed = (id = scope().conversationId) => db.prepare('UPDATE a9_sessions SET metadata_json = ? WHERE session_id = ?')
    .run(JSON.stringify({ keep: 'yes', inbox: { version: 1, settledAt: old, activeSince: old, lastVisitedAt: null } }), id);
  const make = () => createA9WorkspaceRegistry({ createRuntime: (workspaceRoot: string, host: any) => createA9AgentRuntime({
    ...host, workspaceRoot, dataRoot: path.join(root, 'data'), ownerId: 'a9-54-test',
    openDatabase: (file: string, options: any) => { const opened = new Database(file, options); databases.push(opened); return opened; },
    wrapProvider: () => ({ sendStreamRequest: () => response() }),
  }) });
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'w7ca-a9-54-runtime-'));
    databases = []; response = async () => done;
    a = path.join(root, 'A 中文'); b = path.join(root, 'B space'); fs.mkdirSync(a); fs.mkdirSync(b);
    // Sandbox temp ancestors contain a .git sentinel; give each test workspace its own identity.
    fs.mkdirSync(path.join(a, '.git')); fs.mkdirSync(path.join(b, '.git'));
    fs.writeFileSync(path.join(a, 'note.txt'), 'keep', 'utf8');
    registry = make(); runtime = registry.activate(a).runtime;
    db = databases.find(item => item.open && !item.readonly);
    handler = createA9ProductRequestHandler({ workspaceRegistry: registry, isValidRendererSender: () => true,
      getA9Runtime: () => registry.getActive().runtime });
  });
  afterEach(async () => {
    try { if (registry) await registry.shutdown(); }
    finally { try { for (const opened of databases) if (opened.open) opened.close(); }
      finally { fs.rmSync(root, { recursive: true, force: true }); } }
  });
  async function configure() {
    runtime.setMode('full_access');
    await runtime.configureProvider({ baseUrl: 'https://fixture.invalid', model: 'fixture', skipProbe: true });
  }
  function hold() {
    let release!: (result: any) => void, entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    response = () => { entered(); return new Promise(resolve => { release = resolve; }); };
    return { ready, release: (result = done) => release(result) };
  }

  it('settles, reopens and visits without changing updated_at or unrelated metadata', async () => {
    const id = scope().conversationId;
    db.prepare('UPDATE a9_sessions SET updated_at = ? WHERE session_id = ?').run(old, id);
    for (const action of ['settle', 'visit', 'reopen']) {
      expect(await call(action, { conversationId: id })).toEqual({ ok: true, conversationId: id });
      expect(row().updatedAt).toBe(old);
      if (action === 'settle') expect(row().settledAt).toEqual(expect.any(String));
      if (action === 'visit') expect(row().lastVisitedAt).toEqual(expect.any(String));
    }
    expect(row()).toMatchObject({ settledAt: null, lastCompletedAt: null });
    const inbox = JSON.parse(db.prepare('SELECT metadata_json FROM a9_sessions WHERE session_id = ?').get(id).metadata_json).inbox;
    expect(inbox.activeSince).toEqual(expect.any(String));
    expect(Date.parse(row().lastActivityAt)).toBe(Math.max(Date.parse(inbox.activeSince), Date.parse(inbox.lastVisitedAt)));
    seed(); await call('visit', { conversationId: id });
    expect(JSON.parse(db.prepare('SELECT metadata_json FROM a9_sessions WHERE session_id = ?').get(id).metadata_json).keep).toBe('yes');
  });

  it('returns all four fields in current and other resident workspace snapshots', async () => {
    const first = scope(); seed();
    const rb = registry.activate(b).runtime;
    const current = rb.getSnapshot().conversations[0];
    expect(current).toMatchObject({ settledAt: null, lastVisitedAt: null, lastCompletedAt: null, lastActivityAt: current.createdAt });
    const result = await handler({}, { schemaVersion: 9, action: 'a9.snapshot.get', payload: {} });
    expect(result.snapshot.conversations[0]).toMatchObject(current);
    expect(result.snapshot.workspaces.find((item: any) => item.workspaceId === first.workspaceId).conversations[0])
      .toMatchObject({ settledAt: old, lastVisitedAt: null, lastCompletedAt: null, lastActivityAt: old });
    expect(result.snapshot.workspaces.find((item: any) => item.active).conversations[0])
      .toMatchObject({ settledAt: null, lastVisitedAt: null, lastCompletedAt: null, lastActivityAt: current.createdAt });
  });

  it('updates a non-current conversation in background B without changing timestamps or either selection', async () => {
    const foreground = scope();
    const entry = registry.open(b); const rb = entry.runtime;
    const id = rb.getSnapshot().activeConversationId;
    expect((await rb.createConversation()).ok).toBe(true);
    const current = rb.getSnapshot().activeConversationId;
    expect(current).not.toBe(id);
    db.prepare('UPDATE a9_sessions SET updated_at = ? WHERE session_id = ?').run(old, id);
    const timestamps = () => rb.getSnapshot().conversations.map((item: any) => ({ sessionId: item.sessionId, updatedAt: item.updatedAt }));
    const before = timestamps();
    const target = { workspaceId: entry.workspaceId, conversationId: id };
    const targetRow = () => rb.getSnapshot().conversations.find((item: any) => item.sessionId === id);
    for (const action of ['settle', 'visit', 'reopen']) {
      expect(await call(action, { conversationId: id }, target)).toEqual({ ok: true, conversationId: id });
      if (action === 'settle') expect(targetRow().settledAt).toEqual(expect.any(String));
      if (action === 'visit') expect(targetRow().lastVisitedAt).toEqual(expect.any(String));
      if (action === 'reopen') expect(targetRow().settledAt).toBeNull();
      expect(timestamps()).toEqual(before);
      expect(scope()).toEqual(foreground);
      expect(rb.getSnapshot().activeConversationId).toBe(current);
    }
    expect((await call('query', { conversationId: current }, { ...target, conversationId: current })).error.code).toBe('A9_SCOPE_STALE');
  });

  it.each(['settle', 'reopen', 'visit'])('rejects non-resident and closed workspace %s targets without opening them', async action => {
    const foreground = scope();
    const target = { workspaceId: workspaceId(fs.realpathSync(b)), conversationId: foreground.conversationId };
    expect((await call(action, { conversationId: target.conversationId }, target)).error.code).toBe('A9_SCOPE_STALE');
    expect(registry.size).toBe(1);
    const entry = registry.open(b);
    target.conversationId = entry.runtime.getSnapshot().activeConversationId;
    await registry.close(entry.workspaceId);
    expect((await call(action, { conversationId: target.conversationId }, target)).error.code).toBe('A9_SCOPE_STALE');
    expect(registry.size).toBe(1);
    expect(scope()).toEqual(foreground);
  });

  it.each(['workspace', 'application'])('rejects inbox targets during %s shutdown', async kind => {
    const entry = registry.open(b);
    const target = { workspaceId: entry.workspaceId, conversationId: entry.runtime.getSnapshot().activeConversationId };
    const shutdown = entry.runtime.shutdown;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    entry.runtime.shutdown = async (...args: any[]) => { await held; return shutdown(...args); };
    const closing = kind === 'workspace' ? registry.close(entry.workspaceId) : registry.shutdown();
    try {
      for (const action of ['settle', 'reopen', 'visit']) {
        expect((await call(action, { conversationId: target.conversationId }, target)).error.code).toBe('A9_SCOPE_STALE');
      }
    } finally { release(); await closing; entry.runtime.shutdown = shutdown; }
  });

  it('revalidates background workspace Git identity before updating inbox timestamps', async () => {
    const entry = registry.open(b);
    const target = { workspaceId: entry.workspaceId, conversationId: entry.runtime.getSnapshot().activeConversationId };
    fs.writeFileSync(path.join(b, '.git', 'commondir'), path.join(a, '.git'), 'utf8');
    for (const action of ['settle', 'reopen', 'visit']) {
      expect((await call(action, { conversationId: target.conversationId }, target)).error.code).toBe('A9_SCOPE_STALE');
    }
  });

  it.each(['settle', 'reopen', 'visit'])('returns runtime unavailable when a resident runtime lacks the %s method', async action => {
    const entry = registry.open(b); const ready = entry.runtime;
    const target = { workspaceId: entry.workspaceId, conversationId: ready.getSnapshot().activeConversationId };
    entry.runtime = { status: 'diagnostics', getSnapshot: () => ({ status: 'diagnostics' }) };
    try {
      expect((await call(action, { conversationId: target.conversationId }, target)).error.code).toBe('A9_RUNTIME_UNAVAILABLE');
    } finally { entry.runtime = ready; }
  });

  it.each(['settle', 'reopen', 'visit'])('rejects archived, foreign, mismatched and malformed %s targets', async action => {
    const original = scope(); const id = original.conversationId;
    registry.activate(b);
    const background = scope();
    expect((await call(action, { conversationId: id }, original)).ok).toBe(true);
    registry.activate(a);
    expect((await call(action, { conversationId: id }, { ...background, conversationId: id })).error.code).toBe('A9_CONVERSATION_WORKSPACE_MISMATCH');
    for (const payload of [{}, { conversationId: 3 }, { conversationId: '' }, { conversationId: 'x'.repeat(257) }, { conversationId: id, settledAt: old }]) {
      expect((await call(action, payload)).error.code).toBe('A9_PAYLOAD_INVALID');
    }
    expect((await call(action, { conversationId: id }, { ...original, conversationId: 'stale' })).error.code).toBe('A9_SCOPE_INVALID');
    expect((await call(action, { conversationId: id }, original, 8)).error.code).toBe('A9_SCOPE_REQUIRED');
    expect((await handler({}, { schemaVersion: 9, action: `a9.conversation.${action}`, payload: { conversationId: id } })).error.code).toBe('A9_SCOPE_REQUIRED');
    runtime.archiveConversation(id);
    expect((await call(action, { conversationId: id }, original)).error.code).toBe('A9_CONVERSATION_ARCHIVED');
  });

  it('clears settle on start, rejects settling while running and preserves completion after restart', async () => {
    await configure(); seed(); const id = scope().conversationId;
    const held = hold(); const running = runtime.submitTurn('complete');
    await held.ready;
    expect(row().settledAt).toBeNull(); expect(row().lastActivityAt).not.toBe(old);
    expect((await call('settle', { conversationId: id })).error.code).toBe('A9_CONVERSATION_BUSY');
    expect((await call('visit', { conversationId: id })).ok).toBe(true);
    expect((await call('reopen', { conversationId: id })).ok).toBe(true);
    held.release(); const result = await running;
    expect(result.result.outcome).toBe('completed');
    expect(row().lastCompletedAt).toEqual(expect.any(String));
    await call('visit', { conversationId: id }); await call('settle', { conversationId: id });
    const before = row();
    await registry.shutdown(); for (const opened of databases) if (opened.open) opened.close();
    registry = make(); runtime = registry.activate(a).runtime;
    expect(row()).toMatchObject({ settledAt: before.settledAt, lastVisitedAt: before.lastVisitedAt,
      lastCompletedAt: before.lastCompletedAt, lastActivityAt: before.lastActivityAt });
  });

  it.each(['approval', 'question'])('clears settle when %s appears and rejects ending pending work', async kind => {
    await configure(); seed(); const held = hold(); const running = runtime.submitTurn('pending');
    await held.ready;
    // Inject an old mark after start to prove the pending callback clears it independently.
    seed();
    held.release({ id: kind, content: '', finishReason: 'tool_calls', toolCalls: [{ id: 'call', name: kind === 'approval' ? 'delete' : 'ask_user',
      arguments: JSON.stringify(kind === 'approval' ? { path: 'note.txt', permanent: true } : { prompt: 'Which target?' }) }] } as any);
    const result = await running;
    expect(result.result.outcome).toBe(kind === 'approval' ? 'needs_approval' : 'needs_input');
    expect(row().settledAt).toBeNull(); expect(row().lastActivityAt).not.toBe(old);
    expect((await call('settle', { conversationId: scope().conversationId })).error.code).toBe('A9_CONVERSATION_BUSY');
    expect(fs.readFileSync(path.join(a, 'note.txt'), 'utf8')).toBe('keep');
  });

  it('preload invokes v9 actions with the supplied workspace scope through the real IPC handler', async () => {
    let api: any;
    const context = { process: { argv: [] }, require: (name: string) => {
      if (name !== 'electron') throw new Error(name);
      return { contextBridge: { exposeInMainWorld: (_name: string, value: any) => { api = value; } },
        ipcRenderer: { invoke: (_channel: string, request: any) => handler({}, request) } };
    } };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../product/preload.js'), 'utf8'), context);
    const target = scope(); const scoped = api.a9.forScope(target);
    expect((await scoped.settleConversation(target.conversationId)).ok).toBe(true);
    expect(row().settledAt).toEqual(expect.any(String));
    expect((await scoped.visitConversation(target.conversationId)).ok).toBe(true);
    expect(row().lastVisitedAt).toEqual(expect.any(String));
    expect((await scoped.reopenConversation(target.conversationId)).ok).toBe(true);
    expect(row().settledAt).toBeNull();
    registry.activate(b);
    expect((await scoped.visitConversation(target.conversationId)).ok).toBe(true);
  });
});
