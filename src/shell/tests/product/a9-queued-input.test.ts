/// <reference path="./better-sqlite3.d.ts" />
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import Database from 'better-sqlite3';
const { createA9AgentRuntime } = require('../../product/a9-agent-runtime');
const { createA9ProductRequestHandler } = require('../../product/a9-product-ipc');

async function until(check: () => boolean) {
  const deadline = Date.now() + 4000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('QUEUE_CONDITION_TIMEOUT');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

async function fixture(durable = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'win7-a9-50-queue-'));
  const workspaceRoot = path.join(root, '中文 workspace'); fs.mkdirSync(workspaceRoot);
  fs.writeFileSync(path.join(workspaceRoot, 'note.txt'), 'preserved', 'utf8');
  const requests: any[] = []; const sockets = new Set<any>();
  let held: http.ServerResponse | null = null;
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
      if (requests.length === 1) held = res;
      else send(res, { content: 'done' });
    });
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  const databases: any[] = [];
  const make = () => createA9AgentRuntime({ workspaceRoot, dataRoot: path.join(root, 'data'),
    ...(durable ? { vaultPlatform: 'win32', safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (text: string) => Buffer.from(Buffer.from(text).toString('base64')),
      decryptString: (bytes: Buffer) => Buffer.from(bytes.toString(), 'base64').toString(),
    } } : {}),
    openDatabase: (file: string, options: any) => { const db = new Database(file, options); databases.push(db); return db; } });
  let runtime: any;
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    runtime = make();
    runtime.setMode('read_only');
    await runtime.configureProvider({ baseUrl: `http://127.0.0.1:${(server.address() as any).port}`, model: 'fixture' });
    await runtime.probeProvider();
  } catch (error) {
    if (runtime) await runtime.shutdown();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    for (const db of databases) if (db.open) db.close();
    fs.rmSync(root, { recursive: true, force: true }); throw error;
  }
  const conversationId = runtime.getSnapshot().activeConversationId;
  return { root, get runtime() { return runtime; }, requests, conversationId,
    async restart() { await runtime.shutdown(); runtime = make(); },
    update: (operation: string, values: any = {}) => runtime.updateQueue({ conversationId, operation, ...values }),
    async start() { const request = runtime.submitTurn('first'); await until(() => held !== null); return { request }; },
    release(kind = 'text') {
      if (kind === 'fail') { held!.writeHead(400); held!.end('fixture failure'); }
      else if (kind === 'approval') send(held!, { tool_calls: [{ index: 0, id: 'delete-file', function: { name: 'delete', arguments: '{"path":"note.txt","permanent":true}' } }] }, 'tool_calls');
      else if (kind === 'ask') send(held!, { tool_calls: [{ index: 0, id: 'question', function: { name: 'ask_user', arguments: '{"prompt":"choose?","options":["yes","no"]}' } }] }, 'tool_calls');
      else send(held!, { content: 'first complete' });
      held = null;
    },
    async close() {
      try { await runtime.shutdown(); }
      finally {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>(resolve => server.close(() => resolve()));
        for (const db of databases) if (db.open) db.close();
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  };
}

describe('A9-50 real runtime and SQLite queue', () => {
  it('sends FIFO once, keeps unrelated drafts out of requests and events', async () => {
    const f = await fixture();
    try {
      const { request } = await f.start();
      expect(f.update('add', { text: 'second' }).ok).toBe(true);
      expect(f.update('add', { text: 'third' }).ok).toBe(true);
      f.runtime.saveDraft('UNSENT_PRIVATE_DRAFT');
      f.release(); expect((await request).ok).toBe(true);
      await until(() => f.requests.length === 3 && f.runtime.getSnapshot().agentStatus === 'completed');
      expect(f.requests.map(r => r.messages.filter((m: any) => m.role === 'user').pop().content)).toEqual(['first', 'second', 'third']);
      expect(JSON.stringify(f.requests)).not.toContain('UNSENT_PRIVATE_DRAFT');
      expect(f.runtime.getSnapshot().draft.text).toBe('UNSENT_PRIVATE_DRAFT');
      expect(f.runtime.getSnapshot().queue.items).toHaveLength(0);
      const db = new Database(path.join(f.root, 'data/a9-state.db'), { readonly: true });
      try { expect(JSON.stringify(db.prepare('SELECT payload_json FROM a9_events').all())).not.toContain('UNSENT_PRIVATE_DRAFT'); }
      finally { db.close(); }
    } finally { await f.close(); }
  });
  it.each(['stop', 'fail', 'pause'])('retains queued text without sending after %s', async kind => {
    const f = await fixture();
    try {
      const { request } = await f.start(); f.update('add', { text: 'second' });
      if (kind === 'stop') f.runtime.stop();
      else { if (kind === 'pause') f.update('pause'); f.release(kind === 'fail' ? 'fail' : 'text'); }
      await request;
      await new Promise(resolve => setImmediate(resolve));
      expect(f.requests).toHaveLength(1);
      expect(f.runtime.getSnapshot().queue).toMatchObject({ paused: true, items: [{ text: 'second' }] });
      expect(f.update('resume').ok).toBe(true);
      await until(() => f.requests.length === 2 && f.runtime.getSnapshot().agentStatus === 'completed');
    } finally { await f.close(); }
  });
  it.each(['answered', 'cancelled'])('keeps queue behind a question and handles %s explicitly', async decision => {
    const f = await fixture();
    try {
      const { request } = await f.start(); f.update('add', { text: 'second' }); f.release('ask');
      await request;
      expect(f.requests).toHaveLength(1);
      const q = f.runtime.getSnapshot().pendingQuestion;
      expect(q).toBeTruthy();
      await f.runtime.answerQuestion({ conversationId: q.conversationId, questionId: q.questionId, revision: q.revision,
        decision, ...(decision === 'answered' ? { answer: 'yes' } : {}) });
      if (decision === 'answered') await until(() => f.requests.length === 3 && f.runtime.getSnapshot().agentStatus === 'completed');
      else {
        expect(f.requests).toHaveLength(1);
        expect(f.runtime.getSnapshot().queue.paused).toBe(true);
      }
    } finally { await f.close(); }
  });
  it.each(['approved', 'denied'])('keeps queued messages behind target-bound approval: %s', async decision => {
    const f = await fixture();
    try {
      f.runtime.setMode('full_access');
      const { request } = await f.start(); f.update('add', { text: 'second' }); f.release('approval');
      const first = await request;
      expect(first.result.outcome).toBe('needs_approval');
      expect(f.requests).toHaveLength(1);
      const pending = first.result.pendingApproval;
      await f.runtime.resumeApproval({ conversationId: pending.conversationId, taskId: pending.taskId,
        turnId: pending.turnId, approvalId: pending.approvalId, bindingDigest: pending.bindingDigest, decision });
      if (decision === 'approved') {
        await until(() => f.requests.length === 3 && f.runtime.getSnapshot().agentStatus === 'completed');
        expect(fs.existsSync(path.join(f.root, '中文 workspace/note.txt'))).toBe(false);
      } else {
        await new Promise(resolve => setImmediate(resolve));
        expect(f.runtime.getSnapshot().queue).toMatchObject({ paused: true, items: [{ text: 'second' }] });
        expect(fs.readFileSync(path.join(f.root, '中文 workspace/note.txt'), 'utf8')).toBe('preserved');
      }
    } finally { await f.close(); }
  });
  it('restores encrypted queue content paused with synthetic safeStorage, without replay', async () => {
    const f = await fixture(true);
    try {
      const { request } = await f.start(); f.update('add', { text: 'second' }); f.runtime.saveDraft('unsent');
      f.runtime.stop(); await request; await f.restart();
      const state = f.runtime.getSnapshot();
      expect(state.queue).toMatchObject({ paused: true, persistence: 'dpapi', items: [{ text: 'second' }] });
      expect(state.draft.text).toBe('unsent');
      await new Promise(resolve => setImmediate(resolve)); expect(f.requests).toHaveLength(1);
      await f.runtime.probeProvider(); expect(f.update('resume').ok).toBe(true);
      await until(() => f.requests.length === 2 && f.runtime.getSnapshot().agentStatus === 'completed');
    } finally { await f.close(); }
  });
  it('Stop invalidates a scheduled dispatch before the next turn starts', async () => {
    const f = await fixture();
    try {
      const { request } = await f.start(); f.update('add', { text: 'second' }); f.release(); await request;
      f.runtime.stop();
      await new Promise(resolve => setImmediate(resolve));
      expect(f.requests).toHaveLength(1);
      expect(f.runtime.getSnapshot().queue).toMatchObject({ paused: true, items: [{ text: 'second' }] });
    } finally { await f.close(); }
  });
  it('rejects wrong conversations, unsupported versions and extra fields before dispatch', async () => {
    const f = await fixture();
    try {
      const handler = createA9ProductRequestHandler({ isValidRendererSender: () => true, getA9Runtime: () => f.runtime });
      for (const payload of [{ conversationId: f.conversationId, operation: 'add', text: 'x', arbitrary: true },
        { conversationId: f.conversationId, operation: 'pause', text: 'x' }]) {
        expect((await handler({}, { schemaVersion: 8, action: 'a9.queue.update', payload })).error.code).toBe('A9_PAYLOAD_INVALID');
      }
      expect((await handler({}, { schemaVersion: 7, action: 'a9.queue.update', payload: { conversationId: f.conversationId, operation: 'pause' } })).ok).toBe(false);
      expect(f.runtime.updateQueue({ conversationId: 'other', operation: 'resume' }).error.code).toBe('A9_QUEUE_CONVERSATION_MISMATCH');
      expect(f.requests).toHaveLength(0);
    } finally { await f.close(); }
  });
});
