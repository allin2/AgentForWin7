/// <reference path="./better-sqlite3.d.ts" />
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';

const { createA9AgentRuntime } = require('../../product/a9-agent-runtime');
const { createA9WorkspaceRegistry } = require('../../product/a9-workspace-registry');
const { createA9ProductRequestHandler } = require('../../product/a9-product-ipc');
const PREFIX = 'win7-a958-delivery-';
const residuals = () => fs.readdirSync(os.tmpdir()).filter(name => name.startsWith(PREFIX)).sort();
let initialResiduals: string[];
beforeAll(() => { initialResiduals = residuals(); });
afterAll(() => { expect(residuals()).toEqual(initialResiduals); });

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

function state(f: any) {
  const tables = f.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
  return {
    tables: tables.map((row: any) => [row.name, f.db.prepare(`SELECT * FROM "${row.name.replace(/"/g, '""')}"`).all()]),
    changes: f.db.prepare('SELECT total_changes() AS n').get().n,
    snapshot: f.runtime.getSnapshot({ conversationPage: true }),
    accounting: f.registry.accounting(),
  };
}

const { A9WorkspaceService } = require('../../../workspace/dist');
function delivery(f: any, conversationId: string, turnId: string) {
  return f.call('a9.delivery.get', { conversationId, turnId }, f.scope());
}
function turn(f: any, turnId: string, outcome = 'completed', verification?: string) {
  const conversationId = f.scope().conversationId, taskId = `task-${turnId}`;
  const status = ['completed_with_warnings'].includes(outcome) ? 'completed' : ['needs_approval', 'needs_input'].includes(outcome) ? 'active' : outcome === 'blocked' ? 'failed' : outcome;
  f.persistence.upsertTask(taskId, conversationId, status);
  f.persistence.upsertTurn(turnId, taskId, conversationId, status, { outcome, ...(verification ? { verification } : {}) });
  f.persistence.saveCheckpoint({ turnId, sessionId: conversationId, payload: { outcome, ...(verification ? { verification } : {}) } });
  return conversationId;
}
function auditCommand(f: any, conversationId: string, turnId: string, callId: string, command: string, exitCode: number | null, status = 'completed') {
  f.persistence.recordToolEvent(conversationId, turnId, 'tool_start', { data: { toolName: 'shell', callId, args: { command } } });
  return f.persistence.recordToolEvent(conversationId, turnId, 'tool_end', { data: { toolName: 'shell', callId,
    shell: { schemaVersion: 1, status, exitCode, stdout: '', stderr: exitCode ? 'observed failure' : '' } } }).eventId;
}
it('projects actual bounded checkpoint metadata and exact audit command evidence without scans, writes or recovery', async () => {
  const f = fixture();
  try {
    const conversationId = turn(f, 'delivery-turn', 'completed', 'verified');
    const service = new A9WorkspaceService(f.workspace);
    await service.read('note.txt'); await service.edit('note.txt', 'preserved', 'changed', { turnId: 'delivery-turn' });
    auditCommand(f, conversationId, 'delivery-turn', 'ordinary', 'echo not-a-test', 0);
    auditCommand(f, conversationId, 'delivery-turn', 'check', 'npm test', 0);
    const event = f.persistence.recordToolEvent(conversationId, 'delivery-turn', 'turn_completed', {
      data: { verificationEvidence: { command: 'npm test', exitCode: 0 } } });
    const before = state(f), bytes = fs.readFileSync(path.join(f.workspace, 'note.txt'));
    const result = await delivery(f, conversationId, 'delivery-turn');
    expect(result).toMatchObject({ ok: true, card: { turnId: 'delivery-turn', taskId: 'task-delivery-turn', outcome: 'completed', verification: 'verified',
      verificationEvidence: { command: 'npm test', exitCode: 0, eventId: event.eventId },
      changes: { evidence: 'checkpoint_metadata', total: 1, remaining: 0, files: [{ path: 'note.txt', action: 'modify', undone: false }] } } });
    expect(result.card.checks.map((check: any) => [check.command, check.exitCode])).toEqual([['echo not-a-test', 0], ['npm test', 0]]);
    expect(result.card.checks.every((check: any) => check.verification === undefined)).toBe(true);
    expect(fs.readFileSync(path.join(f.workspace, 'note.txt'))).toEqual(bytes); expect(state(f)).toEqual(before);
    // Explicit existing undo (separate execution action) still owns its guards.
    expect((await f.runtime.undoTurn('delivery-turn')).outcome.restored).toEqual(['note.txt (已恢复原始版本)']);
    expect((await delivery(f, conversationId, 'delivery-turn')).card.changes.files[0].undone).toBe(true);
  } finally { await f.close(); }
});
it.each(['completed_with_warnings', 'failed', 'blocked', 'cancelled', 'interrupted', 'needs_input', 'needs_approval'])('retains %s and missing observations as unknown', async outcome => {
  const f = fixture();
  try {
    const id = turn(f, 'missing-turn', outcome);
    const result = await delivery(f, id, 'missing-turn');
    expect(result).toMatchObject({ ok: true, card: { outcome, verification: 'UNKNOWN', verificationEvidence: null, checks: [], changes: { evidence: 'UNKNOWN', diagnostic: 'A9_CHECKPOINT_EVIDENCE_UNAVAILABLE' } } });
    expect(result.card.changes.total).toBeUndefined();
    auditCommand(f, id, 'missing-turn', 'cancelled-call', 'npm test', null, 'cancelled');
    expect((await delivery(f, id, 'missing-turn')).card.checks[0]).toMatchObject({ exitCode: null, status: 'cancelled' });
  } finally { await f.close(); }
});
it('bounds audit lists, shows failures and rejects hidden payload leakage or fabricated verification', async () => {
  const f = fixture();
  try {
    const id = turn(f, 'many-turn', 'completed', 'verified');
    for (let n = 0; n < 125; n++) auditCommand(f, id, 'many-turn', `call-${n}`, `echo ${n} password=COMMAND_SECRET`, n % 2);
    f.persistence.recordToolEvent(id, 'many-turn', 'tool_end', { data: { toolName: 'read', callId: 'broken', result: JSON.stringify({
      error: { message: 'broken password=ERROR_SECRET' }, credential: 'HIDDEN_SECRET' }) } });
    const result = await delivery(f, id, 'many-turn');
    expect(result.card).toMatchObject({ auditTruncated: true, verificationEvidence: null, verification: 'UNKNOWN', checksRemaining: 79 });
    expect(result.card.checks).toHaveLength(20); expect(result.card.issues.length).toBeLessThanOrEqual(20);
    for (const secret of ['COMMAND_SECRET', 'ERROR_SECRET', 'HIDDEN_SECRET']) expect(JSON.stringify(result)).not.toContain(secret);
  } finally { await f.close(); }
});
it('reconstructs archived read-only cards after runtime restart and keeps the current execution undo boundary', async () => {
  const f = fixture(); let reopened: any;
  try {
    const id = turn(f, 'restart-turn', 'interrupted');
    const service = new A9WorkspaceService(f.workspace);
    await service.read('note.txt'); await service.edit('note.txt', 'preserved', 'after', { turnId: 'restart-turn' });
    auditCommand(f, id, 'restart-turn', 'failed', 'npm test', 2, 'failed');
    f.runtime.archiveConversation(id);
    const prior = await delivery(f, id, 'restart-turn');
    expect(prior.card.issues.length).toBeGreaterThan(0);
    expect(() => f.runtime.getDiff('restart-turn')).toThrow('A9_CHECKPOINT_CONVERSATION_MISMATCH');
    await f.runtime.shutdown();
    reopened = createA9AgentRuntime({ workspaceRoot: f.workspace, dataRoot: path.join(f.root, 'data'), ownerId: 'reopen', openDatabase: (file: string, opts: any) => new Database(file, opts) });
    expect(reopened.getDelivery({ conversationId: id, turnId: 'restart-turn' })).toEqual(prior);
    const before = state(f);
    expect(await delivery(f, id, 'restart-turn')).toEqual(prior); expect(state(f)).toEqual(before);
  } finally { if (reopened) await reopened.shutdown(); await f.close(); }
});
it('fails closed on oversized or malformed checkpoint metadata and supports retry after repair', async () => {
  const f = fixture();
  try {
    const id = turn(f, 'bounded-turn');
    const dir = path.join(f.workspace, '.agent_recovery', 'checkpoints'); fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'bounded-turn.json');
    fs.writeFileSync(file, 'x'.repeat(2 * 1024 * 1024 + 1), 'utf8');
    expect((await delivery(f, id, 'bounded-turn')).card.changes.diagnostic).toBe('A9_CHECKPOINT_METADATA_LIMIT');
    fs.writeFileSync(file, '{}', 'utf8');
    expect((await delivery(f, id, 'bounded-turn')).card.changes.diagnostic).toBe('A9_CHECKPOINT_METADATA_INVALID');
    const service = new A9WorkspaceService(f.workspace); fs.unlinkSync(file);
    await service.read('note.txt'); await service.edit('note.txt', 'preserved', 'new', { turnId: 'bounded-turn' });
    expect((await delivery(f, id, 'bounded-turn')).card.changes.evidence).toBe('checkpoint_metadata');
  } finally { await f.close(); }
});

it('reads metadata through an ancestor alias while rejecting redirected checkpoint directories and files', async () => {
  const f = fixture();
  try {
    const id = turn(f, 'alias-turn');
    const service = new A9WorkspaceService(f.workspace);
    await service.read('note.txt');
    await service.edit('note.txt', 'preserved', 'alias change', { turnId: 'alias-turn' });
    const alias = path.join(f.root, 'workspace-alias');
    fs.symlinkSync(f.workspace, alias, 'junction');
    const prototype = Object.getPrototypeOf(service.getCheckpointManager());
    const recovery = jest.spyOn(prototype, 'getRecoveryRoot').mockReturnValue(path.join(alias, '.agent_recovery'));
    try {
      expect((await delivery(f, id, 'alias-turn')).card.changes).toMatchObject({ evidence: 'checkpoint_metadata', total: 1 });
    } finally { recovery.mockRestore(); }
    const parent = path.join(f.workspace, '.agent_recovery', 'checkpoints');
    const moved = path.join(f.root, 'redirected-checkpoints');
    fs.renameSync(parent, moved);
    fs.symlinkSync(moved, parent, 'junction');
    expect((await delivery(f, id, 'alias-turn')).card.changes.diagnostic).toBe('A9_CHECKPOINT_PATH_INVALID');
    fs.unlinkSync(parent);
    fs.renameSync(moved, parent);
    const target = path.join(parent, 'alias-turn.json');
    const movedFile = path.join(f.root, 'redirected.json');
    fs.renameSync(target, movedFile);
    fs.symlinkSync(movedFile, target);
    expect((await delivery(f, id, 'alias-turn')).card.changes.diagnostic).toBe('A9_CHECKPOINT_PATH_INVALID');
  } finally { await f.close(); }
});
