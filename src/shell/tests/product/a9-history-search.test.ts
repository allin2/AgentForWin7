/// <reference path="./better-sqlite3.d.ts" />
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vm from 'vm';
import Database from 'better-sqlite3';

const { createA9AgentRuntime } = require('../../product/a9-agent-runtime');
const { createA9WorkspaceRegistry } = require('../../product/a9-workspace-registry');
const { createA9ProductRequestHandler } = require('../../product/a9-product-ipc');
const PREFIX = 'win7-a958-runtime-';
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
  let root = fs.mkdtempSync(path.join(os.tmpdir(), PREFIX));
  let workspace = '', otherWorkspace = '';
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
    root = fs.realpathSync(root);
    workspace = path.join(root, '中文 workspace'); otherWorkspace = path.join(root, 'other space');
    fs.mkdirSync(workspace); fs.mkdirSync(otherWorkspace);
    // Give both fixtures their own Git identity; sandbox temp ancestors may
    // contain a synthetic .git that would correctly make siblings overlap.
    fs.mkdirSync(path.join(workspace, '.git')); fs.mkdirSync(path.join(otherWorkspace, '.git'));
    fs.writeFileSync(path.join(workspace, 'note.txt'), 'preserved', 'utf8');
    const dataRoot = path.join(root, 'data');
    if (options.restrictedStatus && options.restrictedStatus !== 'electron_sqlite_unavailable') {
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

const search = (f: any, query: string, page: any = {}) => f.call('a9.history.search', { query, ...page }, f.scope());
const locate = (f: any, item: any, query?: string) => f.call('a9.history.locate', { conversationId: item.conversationId,
  source: item.source, id: item.id, ...(query ? { query } : {}) }, f.scope());
it('real preload/registry/runtime/SQLite: searches archived and deep history and locates without state changes', async () => {
  const f = fixture();
  try {
    const b = seedHistory(f, 155), scope = f.scope();
    f.runtime.saveDraft('execution unsent');
    f.persistence.recordToolEvent(b, 'history-turn-0', 'tool_start', { data: { callId: 'call', toolName: 'shell', args: { command: `中文 % _ ' \\ command` } } });
    f.persistence.recordToolEvent(b, 'history-turn-0', 'tool_end', { data: { callId: 'call', toolName: 'shell', shell: { exitCode: 1, stdout: 'stdout retained', stderr: 'OLD_ERROR 中文' } } });
    const current = f.scope().conversationId;
    f.persistence.upsertTask('current-task', current, 'active');
    f.persistence.recordModelEvent(current, null, 'conversation.request', { taskId: 'current-task', requestPrompt: 'current searchable' });
    const preload = preloadApi(f.handler).api.forScope(scope);
    const before = state(f), facts = jest.spyOn(f.persistence, 'listConversationFactPage');
    const first = await preload.searchHistory({ query: 'B request', limit: 11 });
    expect(first).toMatchObject({ ok: true, hasMore: true }); expect(first.results).toHaveLength(11);
    expect(first.results.every((item: any) => item.conversationId === b)).toBe(true);
    const second = await preload.searchHistory({ query: 'B request', limit: 11, before: first.nextBefore });
    expect(new Set([...first.results, ...second.results].map((item: any) => item.id)).size).toBe(22);
    const old = (await search(f, 'B request 0')).results[0];
    const source = await locate(f, old, 'B request 0');
    expect(source).toMatchObject({ ok: true, conversationId: b }); expect(source.message.text).toContain('B request 0');
    expect((await search(f, `中文 % _ ' \\ command`)).results).toHaveLength(1);
    expect((await search(f, 'OLD_ERROR 中文')).results).toHaveLength(1);
    expect((await search(f, 'current searchable')).results[0].conversationId).toBe(current);
    expect((await search(f, 'B_HISTORY_TOKEN')).results).toEqual([]);
    expect((await search(f, 'B_HIST')).results).toEqual([]);
    expect((await search(f, 'execution unsent')).results).toEqual([]);
    expect(facts.mock.calls.every(call => call[0] === current)).toBe(true); expect(state(f)).toEqual(before);
  } finally { await f.close(); }
});
it('rejects missing/legacy/stale scopes, unknown keys/types/cursors and cross-workspace source identities', async () => {
  const f = fixture();
  try {
    const b = seedHistory(f), scope = f.scope();
    for (const action of ['a9.history.search', 'a9.history.locate', 'a9.delivery.get']) {
      expect((await f.call(action, {}, undefined)).error.code).toBe('A9_SCOPE_REQUIRED');
      expect((await f.call(action, {}, scope, 8)).error.code).toBe('A9_SCOPE_REQUIRED');
      expect((await f.call(action, {}, { ...scope, conversationId: b })).error.code).toBe('A9_SCOPE_STALE');
    }
    for (const payload of [{ query: '' }, { query: 'x', unknown: true }, { query: 1 }, { query: 'x'.repeat(257) },
      { query: 'x\n' }, { query: 'x', limit: 0 }, { query: 'x', before: { createdAt: 'bad', source: 'event', id: '1' } },
      { query: 'x', before: { createdAt: '2026-11-01', source: 'event', id: '1', unknown: true } }]) {
      expect((await f.call('a9.history.search', payload, scope)).error.code).toBe('A9_PAYLOAD_INVALID');
      expect(() => f.runtime.searchHistory(payload)).toThrow('A9_PAYLOAD_INVALID');
    }
    f.registry.open(f.otherWorkspace);
    const foreign = f.registry.getActive(); // open does not select; obtain the other entry explicitly
    const other = f.registry.open(f.otherWorkspace);
    const otherConversation = other.runtime.getSnapshot().activeConversationId;
    expect((await f.call('a9.history.locate', { conversationId: otherConversation, source: 'event', id: '1' }, scope)).error.code).toBe('A9_CONVERSATION_MISMATCH');
    expect((await f.call('a9.delivery.get', { conversationId: otherConversation, turnId: 'history-turn-0' }, scope)).error.code).toBe('A9_CONVERSATION_MISMATCH');
    expect(foreign).toBeTruthy();
  } finally { await f.close(); }
});
it.each(['diagnostics', 'schema_refused', 'electron_sqlite_unavailable'])('restricted %s returns diagnostics for all new methods', async restrictedStatus => {
  const f = fixture({ restrictedStatus, ...(restrictedStatus === 'electron_sqlite_unavailable' ? { electronSqliteRoot: path.join(os.tmpdir(), 'win7-a958-no-sqlite') } : {}) });
  try {
    const scope = { workspaceId: f.registry.getActive().workspaceId };
    for (const [action, payload] of [ ['a9.history.search', { query: 'x' }],
      ['a9.history.locate', { conversationId: 'c', source: 'event', id: '1' }], ['a9.delivery.get', { conversationId: 'c', turnId: 't' }] ]) {
      expect((await f.call(action as string, payload, scope)).error.code).toBe(restrictedStatus === 'electron_sqlite_unavailable' ? 'ELECTRON_SQLITE_UNAVAILABLE' : 'A9_DIAGNOSTICS_MODE');
    }
  } finally { await f.close(); }
});
it.each(['running', 'approval', 'question'])('SURROGATE in-process model: current/history search while %s causes zero extra requests or writes', async kind => {
  const held = new Map<string, (result: any) => void>(), requests: any[] = [];
  const f = fixture({ wrapProvider: () => ({ sendStreamRequest: (request: any, _chunk: any, options: any) => {
    requests.push(request);
    const prompt = request.messages.filter((message: any) => message.role === 'user').pop().content;
    return new Promise((resolve, reject) => {
      const abort = () => { held.delete(prompt); reject(new Error('fixture aborted')); };
      options?.signal?.addEventListener('abort', abort, { once: true });
      held.set(prompt, result => { options?.signal?.removeEventListener('abort', abort); resolve(result); });
    });
  } }) });
  try {
    const b = seedHistory(f);
    f.runtime.setMode('full_access');
    await f.runtime.configureProvider({ baseUrl: 'https://fixture.invalid', model: 'fixture', apiKey: 'HISTORY_KNOWN_SECRET', skipProbe: true });
    const pending = f.runtime.submitTurn(`execution ${kind} HISTORY_KNOWN_SECRET`);
    await until(() => held.size === 1);
    if (kind !== 'running') {
      const finish = held.values().next().value!; held.clear();
      finish({ id: kind, content: '', finishReason: 'tool_calls', toolCalls: [{ id: `${kind}-call`, name: kind === 'approval' ? 'delete' : 'ask_user',
        arguments: JSON.stringify(kind === 'approval' ? { path: 'note.txt', permanent: true } : { prompt: 'Choose?', options: ['one', 'two'] }) }] });
      await pending;
    }
    const before = state(f), count = requests.length;
    expect((await search(f, `execution ${kind}`)).results).toHaveLength(1);
    expect((await search(f, 'HISTORY_KNOWN_SECRET')).results).toEqual([]);
    const item = (await search(f, 'B final 0')).results[0];
    expect((await locate(f, item)).ok).toBe(true);
    expect(state(f)).toEqual(before); expect(requests).toHaveLength(count);
    if (kind === 'running') { await f.runtime.stop(); await pending; }
  } finally { await f.close(); }
});
