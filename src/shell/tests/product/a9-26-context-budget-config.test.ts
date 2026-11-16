/// <reference path="./better-sqlite3.d.ts" />
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';

const { createA9AgentRuntime, openA9RuntimePersistence } = require('../../product/a9-agent-runtime') as any;
const { createA9ProductRequestHandler, A9_ACTIONS } = require('../../product/a9-product-ipc') as any;
const { createA9WorkspaceRegistry } = require('../../product/a9-workspace-registry') as any;

function makeRuntimeWithBudget(budget: unknown) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a9-r3-config-'));
  const workspaceRoot = path.join(root, 'ws');
  const dataRoot = path.join(root, 'data');
  fs.mkdirSync(workspaceRoot);
  fs.mkdirSync(dataRoot);
  const configPath = path.join(dataRoot, 'a9-provider-config.v1.json');
  fs.writeFileSync(configPath, JSON.stringify({ schemaVersion: 1, baseUrl: 'http://127.0.0.1:1/v1',
    model: 'fixture', customHeaderNames: [], contextBudgetChars: budget }), 'utf8');
  const runtime = createA9AgentRuntime({ workspaceRoot, dataRoot, ownerId: `r3-${Date.now()}-${Math.random()}`,
    openDatabase: (databasePath: string, options?: { readonly?: boolean }) =>
      new Database(databasePath, options?.readonly ? { readonly: true } : {}) });
  return { root, configPath, runtime };
}

describe('A9-26 persisted request budget', () => {
  it('R3-04 valid optional budget survives saving Provider settings', async () => {
    const env = makeRuntimeWithBudget(120_000);
    try {
      expect(env.runtime.getSnapshot().contextWindow.budgetChars).toBe(120_000);
      await env.runtime.configureProvider({ baseUrl: 'http://127.0.0.1:1/v1', model: 'fixture-2', skipProbe: true });
      expect(JSON.parse(fs.readFileSync(env.configPath, 'utf8')).contextBudgetChars).toBe(120_000);
    } finally { env.runtime.shutdown(); fs.rmSync(env.root, { recursive: true, force: true }); }
  });

  it.each([0, 15_999, 1_000_001, 1.5, '96000'])('R3-04 invalid budget %s falls back with diagnosis', (budget) => {
    const env = makeRuntimeWithBudget(budget);
    try {
      const snapshot = env.runtime.getSnapshot();
      expect(snapshot.contextWindow.budgetChars).toBe(400_000);
      expect(snapshot.contextBudgetDiagnostics.code).toBe('A9_CONTEXT_BUDGET_INVALID');
    } finally { env.runtime.shutdown(); fs.rmSync(env.root, { recursive: true, force: true }); }
  });

  it('A9-Settings preserves 128K prompts/drafts/queues without silent 8000/32000 truncation, rejects over-limit, and clears thinking/effort via null', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a9-settings-128k-'));
    const workspaceRoot = path.join(root, 'ws');
    const docsRoot = path.join(root, 'docs');
    const dataRoot = path.join(root, 'data');
    fs.mkdirSync(workspaceRoot);
    fs.mkdirSync(docsRoot);
    fs.mkdirSync(dataRoot);
    const requestBodies: any[] = [];
    const dbs: any[] = [];
    const sockets = new Set<any>();
    let heldRes: http.ServerResponse | null = null;
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk.toString('utf8'); });
      req.on('end', () => {
        const data = JSON.parse(body);
        if (data.tools?.[0]?.function?.name === 'probe_test_echo') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.end(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'probe', function: { name: 'probe_test_echo', arguments: '{"message":"probe_ok"}' } }] }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`);
          return;
        }
        requestBodies.push(data);
        const lastContent = data.messages?.[data.messages.length - 1]?.content;
        if (typeof lastContent === 'string' && lastContent.startsWith('hold')) {
          heldRes = res;
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end('data: {"id":"1","choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
      });
    });
    server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
    const openDatabase = (databasePath: string, options?: { readonly?: boolean }) => {
      const db = new Database(databasePath, options?.readonly ? { readonly: true } : {});
      dbs.push(db);
      return db;
    };
    const makeRuntime = (ws = workspaceRoot, extra: Record<string, any> = {}) => createA9AgentRuntime({
      workspaceRoot: ws,
      dataRoot,
      openDatabase,
      ...extra,
    });
    let runtime = makeRuntime();
    try {
      runtime.setMode('full_access');
      await runtime.configureProvider({
        baseUrl,
        model: 'fixture-model',
        thinkingEnabled: true,
        reasoningEffort: 'high',
      });
      await runtime.probeProvider();
      const handler = createA9ProductRequestHandler({
        isValidRendererSender: () => true,
        getA9Runtime: () => runtime,
      });

      // 1. Over-limit rejected cleanly without truncating or running a turn.
      const over128k = 'x'.repeat(128_001);
      expect(await runtime.submitTurn(over128k)).toMatchObject({ ok: false, error: { code: 'A9_PROMPT_TOO_LONG' } });
      expect(runtime.saveDraft(over128k)).toMatchObject({ ok: false, error: { code: 'A9_DRAFT_TOO_LONG' } });

      // 2. Draft > 32K (100K) persists intact in full (not sliced to 32000).
      const draft100k = 'd'.repeat(99_990) + 'DRAFT_TAIL';
      expect(runtime.saveDraft(draft100k)).toMatchObject({ ok: true });
      expect(runtime.getSnapshot().draft.text).toBe(draft100k);

      // 3. SubmitTurn > 8K (100K) reaches Gateway intact without slicing at 8000.
      const prompt100k = 'p'.repeat(99_986) + 'IMPORTANT_TAIL';
      expect((await runtime.submitTurn(prompt100k)).ok).toBe(true);
      const sentMessages = requestBodies[0].messages;
      expect(sentMessages[sentMessages.length - 1].content).toBe(prompt100k);
      expect(requestBodies[0].thinking).toEqual({ type: 'enabled' });
      expect(requestBodies[0].reasoning_effort).toBe('high');

      // 4. Queue > 8K (50K) allowed through IPC & runtime, while > 128K is rejected.
      const cid = runtime.getSnapshot().activeConversationId;
      const inFlight = runtime.submitTurn('hold');
      while (!heldRes) await new Promise((r) => setTimeout(r, 5));
      const queue50k = 'q'.repeat(49_990) + 'QUEUE_TAIL';
      expect(await handler({}, {
        schemaVersion: 8,
        action: A9_ACTIONS.QUEUE_UPDATE,
        payload: { conversationId: cid, operation: 'add', text: queue50k },
      })).toMatchObject({ ok: true, queue: { items: [{ text: queue50k }] } });
      expect(await handler({}, {
        schemaVersion: 8,
        action: A9_ACTIONS.QUEUE_UPDATE,
        payload: { conversationId: cid, operation: 'add', text: over128k },
      })).toMatchObject({ ok: false, error: { code: 'A9_QUEUE_TEXT_INVALID' } });
      (heldRes as http.ServerResponse).writeHead(200, { 'Content-Type': 'text/event-stream' });
      (heldRes as http.ServerResponse).end('data: {"id":"2","choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
      heldRes = null;
      await inFlight;
      while (requestBodies.length < 3 || runtime.getSnapshot().agentStatus !== 'completed' || runtime.getSnapshot().controls.canStop) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(requestBodies[2].messages[requestBodies[2].messages.length - 1].content).toBe(queue50k);

      // 5. Switching back to auto (passing null) clears saved thinkingEnabled / reasoningEffort.
      await runtime.configureProvider({
        baseUrl,
        model: 'fixture-model',
        thinkingEnabled: null,
        reasoningEffort: null,
      });
      await runtime.probeProvider();
      const clearedSnap = runtime.getSnapshot();
      expect(clearedSnap.provider.thinkingEnabled).toBeUndefined();
      expect(clearedSnap.provider.reasoningEffort).toBeUndefined();
      const persisted = JSON.parse(fs.readFileSync(path.join(dataRoot, 'a9-provider-config.v1.json'), 'utf8'));
      expect(persisted.thinkingEnabled).toBeUndefined();
      expect(persisted.reasoningEffort).toBeUndefined();
      expect((await runtime.submitTurn('after-auto-clear')).ok).toBe(true);
      expect(requestBodies[3].thinking).toBeUndefined();
      expect(requestBodies[3].reasoning_effort).toBeUndefined();

      // 6. Lowering composerMaxChars does not drop an already-queued 50K item on resume/dispatch.
      const held2 = runtime.submitTurn('hold-for-queue-retention');
      while (!heldRes) await new Promise((r) => setTimeout(r, 5));
      expect(await handler({}, {
        schemaVersion: 8,
        action: A9_ACTIONS.QUEUE_UPDATE,
        payload: { conversationId: cid, operation: 'add', text: queue50k },
      })).toMatchObject({ ok: true, queue: { items: [{ text: queue50k }] } });
      expect(await handler({}, {
        schemaVersion: 8,
        action: A9_ACTIONS.QUEUE_UPDATE,
        payload: { conversationId: cid, operation: 'pause' },
      })).toMatchObject({ ok: true, queue: { paused: true, items: [{ text: queue50k }] } });
      (heldRes as http.ServerResponse).writeHead(200, { 'Content-Type': 'text/event-stream' });
      (heldRes as http.ServerResponse).end('data: {"id":"hold2","choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
      heldRes = null;
      await held2;
      while (runtime.getSnapshot().agentStatus !== 'completed' || runtime.getSnapshot().controls.canStop) {
        await new Promise((r) => setTimeout(r, 10));
      }
      await runtime.configureProvider({
        baseUrl,
        model: 'fixture-model',
        composerMaxChars: 1000,
      });
      await runtime.probeProvider();
      const requestsBeforeResume = requestBodies.length;
      const resumeTooLong = await handler({}, {
        schemaVersion: 8,
        action: A9_ACTIONS.QUEUE_UPDATE,
        payload: { conversationId: cid, operation: 'resume' },
      });
      expect(resumeTooLong).toMatchObject({
        ok: false,
        error: { code: 'A9_PROMPT_TOO_LONG' },
        queue: { paused: true, items: [{ text: queue50k }] },
      });
      expect(runtime.getSnapshot().queue).toMatchObject({
        paused: true,
        items: [{ text: queue50k }],
        error: { code: 'A9_PROMPT_TOO_LONG' },
      });
      expect(requestBodies.length).toBe(requestsBeforeResume);
      const queuedItemId = runtime.getSnapshot().queue.items[0].id;
      expect(await handler({}, {
        schemaVersion: 8,
        action: A9_ACTIONS.QUEUE_UPDATE,
        payload: { conversationId: cid, operation: 'remove', itemId: queuedItemId },
      })).toMatchObject({ ok: true, queue: { items: [] } });
      await runtime.configureProvider({
        baseUrl,
        model: 'fixture-model',
        composerMaxChars: 128_000,
      });
      await runtime.probeProvider();

      // 7. Default workdir start respects 128K limit and does not reserve a folder when > 128K.
      await runtime.shutdown();
      const registry = createA9WorkspaceRegistry({
        createRuntime: (ws: string, extra: Record<string, any>) => makeRuntime(ws, extra),
        getDocumentsPath: () => docsRoot,
        getDataRoot: () => dataRoot,
        normalizeConversationTitle: (v: string) => String(v || '').slice(0, 20),
        openPersistence: () => openA9RuntimePersistence({ workspaceRoot, dataRoot, openDatabase }),
      });
      const regHandler = createA9ProductRequestHandler({
        isValidRendererSender: () => true,
        workspaceRegistry: registry,
      });
      const tooLongDefault = await regHandler({}, {
        schemaVersion: 9,
        action: A9_ACTIONS.WORKDIR_START,
        payload: { prompt: over128k },
      });
      expect(tooLongDefault).toMatchObject({ ok: false, error: { code: 'A9_PROMPT_TOO_LONG' } });
      expect(fs.readdirSync(docsRoot)).toEqual([]);
      const longDefaultPrompt = 'w'.repeat(20_000) + '_DEFAULT_TAIL';
      const okDefault = await regHandler({}, {
        schemaVersion: 9,
        action: A9_ACTIONS.WORKDIR_START,
        payload: { prompt: longDefaultPrompt, mode: 'full_access' },
      });
      expect(okDefault).toMatchObject({ ok: true });
      while (requestBodies.length < 6 || (okDefault.scope && registry.getActive()?.runtime.getSnapshot().agentStatus !== 'completed')) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(requestBodies[requestBodies.length - 1].messages[requestBodies[requestBodies.length - 1].messages.length - 1].content).toBe(longDefaultPrompt);
      await registry.shutdown();
    } finally {
      await runtime.shutdown();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      for (const db of dbs) if (db.open) db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 15000);
});
