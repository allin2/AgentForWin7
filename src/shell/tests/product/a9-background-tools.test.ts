/// <reference path="./better-sqlite3.d.ts" />
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import { createRequire } from 'module';
import Database from 'better-sqlite3';
import * as Core from '../../../core/src';
import * as State from '../../../state/src/a9-persistence';
import { BackgroundProcessManager } from '../../../runner/src/background-process-manager';

function testPlatform(value: NodeJS.Platform) {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...original, value });
  return { restore: () => Object.defineProperty(process, 'platform', original) };
}

async function scenario(auditFailure = false, releaseFailure = false, options: {
  workspace?: string; canonicalize?: (workspace: string) => string; startingAuditFailure?: boolean | 'ignore-event' | 'ignore-fact';
  startFailure?: 'confirmed' | 'unknown'; terminalAuditFailure?: boolean; builtRunner?: boolean; commandCwd?: string; queuedPrompt?: string; recoveredQueueBlock?: boolean;
} = {}) {
  const workspace = options.workspace ?? '/memory/workspace';
  const disk = new Map<string, unknown>();
  const memoryFs = { mkdirSync() {}, existsSync: (p: string) => disk.has(p), writeFileSync: (p: string, v: unknown) => disk.set(p, v),
    readFileSync: (p: string) => disk.get(p), renameSync: (a: string, b: string) => { disk.set(b, disk.get(a)); disk.delete(a); } };
  const file = path.resolve(__dirname, '../../product/a9-agent-runtime.js'), req = createRequire(file);
  const box: any = { module: { exports: {} }, exports: {}, require: (n: string) => n === 'fs' ? memoryFs : req(n), __dirname: path.dirname(file),
    Buffer, URL, process, AbortController, setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, clearImmediate, console };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), box, { filename: file });
  const projected: string[] = []; let audited = 0;
  let db: any, manager!: BackgroundProcessManager, publish!: (c: any) => Promise<void>;
  let complete!: (c: any) => void; let requests = 0, seq = 0, bytes = 0, nativeStarts = 0;
  class Mode { static settingsFilePathFor() { return '/memory/mode'; } static legacyBasenameFilePathFor() { return '/memory/legacy'; }
    load() { return { status: 'configured', settings: { permissionMode: 'full_access' } }; } }
  class Workspace { getCheckpointManager() { return { loadCheckpoint() {}, revalidatePersistedTurns() {}, getRecoveryDiagnostics: () => [] }; }
    async freezeTurnBaseline() { return {}; } async collectExternalChanges() { return { changes: [], unrecoverable: [] }; } }
  const built = options.builtRunner ? req('../../runner/dist') : null;
  class Runner {
    execute: any;
    constructor(opts: any) {
      const transport = { invoke: jest.fn(), startManaged: (_request: any, _env: any, callback: any) => {
        nativeStarts++;
        const intent = db.prepare("SELECT payload_json FROM a9_events WHERE event_type='managed_process_ownership' ORDER BY id DESC LIMIT 1").get();
        expect(intent).toBeDefined();
        expect(JSON.parse(intent.payload_json)).toMatchObject({ handleId: options.builtRunner ? _request.requestId : 'h', ownershipState: 'owned' });
        expect(db.prepare('SELECT last_probe_status FROM a9_managed_processes WHERE handle_id=?').get(options.builtRunner ? _request.requestId : 'h')).toEqual({ last_probe_status: 'starting' });
        publish = callback; const completion = new Promise<any>((r) => { complete = r; });
        return { pid: 456, ready: options.startFailure ? Promise.reject(new Error('fixture readiness failure')) : Promise.resolve({ childPid: 345 } as any), completion, cancel: () => complete(options.startFailure === 'unknown'
          ? { kind: 'helper_crashed', detail: 'no terminal proof', cleanupConfirmed: false }
          : { kind: 'response', response: {
          schemaVersion: 3, type: 'execution_result', requestId: _request.requestId, profileId: 'a9-trusted-shell-current-user-v2',
          exitCode: 1, canceled: true, timedOut: false, idleTimedOut: false, containmentVerified: true,
          inputDetached: true, cleanupConfirmed: true, workDirAclModified: false,
          hostJob: { detected: false, breakaway: 'none', childJobAssignmentVerified: true },
          tokenAudit: { verified: true, tokenMode: 'current_user', restrictedToken: false, tokenType: 'primary', sameUser: true, lowIntegrity: false },
          lastOutputSeq: seq, stdout: { rawBytesRead: bytes, emittedBytes: bytes, omittedBytes: 0 }, stderr: { rawBytesRead: 0, emittedBytes: 0, omittedBytes: 0 },
        } }),
          release: async (releaseId: string) => {
            if (releaseFailure) { complete({ kind: 'helper_crashed', detail: 'lost receipt', cleanupConfirmed: false }); throw new Error('A9_RELEASE_UNKNOWN'); }
            const receipt: any = { type: 'execution_released', schemaVersion: 3, profileId: 'a9-trusted-shell-current-user-v2', releaseId, requestId: _request.requestId, childPid: 345, lastOutputSeq: seq,
              stdout: { rawBytesRead: bytes, emittedBytes: bytes, omittedBytes: 0 }, stderr: { rawBytesRead: 0, emittedBytes: 0, omittedBytes: 0 }, jobKillOnCloseDisabled: true, ownershipReleased: true };
            complete({ kind: 'response', response: receipt }); return receipt;
          } };
      } };
      if (built) {
        const actual = new built.TrustedShellRunner({ ...opts, platform: 'win32', helperProtocolVersion: 3, helperTransport: transport,
          resolveShellIdentity: () => ({ canonicalPath: 'C:\\Windows\\System32\\cmd.exe', sha256: 'e'.repeat(64), fileId: '1:5' }) });
        manager = actual.getBackgroundManager(); this.execute = actual.execute.bind(actual);
      } else manager = new BackgroundProcessManager(transport, (s) => { const safe = opts.redactText(s); projected.push(safe); return safe; }, opts.getSensitiveValues, opts.onBackgroundStateChange);
    }
    getBackgroundManager() { return manager; }
  }
  class Provider { async probeCapability() { return { ok: true, hasToolCalling: true, hasStreaming: true }; } async sendStreamRequest() { return ++requests === 1
    ? { id: 'tools', content: '', finishReason: 'tool_calls', toolCalls: [{ id: 'start-call', name: 'start_process', arguments: JSON.stringify({ command: 'echo tick', ...(options.commandCwd ? { cwd: options.commandCwd } : {}) }) }] }
    : { id: 'done', content: 'done', finishReason: 'stop' }; } }
  const runtime = box.module.exports.createA9AgentRuntime({ workspaceRoot: workspace, dataRoot: '/memory/data', ownerId: 'managed-test',
    modules: { core: { ...Core, canonicalizeWorkspacePath: options.canonicalize ?? ((p: string) => p), WorkspaceModeSettingsStore: Mode }, state: State,
      workspace: { A9WorkspaceService: Workspace }, gateway: { OpenAICompatibleProvider: Provider }, gitAdapter: {},
      runner: { TrustedShellRunner: Runner, selectShell: () => ({ available: true, kind: 'cmd' }), validateTrustedShellEnvironmentOverlay: (x: any) => x,
        createTrustedShellLoopAdapter: (runner: any) => built ? built.createTrustedShellLoopAdapter(runner) : ({ execute: async (_command: string, opts: any) => {
          try { await manager.start('h', 'echo tick', 'cmd.exe', [], workspace, undefined,
            { schemaVersion: 3, requestId: 'req', profileId: 'a9-trusted-shell-current-user-v2', outputEncoding: { stdout: 'utf-8', stderr: 'utf-8' }, managed: true } as any, { owner: opts.managedOwner, onOutput: async (c) => { audited++; await opts.onOutput(c); } });
          } catch (error: any) {
            if (!options.startFailure) throw error;
            return { status: 'failed', exitCode: null, stdout: '', stderr: error.message, durationMs: 1,
              residueRisk: error.cleanupRequired, spawnFacts: { helperSpawned: true, backgroundProcess: 'unknown', cleanupConfirmed: error.cleanupConfirmed, cleanupRequired: error.cleanupRequired } };
          }
          return { status: 'background_started', backgroundHandle: 'h', exitCode: null, stdout: '', stderr: '', durationMs: 1, timedOut: false };
        } }) } }, openDatabase: () => { db = new Database(':memory:'); return db; } });
  await runtime.configureProvider({ baseUrl: 'http://example.invalid', model: 'fixture', skipProbe: true });
  if (options.startingAuditFailure === true) db.exec("CREATE TRIGGER fail_intent BEFORE INSERT ON a9_events WHEN NEW.event_type='managed_process_ownership' BEGIN SELECT RAISE(FAIL,'intent disk failed'); END");
  // RAISE(IGNORE) reports success with zero rows; State must still refuse the write (ADR-0344).
  if (options.startingAuditFailure === 'ignore-event') db.exec("CREATE TRIGGER fail_intent BEFORE INSERT ON a9_events WHEN NEW.event_type='managed_process_ownership' BEGIN SELECT RAISE(IGNORE); END");
  if (options.startingAuditFailure === 'ignore-fact') db.exec("CREATE TRIGGER fail_intent BEFORE INSERT ON a9_managed_processes WHEN NEW.last_probe_status='starting' BEGIN SELECT RAISE(IGNORE); END");
  if (options.terminalAuditFailure) db.exec("CREATE TRIGGER fail_terminal BEFORE INSERT ON a9_managed_processes WHEN NEW.last_probe_status='failed' BEGIN SELECT RAISE(FAIL,'terminal disk failed'); END");
  if (options.queuedPrompt) await runtime.probeProvider();
  if (options.recoveredQueueBlock) manager.adoptRecoveredFact('recovered', { pid: process.pid, command: 'recovered fact', cwd: workspace,
    startTime: new Date().toISOString(), cleanupRequired: false });
  const pending = runtime.submitTurn('start background');
  if (options.queuedPrompt) expect(runtime.updateQueue({ conversationId: runtime.getSnapshot().activeConversationId,
    operation: 'add', text: options.queuedPrompt }).ok).toBe(true);
  const result = await pending;
  if (!options.startingAuditFailure && !options.startFailure && !result.ok) { db.close(); expect(result.ok).toBe(true); }
  if (auditFailure) db.exec("CREATE TRIGGER fail_output BEFORE INSERT ON a9_events WHEN NEW.event_type='tool_output' BEGIN SELECT RAISE(FAIL,'disk failed'); END");
  async function output(text: string) { const b = Buffer.from(text); bytes += b.length; await publish({ type: 'output_chunk', requestId: 'req', stream: 'stdout', seq: ++seq, streamOffset: bytes - b.length, byteLength: b.length, dataBase64: b.toString('base64') }); }
  return { runtime, db, manager, output, result, trace: () => ({ audited, projected, nativeStarts, requests }), close: () => db.close(),
    ipc: req('./a9-product-ipc').createA9ProductRequestHandler({ getA9Runtime: () => runtime, isValidRendererSender: () => true }) };
}

it.each(['stop', 'release'])('uses canonical Windows ownership before native start and keeps display-path facts through %s', async (choice) => {
  const platform = testPlatform('win32');
  const workspace = 'C:\\Users\\A9 Builder\\中文 空格%#\\Project';
  let f: Awaited<ReturnType<typeof scenario>> | undefined;
  try {
    f = await scenario(false, false, { workspace, canonicalize: Core.canonicalizeWorkspacePath });
    expect(f.result.ok).toBe(true);
    const owner = f.manager.list()[0].owner!;
    expect(owner.workspace).toBe(Core.canonicalizeWorkspacePath(workspace, 'win32'));
    expect(f.trace().nativeStarts).toBe(1);
    expect(f.db.prepare('SELECT workspace_path FROM a9_sessions').get()).toEqual({ workspace_path: owner.workspace });
    expect(f.db.prepare('SELECT workspace_path FROM a9_managed_processes').get()).toEqual({ workspace_path: workspace });
    await f.output('中文 tick after completed turn\n');
    expect(f.db.prepare("SELECT turn_id FROM a9_events WHERE event_type='tool_output'").get()).toEqual({ turn_id: owner.turnId });
    expect(f.runtime.getSnapshot().managedProcesses).toEqual([expect.objectContaining({ handleId: 'h' })]);
    expect(() => f!.manager.readOutput('h', { ...owner, workspace: owner.workspace + '-other' })).toThrow('WRONG_OWNER');
    const page = await f.ipc({}, { schemaVersion: 7, action: 'a9.events.query', payload: { conversationId: owner.conversationId, limit: 100 } });
    expect(page.events.some((e: any) => e.eventType === 'tool_output')).toBe(true);
    const result = await f.runtime.shutdown({ stopManaged: choice === 'stop' });
    expect(result.unresolved).toEqual([]);
    expect(result.leftToSystem).toEqual(choice === 'release' ? ['h'] : []);
    expect(f.db.prepare('SELECT last_probe_status FROM a9_managed_processes').get().last_probe_status).toBe(choice === 'release' ? 'released' : 'stopped');
  } finally { f?.close(); platform.restore(); }
});

it('does not launch or publish a Windows managed process when its starting audit transaction fails', async () => {
  const platform = testPlatform('win32');
  let f: Awaited<ReturnType<typeof scenario>> | undefined;
  try {
    f = await scenario(false, false, { workspace: 'C:\\Users\\A9 Builder\\Project', canonicalize: Core.canonicalizeWorkspacePath, startingAuditFailure: true });
    expect(f.result).toMatchObject({ ok: false, error: { code: 'A9_AUDIT_PERSISTENCE_FAILED', failedEvent: 'tool_end' } });
    expect(f.trace().nativeStarts).toBe(0);
    expect(f.manager.list()).toEqual([]);
    expect(f.db.prepare('SELECT count(*) AS n FROM a9_managed_processes').get()).toEqual({ n: 0 });
    expect(f.db.prepare("SELECT count(*) AS n FROM a9_events WHERE event_type IN ('managed_process_ownership','tool_output')").get()).toEqual({ n: 0 });
    const requests = f.trace().requests;
    expect((await f.runtime.submitTurn('retry')).error.code).toBe('A9_AUDIT_PERSISTENCE_FAILED');
    expect(f.trace().requests).toBe(requests);
  } finally { f?.close(); platform.restore(); }
});
it('keeps late background output bound to original completed turn and exposes SQLite identity through IPC', async () => {
  const f = await scenario(); try {
    const owner = f.manager.list()[0].owner!;
    await f.output('tick after turn\n');
    const events = f.db.prepare("SELECT session_id,turn_id,payload_json FROM a9_events WHERE event_type='tool_output'").all();
    expect(events).toHaveLength(1); expect(events[0]).toMatchObject({ session_id: owner.conversationId, turn_id: owner.turnId });
    expect(JSON.parse(events[0].payload_json).data).toMatchObject({ toolName: 'start_process', taskId: owner.taskId, toolCallId: owner.toolCallId, outputSeq: 1 });
    const page = await f.ipc({}, { schemaVersion: 7, action: 'a9.events.query', payload: { conversationId: owner.conversationId, limit: 100 } });
    expect(page.events.some((e: any) => e.eventType === 'tool_output')).toBe(true);
    expect(f.runtime.getSnapshot().timeline.some((e: any) => e.type === 'tool_output')).toBe(true);
    const released = await f.runtime.shutdown({ stopManaged: false }); expect(released).toMatchObject({ leftToSystem: ['h'], unresolved: [] });
    expect(f.db.prepare('SELECT last_probe_status FROM a9_managed_processes WHERE handle_id=?').get('h').last_probe_status).toBe('released');
    expect(JSON.parse(f.db.prepare("SELECT payload_json FROM a9_events WHERE event_type='managed_process_ownership' ORDER BY id DESC LIMIT 1").get().payload_json).ownershipState).toBe('released');
  } finally { f.close(); }
});
it.each(['tick\n', 'visible tick\n', '中文 late output\r\n'])('late mandatory output audit failure blocks future turns without publishing output (%#)', async (text) => {
  const f = await scenario(true); try {
    const check = f.db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name='fail_output'").get(); expect(check).toBeDefined();
    let caught: any; try { await f.output(text); } catch (error) { caught = error; }
    expect({ caught: caught?.message, trace: f.trace() }).toMatchObject({ caught: expect.stringContaining('disk failed') });
    expect(f.manager.readOutput('h', f.manager.list()[0].owner!).entries).toEqual([]);
    const result = await f.runtime.submitTurn('retry'); expect(result.ok).toBe(false); expect(result.error.code).toBe('A9_AUDIT_PERSISTENCE_FAILED');
    expect(f.db.prepare("SELECT count(*) n FROM a9_events WHERE event_type='tool_output'").get().n).toBe(0);
  } finally { f.close(); }
});
it('identifies the historical cross-realm SqliteError matcher failure without weakening audit assertions', async () => {
  const f = await scenario(true);
  const req = createRequire(path.resolve(__dirname, '../../product/a9-agent-runtime.js'));
  const addon = req(path.resolve(path.dirname(req.resolve('better-sqlite3')), '../build/Release/better_sqlite3.node'));
  let originalConstructor: any;
  try { f.db.exec('SELECT * FROM audit_matcher_missing_table'); }
  catch (error) { originalConstructor = Object.getPrototypeOf(error).constructor; }
  const foreign: any = { module: { exports: {} } };
  vm.runInNewContext(fs.readFileSync(path.resolve(path.dirname(req.resolve('better-sqlite3')), 'sqlite-error.js'), 'utf8'), foreign);
  // The native addon retains its first initialized constructor across Jest VMs.
  // Reproduce that prior-suite realm explicitly, then restore its constructor.
  addon.setErrorConstructor(foreign.module.exports);
  try {
    let caught: any; try { await f.output('tick\n'); } catch (error) { caught = error; }
    expect(caught?.message).toContain('disk failed');
    expect(caught?.name).toBe('SqliteError');
    expect(Object.prototype.toString.call(caught)).toBe('[object Object]');
    expect(caught instanceof Error).toBe(false);
    // A prior realm's SQLite Error prototype differs from this Jest VM's,
    // so rejects.toThrow misclassifies an actual rejected audit write.
    let matcherFailure: any;
    try { await expect(Promise.reject(caught)).rejects.toThrow('disk failed'); }
    catch (error) { matcherFailure = error; }
    expect(matcherFailure?.message).toContain('Received function did not throw');
    await expect(Promise.reject(new Error(caught.message))).rejects.toThrow('disk failed');
    expect(f.trace().audited).toBe(1);
    expect(f.manager.readOutput('h', f.manager.list()[0].owner!).entries).toEqual([]);
    expect(f.db.prepare("SELECT count(*) n FROM a9_events WHERE event_type='tool_output'").get().n).toBe(0);
    expect((await f.runtime.submitTurn('retry')).error.code).toBe('A9_AUDIT_PERSISTENCE_FAILED');
  } finally { addon.setErrorConstructor(originalConstructor); f.close(); }
});
it('lost release acknowledgement retains workspace lock and visible unknown ownership', async () => {
  const f = await scenario(false, true); try {
    const result = await f.runtime.shutdown({ stopManaged: false }); expect(result.leftToSystem).toEqual([]); expect(result.unresolved).toHaveLength(1);
    expect(f.manager.getActiveCount()).toBe(1); expect(f.manager.list()[0].ownershipState).toBe('release_unknown');
    const ownership = JSON.parse(f.db.prepare("SELECT payload_json FROM a9_events WHERE event_type='managed_process_ownership' ORDER BY id DESC LIMIT 1").get().payload_json);
    expect(ownership.ownershipState).toBe('release_unknown');
  } finally { f.close(); }
});

it('main offers stop/release/cancel before shutdown and blocks unknown release', async () => {
  const main = fs.readFileSync(path.resolve(__dirname, '../../product/main.js'), 'utf8');
  const start = main.indexOf('async function selectA9ShutdownPolicy()'), end = main.indexOf('function beginA9ShutdownBeforeQuit(', start);
  let response = 1; const runtime = { getSnapshot: () => ({ managedProcesses: [{ handleId: 'h', lastProbeStatus: 'running' }] }), shutdown: jest.fn(async () => ({ unresolved: [] as string[], leftToSystem: ['h'] })) };
  const dialog = { showMessageBox: jest.fn(async () => { expect(runtime.shutdown).not.toHaveBeenCalled(); return { response }; }) };
  const choose = vm.runInNewContext(main.slice(start, end) + '; executeA9ShutdownChoice', { a9ShutdownAttempt: null, a9ShutdownComplete: false, setTimeout, clearTimeout, a9Workspaces: { directory: () => [{ opened: true, workspaceId: 'A', workspaceRoot: '/A' }], getById: () => ({ runtime }), shutdown: runtime.shutdown }, dialog });
  expect(await choose()).toBe(true); expect(runtime.shutdown).toHaveBeenCalledWith({ stopManaged: false });
  runtime.shutdown.mockClear(); response = 2; expect(await choose()).toBe(false); expect(runtime.shutdown).not.toHaveBeenCalled();
  runtime.shutdown.mockClear(); response = 0; runtime.shutdown.mockResolvedValueOnce({ unresolved: [] as string[], leftToSystem: [] }); expect(await choose()).toBe(true); expect(runtime.shutdown).toHaveBeenCalledWith();
  runtime.shutdown.mockClear(); response = 1; runtime.shutdown.mockResolvedValueOnce({ unresolved: ['release_unknown'], leftToSystem: [] }); await expect(choose()).rejects.toThrow('RESIDUE');
});
it('renderer keeps late output on the original settled tool card and ignores duplicate sequence', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../../product/renderer/a9-workbench.js'), 'utf8');
  const start = source.indexOf('  function appendEventNode('), end = source.indexOf('\n  function ', start + 10);
  const calls: any[] = []; const original: any = { li: { appendChild() {} }, tag: {}, outputEl: null };
  const block: any = { pendingItems: new Map([['call', original]]), outputItems: new Map([['call', original]]) };
  const append = vm.runInNewContext(source.slice(start, end) + '; appendEventNode', { document: { createElement: () => ({ setAttribute() {}, textContent: '' }) },
    state: {}, TOOL_OUTPUT_LIMIT: 32000, ensureActivityGroup() {}, settleItem() {}, toolEndStatus: () => ['completed', '完成'], attachActivityDetail() {},
    addActivityItem: (...args: any[]) => { calls.push(args); return original; } });
  append(block, { type: 'tool_end', data: { toolName: 'start_process', callId: 'call' } }); expect(block.pendingItems.has('call')).toBe(false);
  const event = { type: 'tool_output', turnId: 'turn', data: { schemaVersion: 1, toolName: 'start_process', toolCallId: 'call', outputSeq: 1, stream: 'stdout', text: 'late tick\n', truncated: false } };
  append(block, event); append(block, event); expect(calls).toHaveLength(0); expect(original.streamOutput.stdout).toBe('late tick\n');
});

it('A9-35 records a normal readiness failure once after proven cleanup without poisoning audit', async () => {
  const f = await scenario(false, false, { startFailure: 'confirmed' });
  try {
    expect(f.result.ok).toBe(true);
    expect(f.manager.list()[0]).toMatchObject({ status: 'failed', cleanupRequired: false });
    expect(f.manager.getActiveCount()).toBe(0);
    const ends = f.db.prepare("SELECT payload_json FROM a9_events WHERE event_type='tool_end'").all();
    expect(ends).toHaveLength(1);
    expect(JSON.parse(ends[0].payload_json).data.toolName).toBe('start_process');
    expect(JSON.parse(JSON.parse(ends[0].payload_json).data.result).status).toBe('failed');
    expect(f.db.prepare('SELECT status FROM a9_turns').get().status).not.toBe('active');
    expect((await f.runtime.submitTurn('next normal turn')).ok).toBe(true);
  } finally { f.close(); }
});
it.each([false, true])('A9-35 still blocks unknown cleanup or real terminal audit failure (%s)', async (terminalAuditFailure) => {
  const f = await scenario(false, false, { startFailure: terminalAuditFailure ? 'confirmed' : 'unknown', terminalAuditFailure });
  try {
    expect(f.result.ok).toBe(false);
    const requests = f.trace().requests;
    expect((await f.runtime.submitTurn('blocked retry')).ok).toBe(false);
    expect(f.trace().requests).toBe(requests);
    if (!terminalAuditFailure) expect(f.manager.list()[0].cleanupRequired).toBe(true);
  } finally { f.close(); }
});

const consumerWorkspaces: string[] = [];
afterEach(() => {
  for (const workspace of consumerWorkspaces.splice(0)) fs.rmSync(workspace, { recursive: true, force: true });
});

// Load the same current compiled runner and adapter that the product loads.
it.each(['preflight', 'confirmed', 'unknown'] as const)('A9-35 current-dist consumer preserves %s failure semantics', async (kind) => {
  const os = require('os');
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'a9-built-consumer-'));
  consumerWorkspaces.push(workspace);
  const f = await scenario(false, false, { workspace, builtRunner: true,
    ...(kind === 'preflight' ? { commandCwd: path.join(workspace, 'missing') } : { startFailure: kind }) });
  try {
    expect(f.result.ok).toBe(kind !== 'unknown');
    expect(f.trace().nativeStarts).toBe(kind === 'preflight' ? 0 : 1);
    const ends = f.db.prepare("SELECT payload_json FROM a9_events WHERE event_type='tool_end'").all();
    if (kind !== 'unknown') {
      expect(ends).toHaveLength(1);
      expect(JSON.parse(JSON.parse(ends[0].payload_json).data.result).status).toBe('failed');
      expect(f.manager.getActiveCount()).toBe(0);
      expect(f.db.prepare('SELECT status FROM a9_turns').get().status).not.toBe('active');
    } else {
      expect(f.manager.list()[0].cleanupRequired).toBe(true);
      const before = f.trace().requests;
      expect((await f.runtime.submitTurn('blocked')).ok).toBe(false);
      expect(f.trace().requests).toBe(before);
    }
  } finally { f.close(); }
});

it('A9-50 sends a queued follow-up while a healthy owned background process stays active', async () => {
  const f = await scenario(false, false, { queuedPrompt: 'next task' });
  try {
    expect(f.result.ok).toBe(true);
    expect(f.manager.getActiveCount()).toBe(1);
    const deadline = Date.now() + 1000;
    while (f.trace().requests < 3 && Date.now() < deadline) await new Promise(resolve => setImmediate(resolve));
    expect(f.trace().requests).toBe(3);
    expect(f.runtime.getSnapshot().queue.items).toHaveLength(0);
    expect(f.manager.getActiveCount()).toBe(1);
    expect(f.runtime.getSnapshot().conversationControls.canSwitch).toBe(false);
  } finally { await f.runtime.shutdown(); f.close(); }
});

it('A9-50 refuses automatic queue dispatch beside a recovered live PID even without cleanupRequired', async () => {
  const f = await scenario(false, false, { queuedPrompt: 'must wait for lifecycle resolution', recoveredQueueBlock: true });
  try {
    const recovered = f.manager.list().find(handle => handle.handleId === 'recovered')!;
    expect(recovered.pidReusePossible).toBe(true);
    expect(recovered.recoveryStatus).toBe('running_unknown');
    expect(recovered.cleanupRequired).not.toBe(true);
    await new Promise(resolve => setImmediate(resolve));
    expect(f.trace().requests).toBe(2);
    expect(f.runtime.getSnapshot().queue.items).toHaveLength(1);
  } finally {
    // A recovered PID fact is never signalled. The actual managed helper from
    // this test is stopped; memory-only recovered facts are left to the OS.
    await f.manager.stop('h'); await f.runtime.shutdown({ stopManaged: false }); f.close();
  }
});

it.each([
  ['stop', 'late cleanup fact', 'stop'],
  ['release', 'late cleanup fact', 'release'],
  ['stop', 'late unowned running fact', 'stop'],
  ['release', 'late unowned running fact', 'release'],
  ['release', 'released fact changed to cleanup_required', 'stop'],
  ['release', 'released fact changed to cleanup_required', 'release'],
] as const)('final lock release re-reads SQLite after real dispose (%s, %s, retry %s)', async (choice, mutation, retryChoice) => {
  const f = await scenario(); try {
    const dispose = f.manager.dispose.bind(f.manager);
    jest.spyOn(f.manager, 'dispose').mockImplementationOnce(async (options) => {
      const result = await dispose(options);
      if (mutation !== 'released fact changed to cleanup_required') {
        // Committed after the in-memory checks, with no in-memory handle at all.
        f.db.prepare(`INSERT INTO a9_managed_processes (handle_id, workspace_path, pid, command, cwd, started_at, last_probe_status, pid_reuse_possible)
          VALUES ('late', '/memory/workspace', 7, 'late', '/memory/workspace', '2026-11-19', ?, 0)`)
          .run(mutation === 'late cleanup fact' ? 'cleanup_required' : 'running');
      } else f.db.prepare("UPDATE a9_managed_processes SET last_probe_status = 'cleanup_required' WHERE handle_id = 'h'").run();
      return result;
    });
    const blocked = await f.runtime.shutdown({ stopManaged: choice === 'stop' });
    expect(f.manager.dispose).toHaveBeenCalledTimes(1);
    expect(blocked.unresolved).toEqual([expect.stringContaining(mutation.startsWith('late') ? 'late' : 'h')]);
    expect(f.db.prepare('SELECT owner_id FROM a9_workspace_locks').get()).toEqual({ owner_id: 'managed-test' });
    expect(f.runtime.getSnapshot().lock.held).toBe(true);
    // The refusal stays retryable for both exit choices while the fact is unresolved.
    for (const stopManaged of [true, false]) expect((await f.runtime.shutdown({ stopManaged })).unresolved).toHaveLength(1);
    expect(f.db.prepare('SELECT owner_id FROM a9_workspace_locks').get()).toEqual({ owner_id: 'managed-test' });
    // Once SQLite again proves a settled fact (the late fact is gone, or the exact
    // released identity and its release chain verify), the next retry releases the lock.
    if (mutation.startsWith('late')) f.db.prepare("DELETE FROM a9_managed_processes WHERE handle_id = 'late'").run();
    else {
      // A corrected status with another persisted identity does not clear the isolation.
      const { pid } = f.db.prepare("SELECT pid FROM a9_managed_processes WHERE handle_id = 'h'").get();
      f.db.prepare("UPDATE a9_managed_processes SET last_probe_status = 'released', pid = 999 WHERE handle_id = 'h'").run();
      expect((await f.runtime.shutdown({ stopManaged: retryChoice === 'stop' })).unresolved).toHaveLength(1);
      expect(f.db.prepare('SELECT count(*) AS n FROM a9_workspace_locks').get()).toEqual({ n: 1 });
      f.db.prepare("UPDATE a9_managed_processes SET pid = ? WHERE handle_id = 'h'").run(pid);
    }
    const retried = await f.runtime.shutdown({ stopManaged: retryChoice === 'stop' });
    expect(retried.unresolved).toEqual([]);
    expect(f.db.prepare('SELECT count(*) AS n FROM a9_workspace_locks').get()).toEqual({ n: 0 });
    if (!mutation.startsWith('late')) {
      expect(f.runtime.getSnapshot().persistenceDiagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'A9_MANAGED_OWNERSHIP_CORRUPT' }), expect.objectContaining({ code: 'A9_MANAGED_QUARANTINE_CLEARED' })]));
    }
  } finally { f.close(); }
});

it.each(['ignore-event', 'ignore-fact'] as const)('an ignored mandatory starting audit (%s) dispatches nothing and commits nothing', async (mode) => {
  const f = await scenario(false, false, { startingAuditFailure: mode });
  try {
    expect(f.result).toMatchObject({ ok: false, error: { code: 'A9_AUDIT_PERSISTENCE_FAILED' } });
    expect(f.trace().nativeStarts).toBe(0);
    expect(f.manager.list()).toEqual([]);
    expect(f.db.prepare('SELECT count(*) AS n FROM a9_managed_processes').get()).toEqual({ n: 0 });
    expect(f.db.prepare("SELECT count(*) AS n FROM a9_events WHERE event_type IN ('managed_process_ownership','tool_output')").get()).toEqual({ n: 0 });
    const requests = f.trace().requests;
    expect((await f.runtime.submitTurn('retry')).error.code).toBe('A9_AUDIT_PERSISTENCE_FAILED');
    expect(f.trace().requests).toBe(requests);
    expect(f.trace().nativeStarts).toBe(0);
  } finally { await f.runtime.shutdown({ stopManaged: true }); f.close(); }
});

async function waitForPidGone(pid: number) {
  for (let i = 0; i < 250; i++) {
    try { process.kill(pid, 0); } catch (error: any) { if (error?.code === 'ESRCH') break; }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  // Let the child's close callback (stdio drained after exit) run before asserting.
  await new Promise(resolve => setTimeout(resolve, 150));
}

it.each(['same identity', 'identity replaced while waiting'] as const)(
  'a handed-over legacy child exiting naturally after an ignored lock DELETE never rewrites persistent facts (%s)', async (variant) => {
    const f = await scenario();
    // TEST_ONLY controlled legacy direct-spawn handle: a real short child that exits on its own.
    const child = await f.manager.start('legacy', 'legacy child', process.execPath, ['-e', 'setTimeout(() => {}, 400)'], process.cwd());
    const row = () => f.db.prepare("SELECT pid, started_at, last_probe_status FROM a9_managed_processes WHERE handle_id = 'legacy'").get();
    try {
      await new Promise(resolve => setTimeout(resolve, 50));
      const original = row();
      expect(original).toEqual({ pid: child.pid, started_at: child.startTime, last_probe_status: 'running' });
      f.db.exec('CREATE TRIGGER keep_lock BEFORE DELETE ON a9_workspace_locks BEGIN SELECT RAISE(IGNORE); END');
      const blocked = await f.runtime.shutdown({ stopManaged: false });
      expect(blocked.leftToSystem).toEqual(expect.arrayContaining(['legacy']));
      expect(blocked.unresolved).toEqual(['workspace lock release could not be confirmed']);
      const replaced = { pid: child.pid! + 100000, started_at: '2026-11-20T00:00:00.000Z', last_probe_status: 'running' };
      if (variant === 'identity replaced while waiting') {
        f.db.prepare("UPDATE a9_managed_processes SET pid = ?, started_at = ? WHERE handle_id = 'legacy'").run(replaced.pid, replaced.started_at);
      }
      await waitForPidGone(child.pid!);
      // The old Runner callback wrote neither an uncredentialed 'released' nor the old identity.
      expect(row()).toEqual(variant === 'same identity' ? original : replaced);
      f.db.exec('DROP TRIGGER keep_lock');
      const retried = await f.runtime.shutdown({ stopManaged: false });
      if (variant === 'same identity') {
        expect(retried).toEqual({ stopped: [], leftToSystem: [], unresolved: [] });
        expect(f.db.prepare('SELECT count(*) AS n FROM a9_workspace_locks').get()).toEqual({ n: 0 });
      } else {
        expect(retried.unresolved).toEqual([expect.stringContaining('legacy')]);
        expect(f.db.prepare('SELECT count(*) AS n FROM a9_workspace_locks').get()).toEqual({ n: 1 });
      }
      expect(row()).toEqual(variant === 'same identity' ? original : replaced);
    } finally {
      try { process.kill(child.pid!, 'SIGKILL'); } catch (_error) { /* already gone */ }
      await waitForPidGone(child.pid!); f.close();
    }
  });

it('a legacy handover credential survives an ignored lock DELETE and is re-verified on retry', async () => {
  const f = await scenario();
  // TEST_ONLY controlled legacy direct-spawn handle: a real short child that this test always reaps.
  const child = await f.manager.start('legacy', 'legacy child', process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], process.cwd());
  const reap = async () => {
    try { process.kill(child.pid!, 'SIGKILL'); } catch (_error) { /* already gone */ }
    // After a confirmed handover the Runner writes nothing; only wait for the child to go.
    await waitForPidGone(child.pid!);
  };
  try {
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(f.db.prepare("SELECT last_probe_status FROM a9_managed_processes WHERE handle_id = 'legacy'").get()).toEqual({ last_probe_status: 'running' });
    f.db.exec('CREATE TRIGGER keep_lock BEFORE DELETE ON a9_workspace_locks BEGIN SELECT RAISE(IGNORE); END');
    const blocked = await f.runtime.shutdown({ stopManaged: false });
    expect(blocked.leftToSystem).toEqual(expect.arrayContaining(['h', 'legacy']));
    expect(blocked.unresolved).toEqual(['workspace lock release could not be confirmed']);
    expect(f.db.prepare('SELECT owner_id FROM a9_workspace_locks').get()).toEqual({ owner_id: 'managed-test' });
    // The Runner already forgot the handle; the exact identity is still exempt on retry.
    expect(f.manager.list().map(handle => handle.handleId)).not.toContain('legacy');
    f.db.exec('DROP TRIGGER keep_lock');
    // A changed identity under the same handle is never exempt.
    const { pid } = f.db.prepare("SELECT pid FROM a9_managed_processes WHERE handle_id = 'legacy'").get();
    f.db.prepare("UPDATE a9_managed_processes SET pid = ? WHERE handle_id = 'legacy'").run(pid + 1);
    expect((await f.runtime.shutdown({ stopManaged: false })).unresolved).toEqual([expect.stringContaining('legacy')]);
    expect(f.db.prepare('SELECT count(*) AS n FROM a9_workspace_locks').get()).toEqual({ n: 1 });
    f.db.prepare("UPDATE a9_managed_processes SET pid = ? WHERE handle_id = 'legacy'").run(pid);
    expect(await f.runtime.shutdown({ stopManaged: false })).toEqual({ stopped: [], leftToSystem: [], unresolved: [] });
    expect(f.db.prepare('SELECT count(*) AS n FROM a9_workspace_locks').get()).toEqual({ n: 0 });
    expect(f.db.prepare("SELECT last_probe_status FROM a9_managed_processes WHERE handle_id = 'legacy'").get()).toEqual({ last_probe_status: 'running' });
  } finally { await reap(); f.close(); }
});
