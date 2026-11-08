/// <reference path="./better-sqlite3.d.ts" />
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import Database from 'better-sqlite3';
const { createA9AgentRuntime } = require('../../product/a9-agent-runtime');
const { createA9WorkspaceRegistry } = require('../../product/a9-workspace-registry');
const { createA9ProductRequestHandler } = require('../../product/a9-product-ipc');

async function until(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('MULTIWORKSPACE_CONDITION_TIMEOUT');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'win7-a9-52-'));
  const a = path.join(root, 'A 中文'), b = path.join(root, 'B space');
  fs.mkdirSync(a); fs.mkdirSync(b);
  for (const workspace of [a, b]) fs.writeFileSync(path.join(workspace, 'note.txt'), 'preserved', 'utf8');
  const held = new Map<string, http.ServerResponse>();
  const sockets = new Set<any>(); const databases: any[] = [];
  const requests: any[] = [];
  const send = (res: http.ServerResponse, delta: any, reason = 'stop') => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: reason }] })}\n\ndata: [DONE]\n\n`);
  };
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const data = JSON.parse(body);
      if (data.tools?.[0]?.function?.name === 'probe_test_echo') {
        send(res, { tool_calls: [{ index: 0, id: 'probe', function: { name: 'probe_test_echo', arguments: '{"message":"probe_ok"}' } }] }, 'tool_calls'); return;
      }
      requests.push(data);
      const prompt = data.messages.filter((m: any) => m.role === 'user').pop().content;
      if (!data.messages.some((m: any) => m.role === 'tool')) held.set(prompt, res);
      else send(res, { content: 'done' });
    });
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  let selected = a;
  const registry = createA9WorkspaceRegistry({ createRuntime: (workspaceRoot: string, hostOptions: any) => createA9AgentRuntime({
    ...hostOptions, workspaceRoot, dataRoot: path.join(root, 'data'), ownerId: `main-${process.pid}`,
    openDatabase: (file: string, options: any) => { const db = new Database(file, options); databases.push(db); return db; },
  }) });
  const handler = createA9ProductRequestHandler({ workspaceRegistry: registry, isValidRendererSender: (e: any) => e.trusted !== false,
    getA9Runtime: () => registry.getActive()?.runtime || registry.activate(selected).runtime,
    selectWorkspace: async (workspace: string) => { selected = workspace; }, chooseWorkspace: async () => null });
  const call = (action: string, payload: any = {}, scope?: any, schemaVersion = 9) => handler({}, { schemaVersion, action, payload, ...(scope ? { scope } : {}) });
  const scope = () => { const entry = registry.getActive(); return { workspaceId: entry.workspaceId, conversationId: entry.runtime.getSnapshot().activeConversationId }; };
  async function close() {
    try { await registry.shutdown(); }
    finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
      for (const db of databases) if (db.open) db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const ra = registry.activate(a).runtime; ra.setMode('full_access');
    await registry.configureProvider(ra, { baseUrl: `http://127.0.0.1:${(server.address() as any).port}`, model: 'fixture', apiKey: 'MEMORY_ONLY_SENTINEL' });
  } catch (error) { await close(); throw error; }
  return { root, a, b, registry, held, requests, databases, call, scope, close,
    release(prompt: string, tool?: string) {
      const res = held.get(prompt)!; held.delete(prompt);
      if (tool === 'delete') send(res, { tool_calls: [{ index: 0, id: `delete-${prompt}`, function: { name: 'delete', arguments: '{"path":"note.txt","permanent":true}' } }] }, 'tool_calls');
      else if (tool === 'write') send(res, { tool_calls: [{ index: 0, id: `write-${prompt}`, function: { name: 'write', arguments: JSON.stringify({ path: 'result.txt', content: prompt }) } }] }, 'tool_calls');
      else send(res, { content: `${prompt} done` });
    },
  };
}

describe('A9-52 real SQLite/runtime multiworkspace isolation', () => {
  it('keeps A active when opening B, overlaps requests and stops A without cancelling B', async () => {
    const f = await fixture();
    try {
      const ra = f.registry.getActive().runtime, scopeA = f.scope();
      const requestA = f.call('a9.turn.submit', { prompt: 'A' }, scopeA);
      await until(() => f.held.has('A'));
      ra.saveDraft('private A');
      ra.updateQueue({ conversationId: scopeA.conversationId, operation: 'add', text: 'A queued' });
      const rb = f.registry.activate(f.b).runtime; rb.setMode('full_access');
      expect(f.databases).toHaveLength(1);
      expect(f.databases[0].prepare("SELECT status FROM a9_tasks WHERE session_id=?").get(scopeA.conversationId).status).toBe('active');
      expect(rb.getSnapshot().provider.apiKey.source).toBe('memory');
      expect(JSON.stringify(rb.getSnapshot())).not.toContain('MEMORY_ONLY_SENTINEL');
      const requestB = f.call('a9.turn.submit', { prompt: 'B' }, f.scope());
      await until(() => f.held.has('B'));
      expect(f.registry.accounting().activeRequests).toBe(2);
      expect(ra.getSnapshot().queue.paused).toBe(false);
      await expect(f.registry.configureProvider(rb, {})).rejects.toMatchObject({ code: 'A9_PROVIDER_RECONFIGURE_BUSY' });
      const stale = await f.call('a9.turn.stop', {}, scopeA);
      expect(stale.error.code).toBe('A9_SCOPE_STALE');
      expect(ra.getSnapshot().agentStatus).toBe('running');
      f.registry.activate(f.a);
      expect((await f.call('a9.turn.stop', {}, scopeA)).ok).toBe(true);
      await requestA;
      expect(rb.getSnapshot().agentStatus).toBe('running');
      f.registry.activate(f.b); f.release('B', 'write');
      expect((await requestB).ok).toBe(true);
      expect(fs.readFileSync(path.join(f.b, 'result.txt'), 'utf8')).toBe('B');
      expect(fs.existsSync(path.join(f.a, 'result.txt'))).toBe(false);
      expect(ra.getSnapshot().draft.text).toBe('private A');
      expect(ra.getSnapshot().queue).toMatchObject({ paused: true, items: [{ text: 'A queued' }] });
      expect(f.registry.accounting().reportedTokens).toBeNull();
    } finally { await f.close(); }
  });

  it('keeps A approval pending while B runs, rejects wrong target, and denies without side effects', async () => {
    const f = await fixture();
    try {
      const ra = f.registry.getActive().runtime, scopeA = f.scope();
      const requestA = f.call('a9.turn.submit', { prompt: 'approval A' }, scopeA);
      await until(() => f.held.has('approval A')); f.release('approval A', 'delete');
      const response = await requestA;
      expect(response.result.outcome).toBe('needs_approval');
      const pending = response.result.pendingApproval;
      const rb = f.registry.activate(f.b).runtime; rb.setMode('read_only');
      const wrong = await f.call('a9.turn.resumeApproval', { ...pending, decision: 'approved' }, scopeA);
      expect(wrong.error.code).toBe('A9_SCOPE_STALE');
      const requestB = f.call('a9.turn.submit', { prompt: 'B' }, f.scope());
      await until(() => f.held.has('B')); f.release('B'); await requestB;
      expect(ra.getSnapshot().pendingApproval.approvalId).toBe(pending.approvalId);
      f.registry.activate(f.a);
      const denied = await f.call('a9.turn.resumeApproval', { conversationId: pending.conversationId, taskId: pending.taskId,
        turnId: pending.turnId, approvalId: pending.approvalId, bindingDigest: pending.bindingDigest, decision: 'denied' }, scopeA);
      expect(denied.ok).toBe(true);
      expect(fs.existsSync(path.join(f.a, 'note.txt'))).toBe(true);
      expect(fs.existsSync(path.join(f.b, 'note.txt'))).toBe(true);
    } finally { await f.close(); }
  });

  it('rejects same-workspace switching during a task but permits returning to its running conversation', async () => {
    const f = await fixture();
    try {
      const aEntry = f.registry.getActive(); const first = f.scope();
      aEntry.runtime.createConversation(); const second = f.scope();
      const running = f.call('a9.turn.submit', { prompt: 'A' }, second);
      await until(() => f.held.has('A'));
      const denied = await f.call('a9.workspace.activate', { workspaceId: first.workspaceId, conversationId: first.conversationId });
      expect(denied.error.code).toBe('A9_CONVERSATION_BUSY');
      f.registry.activate(f.b);
      const allowed = await f.call('a9.workspace.activate', { workspaceId: second.workspaceId, conversationId: second.conversationId });
      expect(allowed.ok).toBe(true);
      f.release('A'); await running;
    } finally { await f.close(); }
  });

  it('persists workspace directory, cancels picker without creating, and closes only the chosen runtime', async () => {
    const f = await fixture();
    try {
      const aEntry = f.registry.getActive();
      const before = aEntry.runtime.getSnapshot().conversations.length;
      expect(await f.call('a9.workspace.activate', { chooseDirectory: true, createConversation: true })).toEqual({ ok: false, cancelled: true });
      expect(aEntry.runtime.getSnapshot().conversations).toHaveLength(before);
      const bEntry = f.registry.activate(f.b); bEntry.runtime.setMode('read_only');
      const running = f.call('a9.turn.submit', { prompt: 'B' }, f.scope());
      await until(() => f.held.has('B'));
      expect((await f.call('a9.workspace.close', { workspaceId: aEntry.workspaceId, confirmed: true })).ok).toBe(true);
      expect(bEntry.runtime.getSnapshot().agentStatus).toBe('running');
      expect(f.registry.directory().find((item: any) => item.workspaceId === aEntry.workspaceId).opened).toBe(false);
      f.release('B'); await running;
      expect((await f.call('a9.workspace.list')).workspaces).toHaveLength(2);
      expect((await f.call('a9.turn.stop', {}, undefined, 8)).error.code).toBe('A9_SCOPE_REQUIRED');
      expect((await f.call('a9.turn.stop', {}, { ...f.scope(), conversationId: 'old' })).error.code).toBe('A9_SCOPE_STALE');
    } finally { await f.close(); }
  });

  it('reuses aliases and rejects nested roots and linked worktrees sharing Git metadata', async () => {
    const f = await fixture();
    try {
      const alias = path.join(f.root, 'alias'); fs.symlinkSync(f.a, alias, 'dir');
      expect(f.registry.activate(alias).workspaceId).toBe(f.registry.activate(f.a).workspaceId);
      const nested = path.join(f.a, 'nested'); fs.mkdirSync(nested);
      expect(() => f.registry.activate(nested)).toThrow('重叠');
      fs.mkdirSync(path.join(f.a, '.git'));
      const linkedGit = path.join(f.a, '.git', 'worktrees', 'B'); fs.mkdirSync(linkedGit, { recursive: true });
      fs.writeFileSync(path.join(linkedGit, 'commondir'), '../..', 'utf8');
      fs.writeFileSync(path.join(f.b, '.git'), `gitdir: ${linkedGit}`, 'utf8');
      expect(() => f.registry.activate(f.b)).toThrow('Git');
    } finally { await f.close(); }
  });

  it('shares successful and failed global provider updates; fresh workspaces inherit current memory secrets', async () => {
    const f = await fixture();
    try {
      const ra = f.registry.getActive().runtime;
      const rb = f.registry.activate(f.b).runtime;
      const values = { baseUrl: ra.getSnapshot().provider.baseUrl, model: 'new-fixture', apiKey: 'ROTATED_MEMORY' };
      expect((await f.registry.configureProvider(rb, values)).ok).toBe(true);
      expect(ra.getSnapshot().provider.model).toBe('new-fixture');
      const c = path.join(f.root, 'C'); fs.mkdirSync(c);
      const rc = f.registry.activate(c).runtime;
      expect(rc.getSnapshot().provider.model).toBe('new-fixture');
      expect(rc.getSnapshot().provider.apiKey.source).toBe('memory');
      expect(JSON.stringify(f.registry.directory())).not.toContain('ROTATED_MEMORY');
    } finally { await f.close(); }
  });

  it('enforces the model cap globally without sending a third request, then recovers capacity', async () => {
    const f = await fixture();
    try {
      const ra = f.registry.getActive().runtime;
      const aRequest = ra.submitTurn('A'); await until(() => f.held.has('A'));
      const rb = f.registry.activate(f.b).runtime; rb.setMode('read_only');
      const bRequest = rb.submitTurn('B'); await until(() => f.held.has('B'));
      const c = path.join(f.root, 'C'); fs.mkdirSync(c);
      const rc = f.registry.activate(c).runtime; rc.setMode('read_only');
      const refused = await rc.submitTurn('C');
      expect(refused.result.outcome).toBe('failed');
      expect(f.held.has('C')).toBe(false);
      expect(f.registry.accounting().activeRequests).toBe(2);
      f.release('A'); await aRequest;
      const cRequest = rc.submitTurn('C retry'); await until(() => f.held.has('C retry'));
      f.release('C retry'); f.release('B'); await Promise.all([bRequest, cRequest]);
      expect(f.registry.accounting().activeRequests).toBe(0);
    } finally { await f.close(); }
  });

  it('continues the original FIFO while a different workspace is selected and active', async () => {
    const f = await fixture();
    try {
      const a = f.registry.getActive(), conversationId = a.runtime.getSnapshot().activeConversationId;
      const requestA = a.runtime.submitTurn('A'); await until(() => f.held.has('A'));
      a.runtime.updateQueue({ conversationId, operation: 'add', text: 'A second' });
      a.runtime.updateQueue({ conversationId, operation: 'add', text: 'A third' });
      const b = f.registry.activate(f.b); b.runtime.setMode('read_only');
      const requestB = b.runtime.submitTurn('B'); await until(() => f.held.has('B'));
      f.release('A'); await requestA; await until(() => f.held.has('A second'));
      expect(f.registry.getActive().workspaceId).toBe(b.workspaceId);
      f.release('A second'); await until(() => f.held.has('A third'));
      f.release('A third'); f.release('B'); await requestB;
      await until(() => !a.runtime.getSnapshot().queue.items.length && a.runtime.getSnapshot().agentStatus === 'completed');
      expect(f.requests.map((r: any) => r.messages.filter((m: any) => m.role === 'user').pop().content)).toEqual(['A', 'B', 'A second', 'A third']);
    } finally { await f.close(); }
  });

  it('explicit close revokes pending approval and releases only its own lock without replay', async () => {
    const f = await fixture();
    try {
      const a = f.registry.getActive(), original = a.runtime.getSnapshot().activeConversationId;
      const request = a.runtime.submitTurn('approval A');
      await until(() => f.held.has('approval A')); f.release('approval A', 'delete');
      expect((await request).result.outcome).toBe('needs_approval');
      f.registry.activate(f.b);
      await f.registry.close(a.workspaceId);
      expect(f.databases[0].prepare("SELECT COUNT(*) n FROM a9_tasks WHERE session_id=? AND status='active'").get(original).n).toBe(0);
      expect(f.databases[0].prepare("SELECT COUNT(*) n FROM a9_approvals WHERE session_id=? AND decision='pending'").get(original).n).toBe(0);
      const restored = f.registry.activate(f.a).runtime.getSnapshot();
      expect(restored.pendingApproval).toBeUndefined();
      expect(restored.queue.paused).toBe(true);
      expect(fs.readFileSync(path.join(f.a, 'note.txt'), 'utf8')).toBe('preserved');
    } finally { await f.close(); }
  });
});
