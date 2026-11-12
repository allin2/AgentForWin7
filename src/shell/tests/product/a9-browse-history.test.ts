/// <reference path="./better-sqlite3.d.ts" />
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import * as vm from 'vm';
import Database from 'better-sqlite3';

const { createA9AgentRuntime } = require('../../product/a9-agent-runtime');
const { createA9WorkspaceRegistry } = require('../../product/a9-workspace-registry');
const { createA9ProductRequestHandler } = require('../../product/a9-product-ipc');
const PREFIX = 'win7-a9-57-browse-';
const residuals = () => fs.readdirSync(os.tmpdir()).filter(name => name.startsWith(PREFIX)).sort();
let initialResiduals: string[];
beforeAll(() => { initialResiduals = residuals(); });
afterAll(() => { expect(residuals()).toEqual(initialResiduals); });

async function until(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('BROWSE_CONDITION_TIMEOUT');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

function fixture(options: any = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), PREFIX)));
  const workspace = path.join(root, '中文 workspace'), otherWorkspace = path.join(root, 'other space');
  const databases: any[] = [];
  let persistence: any;
  let registry: any;
  async function close() {
    try { await registry?.shutdown(); }
    finally {
      for (const db of databases) if (db.open) db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
  try {
    fs.mkdirSync(workspace); fs.mkdirSync(otherWorkspace);
    // Give both fixtures their own Git identity; sandbox temp ancestors may
    // contain a synthetic .git that would correctly make siblings overlap.
    fs.mkdirSync(path.join(workspace, '.git')); fs.mkdirSync(path.join(otherWorkspace, '.git'));
    fs.writeFileSync(path.join(workspace, 'note.txt'), 'preserved', 'utf8');
    const dataRoot = path.join(root, 'data');
    if (options.restrictedStatus) {
      fs.mkdirSync(dataRoot);
      const databasePath = path.join(dataRoot, 'a9-state.db');
      if (options.restrictedStatus === 'diagnostics') fs.writeFileSync(databasePath, 'invalid SQLite bytes', 'utf8');
      else {
        const db = new Database(databasePath);
        try { db.exec('CREATE TABLE a9_meta (id INTEGER PRIMARY KEY, schema_version INTEGER); INSERT INTO a9_meta VALUES (1, 999)'); }
        finally { db.close(); }
      }
    }
    registry = createA9WorkspaceRegistry({ createRuntime: (workspaceRoot: string, host: any) => createA9AgentRuntime({
      ...host, ...options, workspaceRoot, dataRoot, ownerId: `browse-${process.pid}`,
      // Test-only reversible storage exercises persisted composer identity, not DPAPI security.
      vaultPlatform: 'win32', safeStorage: { isEncryptionAvailable: () => true,
        encryptString: (value: string) => Buffer.from(`fixture:${value}`, 'utf8'),
        decryptString: (value: Buffer) => value.toString('utf8').slice(8) },
      openPersistence: (values: any, open: any) => {
        const outcome = host.openPersistence(values, open);
        persistence = outcome.manager;
        return outcome;
      },
      wrapProvider: (provider: any) => host.wrapProvider(options.wrapProvider ? options.wrapProvider(provider) : provider),
      openDatabase: (file: string, values: any) => {
        const db = new Database(file, values); databases.push(db); return db;
      },
    }) });
    const handler = createA9ProductRequestHandler({ workspaceRegistry: registry,
      isValidRendererSender: (event: any) => event.trusted !== false,
      getA9Runtime: () => registry.getActive()?.runtime });
    const call = (action: string, payload: any, scope?: any, schemaVersion = 9) =>
      handler({}, { schemaVersion, action, payload, ...(scope === undefined ? {} : { scope }) });
    const scope = () => { const entry = registry.getActive(); return { workspaceId: entry.workspaceId,
      conversationId: entry.runtime.getSnapshot({ conversationPage: true }).activeConversationId }; };
    const entry = registry.activate(workspace), runtime = entry.runtime;
    return { root, workspace, otherWorkspace, registry, runtime, handler, call, scope, close,
      get persistence() { return persistence; }, get db() { return databases[0]; },
      browse: (conversationId: string, kind = 'facts', page: any = {}) =>
        call('a9.conversation.browse', { conversationId, kind, ...page }, scope()),
    };
  } catch (error) {
    for (const db of databases) if (db.open) db.close();
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function seedHistory(f: any, count = 3) {
  const conversationId = f.scope().conversationId;
  const store = f.persistence;
  store.renameConversation(conversationId, 'B Authorization: Bearer B_TITLE_TOKEN', f.workspace);
  store.db.transaction(() => {
    for (let index = 0; index < count; index++) {
      const taskId = `history-task-${String(index).padStart(3, '0')}`, turnId = `history-turn-${index}`;
      store.upsertTask(taskId, conversationId, 'completed');
      store.upsertTurn(turnId, taskId, conversationId, 'completed', { outcome: 'completed' });
      store.upsertRun(`history-run-${index}`, turnId, conversationId, 'completed');
      store.recordModelEvent(conversationId, null, 'conversation.request', {
        taskId, requestPrompt: `B request ${index} Authorization: Bearer B_HISTORY_TOKEN`,
      });
      store.saveCheckpoint({ turnId, sessionId: conversationId,
        payload: { finalMessage: `B final ${index}`, outcome: 'completed', verification: 'not_applicable' } });
    }
    // Equal timestamps force the taskId tie-breaker across facts page boundaries.
    store.db.prepare('UPDATE a9_events SET created_at=? WHERE session_id=?')
      .run('2026-11-01T00:00:00.000Z', conversationId);
    store.db.prepare('UPDATE a9_checkpoints SET created_at=? WHERE session_id=?')
      .run('2026-11-01T00:00:00.000Z', conversationId);
    for (let index = 0; index < 351; index++) store.recordToolEvent(conversationId, null, 'saved.process', {
      index, apiKey: 'B_EVENT_TOKEN', message: 'Authorization: Basic B_EVENT_TOKEN',
      text: '<script>untrusted history</script>', url: 'https://user:B_URL_TOKEN@example.invalid/path',
    });
  })();
  f.runtime.archiveConversation(conversationId);
  return conversationId;
}

function state(f: any) {
  const tables = f.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
  return {
    tables: tables.map((row: any) => [row.name, f.db.prepare(`SELECT * FROM "${row.name.replace(/"/g, '""')}"`).all()]),
    changes: f.db.prepare('SELECT total_changes() AS n').get().n,
    snapshot: f.runtime.getSnapshot({ conversationPage: true }),
    accounting: f.registry.accounting(),
  };
}

function preloadApi(handler: any) {
  let api: any;
  const requests: any[] = [];
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../../product/preload.js'), 'utf8'), {
    setTimeout, clearTimeout, setInterval, clearInterval,
    process: { argv: ['electron', 'main.js'] },
    require: (name: string) => {
      if (name !== 'electron') throw new Error(`Unexpected preload import: ${name}`);
      return { contextBridge: { exposeInMainWorld: (_name: string, value: any) => { api = value; } },
        ipcRenderer: { invoke: (channel: string, request: any) => {
          expect(channel).toBe('product:a9-request'); requests.push(request); return handler({}, request);
        } } };
    },
  });
  return { api: api.a9, requests };
}

describe('A9-57 real SQLite/runtime/scoped IPC browse without a port', () => {
  it('pages archived B facts and events, redacts projections, and leaves A and all persisted state untouched', async () => {
    const f = fixture();
    try {
      const b = seedHistory(f, 105), executionScope = f.scope();
      f.runtime.saveDraft('A unsent draft');
      const contextReads = jest.spyOn(f.persistence, 'listConversationFacts');
      const before = state(f);
      const page = await f.browse(b);
      expect(page).toMatchObject({ ok: true, conversationId: b, title: 'B Authorization: ***redacted***', hasMore: true });
      expect(page.facts).toHaveLength(30);
      expect(page.facts[0].taskId).toBe('history-task-075');
      expect(page.facts[29].finalMessage).toBe('B final 104');
      expect(page.nextBefore).toEqual({ createdAt: '2026-11-01T00:00:00.000Z', taskId: 'history-task-075' });
      expect((await f.browse(b, 'facts', { limit: 100 })).facts).toHaveLength(100);
      const tasks: string[] = [];
      let beforeFact: any;
      for (;;) {
        const result = await f.browse(b, 'facts', { limit: 17, ...(beforeFact ? { before: beforeFact } : {}) });
        tasks.push(...result.facts.map((fact: any) => fact.taskId));
        if (!result.hasMore) { expect(result.nextBefore).toBeNull(); break; }
        beforeFact = result.nextBefore;
      }
      expect(tasks).toHaveLength(105); expect(new Set(tasks).size).toBe(105);
      const events = await f.browse(b, 'events');
      expect(events.events).toHaveLength(300); expect(events.hasMore).toBe(true);
      expect(events.events[0].eventId).toBeLessThan(events.events[299].eventId);
      expect(events.events[0].payload).toMatchObject({ apiKey: '***redacted***', message: 'Authorization: ***redacted***',
        text: '<script>untrusted history</script>', url: 'https://***redacted***@example.invalid/path' });
      const previous = await f.browse(b, 'events', { beforeEventId: events.events[0].eventId, limit: 300 });
      expect(previous.hasMore).toBe(false);
      expect(previous.events).toHaveLength(156);
      const ids = [...previous.events, ...events.events].map((event: any) => event.eventId);
      expect(new Set(ids).size).toBe(456);
      expect((await f.browse(b, 'events', { beforeEventId: ids[0] })).events).toEqual([]);
      expect((await f.browse(b, 'events', { beforeEventId: 1 })).hasMore).toBe(false);
      expect(JSON.stringify([page, events, previous])).not.toMatch(/B_(?:TITLE|HISTORY|EVENT|URL)_TOKEN/);
      expect(state(f)).toEqual(before);
      expect(contextReads).not.toHaveBeenCalled();
      expect(f.scope()).toEqual(executionScope);
      expect(f.db.prepare('SELECT active_session_id FROM a9_workspace_conversation_state WHERE workspace_path=?')
        .get(f.workspace).active_session_id).toBe(executionScope.conversationId);
    } finally { await f.close(); }
  });

  it('uses the actual preload v9 execution scope and keeps the old current-conversation queries restricted', async () => {
    const f = fixture();
    try {
      const b = seedHistory(f), executionScope = f.scope();
      const { api, requests } = preloadApi(f.handler);
      const scoped = api.forScope(executionScope);
      expect(Object.isFrozen(scoped)).toBe(true);
      expect((await scoped.browseConversation({ conversationId: b, kind: 'facts', limit: 1 })).ok).toBe(true);
      expect(requests[0]).toEqual({ schemaVersion: 9, action: 'a9.conversation.browse', scope: executionScope,
        payload: { conversationId: b, kind: 'facts', limit: 1 } });
      expect((await api.browseConversation({ conversationId: b, kind: 'events' })).error.code).toBe('A9_SCOPE_REQUIRED');
      expect(requests[1].schemaVersion).toBe(9);
      expect((await scoped.queryConversation({ conversationId: b })).error.code).toBe('A9_CONVERSATION_MISMATCH');
      expect((await scoped.queryEvents({ conversationId: b })).error.code).toBe('A9_EVENTS_CONVERSATION_MISMATCH');
    } finally { await f.close(); }
  });

  it('rejects foreign/unknown targets, stale identities, old schemas and missing scope through the real registry', async () => {
    const f = fixture();
    try {
      const b = seedHistory(f), executionScope = f.scope();
      const foreignRuntime = f.registry.activate(f.otherWorkspace).runtime;
      const foreign = f.scope(); f.registry.activate(f.workspace);
      const before = state(f);
      for (const kind of ['facts', 'events']) {
        for (const target of [foreign.conversationId, 'unknown']) {
          expect(await f.browse(target, kind)).toMatchObject({ ok: false, error: { code: 'A9_CONVERSATION_MISMATCH' } });
        }
        const payload = { conversationId: b, kind };
        for (const version of [6, 7, 8]) {
          expect((await f.call('a9.conversation.browse', payload, undefined, version)).error.code).toBe('A9_SCOPE_REQUIRED');
          expect((await f.call('a9.conversation.browse', payload, executionScope, version)).error.code).toBe('A9_SCOPE_REQUIRED');
        }
        expect((await f.call('a9.conversation.browse', payload)).error.code).toBe('A9_SCOPE_REQUIRED');
        expect((await f.call('a9.conversation.browse', payload, foreign)).error.code).toBe('A9_SCOPE_STALE');
        expect((await f.call('a9.conversation.browse', payload, { ...executionScope, conversationId: b })).error.code).toBe('A9_SCOPE_STALE');
        expect((await f.call('a9.conversation.browse', payload, { workspaceId: executionScope.workspaceId })).error.code).toBe('A9_SCOPE_INVALID');
      }
      expect(state(f)).toEqual(before);
      expect(foreignRuntime.getSnapshot({ conversationPage: true }).activeConversationId).toBe(foreign.conversationId);
      const denied = await f.handler({ trusted: false }, { schemaVersion: 9, action: 'a9.conversation.browse',
        scope: executionScope, payload: { conversationId: b, kind: 'facts' } });
      expect(denied.error.code).toBe('RENDERER_CAPABILITY_DENIED');
    } finally { await f.close(); }
  });

  it('strictly rejects malformed payloads and mixed cursors without reading any history page', async () => {
    const f = fixture();
    try {
      const b = seedHistory(f), executionScope = f.scope();
      const facts = { conversationId: b, kind: 'facts' }, events = { conversationId: b, kind: 'events' };
      const invalid: any[] = [null, false, '', 1, [], {}, { conversationId: b }, { kind: 'facts' },
        ...['', ' ', 'x'.repeat(257), 1, null, {}, []].map(conversationId => ({ ...facts, conversationId })),
        ...['', 'Facts', 'other', 1, null, {}, []].map(kind => ({ ...facts, kind })),
        { ...facts, extra: true }, { ...events, turnId: 'turn' }, { ...facts, beforeEventId: 1 },
        { ...events, before: { createdAt: '', taskId: 'x' } },
        ...[null, [], {}, { createdAt: '' }, { taskId: 'x' }, { createdAt: 1, taskId: 'x' },
          { createdAt: 'x'.repeat(65), taskId: 'x' }, { createdAt: '', taskId: '' },
          { createdAt: '', taskId: 1 }, { createdAt: '', taskId: 'x'.repeat(257) },
          { createdAt: '', taskId: 'x', extra: true }, undefined].map(before => ({ ...facts, before })),
        ...[0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1', null, undefined, NaN, Infinity]
          .map(beforeEventId => ({ ...events, beforeEventId })),
      ];
      for (const base of [facts, events]) {
        invalid.push(...[0, -1, 1.5, '1', null, undefined, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1,
          base.kind === 'facts' ? 101 : 301].map(limit => ({ ...base, limit })));
      }
      const readFacts = jest.spyOn(f.persistence, 'listConversationFactPage');
      const readEvents = jest.spyOn(f.persistence, 'listSessionEvents');
      const browse = jest.spyOn(f.runtime, 'browseConversation');
      for (const payload of invalid) {
        expect(await f.call('a9.conversation.browse', payload, executionScope))
          .toMatchObject({ ok: false, error: { code: 'A9_PAYLOAD_INVALID' } });
      }
      expect(browse).not.toHaveBeenCalled(); expect(readEvents).not.toHaveBeenCalled();
      // resolve still reads only the execution conversation's compact snapshot.
      expect(readFacts.mock.calls.every((args: any[]) => args[0] === executionScope.conversationId)).toBe(true);
      expect((await f.browse(b, 'facts', { before: { createdAt: '', taskId: 'x' }, limit: 1 })).ok).toBe(true);
      expect((await f.browse(b, 'facts', { before: { createdAt: 'x'.repeat(64), taskId: 'x'.repeat(256) } })).ok).toBe(true);
      expect((await f.browse(b, 'events', { beforeEventId: Number.MAX_SAFE_INTEGER, limit: 1 })).ok).toBe(true);
      expect((await f.browse('x'.repeat(256))).error.code).toBe('A9_CONVERSATION_MISMATCH');
    } finally { await f.close(); }
  });

  it.each([
    ['electron_sqlite_unavailable', 'ELECTRON_SQLITE_UNAVAILABLE'],
    ['diagnostics', 'A9_DIAGNOSTICS_MODE'],
    ['schema_refused', 'A9_DIAGNOSTICS_MODE'],
  ])('keeps the real %s runtime diagnostic and exposes no missing method exception', async (status, code) => {
    const f = fixture(status === 'electron_sqlite_unavailable'
      ? { electronSqliteRoot: path.join(os.tmpdir(), PREFIX + 'missing-native') }
      : { restrictedStatus: status });
    try {
      expect(f.runtime.status).toBe(status);
      const before = f.runtime.getSnapshot();
      const workspaceId = f.registry.getActive().workspaceId;
      for (const kind of ['facts', 'events']) {
        const values = { conversationId: 'history', kind };
        expect(f.runtime.browseConversation(values)).toEqual({ ok: false, error: { code } });
        expect(await f.call('a9.conversation.browse', values, { workspaceId })).toEqual({ ok: false, error: { code } });
      }
      expect(f.runtime.getSnapshot()).toEqual(before);
    } finally { await f.close(); }
  });
});

async function loopback() {
  const held = new Map<string, http.ServerResponse>(), sockets = new Set<any>();
  const requests: any[] = [];
  const send = (response: http.ServerResponse, delta: any, reason = 'stop') => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: reason }] })}\n\ndata: [DONE]\n\n`);
  };
  const server = http.createServer((request, response) => {
    let body = ''; request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      const values = JSON.parse(body); requests.push(values);
      if (values.tools?.[0]?.function?.name === 'probe_test_echo') {
        send(response, { tool_calls: [{ index: 0, id: 'probe', function: {
          name: 'probe_test_echo', arguments: '{"message":"probe_ok"}' } }] }, 'tool_calls');
      } else held.set(values.messages.filter((item: any) => item.role === 'user').pop().content, response);
    });
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  const f = fixture();
  async function close() {
    try { await f.close(); }
    finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }
  try {
    // EPERM is an environment failure: reject and retain the real test criterion.
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    f.runtime.setMode('full_access');
    await f.registry.configureProvider(f.runtime, { baseUrl: `http://127.0.0.1:${(server.address() as any).port}`,
      model: 'browse-fixture', apiKey: 'BROWSE_MEMORY_SENTINEL' });
    return { ...f, close, held, requests, release(prompt: string, kind?: string) {
      const response = held.get(prompt)!; held.delete(prompt);
      if (kind) send(response, { tool_calls: [{ index: 0, id: `${kind}-call`, function: {
        name: kind === 'approval' ? 'delete' : 'ask_user', arguments: kind === 'approval'
          ? '{"path":"note.txt","permanent":true}' : '{"prompt":"Which option?","options":["one","two"]}' } }] }, 'tool_calls');
      else send(response, { content: `${prompt} complete BROWSE_MEMORY_SENTINEL` });
    } };
  } catch (error) { await close(); throw error; }
}

async function checkInFlightBrowse(f: any, kind: string) {
    let running: any;
    try {
      const b = f.scope().conversationId;
      const old = f.call('a9.turn.submit', { prompt: 'B saved request' }, f.scope());
      await until(() => f.held.has('B saved request')); f.release('B saved request');
      expect((await old).ok).toBe(true);
      f.runtime.createConversation(); const executionScope = f.scope();
      running = f.call('a9.turn.submit', { prompt: 'A in flight' }, executionScope);
      await until(() => f.held.has('A in flight'));
      expect(f.runtime.updateQueue({ conversationId: executionScope.conversationId,
        operation: 'add', text: 'A queued stays' }).ok).toBe(true);
      if (kind !== 'running') {
        f.release('A in flight', kind);
        expect((await running).result.outcome).toBe(kind === 'approval' ? 'needs_approval' : 'needs_input');
      }
      f.runtime.saveDraft('A draft stays');
      const before = state(f), count = f.requests.length;
      const modelInputs = JSON.stringify(f.requests);
      const contextReads = jest.spyOn(f.persistence, 'listConversationFacts');
      expect(before.snapshot.agentStatus).toBe(kind === 'running' ? 'running' : kind === 'approval' ? 'needs_approval' : 'needs_input');
      for (const table of ['a9_tasks', 'a9_turns', 'a9_runs']) {
        expect(f.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE session_id=? AND status='active'`)
          .get(executionScope.conversationId).n).toBe(1);
      }
      expect(before.snapshot.draft.text).toBe('A draft stays');
      expect(before.snapshot.queue.items).toMatchObject([{ text: 'A queued stays' }]);
      expect(f.db.prepare('SELECT draft_ciphertext FROM a9_sessions WHERE session_id=?')
        .get(executionScope.conversationId).draft_ciphertext).toEqual(expect.any(String));
      if (kind === 'approval') expect(before.snapshot.pendingApproval.conversationId).toBe(executionScope.conversationId);
      if (kind === 'question') expect(before.snapshot.pendingQuestion.conversationId).toBe(executionScope.conversationId);
      const { api } = preloadApi(f.handler), scoped = api.forScope(executionScope);
      const facts = await scoped.browseConversation({ conversationId: b, kind: 'facts', limit: 1 });
      const events = await scoped.browseConversation({ conversationId: b, kind: 'events', limit: 300 });
      expect(facts).toMatchObject({ ok: true, conversationId: b,
        facts: [{ requestPrompt: 'B saved request', finalMessage: 'B saved request complete ***redacted***' }] });
      expect(events.ok).toBe(true); expect(events.events.length).toBeGreaterThan(0);
      expect(JSON.stringify([facts, events])).not.toContain('BROWSE_MEMORY_SENTINEL');
      expect(f.requests).toHaveLength(count);
      expect(JSON.stringify(f.requests)).toBe(modelInputs);
      expect(contextReads).not.toHaveBeenCalled();
      expect(state(f)).toEqual(before);
      expect((await f.call('a9.conversation.activate', { conversationId: b }, executionScope)).error.code).toBe('A9_CONVERSATION_BUSY');
      expect(fs.readFileSync(path.join(f.workspace, 'note.txt'), 'utf8')).toBe('preserved');
    } finally {
      try { await f.call('a9.turn.stop', {}, f.scope()); await running; }
      finally { await f.close(); }
    }
}

describe('A9-57 real loopback provider/SQLite/runtime/IPC while A is in flight', () => {
  it.each(['running', 'approval', 'question'])('reads B while A is %s and preserves its execution and approval/question identity', async kind => {
    await checkInFlightBrowse(await loopback(), kind);
  });
});

// Independent of loopback admission: only the model transport is a controlled
// in-process substitute. SQLite, runtime, loop, registry, preload and IPC stay real.
describe('A9-57 in-flight runtime without a port (SURROGATE model transport)', () => {
  it.each(['running', 'approval', 'question'])('preserves A while %s with zero browse-triggered model calls', async kind => {
    const held = new Map<string, (value: any) => void>(), requests: any[] = [];
    const f = fixture({ wrapProvider: () => ({ sendStreamRequest: (request: any, _chunk: any, options: any) => {
      requests.push(request);
      const prompt = request.messages.filter((item: any) => item.role === 'user').pop().content;
      return new Promise((resolve, reject) => {
        const signal = options?.signal;
        const abort = () => { held.delete(prompt); reject(new Error('fixture transport aborted')); };
        if (signal?.aborted) { abort(); return; }
        signal?.addEventListener('abort', abort, { once: true });
        held.set(prompt, value => { signal?.removeEventListener('abort', abort); resolve(value); });
      });
    } }) });
    try {
      f.runtime.setMode('full_access');
      await f.runtime.configureProvider({ baseUrl: 'https://fixture.invalid', model: 'fixture',
        apiKey: 'BROWSE_MEMORY_SENTINEL', skipProbe: true });
    } catch (error) { await f.close(); throw error; }
    await checkInFlightBrowse({ ...f, held, requests, release(prompt: string, pending?: string) {
      const release = held.get(prompt)!; held.delete(prompt);
      release(pending ? { id: pending, content: '', finishReason: 'tool_calls', toolCalls: [{ id: `${pending}-call`,
        name: pending === 'approval' ? 'delete' : 'ask_user', arguments: JSON.stringify(pending === 'approval'
          ? { path: 'note.txt', permanent: true } : { prompt: 'Which option?', options: ['one', 'two'] }) }] }
        : { id: 'done', content: `${prompt} complete BROWSE_MEMORY_SENTINEL`, finishReason: 'stop' });
    } }, kind);
  });
});
