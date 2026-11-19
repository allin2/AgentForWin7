/**
 * F5 回归：task/turn/run 生命周期与真实子进程中断恢复。
 *
 * 复现缺陷：产品 submitTurn 未调用 upsertTask/upsertTurn/upsertRun，真实
 * 一轮后 tasks=0/turns=0/runs=0；旧 J5 用测试代码直接 INSERT crash-task。
 */
/// <reference path="./better-sqlite3.d.ts" />
import { execFileSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';

const { createA9AgentRuntime } = require('../../product/a9-agent-runtime') as any;

function sse(res: http.ServerResponse, obj: unknown): void {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

/** 延迟 fixture：read 工具回执后不结束响应（保持 Turn active），可解锁。 */
function startDelayedFixture(): Promise<{ baseUrl: string; close: () => Promise<void>; release: () => void }> {
  let released = false;
  const pending: import('http').ServerResponse[] = [];
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d: Buffer) => { body += d.toString('utf8'); });
      req.on('end', () => {
        const parsed = JSON.parse(body);
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        if (parsed?.tools?.[0]?.function?.name === 'probe_test_echo') {
          sse(res, { choices: [{ delta: { tool_calls: [{ index: 0, id: 'p1', function: { name: 'probe_test_echo', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] });
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }
        const toolMsgs = (parsed.messages ?? []).filter((m: any) => m.role === 'tool' && m.name !== 'probe_test_echo');
        if (toolMsgs.length === 0) {
          sse(res, { choices: [{ delta: { tool_calls: [{ index: 0, id: 'r1', function: { name: 'read', arguments: '{"path":"note.txt"}' } }] }, finish_reason: 'tool_calls' }] });
          res.write('data: [DONE]\n\n');
          res.end();
        } else if (released) {
          sse(res, { choices: [{ delta: { content: 'late final' }, finish_reason: 'stop' }] });
          res.write('data: [DONE]\n\n');
          res.end();
        } else {
          pending.push(res); // 不结束：模型“停住”
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({
        baseUrl: `http://127.0.0.1:${(server.address() as any).port}`,
        close: () => new Promise<void>((done) => server.close(() => done())),
        release: () => {
          released = true;
          for (const res of pending.splice(0)) {
            sse(res, { choices: [{ delta: { content: 'late final' }, finish_reason: 'stop' }] });
            res.write('data: [DONE]\n\n');
            res.end();
          }
        },
      });
    });
  });
}

/** 常规行为 fixture：read→final。 */
function startQuickFixture(firstTool: { name: string; arguments: string } = {
  name: 'read', arguments: '{"path":"note.txt"}',
}): Promise<{ baseUrl: string; close: () => Promise<void>; requests: any[] }> {
  const requests: any[] = [];
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d: Buffer) => { body += d.toString('utf8'); });
      req.on('end', () => {
        const parsed = JSON.parse(body);
        requests.push(parsed);
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        if (parsed?.tools?.[0]?.function?.name === 'probe_test_echo') {
          sse(res, { choices: [{ delta: { tool_calls: [{ index: 0, id: 'p1', function: { name: 'probe_test_echo', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] });
        } else {
          const toolMsgs = (parsed.messages ?? []).filter((m: any) => m.role === 'tool' && m.name !== 'probe_test_echo');
          if (toolMsgs.length === 0) {
            sse(res, { choices: [{ delta: { tool_calls: [{ index: 0, id: 'r1', function: firstTool }] }, finish_reason: 'tool_calls' }] });
          } else {
            sse(res, { choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] });
          }
        }
        res.write('data: [DONE]\n\n');
        res.end();
      });
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ baseUrl: `http://127.0.0.1:${(server.address() as any).port}`, requests, close: () => new Promise<void>((done) => server.close(() => done())) });
    });
  });
}

/** A9SH-03 fixture：启动真实托管后台进程后结束 Turn。 */
function startBackgroundFixture(commandOverride?: string): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const command = commandOverride || `${JSON.stringify(process.execPath)} -e "setInterval(() => {}, 1000)"`;
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d: Buffer) => { body += d.toString('utf8'); });
      req.on('end', () => {
        const parsed = JSON.parse(body);
        const toolMsgs = (parsed.messages ?? []).filter((m: any) => m.role === 'tool' && m.name !== 'probe_test_echo');
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        if (toolMsgs.length === 0) {
          sse(res, { choices: [{ delta: { tool_calls: [{ index: 0, id: 'bg1', function: { name: 'start_process', arguments: JSON.stringify({ command }) } }] }, finish_reason: 'tool_calls' }] });
        } else {
          sse(res, { choices: [{ delta: { content: 'background started' }, finish_reason: 'stop' }] });
        }
        res.write('data: [DONE]\n\n');
        res.end();
      });
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ baseUrl: `http://127.0.0.1:${(server.address() as any).port}`, close: () => new Promise<void>((done) => server.close(() => done())) });
    });
  });
}

function startApprovalFixture(options: { secondApproval?: boolean; failAfterFirstTool?: boolean } = {}): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d: Buffer) => { body += d.toString('utf8'); });
      req.on('end', () => {
        const parsed = JSON.parse(body);
        const toolMsgs = (parsed.messages ?? []).filter((m: any) => m.role === 'tool' && m.name !== 'probe_test_echo');
        if (options.failAfterFirstTool && toolMsgs.length > 0) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'forced resume provider failure' } }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        if (toolMsgs.length === 0) {
          sse(res, { choices: [{ delta: { tool_calls: [{ index: 0, id: 'd1', function: { name: 'delete', arguments: '{"path":"note.txt","permanent":true}' } }] }, finish_reason: 'tool_calls' }] });
        } else if (options.secondApproval && toolMsgs.length === 1) {
          sse(res, { choices: [{ delta: { tool_calls: [{ index: 0, id: 'd2', function: { name: 'delete', arguments: '{"path":"second.txt","permanent":true}' } }] }, finish_reason: 'tool_calls' }] });
        } else {
          sse(res, { choices: [{ delta: { content: 'handled' }, finish_reason: 'stop' }] });
        }
        res.write('data: [DONE]\n\n');
        res.end();
      });
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ baseUrl: `http://127.0.0.1:${(server.address() as any).port}`, close: () => new Promise<void>((done) => server.close(() => done())) });
    });
  });
}

/** 审批通过后的第二轮 Provider 请求保持挂起，用于观察恢复中的产品快照。 */
function startHeldApprovalFixture(): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
  release: () => void;
  resumed: Promise<void>;
}> {
  let releaseResponse: (() => void) | null = null;
  let markResumed: (() => void) | null = null;
  const resumed = new Promise<void>((resolve) => { markResumed = resolve; });
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d: Buffer) => { body += d.toString('utf8'); });
      req.on('end', () => {
        const parsed = JSON.parse(body);
        const toolMsgs = (parsed.messages ?? []).filter((m: any) => m.role === 'tool' && m.name !== 'probe_test_echo');
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        if (toolMsgs.length === 0) {
          sse(res, { choices: [{ delta: { tool_calls: [{ index: 0, id: 'd1', function: { name: 'delete', arguments: '{"path":"note.txt","permanent":true}' } }] }, finish_reason: 'tool_calls' }] });
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }
        if (markResumed) {
          markResumed();
          markResumed = null;
        }
        releaseResponse = () => {
          sse(res, { choices: [{ delta: { content: 'handled' }, finish_reason: 'stop' }] });
          res.write('data: [DONE]\n\n');
          res.end();
        };
      });
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({
        baseUrl: `http://127.0.0.1:${(server.address() as any).port}`,
        resumed,
        release: () => {
          const release = releaseResponse;
          releaseResponse = null;
          if (release) release();
        },
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

function startFailingFixture(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'forced provider failure' } }));
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ baseUrl: `http://127.0.0.1:${(server.address() as any).port}`, close: () => new Promise<void>((done) => server.close(() => done())) });
    });
  });
}

/** A9-38 TEST_ONLY: fake safeStorage for the DPAPI vault contract on non-Windows hosts. */
function fakeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plain: string) => Buffer.from(`enc:${Buffer.from(plain, 'utf8').toString('base64')}`, 'utf8'),
    decryptString: (cipher: Buffer) => {
      const text = cipher.toString('utf8');
      if (!text.startsWith('enc:')) throw new Error('bad ciphertext');
      return Buffer.from(text.slice(4), 'base64').toString('utf8');
    },
  };
}

const temporaryRoots: string[] = [];
afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function makeEnv() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a9-f5-'));
  temporaryRoots.push(root);
  const workspaceRoot = path.join(root, 'ws');
  const dataRoot = path.join(root, 'data');
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.mkdirSync(dataRoot, { recursive: true });
  fs.writeFileSync(path.join(workspaceRoot, 'note.txt'), 'n\n');
  return { root, workspaceRoot, dataRoot };
}

function listDataFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listDataFiles(full));
    else files.push(full);
  }
  return files;
}

/** TEST_ONLY: actual POSIX process lifecycle behind a simulated v3 transport.
 * Job/token fields below model the interface only; they are not Windows evidence.
 * Production transport/Runner fail-closed behavior is never overridden outside this fixture.
 */
function managedLifecycleModules() {
  const actual = require('../../../runner/dist');
  class FixtureRunner extends actual.TrustedShellRunner {
    private manager: any;
    constructor(options: any) {
      super(options);
      const transport = { invoke: () => { throw new Error('TEST_ONLY managed transport'); },
        startManaged: (request: any, environment: any, onOutput: any) => {
          const child = spawn('/bin/sh', ['-c', request.command], { cwd: request.cwd, env: environment, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
          let cancelled = false, seq = 0, output = Promise.resolve();
          const counts = { stdout: 0, stderr: 0 };
          const tokenAudit = { verified: true, tokenMode: 'current_user', restrictedToken: false, tokenType: 'primary', sameUser: true, lowIntegrity: false };
          const ready = new Promise<any>((resolve, reject) => {
            child.once('error', reject);
            child.once('spawn', () => resolve({ childPid: child.pid }));
          });
          for (const stream of ['stdout', 'stderr'] as const) child[stream]!.on('data', (chunk: Buffer) => {
            const offset = counts[stream]; counts[stream] += chunk.length;
            const frame = { type: 'output_chunk', requestId: request.requestId, stream, seq: ++seq, streamOffset: offset, byteLength: chunk.length, dataBase64: chunk.toString('base64') };
            output = output.then(() => onOutput(frame));
          });
          const completion = new Promise<any>((resolve) => {
            child.once('error', (error) => resolve({ kind: 'spawn_failed', detail: error.message, cleanupConfirmed: true }));
            child.once('close', async (exitCode) => {
              try { await output; } catch (error) { resolve({ kind: 'helper_crashed', detail: String(error), cleanupConfirmed: false }); return; }
              resolve({ kind: 'response', response: { schemaVersion: 3, type: 'execution_result', requestId: request.requestId,
                profileId: 'a9-trusted-shell-current-user-v2', exitCode, canceled: cancelled, timedOut: false, idleTimedOut: false,
                containmentVerified: true, inputDetached: true, cleanupConfirmed: true, workDirAclModified: false,
                hostJob: { detected: false, breakaway: 'none', childJobAssignmentVerified: true }, tokenAudit } });
            });
          });
          return { ready, completion, cancel: () => { cancelled = true; void actual.killProcessTree(child.pid); } };
        } };
      this.manager = new actual.BackgroundProcessManager(transport, options.redactText, options.getSensitiveValues, options.onBackgroundStateChange);
    }
    getBackgroundManager() { return this.manager; }
  }
  return { core: require('../../../core/dist'), gateway: require('../../../gateway/dist'), state: require('../../../state/dist'),
    workspace: require('../../../workspace/dist'), gitAdapter: require('../../../git-adapter/dist'),
    runner: { ...actual, TrustedShellRunner: FixtureRunner, createTrustedShellLoopAdapter: (runner: any) => {
      const adapter = actual.createTrustedShellLoopAdapter(runner);
      return { ...adapter, execute: async (command: string, options: any) => {
        if (!options.background || !options.managedOwner) return adapter.execute(command, options);
        const requestId = `TEST_ONLY-${Date.now()}-${Math.random()}`;
        const handle = await runner.getBackgroundManager().start(requestId, command, '/bin/sh', ['-c', command], options.cwd, process.env,
          { schemaVersion: 3, profileId: 'a9-trusted-shell-current-user-v2', requestId, command, cwd: options.cwd, managed: true, outputEncoding: { stdout: 'utf-8', stderr: 'utf-8' } },
          { owner: options.managedOwner, onOutput: options.onOutput });
        // Preserve the external-change collection race exercised by the historical fixture.
        await new Promise((resolve) => setTimeout(resolve, 100));
        return { status: 'background_started', backgroundHandle: handle.handleId, exitCode: null, stdout: '', stderr: '', durationMs: 100, timedOut: false };
      } };
    } } };
}

function makeRuntime(env: ReturnType<typeof makeEnv>, managedFixture = false) {
  return createA9AgentRuntime({
    ...(managedFixture ? { modules: managedLifecycleModules() } : {}),
    workspaceRoot: env.workspaceRoot,
    dataRoot: env.dataRoot,
    ownerId: `f5-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    openDatabase: (p: string, o?: { readonly?: boolean }) => new Database(p, o?.readonly ? { readonly: true } : {}),
  });
}

/** A9-37 TEST_ONLY: real short POSIX Shell behind the product loop adapter.
 * Windows native transport/Job evidence is NOT_PERFORMED. No production override.
 */
function makeCheckpointRuntime(env: ReturnType<typeof makeEnv>, onExecute = () => {}, extraConfig: Record<string, unknown> = {}) {
  const modules = managedLifecycleModules();
  const adapt = modules.runner.createTrustedShellLoopAdapter;
  modules.runner.createTrustedShellLoopAdapter = (runner: any) => ({
    ...adapt(runner),
    execute: async (command: string, options: any) => {
      onExecute();
      const stdout = execFileSync('/bin/sh', ['-c', command], { cwd: options.cwd || env.workspaceRoot, encoding: 'utf8', timeout: 5000 });
      return { status: 'completed', exitCode: 0, stdout, stderr: '', durationMs: 1, timedOut: false, cancelled: false, processTreeReaped: true };
    },
  });
  return createA9AgentRuntime({ ...extraConfig, modules, workspaceRoot: env.workspaceRoot, dataRoot: env.dataRoot,
    ownerId: `checkpoint-${process.pid}-${Date.now()}-${Math.random()}`,
    openDatabase: (p: string, o?: { readonly?: boolean }) => new Database(p, o?.readonly ? { readonly: true } : {}),
  });
}

function approvalDecision(approval: any, decision: 'approved' | 'denied', overrides: Record<string, unknown> = {}) {
  return {
    approvalId: approval.approvalId,
    decision,
    bindingDigest: approval.bindingDigest,
    conversationId: approval.conversationId,
    taskId: approval.taskId,
    turnId: approval.turnId,
    ...overrides,
  };
}

function counts(env: ReturnType<typeof makeEnv>) {
  const db = new Database(path.join(env.dataRoot, 'a9-state.db'), { readonly: true });
  const read = (table: string, status?: string) =>
    (db.prepare(`SELECT COUNT(*) AS n FROM ${table} ${status ? 'WHERE status = ?' : ''}`).get(...(status ? [status] : []) as any[]) as any).n;
  const out = {
    tasks: read('a9_tasks'),
    turns: read('a9_turns'),
    runs: read('a9_runs'),
    activeTasks: read('a9_tasks', 'active'),
    activeTurns: read('a9_turns', 'active'),
    activeRuns: read('a9_runs', 'active'),
    interruptedTasks: read('a9_tasks', 'interrupted'),
    failedTasks: read('a9_tasks', 'failed'),
    failedTurns: read('a9_turns', 'failed'),
    failedRuns: read('a9_runs', 'failed'),
  };
  db.close();
  return out;
}

function lifecycleFacts(env: ReturnType<typeof makeEnv>) {
  const db = new Database(path.join(env.dataRoot, 'a9-state.db'), { readonly: true });
  const checkpointRows = db.prepare('SELECT turn_id, payload_json FROM a9_checkpoints ORDER BY created_at').all() as any[];
  const out = {
    tasks: db.prepare('SELECT task_id, status FROM a9_tasks ORDER BY task_id').all() as any[],
    turns: db.prepare('SELECT turn_id, status FROM a9_turns ORDER BY turn_id').all() as any[],
    runs: db.prepare('SELECT run_id, status FROM a9_runs ORDER BY run_id').all() as any[],
    approvals: db.prepare('SELECT approval_id, decision FROM a9_approvals ORDER BY created_at').all() as any[],
    checkpoints: checkpointRows.map((row) => ({ turnId: row.turn_id, payload: JSON.parse(row.payload_json) })),
  };
  db.close();
  return out;
}

describe('F5: task/turn/run lifecycle is persisted by the product runtime', () => {
  let env: ReturnType<typeof makeEnv>;
  beforeEach(() => { env = makeEnv(); });
  afterEach(() => { fs.rmSync(env.root, { recursive: true, force: true }); });

  it('a completed turn leaves task/turn/run rows in terminal states', async () => {
    const fixture = await startQuickFixture();
    try {
      const runtime = makeRuntime(env);
      runtime.setMode('full_access');
      await runtime.configureProvider({ baseUrl: fixture.baseUrl, model: 'fixture', skipProbe: true });
      const turn = await runtime.submitTurn('go');
      expect(turn.ok).toBe(true);
      const c = counts(env);
      expect(c.tasks).toBeGreaterThanOrEqual(1);
      expect(c.turns).toBeGreaterThanOrEqual(1);
      expect(c.runs).toBeGreaterThanOrEqual(1);
      expect(c.activeTasks).toBe(0);
      expect(c.activeTurns).toBe(0);
      expect(c.activeRuns).toBe(0);
      runtime.shutdown();
    } finally {
      await fixture.close();
    }
  }, 30_000);

  it('a real subprocess crash mid-turn becomes interrupted on restart, with no replay', async () => {
    const fixture = await startDelayedFixture();
    const markerFile = path.join(env.root, 'crash.marker');
    try {
      const childLog = path.join(env.root, 'child.log');
      const logStream = fs.openSync(childLog, 'a');
      const child = spawn(process.execPath, [path.join(__dirname, 'a9-f5-crash-child.cjs')], {
        env: {
          ...process.env,
          A9_F5_WORKSPACE: env.workspaceRoot,
          A9_F5_DATAROOT: env.dataRoot,
          A9_F5_FIXTURE_URL: fixture.baseUrl,
          A9_F5_MARKER: markerFile,
        },
        stdio: ['ignore', 'ignore', logStream],
      });
      child.on('exit', () => { fs.closeSync(logStream); });
      const deadline = Date.now() + 30_000;
      while (!fs.existsSync(markerFile) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 200));
      }
      expect(fs.existsSync(markerFile)).toBe(true);
      const before = counts(env);
      expect(before.activeTasks).toBeGreaterThanOrEqual(1);
      expect(before.activeTurns).toBeGreaterThanOrEqual(1);
      expect(before.activeRuns).toBeGreaterThanOrEqual(1);
      // 等待子进程退出（崩溃码 70）。
      // 用 pid 存活探测等待退出（jest 环境下 exit 事件可能不投递）。
      const exitDeadline = Date.now() + 15_000;
      let exited = false;
      while (Date.now() < exitDeadline) {
        const childPid = child.pid ?? 0;
        try { process.kill(childPid, 0); await new Promise((r) => setTimeout(r, 150)); } catch (_e) { exited = true; break; }
      }
      expect(exited).toBe(true);
      expect(child.exitCode).toBe(70);

      // 第二个进程打开相同 dataRoot：active → interrupted，只恢复事实。
      const runtime2 = makeRuntime(env);
      const snapshot = runtime2.getSnapshot();
      expect(snapshot.mode).toBe('full_access');
      expect(snapshot.interruptions.some((i: any) => i.kind === 'task')).toBe(true);
      expect(snapshot.interruptions.some((i: any) => i.kind === 'turn')).toBe(true);
      expect(snapshot.interruptions.some((i: any) => i.kind === 'run')).toBe(true);
      expect(snapshot.timeline).toEqual([]); // 无自动模型/Shell/Git/审批重放
      const after = counts(env);
      expect(after.activeTasks).toBe(0);
      expect(after.interruptedTasks).toBeGreaterThanOrEqual(1);
      runtime2.shutdown();

      // 旧审批不可执行（没有挂起审批却尝试恢复 → 结构化拒绝）。
      const runtime3 = makeRuntime(env);
      const resume = await runtime3.resumeApproval({
        approvalId: 'apr-forged', decision: 'approved', bindingDigest: '0'.repeat(64),
        conversationId: 'a9c-forged', taskId: 'task-forged', turnId: 'turn-forged',
      });
      expect(resume.ok).toBe(false);
      expect(resume.error.code).toBe('A9_APPROVAL_UNKNOWN');
      runtime3.shutdown();
    } finally {
      fixture.release();
      await fixture.close();
    }
  }, 90_000);
});

describe('F5: pending approval keeps active state and resume continues the same entities', () => {
  it('hides a claimed approval while resume is active and rejects a duplicate decision without consuming it twice', async () => {
    const env = makeEnv();
    const fixture = await startHeldApprovalFixture();
    try {
      const runtime = makeRuntime(env);
      runtime.setMode('full_access');
      await runtime.configureProvider({ baseUrl: fixture.baseUrl, model: 'fixture', skipProbe: true });
      const first = await runtime.submitTurn('delete note');
      const approval = first.result.pendingApproval;
      expect(runtime.getSnapshot().pendingApproval.approvalId).toBe(approval.approvalId);
      expect(() => runtime.createConversation()).toThrow('A9_CONVERSATION_BUSY');
      const blockedTurn = await runtime.submitTurn('must not replace the pending approval');
      expect(blockedTurn.ok).toBe(false);
      expect(blockedTurn.error.code).toBe('A9_APPROVAL_REQUIRED');
      expect(runtime.getSnapshot().pendingApproval.approvalId).toBe(approval.approvalId);

      const resumedPromise = runtime.resumeApproval(approvalDecision(approval, 'approved'));
      await fixture.resumed;
      const duringResume = runtime.getSnapshot();
      expect(duringResume.pendingApproval).toBeUndefined();
      expect(duringResume.agentStatus).toBe('running');
      expect(duringResume.controls).toMatchObject({ canStop: true, stopKind: 'turn' });

      const duplicate = await runtime.resumeApproval(approvalDecision(approval, 'approved'));
      expect(duplicate.ok).toBe(false);
      expect(duplicate.error.code).toBe('A9_APPROVAL_DECISION_IN_PROGRESS');
      expect(runtime.getSnapshot().pendingApproval).toBeUndefined();

      const concurrentTurn = await runtime.submitTurn('must not run beside approval resume');
      expect(concurrentTurn.ok).toBe(false);
      expect(concurrentTurn.error.code).toBe('A9_TURN_ALREADY_ACTIVE');
      expect(runtime.getSnapshot().pendingApproval).toBeUndefined();

      fixture.release();
      const resumed = await resumedPromise;
      expect(resumed.ok).toBe(true);
      expect(['completed', 'completed_with_warnings']).toContain(resumed.result.outcome);
      expect(lifecycleFacts(env).approvals.filter((item) => item.decision === 'approved')).toHaveLength(1);
      runtime.shutdown();
    } finally {
      fixture.release();
      await fixture.close();
      fs.rmSync(env.root, { recursive: true, force: true });
    }
  }, 30_000);

  it('needs_approval leaves task/turn/run active; denied resume closes them', async () => {
    const env = makeEnv();
    try {
      // 审批 fixture：先 delete(permanent) 工具调用。
      const requests: any[] = [];
      const fixture = await new Promise<{ baseUrl: string; close: () => Promise<void> }>((resolve) => {
        const server = http.createServer((req, res) => {
          let body = '';
          req.on('data', (d: Buffer) => { body += d.toString('utf8'); });
          req.on('end', () => {
            const parsed = JSON.parse(body);
            requests.push(parsed);
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            if (parsed?.tools?.[0]?.function?.name === 'probe_test_echo') {
              sse(res, { choices: [{ delta: { tool_calls: [{ index: 0, id: 'p1', function: { name: 'probe_test_echo', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] });
            } else {
              const toolMsgs = (parsed.messages ?? []).filter((m: any) => m.role === 'tool' && m.name !== 'probe_test_echo');
              if (toolMsgs.length === 0) {
                sse(res, { choices: [{ delta: { tool_calls: [{ index: 0, id: 'd1', function: { name: 'delete', arguments: '{"path":"note.txt","permanent":true}' } }] }, finish_reason: 'tool_calls' }] });
              } else {
                sse(res, { choices: [{ delta: { content: 'handled' }, finish_reason: 'stop' }] });
              }
            }
            res.write('data: [DONE]\n\n');
            res.end();
          });
        });
        server.listen(0, '127.0.0.1', () => {
          resolve({ baseUrl: `http://127.0.0.1:${(server.address() as any).port}`, close: () => new Promise<void>((d) => server.close(() => d())) });
        });
      });
      try {
        const runtime = makeRuntime(env);
        runtime.setMode('full_access');
        await runtime.configureProvider({ baseUrl: fixture.baseUrl, model: 'fixture', skipProbe: true });
        const first = await runtime.submitTurn('delete note');
        expect(first.result.outcome).toBe('needs_approval');
        let c = counts(env);
        expect(c.activeTasks).toBe(1);
        expect(c.activeTurns).toBe(1);
        expect(c.activeRuns).toBe(1);

        const denied = await runtime.resumeApproval(approvalDecision(first.result.pendingApproval, 'denied'));
        expect(denied.ok).toBe(true);
        c = counts(env);
        expect(c.activeTasks).toBe(0);
        expect(c.activeTurns).toBe(0);
        expect(c.activeRuns).toBe(0);
        // 同一组实体：总数没有因 resume 增长。
        expect(c.turns).toBe(1);
        expect(c.runs).toBe(1);
        runtime.shutdown();
      } finally {
        await fixture.close();
      }
    } finally {
      fs.rmSync(env.root, { recursive: true, force: true });
    }
  }, 30_000);

  it('persists approval_resolved timeline events for denied decisions across restart (ADR-0114)', async () => {
    const env = makeEnv();
    const fixture = await startApprovalFixture();
    try {
      const runtime = makeRuntime(env);
      runtime.setMode('full_access');
      await runtime.configureProvider({ baseUrl: fixture.baseUrl, model: 'fixture', skipProbe: true });
      const turn = await runtime.submitTurn('delete note');
      expect(turn.result.outcome).toBe('needs_approval');
      const denied = await runtime.resumeApproval(approvalDecision(turn.result.pendingApproval, 'denied'));
      expect(denied.ok).toBe(true);

      // timeline：approval_resolved 带 eventId（a9_events 行 id）与决定事实。
      const snapshot = runtime.getSnapshot();
      const resolved = snapshot.timeline.find((event: any) => event.type === 'approval_resolved');
      expect(resolved).toBeDefined();
      expect(Number.isSafeInteger(resolved.eventId)).toBe(true);
      expect(resolved.sequence).toBe(resolved.eventId);
      expect(resolved.data).toMatchObject({
        approvalId: turn.result.pendingApproval.approvalId,
        decision: 'denied',
        toolName: 'delete',
      });

      // 重启后留痕仍可按会话回看（approval_resolved 已持久化）。
      const conversationId = snapshot.activeConversationId;
      runtime.shutdown();
      const runtime2 = makeRuntime(env);
      const replayed = runtime2.queryEvents({ conversationId, limit: 50 });
      expect(replayed.ok).toBe(true);
      const replayedResolved = replayed.events.find((event: any) => event.payload?.type === 'approval_resolved');
      expect(replayedResolved).toBeDefined();
      expect(replayedResolved.payload.data).toMatchObject({ decision: 'denied', toolName: 'delete' });
      runtime2.shutdown();
    } finally {
      await fixture.close();
      fs.rmSync(env.root, { recursive: true, force: true });
    }
  }, 30_000);

  it('Phase A7: a core validation failure is not persisted as approved; it leaves an independent approval_invalidated audit event', async () => {
    const env = makeEnv();
    const fixture = await startApprovalFixture();
    const core = require('../../../core/dist');
    try {
      const runtime = makeRuntime(env);
      runtime.setMode('full_access');
      await runtime.configureProvider({ baseUrl: fixture.baseUrl, model: 'fixture', skipProbe: true });
      const turn = await runtime.submitTurn('delete note');
      const approval = turn.result.pendingApproval;
      expect(turn.result.outcome).toBe('needs_approval');

      // 模拟“挂起期间来源已变化”：core 重新校验失败，且不会调用 onValidated。
      const spy = jest.spyOn(core.A9AgentLoop.prototype, 'resumeAfterApproval').mockImplementation(async () => {
        throw new core.AgentError(core.AgentErrorCode.APPROVAL_INVALID, 'bindingDigest 与当前挂起调用不一致；审批已失效。');
      });
      const rejected = await runtime.resumeApproval(approvalDecision(approval, 'approved'));
      spy.mockRestore();

      expect(rejected.ok).toBe(false);
      expect(rejected.error.code).toBe('APPROVAL_INVALID');
      // SQLite 审批行仍为 pending：没有任何“已批准”记录。
      expect(lifecycleFacts(env).approvals).toEqual([{ approval_id: approval.approvalId, decision: 'pending' }]);
      const timeline = runtime.getSnapshot().timeline;
      expect(timeline.some((e: any) => e.type === 'approval_resolved')).toBe(false);
      const invalidated = timeline.find((e: any) => e.type === 'approval_invalidated');
      expect(invalidated).toBeDefined();
      expect(invalidated.data).toMatchObject({ approvalId: approval.approvalId, attemptedDecision: 'approved', toolName: 'delete', reason: 'APPROVAL_INVALID' });
      expect(Number.isSafeInteger(invalidated.eventId)).toBe(true);
      // 审批仍待决：之后用同一审批正常拒绝，才产生 denied 记录。
      expect(runtime.getSnapshot().pendingApproval.approvalId).toBe(approval.approvalId);
      const denied = await runtime.resumeApproval(approvalDecision(approval, 'denied'));
      expect(denied.ok).toBe(true);
      expect(lifecycleFacts(env).approvals).toEqual([{ approval_id: approval.approvalId, decision: 'denied' }]);
      runtime.shutdown();
    } finally {
      await fixture.close();
      fs.rmSync(env.root, { recursive: true, force: true });
    }
  }, 30_000);

  it('preserves a second pending approval, rejects the consumed old approval, and refreshes the same checkpoint', async () => {
    const env = makeEnv();
    fs.writeFileSync(path.join(env.workspaceRoot, 'second.txt'), 'second\n');
    const fixture = await startApprovalFixture({ secondApproval: true });
    try {
      const runtime = makeRuntime(env);
      runtime.setMode('full_access');
      await runtime.configureProvider({ baseUrl: fixture.baseUrl, model: 'fixture', skipProbe: true });
      const first = await runtime.submitTurn('delete two files');
      const firstApproval = first.result.pendingApproval;
      expect(first.result.outcome).toBe('needs_approval');
      expect(lifecycleFacts(env).checkpoints[0].payload).toEqual(expect.objectContaining({
        schemaVersion: 1,
        outcome: 'needs_approval',
        pendingApproval: expect.objectContaining({ approvalId: firstApproval.approvalId }),
      }));

      const resumed = await runtime.resumeApproval(approvalDecision(firstApproval, 'approved'));
      expect(resumed.ok).toBe(true);
      const approvalEvents = runtime.getSnapshot().timeline;
      const decisionIndex = approvalEvents.findIndex((e: any) => e.type === 'approval_resolved' && e.data.approvalId === firstApproval.approvalId);
      const executionIndex = approvalEvents.findIndex((e: any) => e.type === 'tool_start');
      expect(decisionIndex).toBeGreaterThanOrEqual(0);
      expect(executionIndex).toBeGreaterThan(decisionIndex);
      expect(resumed.result.outcome).toBe('needs_approval');
      const secondApproval = resumed.result.pendingApproval;
      expect(secondApproval.approvalId).not.toBe(firstApproval.approvalId);
      expect(runtime.getSnapshot().pendingApproval.approvalId).toBe(secondApproval.approvalId);
      let facts = lifecycleFacts(env);
      expect(facts.tasks).toHaveLength(1);
      expect(facts.turns).toHaveLength(1);
      expect(facts.runs).toHaveLength(1);
      expect(facts.checkpoints[0].payload).toEqual(expect.objectContaining({
        schemaVersion: 1,
        outcome: 'needs_approval',
        toolCallsExecuted: 1,
        externalChanges: expect.any(Array),
        pendingApproval: expect.objectContaining({ approvalId: secondApproval.approvalId }),
      }));

      const malformed = await runtime.resumeApproval({
        approvalId: secondApproval.approvalId,
        decision: 'approved',
      });
      expect(malformed.ok).toBe(false);
      expect(malformed.error.code).toBe('A9_APPROVAL_INPUT_INVALID');
      expect(runtime.getSnapshot().pendingApproval.approvalId).toBe(secondApproval.approvalId);

      const wrongDigest = await runtime.resumeApproval({
        ...approvalDecision(secondApproval, 'approved'),
        bindingDigest: '0'.repeat(64),
      });
      expect(wrongDigest.ok).toBe(false);
      expect(runtime.getSnapshot().pendingApproval.approvalId).toBe(secondApproval.approvalId);

      const stale = await runtime.resumeApproval(approvalDecision(firstApproval, 'approved'));
      expect(stale.ok).toBe(false);
      expect(stale.error.code).toBe('A9_APPROVAL_UNKNOWN');
      expect(runtime.getSnapshot().pendingApproval.approvalId).toBe(secondApproval.approvalId);

      const denied = await runtime.resumeApproval(approvalDecision(secondApproval, 'denied'));
      expect(denied.ok).toBe(true);
      facts = lifecycleFacts(env);
      expect(facts.tasks[0].status).not.toBe('active');
      expect(facts.turns[0].status).not.toBe('active');
      expect(facts.runs[0].status).not.toBe('active');
      expect(facts.checkpoints[0].payload.outcome).toBe(denied.result.outcome);
      expect(facts.checkpoints[0].payload.pendingApproval).toBeUndefined();
      expect(fs.existsSync(path.join(env.workspaceRoot, 'note.txt'))).toBe(false);
      expect(fs.existsSync(path.join(env.workspaceRoot, 'second.txt'))).toBe(true);
      runtime.shutdown();
    } finally {
      await fixture.close();
      fs.rmSync(env.root, { recursive: true, force: true });
    }
  }, 30_000);

  it('persists a submit-time provider failure as failed with no active lifecycle rows', async () => {
    const env = makeEnv();
    const fixture = await startFailingFixture();
    try {
      const runtime = makeRuntime(env);
      runtime.setMode('full_access');
      await runtime.configureProvider({ baseUrl: fixture.baseUrl, model: 'fixture', skipProbe: true });
      const failed = await runtime.submitTurn('fail now');
      expect(failed.ok).toBe(true);
      expect(failed.result.outcome).toBe('failed');
      const c = counts(env);
      expect(c.failedTasks).toBe(1);
      expect(c.failedTurns).toBe(1);
      expect(c.failedRuns).toBe(1);
      expect(c.activeTasks + c.activeTurns + c.activeRuns).toBe(0);
      expect(lifecycleFacts(env).checkpoints[0].payload).toEqual(expect.objectContaining({ schemaVersion: 1, outcome: 'failed' }));
      runtime.shutdown();
    } finally {
      await fixture.close();
      fs.rmSync(env.root, { recursive: true, force: true });
    }
  }, 30_000);

  it('persists provider initialization failure as a synthetic failed turn/run instead of leaking an active task', async () => {
    const env = makeEnv();
    try {
      const runtime = makeRuntime(env);
      runtime.setMode('full_access');
      const failed = await runtime.submitTurn('provider is not configured');
      expect(failed.ok).toBe(false);
      const c = counts(env);
      expect(c.failedTasks).toBe(1);
      expect(c.failedTurns).toBe(1);
      expect(c.failedRuns).toBe(1);
      expect(c.activeTasks + c.activeTurns + c.activeRuns).toBe(0);
      expect(lifecycleFacts(env).checkpoints[0].payload).toEqual(expect.objectContaining({ schemaVersion: 1, outcome: 'failed' }));
      runtime.shutdown();
    } finally {
      fs.rmSync(env.root, { recursive: true, force: true });
    }
  }, 30_000);

  it('persists a provider failure after approval resume as failed with no active rows', async () => {
    const env = makeEnv();
    const fixture = await startApprovalFixture({ failAfterFirstTool: true });
    try {
      const runtime = makeRuntime(env);
      runtime.setMode('full_access');
      await runtime.configureProvider({ baseUrl: fixture.baseUrl, model: 'fixture', skipProbe: true });
      const first = await runtime.submitTurn('delete then fail');
      const approval = first.result.pendingApproval;
      const failed = await runtime.resumeApproval(approvalDecision(approval, 'approved'));
      expect(failed.ok).toBe(true);
      expect(failed.result.outcome).toBe('failed');
      const c = counts(env);
      expect(c.failedTasks).toBe(1);
      expect(c.failedTurns).toBe(1);
      expect(c.failedRuns).toBe(1);
      expect(c.activeTasks + c.activeTurns + c.activeRuns).toBe(0);
      expect(lifecycleFacts(env).checkpoints[0].payload).toEqual(expect.objectContaining({ schemaVersion: 1, outcome: 'failed' }));
      runtime.shutdown();
    } finally {
      await fixture.close();
      fs.rmSync(env.root, { recursive: true, force: true });
    }
  }, 30_000);

  it('stop during a stalled model request returns cancelled and leaves no active rows', async () => {
    const env = makeEnv();
    const fixture = await startDelayedFixture();
    try {
      const runtime = makeRuntime(env);
      runtime.setMode('full_access');
      await runtime.configureProvider({ baseUrl: fixture.baseUrl, model: 'fixture', skipProbe: true });
      const turnPromise = runtime.submitTurn('stalled turn');
      // 等待 read 工具回执后模型停住（Turn 保持 active）。
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        if (runtime.getSnapshot().agentStatus === 'running') break;
        await new Promise((r) => setTimeout(r, 150));
      }
      const stopped = runtime.stop();
      expect(stopped.ok).toBe(true);
      const turned = await turnPromise;
      expect(turned.ok).toBe(true);
      // F5 状态语义：用户 stop 打断模型请求 → cancelled（不是 failed）。
      expect(turned.result.outcome).toBe('cancelled');
      const c = counts(env);
      expect(c.activeTasks).toBe(0);
      expect(c.activeTurns).toBe(0);
      expect(c.activeRuns).toBe(0);
      expect(c.tasks).toBeGreaterThanOrEqual(1);
      runtime.shutdown();
    } finally {
      fixture.release();
      await fixture.close();
      fs.rmSync(env.root, { recursive: true, force: true });
    }
  }, 30_000);

  it('persists a managed background process and keeps Stop available after the turn completes', async () => {
    const env = makeEnv();
    const fixture = await startBackgroundFixture();
    const runtime = makeRuntime(env, true);
    try {
      runtime.setMode('full_access');
      await runtime.configureProvider({ baseUrl: fixture.baseUrl, model: 'fixture', skipProbe: true });
      const turn = await runtime.submitTurn('start a managed background process');
      expect(turn.ok).toBe(true);
      expect(turn.result.outcome).toBe('completed_with_warnings');

      const running = runtime.getSnapshot().managedProcesses.filter((item: any) => item.lastProbeStatus === 'running');
      expect(running).toHaveLength(1);
      expect(running[0].pid).toBeGreaterThan(0);
      expect(runtime.getSnapshot().controls).toEqual({ canStop: true, stopKind: 'managed_process' });

      const firstStop = runtime.stop();
      const secondStop = runtime.stop();
      expect(secondStop).toBe(firstStop);
      const stopped = await firstStop;
      expect(stopped.ok).toBe(true);
      expect(stopped.stopped).toContain(running[0].handleId);
      const terminal = runtime.getSnapshot().managedProcesses.find((item: any) => item.handleId === running[0].handleId);
      expect(terminal.lastProbeStatus).toBe('stopped');
      expect(runtime.getSnapshot().controls).toEqual({ canStop: false, stopKind: 'none' });
    } finally {
      await runtime.shutdown();
      await fixture.close();
      fs.rmSync(env.root, { recursive: true, force: true });
    }
  }, 30_000);

  it('restores completed conversation facts after restart without replaying the turn', async () => {
    const env = makeEnv();
    const fixture = await startBackgroundFixture();
    let first: any;
    let reopened: any;
    try {
      first = makeRuntime(env, true);
      first.setMode('full_access');
      await first.configureProvider({ baseUrl: fixture.baseUrl, model: 'fixture', skipProbe: true });
      const turn = await first.submitTurn('restore this exact request after restart');
      expect(turn.ok).toBe(true);
      await first.stop();
      await first.shutdown();

      reopened = makeRuntime(env, true);
      const snapshot = reopened.getSnapshot();
      expect(snapshot.conversation).toEqual([expect.objectContaining({
        turnId: turn.result.turnId,
        requestPrompt: 'restore this exact request after restart',
        outcome: 'completed_with_warnings',
        finalMessage: expect.any(String),
      })]);
      expect(snapshot.timeline).toEqual([]);
      expect(snapshot.pendingApproval).toBeUndefined();
    } finally {
      if (reopened) await reopened.shutdown();
      else if (first) await first.shutdown();
      await fixture.close();
      fs.rmSync(env.root, { recursive: true, force: true });
    }
  }, 30_000);

  it('isolates visible and provider text context across conversations in one workspace', async () => {
    const env = makeEnv();
    const fixture = await startQuickFixture();
    let runtime: any;
    try {
      runtime = makeRuntime(env);
      runtime.setMode('full_access');
      await runtime.configureProvider({ baseUrl: fixture.baseUrl, model: 'fixture', skipProbe: true });
      const firstId = runtime.getSnapshot().activeConversationId;
      expect((await runtime.submitTurn('CONVERSATION_ONE_MARKER')).ok).toBe(true);
      const secondId = runtime.createConversation().conversationId;
      expect(secondId).not.toBe(firstId);
      expect(runtime.getSnapshot().conversation).toEqual([]);
      expect((await runtime.submitTurn('CONVERSATION_TWO_MARKER')).ok).toBe(true);

      runtime.activateConversation(firstId);
      expect(JSON.stringify(runtime.getSnapshot().conversation)).toContain('CONVERSATION_ONE_MARKER');
      expect(JSON.stringify(runtime.getSnapshot().conversation)).not.toContain('CONVERSATION_TWO_MARKER');
      const requestCount = fixture.requests.length;
      expect((await runtime.submitTurn('CONVERSATION_ONE_FOLLOWUP')).ok).toBe(true);
      const afterSwitch = fixture.requests.slice(requestCount)
        .find((request: any) => !(request?.tools?.[0]?.function?.name === 'probe_test_echo'));
      const serializedMessages = JSON.stringify(afterSwitch.messages);
      expect(serializedMessages).toContain('CONVERSATION_ONE_MARKER');
      expect(serializedMessages).toContain('CONVERSATION_ONE_FOLLOWUP');
      expect(serializedMessages).not.toContain('CONVERSATION_TWO_MARKER');
    } finally {
      if (runtime) await runtime.shutdown();
      await fixture.close();
      fs.rmSync(env.root, { recursive: true, force: true });
    }
  }, 30_000);

  it('redacts configured secret material from persisted conversation prompts', async () => {
    const env = makeEnv();
    const fixture = await startBackgroundFixture();
    let first: any;
    let reopened: any;
    try {
      first = makeRuntime(env, true);
      first.setMode('full_access');
      const secret = 'a9/conversation secret';
      await first.configureProvider({
        baseUrl: fixture.baseUrl,
        model: 'fixture',
        apiKey: secret,
        skipProbe: true,
      });
      const encodedSecret = Buffer.from(secret, 'utf8').toString('base64');
      const unpadded = encodedSecret.replace(/=+$/g, '');
      const base64url = unpadded.replace(/\+/g, '-').replace(/\//g, '_');
      const formEncoded = encodeURIComponent(secret).toLowerCase().replace(/%20/g, '+');
      const mixedPercentBase64 = encodeURIComponent(encodedSecret).replace(/%([a-f0-9]{2})/gi, (_m, hex, offset) =>
        offset % 2 === 0 ? `%${hex.toUpperCase()}` : `%${hex.toLowerCase()}`);
      const mixedPercentSecret = '%61%39%2fconversation+se%63ret';
      const variants = [secret, encodedSecret, unpadded, base64url, formEncoded, mixedPercentBase64, mixedPercentSecret];
      const turn = await first.submitTurn(`do not persist ${variants.join(', ')}`);
      expect(turn.ok).toBe(true);
      const liveSnapshot = JSON.stringify(first.getSnapshot());
      expect(liveSnapshot).toContain('***redacted***');
      for (const variant of variants) expect(liveSnapshot).not.toContain(variant);
      await first.stop();
      await first.shutdown();

      for (const file of fs.readdirSync(env.dataRoot).map((name) => path.join(env.dataRoot, name))) {
        if (!fs.statSync(file).isFile()) continue;
        for (const variant of variants) {
          expect(fs.readFileSync(file).includes(Buffer.from(variant, 'utf8'))).toBe(false);
        }
      }

      reopened = makeRuntime(env, true);
      const serialized = JSON.stringify(reopened.getSnapshot().conversation);
      expect(serialized).toContain('***redacted***');
      expect(serialized).not.toContain(secret);
    } finally {
      if (reopened) await reopened.shutdown();
      else if (first) await first.shutdown();
      await fixture.close();
      fs.rmSync(env.root, { recursive: true, force: true });
    }
  }, 30_000);

  it('redacts known secrets from manual conversation titles before SQLite and snapshot projection', async () => {
    const env = makeEnv();
    const fixture = await startQuickFixture();
    const runtime = makeRuntime(env);
    const secret = 'TITLE-SECRET-42';
    try {
      await runtime.configureProvider({ baseUrl: fixture.baseUrl, model: 'fixture', apiKey: secret, skipProbe: true });
      const activeId = runtime.getSnapshot().activeConversationId;
      runtime.renameConversation(activeId, `manual-${secret}`);
      const snapshot = JSON.stringify(runtime.getSnapshot());
      expect(snapshot).toContain('***redacted***');
      expect(snapshot).not.toContain(secret);
      expect(fs.readFileSync(path.join(env.dataRoot, 'a9-state.db')).includes(Buffer.from(secret, 'utf8'))).toBe(false);
    } finally {
      await runtime.shutdown();
      await fixture.close();
      fs.rmSync(env.root, { recursive: true, force: true });
    }
  });

  it('rejects Provider reconfiguration while a Turn is active', async () => {
    const env = makeEnv();
    const fixture = await startDelayedFixture();
    const runtime = makeRuntime(env);
    try {
      await runtime.configureProvider({ baseUrl: fixture.baseUrl, model: 'old-provider', skipProbe: true });
      runtime.setMode('full_access');
      fs.writeFileSync(path.join(env.workspaceRoot, 'note.txt'), 'hello');
      const runningTurn = runtime.submitTurn('hold this turn');
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && runtime.getSnapshot().agentStatus !== 'running') {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const activeSnapshot = runtime.getSnapshot();
      expect(activeSnapshot.agentStatus).toBe('running');

      await expect(runtime.configureProvider({
        baseUrl: `${fixture.baseUrl}/new-provider`, model: 'new-provider', skipProbe: true,
      })).rejects.toMatchObject({ code: 'A9_PROVIDER_RECONFIGURE_BUSY' });
      fixture.release();
      expect((await runningTurn).ok).toBe(true);
      expect(runtime.getSnapshot().provider.model).toBe('old-provider');
    } finally {
      fixture.release();
      await runtime.shutdown();
      await fixture.close();
      fs.rmSync(env.root, { recursive: true, force: true });
    }
  }, 30_000);

  it('does not publish Read Only while a Full Access Turn is still active', async () => {
    const env = makeEnv();
    const fixture = await startDelayedFixture();
    const runtime = makeRuntime(env);
    try {
      await runtime.configureProvider({ baseUrl: fixture.baseUrl, model: 'fixture', skipProbe: true });
      runtime.setMode('full_access');
      fs.writeFileSync(path.join(env.workspaceRoot, 'note.txt'), 'hello');
      const runningTurn = runtime.submitTurn('hold this turn');
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && runtime.getSnapshot().agentStatus !== 'running') {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(() => runtime.setMode('read_only')).toThrow('A9_MODE_CHANGE_BLOCKED_ACTIVE_TURN');
      expect(runtime.getSnapshot().mode).toBe('full_access');
      fixture.release();
      expect((await runningTurn).ok).toBe(true);
      expect(runtime.setMode('read_only')).toMatchObject({ ok: true, mode: 'read_only' });
    } finally {
      fixture.release();
      await runtime.shutdown();
      await fixture.close();
      fs.rmSync(env.root, { recursive: true, force: true });
    }
  }, 30_000);

  it('recursively redacts secret-bearing external change paths before checkpoint and event persistence', async () => {
    const env = makeEnv();
    const secret = 'EXTERNAL-PATH-SECRET-42';
    const script = `require('fs').writeFileSync(${JSON.stringify(path.join(env.workspaceRoot, `${secret}.txt`))}, 'x')`;
    const fixture = await startBackgroundFixture(`${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`);
    const runtime = makeRuntime(env, true);
    try {
      runtime.setMode('full_access');
      await runtime.configureProvider({ baseUrl: fixture.baseUrl, model: 'fixture', apiKey: secret, skipProbe: true });
      const turn = await runtime.submitTurn('create the requested test file');
      expect(turn.ok).toBe(false);
      expect(turn.error.message).toContain('A9_CHECKPOINT_COLLECTION_FAILED');
      expect(JSON.stringify(turn)).not.toContain(secret);
      await new Promise((resolve) => setTimeout(resolve, 100));
      const raw = fs.readFileSync(path.join(env.dataRoot, 'a9-state.db'));
      expect(raw.includes(Buffer.from(secret, 'utf8'))).toBe(false);
      const snapshot = JSON.stringify(runtime.getSnapshot());
      expect(snapshot).not.toContain(secret);
    } finally {
      if (runtime.getSnapshot().controls.canStop) await runtime.stop();
      await runtime.shutdown();
      await fixture.close();
      fs.rmSync(env.root, { recursive: true, force: true });
    }
  }, 30_000);

  it.each([
    ['Authorization', 'Authorization: Bearer A9-37-SYNTHETIC-UNREGISTERED-TOKEN', 'A9-37-SYNTHETIC-UNREGISTERED-TOKEN'],
    ['URL userinfo', 'https://a9synthetic:unregisteredpass@example.invalid/api', 'a9synthetic:unregisteredpass@'],
  ])('A9-37 blocks unregistered %s project instructions in Read Only without Shell', async (_label, instruction, credential) => {
    const env = makeEnv();
    fs.writeFileSync(path.join(env.workspaceRoot, 'AGENTS.md'), instruction, 'utf8');
    const fixture = await startQuickFixture(); // read -> final; no Shell request.
    const runtime = makeRuntime(env);
    try {
      runtime.setMode('read_only');
      await runtime.configureProvider({ baseUrl: fixture.baseUrl, model: 'fixture', skipProbe: true });
      const result = await runtime.submitTurn('read note.txt');
      expect(result.ok).toBe(true);
      expect(runtime.getSnapshot().mode).toBe('read_only');
      expect(fixture.requests.length).toBeGreaterThan(0);
      const toolNames = fixture.requests.flatMap((request) => request.messages)
        .filter((message: any) => message.role === 'tool').map((message: any) => message.name);
      expect(toolNames).toEqual(['read']);
      const started = runtime.getSnapshot().timeline.find((event: any) => event.type === 'turn_started');
      const sent = JSON.stringify(fixture.requests);
      expect({ status: started?.data?.projectInstructions?.status, providerReceivedCredential: sent.includes(credential) })
        .toEqual({ status: 'secret_blocked', providerReceivedCredential: false });
      expect(sent).not.toContain(instruction);
      expect(sent).not.toContain(credential);
    } finally {
      await runtime.shutdown();
      await fixture.close();
      fs.rmSync(env.root, { recursive: true, force: true });
    }
  }, 30_000);

  // A9-37: exact product Runtime/SQLite/Workspace with TEST_ONLY POSIX transport.
  it.each([
    ['header example', 'Authorization: Bearer YOUR_API_KEY', 'utf8'],
    ['source variable', 'const headers = { authorization: token };', 'utf8'],
    ['URL example', 'https://demo:demo@example.invalid/api', 'utf8'],
    ['UTF-16LE example', 'Authorization: Bearer YOUR_API_KEY', 'utf16le'],
  ])('A9-37 preserves and restores %s through a Shell checkpoint', async (_label, content, encoding) => {
    const env = makeEnv();
    const original = Buffer.from(content, encoding as BufferEncoding);
    const target = path.join(env.workspaceRoot, 'example.txt');
    fs.writeFileSync(target, original);
    const fixture = await startQuickFixture({
      name: 'shell', arguments: JSON.stringify({ command: 'printf changed > example.txt' }),
    });
    const runtime = makeCheckpointRuntime(env);
    try {
      runtime.setMode('full_access');
      await runtime.configureProvider({ baseUrl: fixture.baseUrl, model: 'fixture', skipProbe: true });
      const result = await runtime.submitTurn('update the example file');
      expect(result.ok).toBe(true);
      expect(fs.readFileSync(target, 'utf8')).toBe('changed');
      const recovery = listDataFiles(path.join(env.workspaceRoot, '.agent_recovery'));
      expect(recovery.some((file) => fs.readFileSync(file).equals(original))).toBe(true);
      const undo = await runtime.undoTurn(result.result.turnId);
      expect(undo.outcome.errors).toEqual([]);
      expect(fs.readFileSync(target)).toEqual(original);
    } finally {
      await runtime.shutdown();
      await fixture.close();
      fs.rmSync(env.root, { recursive: true, force: true });
    }
  }, 30_000);

  it('A9-37 allows read-only Shell with example text while projections stay redacted', async () => {
    const env = makeEnv();
    const sample = 'Authorization: Bearer YOUR_API_KEY https://demo:demo@example.invalid/api';
    fs.writeFileSync(path.join(env.workspaceRoot, 'example.txt'), sample, 'utf8');
    const fixture = await startQuickFixture({
      name: 'shell', arguments: JSON.stringify({ command: 'printf CHECKPOINT_READ_ONLY_OK' }),
    });
    const runtime = makeCheckpointRuntime(env);
    try {
      runtime.setMode('full_access');
      await runtime.configureProvider({ baseUrl: fixture.baseUrl, model: 'fixture', skipProbe: true });
      const result = await runtime.submitTurn(`run read-only Shell; example: ${sample}`);
      expect(result.ok).toBe(true);
      expect(fs.readFileSync(path.join(env.workspaceRoot, 'example.txt'), 'utf8')).toBe(sample);
      const snapshot = JSON.stringify(runtime.getSnapshot());
      expect(snapshot).toContain('CHECKPOINT_READ_ONLY_OK');
      expect(snapshot).not.toContain('YOUR_API_KEY');
      expect(snapshot).not.toContain('demo:demo@');
      expect(snapshot).toContain('***redacted***');
    } finally {
      await runtime.shutdown();
      await fixture.close();
      fs.rmSync(env.root, { recursive: true, force: true });
    }
  }, 30_000);

  it.each(['plain', 'base64', 'base64url-padded', 'base64url-unpadded', 'base64-unpadded', 'percent', 'utf16le', 'path', 'previous-provider', 'custom-header', 'proxy-password'])(
    'A9-37 still blocks the known secret in %s form', async (form) => {
      const env = makeEnv();
      const secret = 'A9-37-known-~~~???x';
      const base64 = Buffer.from(secret).toString('base64');
      const base64url = base64.replace(/\+/g, '-').replace(/\//g, '_');
      expect(base64).toContain('+');
      expect(base64).toContain('/');
      expect(base64).toMatch(/=+$/);
      expect(base64url).toContain('-');
      expect(base64url).toContain('_');
      const bytes = form === 'utf16le' ? Buffer.from(secret, 'utf16le')
        : Buffer.from(form === 'base64' ? base64
          : form === 'base64url-padded' ? base64url
            : form === 'base64url-unpadded' ? base64url.replace(/=+$/g, '')
            : form === 'base64-unpadded' ? base64.replace(/=+$/g, '')
            : form === 'percent' ? encodeURIComponent(secret) : secret);
      const fileName = form === 'path' ? encodeURIComponent(secret) + '.txt' : 'secret.txt';
      fs.writeFileSync(path.join(env.workspaceRoot, fileName), form === 'path' ? Buffer.from('safe') : bytes);
      const fixture = await startQuickFixture({ name: 'shell', arguments: JSON.stringify({ command: 'printf SHOULD_NOT_RUN' }) });
      let shellCalls = 0;
      const runtime = makeCheckpointRuntime(env, () => { shellCalls += 1; });
      try {
        runtime.setMode('full_access');
        await runtime.configureProvider({ baseUrl: fixture.baseUrl, model: 'fixture',
          apiKey: ['custom-header', 'proxy-password'].includes(form) ? 'different-current-key' : secret,
          ...(form === 'custom-header' ? { customHeaders: { 'X-Fixture-Secret': secret } } : {}),
          ...(form === 'proxy-password' ? { proxy: { host: '127.0.0.1', port: 9, username: 'fixture', password: secret } } : {}),
          skipProbe: true });
        if (form === 'proxy-password') {
          await runtime.configureProvider({ baseUrl: fixture.baseUrl, model: 'fixture', proxy: null, skipProbe: true });
        }
        if (form === 'previous-provider') {
          await runtime.configureProvider({ baseUrl: fixture.baseUrl, model: 'fixture', apiKey: 'different-current-key', skipProbe: true });
        }
        const result = await runtime.submitTurn('try read-only Shell');
        expect(result.ok).toBe(false);
        expect(result.error.message).toContain('A9_CHECKPOINT_SECRET_BLOCKED');
        expect(shellCalls).toBe(0);
        expect(runtime.getSnapshot().managedProcesses).toHaveLength(0);
        expect(JSON.stringify(result)).not.toContain(secret);
        const recoveryRoot = path.join(env.workspaceRoot, '.agent_recovery');
        for (const file of fs.existsSync(recoveryRoot) ? listDataFiles(recoveryRoot) : []) {
          const persisted = fs.readFileSync(file);
          expect(persisted.includes(Buffer.from(secret))).toBe(false);
          if (form !== 'path') expect(persisted.includes(bytes)).toBe(false);
        }
      } finally {
        await runtime.shutdown();
        await fixture.close();
        fs.rmSync(env.root, { recursive: true, force: true });
      }
    }, 30_000,
  );

  // A9-38: registered proxy username/password in HTTP Basic composite form.
  // The proxy points at the path-agnostic Provider fixture, so the current pair stays active.
  const A938_PROXY_USER = 'a9fixture';
  const A938_PROXY_PASSWORD = 'A9-38-proxy-~~~???x';
  const a938Composite = (user: string) => Buffer.from(`${user}:${A938_PROXY_PASSWORD}`, 'utf8').toString('base64');

  it.each([
    'proxy-authorization-header', 'bare-json', 'base64-unpadded', 'base64url-padded', 'base64url-unpadded',
    'percent', 'utf16le', 'previous-after-proxy-null', 'previous-after-username-change', 'current-after-username-change',
  ])('A9-38 blocks the registered proxy Basic credential in %s form', async (form) => {
    const env = makeEnv();
    const composite = a938Composite(form === 'current-after-username-change' ? 'a9renamed' : A938_PROXY_USER);
    const base64url = composite.replace(/\+/g, '-').replace(/\//g, '_');
    expect(composite).toContain('+');
    expect(composite).toContain('/');
    expect(composite).toMatch(/=+$/);
    expect(composite).not.toContain(Buffer.from(A938_PROXY_PASSWORD).toString('base64').replace(/=+$/g, ''));
    const text = form === 'bare-json' ? `{"auth":"${composite}"}`
      : form === 'base64-unpadded' ? composite.replace(/=+$/g, '')
        : form === 'base64url-padded' ? base64url
          : form === 'base64url-unpadded' ? base64url.replace(/=+$/g, '')
            : form === 'percent' ? encodeURIComponent(composite)
              : `Proxy-Authorization: Basic ${composite}`;
    const bytes = Buffer.from(text, form === 'utf16le' ? 'utf16le' : 'utf8');
    fs.writeFileSync(path.join(env.workspaceRoot, 'proxy.txt'), bytes);
    const fixture = await startQuickFixture({ name: 'shell', arguments: JSON.stringify({ command: 'printf SHOULD_NOT_RUN' }) });
    const port = Number(new URL(fixture.baseUrl).port);
    let shellCalls = 0;
    const runtime = makeCheckpointRuntime(env, () => { shellCalls += 1; });
    try {
      runtime.setMode('full_access');
      await runtime.configureProvider({ baseUrl: fixture.baseUrl, model: 'fixture', apiKey: 'different-current-key',
        proxy: { host: '127.0.0.1', port, username: A938_PROXY_USER, password: A938_PROXY_PASSWORD }, skipProbe: true });
      if (form === 'previous-after-proxy-null') {
        await runtime.configureProvider({ baseUrl: fixture.baseUrl, model: 'fixture', proxy: null, skipProbe: true });
      }
      if (form === 'previous-after-username-change' || form === 'current-after-username-change') {
        await runtime.configureProvider({ baseUrl: fixture.baseUrl, model: 'fixture',
          proxy: { host: '127.0.0.1', port, username: 'a9renamed', password: A938_PROXY_PASSWORD }, skipProbe: true });
      }
      const result = await runtime.submitTurn('try read-only Shell');
      expect(fixture.requests.length).toBeGreaterThan(0);
      expect(result.ok).toBe(false);
      expect(result.error.message).toContain('A9_CHECKPOINT_SECRET_BLOCKED');
      expect(shellCalls).toBe(0);
      const projected = JSON.stringify([result, runtime.getSnapshot()]);
      expect(projected).not.toContain(composite.replace(/=+$/g, ''));
      expect(projected).not.toContain(A938_PROXY_PASSWORD);
      const recoveryRoot = path.join(env.workspaceRoot, '.agent_recovery');
      for (const file of fs.existsSync(recoveryRoot) ? listDataFiles(recoveryRoot) : []) {
        const persisted = fs.readFileSync(file);
        expect(persisted.includes(bytes)).toBe(false);
        expect(persisted.includes(Buffer.from(composite.replace(/=+$/g, '')))).toBe(false);
      }
    } finally {
      await runtime.shutdown();
      await fixture.close();
      fs.rmSync(env.root, { recursive: true, force: true });
    }
  }, 30_000);

  it.each([
    ['unregistered composite', `Proxy-Authorization: Basic ${Buffer.from('other:other-pass').toString('base64')}`],
    ['documentation example', 'Authorization: Basic dXNlcjpwYXNz'],
  ])('A9-38 preserves and restores %s with a registered proxy', async (_label, content) => {
    const env = makeEnv();
    const original = Buffer.from(content, 'utf8');
    const target = path.join(env.workspaceRoot, 'example.txt');
    fs.writeFileSync(target, original);
    const fixture = await startQuickFixture({
      name: 'shell', arguments: JSON.stringify({ command: 'printf changed > example.txt' }),
    });
    const port = Number(new URL(fixture.baseUrl).port);
    const runtime = makeCheckpointRuntime(env);
    try {
      runtime.setMode('full_access');
      await runtime.configureProvider({ baseUrl: fixture.baseUrl, model: 'fixture',
        proxy: { host: '127.0.0.1', port, username: A938_PROXY_USER, password: A938_PROXY_PASSWORD }, skipProbe: true });
      const result = await runtime.submitTurn('update the example file');
      expect(result.ok).toBe(true);
      expect(fs.readFileSync(target, 'utf8')).toBe('changed');
      const recovery = listDataFiles(path.join(env.workspaceRoot, '.agent_recovery'));
      expect(recovery.some((file) => fs.readFileSync(file).equals(original))).toBe(true);
      const undo = await runtime.undoTurn(result.result.turnId);
      expect(undo.outcome.errors).toEqual([]);
      expect(fs.readFileSync(target)).toEqual(original);
    } finally {
      await runtime.shutdown();
      await fixture.close();
      fs.rmSync(env.root, { recursive: true, force: true });
    }
  }, 30_000);

  // A9-38 P2-3: each Authorization form is its own case so every one fails independently on the old regex.
  it.each([
    ['Authorization Basic', 'Authorization: Basic A938BASICCREDONE', 'A938BASICCREDONE'],
    ['Proxy-Authorization Basic', 'Proxy-Authorization: Basic A938BASICCREDTWO', 'A938BASICCREDTWO'],
    ['lowercase authorization=basic', 'authorization=basic A938BASICCREDTHREE', 'A938BASICCREDTHREE'],
    ['Proxy-Authorization NTLM', 'Proxy-Authorization: NTLM A938NTLMTOKENFOUR', 'A938NTLMTOKENFOUR'],
  ])('A9-38 redacts the %s credential in prompt projections and SQLite', async (_label, header, credential) => {
    const env = makeEnv();
    const fixture = await startQuickFixture();
    const runtime = makeRuntime(env);
    try {
      runtime.setMode('read_only');
      await runtime.configureProvider({ baseUrl: fixture.baseUrl, model: 'fixture', skipProbe: true });
      const result = await runtime.submitTurn(`${header}\nA938-PROMPT-KEPT`);
      expect(result.ok).toBe(true);
      const snapshot = JSON.stringify(runtime.getSnapshot());
      expect(snapshot).toContain('A938-PROMPT-KEPT');
      expect(snapshot).not.toContain(credential);
    } finally {
      await runtime.shutdown();
      await fixture.close();
    }
    try {
      const stored = listDataFiles(env.dataRoot).map((file) => fs.readFileSync(file));
      expect(stored.some((bytes) => bytes.includes(Buffer.from('A938-PROMPT-KEPT')))).toBe(true);
      expect(stored.some((bytes) => bytes.includes(Buffer.from(credential)))).toBe(false);
    } finally {
      fs.rmSync(env.root, { recursive: true, force: true });
    }
  }, 30_000);

  it('A9-38 keeps the next line after a bare Basic scheme', async () => {
    const env = makeEnv();
    const fixture = await startQuickFixture();
    const runtime = makeRuntime(env);
    try {
      runtime.setMode('read_only');
      await runtime.configureProvider({ baseUrl: fixture.baseUrl, model: 'fixture', skipProbe: true });
      const result = await runtime.submitTurn('Authorization: Basic\nA938-NEXT-LINE-KEPT');
      expect(result.ok).toBe(true);
      expect(JSON.stringify(runtime.getSnapshot())).toContain('A938-NEXT-LINE-KEPT');
    } finally {
      await runtime.shutdown();
      await fixture.close();
      fs.rmSync(env.root, { recursive: true, force: true });
    }
  }, 30_000);

  it('A9-38 redacts a Basic credential in manual conversation titles before SQLite and snapshot', async () => {
    const env = makeEnv();
    const fixture = await startQuickFixture();
    const runtime = makeRuntime(env);
    const credential = 'A938TITLEBASICCRED';
    try {
      await runtime.configureProvider({ baseUrl: fixture.baseUrl, model: 'fixture', skipProbe: true });
      const activeId = runtime.getSnapshot().activeConversationId;
      runtime.renameConversation(activeId, `A938-TITLE Authorization: Basic ${credential}`);
      const snapshot = JSON.stringify(runtime.getSnapshot());
      expect(snapshot).toContain('A938-TITLE');
      expect(snapshot).not.toContain(credential);
    } finally {
      await runtime.shutdown();
      await fixture.close();
    }
    try {
      const stored = listDataFiles(env.dataRoot).map((file) => fs.readFileSync(file));
      expect(stored.some((bytes) => bytes.includes(Buffer.from('A938-TITLE')))).toBe(true);
      expect(stored.some((bytes) => bytes.includes(Buffer.from(credential)))).toBe(false);
    } finally {
      fs.rmSync(env.root, { recursive: true, force: true });
    }
  }, 30_000);

  // A9-38 round 3: RFC 7235 token scheme names may start with any tchar, not only a letter.
  it.each([
    ['1Custom', 'A938DIGITSCHEMECRED'],
    ['!Custom', 'A938BANGSCHEMECRED'],
    ['_Custom', 'A938UNDERSCORESCHEMECRED'],
  ])('A9-38 redacts the credential after the %s token scheme in titles and SQLite', async (scheme, credential) => {
    const env = makeEnv();
    const fixture = await startQuickFixture();
    const runtime = makeRuntime(env);
    let snapshot = '';
    try {
      await runtime.configureProvider({ baseUrl: fixture.baseUrl, model: 'fixture', skipProbe: true });
      const activeId = runtime.getSnapshot().activeConversationId;
      runtime.renameConversation(activeId, `A938-SCHEME Authorization: ${scheme} ${credential}`);
      snapshot = JSON.stringify(runtime.getSnapshot());
    } finally {
      await runtime.shutdown();
      await fixture.close();
    }
    try {
      const stored = listDataFiles(env.dataRoot).map((file) => fs.readFileSync(file));
      expect(snapshot).toContain('A938-SCHEME Authorization: ***redacted***');
      expect(stored.some((bytes) => bytes.includes(Buffer.from('A938-SCHEME')))).toBe(true);
      // Report both projections together so each path is observed on the unfixed product.
      expect({
        snapshotContainsCredential: snapshot.includes(credential),
        sqliteContainsCredential: stored.some((bytes) => bytes.includes(Buffer.from(credential))),
      }).toEqual({ snapshotContainsCredential: false, sqliteContainsCredential: false });
    } finally {
      fs.rmSync(env.root, { recursive: true, force: true });
    }
  }, 30_000);

  it('A9-38 keeps the plain-text Authorization title projection unchanged', async () => {
    const env = makeEnv();
    const fixture = await startQuickFixture();
    const runtime = makeRuntime(env);
    try {
      await runtime.configureProvider({ baseUrl: fixture.baseUrl, model: 'fixture', skipProbe: true });
      const activeId = runtime.getSnapshot().activeConversationId;
      runtime.renameConversation(activeId, 'A938-PLAIN Authorization: see docs');
      const snapshot = JSON.stringify(runtime.getSnapshot());
      expect(snapshot).toContain('"A938-PLAIN Authorization: ***redacted***"');
      expect(snapshot).not.toContain('see docs');
    } finally {
      await runtime.shutdown();
      await fixture.close();
      fs.rmSync(env.root, { recursive: true, force: true });
    }
  }, 30_000);

  it('A9-38 redacts a Basic credential in Shell command projections and SQLite', async () => {
    const env = makeEnv();
    const credential = 'A938COMMANDBASICCRED';
    const command = `printf A938-COMMAND-RAN # Authorization: Basic ${credential}`;
    const fixture = await startQuickFixture({ name: 'shell', arguments: JSON.stringify({ command }) });
    let shellCalls = 0;
    const runtime = makeCheckpointRuntime(env, () => { shellCalls += 1; });
    try {
      runtime.setMode('full_access');
      await runtime.configureProvider({ baseUrl: fixture.baseUrl, model: 'fixture', skipProbe: true });
      const result = await runtime.submitTurn('run the read-only command');
      expect(result.ok).toBe(true);
      expect(shellCalls).toBe(1);
      const snapshot = JSON.stringify(runtime.getSnapshot());
      expect(snapshot).toContain('A938-COMMAND-RAN');
      expect(snapshot).not.toContain(credential);
    } finally {
      await runtime.shutdown();
      await fixture.close();
    }
    try {
      const stored = listDataFiles(env.dataRoot).map((file) => fs.readFileSync(file));
      expect(stored.some((bytes) => bytes.includes(Buffer.from('printf A938-COMMAND-RAN')))).toBe(true);
      expect(stored.some((bytes) => bytes.includes(Buffer.from(credential)))).toBe(false);
    } finally {
      fs.rmSync(env.root, { recursive: true, force: true });
    }
  }, 30_000);

  // A9-38 P2-1: the composite is registered again from the persisted proxy after restart.
  it('A9-38 blocks the restored proxy Basic credential after a runtime restart', async () => {
    const env = makeEnv();
    const composite = a938Composite(A938_PROXY_USER);
    const vault = { safeStorage: fakeSafeStorage(), vaultPlatform: 'win32' };
    const fixture = await startQuickFixture({ name: 'shell', arguments: JSON.stringify({ command: 'printf SHOULD_NOT_RUN' }) });
    const port = Number(new URL(fixture.baseUrl).port);
    let shellCalls = 0;
    let runtime = makeCheckpointRuntime(env, () => { shellCalls += 1; }, vault);
    try {
      await runtime.configureProvider({ baseUrl: fixture.baseUrl, model: 'fixture', apiKey: 'different-current-key', rememberApiKey: true,
        proxy: { host: '127.0.0.1', port, username: A938_PROXY_USER, password: A938_PROXY_PASSWORD }, skipProbe: true });
      expect(runtime.getSnapshot().provider.proxy).toMatchObject({ username: A938_PROXY_USER, passwordAvailable: true });
      await runtime.shutdown();
      fs.writeFileSync(path.join(env.workspaceRoot, 'proxy.txt'), `Proxy-Authorization: Basic ${composite}`, 'utf8');
      runtime = makeCheckpointRuntime(env, () => { shellCalls += 1; }, vault);
      expect(runtime.getSnapshot().provider.proxy).toMatchObject({ username: A938_PROXY_USER, passwordAvailable: true });
      runtime.setMode('full_access');
      const result = await runtime.submitTurn('try read-only Shell');
      expect(fixture.requests.length).toBeGreaterThan(0);
      expect(result.ok).toBe(false);
      expect(result.error.message).toContain('A9_CHECKPOINT_SECRET_BLOCKED');
      expect(shellCalls).toBe(0);
    } finally {
      await runtime.shutdown();
      await fixture.close();
      fs.rmSync(env.root, { recursive: true, force: true });
    }
  }, 30_000);

  // A9-38 P2-4: Shell environment overlays see the composite; Latin-1 composites are registered too.
  const A938_LATIN1_PASSWORD = 'A9-38-préxy-ç';
  const a938Latin1Composite = () => Buffer.from(`${A938_PROXY_USER}:${A938_LATIN1_PASSWORD}`, 'latin1').toString('base64');

  it.each([
    ['UTF-8 composite', () => a938Composite(A938_PROXY_USER), A938_PROXY_PASSWORD],
    ['UTF-8 composite unpadded', () => a938Composite(A938_PROXY_USER).replace(/=+$/g, ''), A938_PROXY_PASSWORD],
    ['UTF-8 composite base64url', () => a938Composite(A938_PROXY_USER).replace(/\+/g, '-').replace(/\//g, '_'), A938_PROXY_PASSWORD],
    ['Latin-1 composite', a938Latin1Composite, A938_LATIN1_PASSWORD],
  ])('A9-38 rejects the %s in a Shell environment overlay', async (_label, value, password) => {
    const env = makeEnv();
    const runtime = makeRuntime(env);
    try {
      await runtime.configureProvider({ baseUrl: 'https://example.test/v1', model: 'm',
        proxy: { host: 'proxy.example.test', port: 8080, username: A938_PROXY_USER, password }, skipProbe: true });
      const overlay = (value as () => string)();
      expect(overlay).not.toContain(password);
      await expect(runtime.configureShell({ kind: 'automatic', envOverlay: { BUILD_MODE: overlay } }))
        .rejects.toThrow('A9_ENV_OVERLAY_REJECTED');
      expect(fs.existsSync(path.join(env.dataRoot, 'a9-shell-config.v1.json'))).toBe(false);
      expect(JSON.stringify(runtime.getSnapshot())).not.toContain(overlay);
    } finally {
      await runtime.shutdown();
      fs.rmSync(env.root, { recursive: true, force: true });
    }
  }, 30_000);

  it.each(['header', 'unpadded', 'base64url'])('A9-38 blocks the Latin-1 proxy Basic credential in %s form', async (form) => {
    const env = makeEnv();
    const latin1 = a938Latin1Composite();
    const utf8 = Buffer.from(`${A938_PROXY_USER}:${A938_LATIN1_PASSWORD}`, 'utf8').toString('base64');
    expect(latin1).not.toBe(utf8);
    const text = form === 'unpadded' ? latin1.replace(/=+$/g, '')
      : form === 'base64url' ? latin1.replace(/\+/g, '-').replace(/\//g, '_')
        : `Proxy-Authorization: Basic ${latin1}`;
    fs.writeFileSync(path.join(env.workspaceRoot, 'proxy.txt'), text, 'utf8');
    const fixture = await startQuickFixture({ name: 'shell', arguments: JSON.stringify({ command: 'printf SHOULD_NOT_RUN' }) });
    const port = Number(new URL(fixture.baseUrl).port);
    let shellCalls = 0;
    const runtime = makeCheckpointRuntime(env, () => { shellCalls += 1; });
    try {
      runtime.setMode('full_access');
      await runtime.configureProvider({ baseUrl: fixture.baseUrl, model: 'fixture', apiKey: 'different-current-key',
        proxy: { host: '127.0.0.1', port, username: A938_PROXY_USER, password: A938_LATIN1_PASSWORD }, skipProbe: true });
      const result = await runtime.submitTurn('try read-only Shell');
      expect(fixture.requests.length).toBeGreaterThan(0);
      expect(result.ok).toBe(false);
      expect(result.error.message).toContain('A9_CHECKPOINT_SECRET_BLOCKED');
      expect(shellCalls).toBe(0);
      expect(JSON.stringify([result, runtime.getSnapshot()])).not.toContain(latin1.replace(/=+$/g, ''));
    } finally {
      await runtime.shutdown();
      await fixture.close();
      fs.rmSync(env.root, { recursive: true, force: true });
    }
  }, 30_000);

  it('A9-38 keeps project instructions with a Basic credential secret_blocked', async () => {
    const env = makeEnv();
    const credential = 'A938INSTRUCTIONBASICCRED';
    fs.writeFileSync(path.join(env.workspaceRoot, 'AGENTS.md'), `Authorization: Basic ${credential}`, 'utf8');
    const fixture = await startQuickFixture();
    const runtime = makeRuntime(env);
    try {
      runtime.setMode('read_only');
      await runtime.configureProvider({ baseUrl: fixture.baseUrl, model: 'fixture', skipProbe: true });
      const result = await runtime.submitTurn('read note.txt');
      expect(result.ok).toBe(true);
      const started = runtime.getSnapshot().timeline.find((event: any) => event.type === 'turn_started');
      expect(started?.data?.projectInstructions?.status).toBe('secret_blocked');
      expect(JSON.stringify(fixture.requests)).not.toContain(credential);
    } finally {
      await runtime.shutdown();
      await fixture.close();
      fs.rmSync(env.root, { recursive: true, force: true });
    }
  }, 30_000);

  it('blocks UTF-16LE known secrets before copying a Shell baseline into recovery', async () => {
    const env = makeEnv();
    const secret = 'UTF16-CHECKPOINT-SECRET-42';
    const encodedSecret = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(secret, 'utf16le')]);
    fs.writeFileSync(path.join(env.workspaceRoot, 'utf16-secret.txt'), encodedSecret);
    const fixture = await startBackgroundFixture();
    const runtime = makeRuntime(env, true);
    try {
      runtime.setMode('full_access');
      await runtime.configureProvider({ baseUrl: fixture.baseUrl, model: 'fixture', apiKey: secret, skipProbe: true });
      const result = await runtime.submitTurn('start background');
      expect(result.ok).toBe(false);
      expect(result.error.message).toContain('CHECKPOINT_SECRET_BLOCKED');
      const recoveryRoot = path.join(env.workspaceRoot, '.agent_recovery');
      for (const file of fs.existsSync(recoveryRoot) ? listDataFiles(recoveryRoot) : []) {
        expect(fs.readFileSync(file).includes(Buffer.from(secret, 'utf16le'))).toBe(false);
      }
    } finally {
      await runtime.shutdown();
      await fixture.close();
      fs.rmSync(env.root, { recursive: true, force: true });
    }
  }, 30_000);

  it('revalidates both standalone and initialized Loop checkpoint caches for a newly known secret', async () => {
    const env = makeEnv();
    const futureSecret = 'FUTURE-LOOP-RECOVERY-SECRET-42';
    const fixture = await startQuickFixture({
      name: 'write', arguments: JSON.stringify({ path: 'future-secret.txt', content: futureSecret }),
    });
    const runtime = makeRuntime(env);
    try {
      runtime.setMode('full_access');
      await runtime.configureProvider({ baseUrl: fixture.baseUrl, model: 'fixture', skipProbe: true });
      expect((await runtime.submitTurn('write test value')).ok).toBe(true);
      await expect(runtime.configureProvider({
        baseUrl: fixture.baseUrl, model: 'fixture', apiKey: futureSecret, skipProbe: true,
      })).rejects.toThrow(/A9_CHECKPOINT_SECRET_BLOCKED/);
    } finally {
      await runtime.shutdown();
      await fixture.close();
      fs.rmSync(env.root, { recursive: true, force: true });
    }
  }, 30_000);

  it('does not resolve shutdown until managed background processes are reaped', async () => {
    const env = makeEnv();
    const fixture = await startBackgroundFixture();
    const runtime = makeRuntime(env, true);
    try {
      runtime.setMode('full_access');
      await runtime.configureProvider({ baseUrl: fixture.baseUrl, model: 'fixture', skipProbe: true });
      await runtime.submitTurn('start a managed background process');
      const running = runtime.getSnapshot().managedProcesses.find((item: any) => item.lastProbeStatus === 'running');
      expect(running.pid).toBeGreaterThan(0);

      const result = await runtime.shutdown();
      expect(result.leftToSystem).toEqual([]);
      expect(result.stopped).toContain(running.handleId);
      expect(() => process.kill(running.pid, 0)).toThrow();
    } finally {
      await fixture.close();
      fs.rmSync(env.root, { recursive: true, force: true });
    }
  }, 30_000);

  it('redacts known secrets from managed process command persistence and snapshots', async () => {
    const env = makeEnv();
    const secret = 'MANAGED-COMMAND-SECRET-42';
    const command = `${JSON.stringify(process.execPath)} -e "setInterval(() => {}, 1000)" ${secret}`;
    const fixture = await startBackgroundFixture(command);
    const runtime = makeRuntime(env, true);
    try {
      runtime.setMode('full_access');
      await runtime.configureProvider({ baseUrl: fixture.baseUrl, model: 'fixture', apiKey: secret, skipProbe: true });
      expect((await runtime.submitTurn('start background')).ok).toBe(true);
      const snapshot = JSON.stringify(runtime.getSnapshot().managedProcesses);
      expect(snapshot).toContain('***redacted***');
      expect(snapshot).not.toContain(secret);
      for (const file of listDataFiles(env.dataRoot)) {
        if (!fs.statSync(file).isFile()) continue;
        expect(fs.readFileSync(file).includes(Buffer.from(secret, 'utf8'))).toBe(false);
      }
      await runtime.shutdown();
    } finally {
      await fixture.close();
      fs.rmSync(env.root, { recursive: true, force: true });
    }
  }, 30_000);

  it('reconciles a crash-time workspace manifest before exposing checkpoint undo', async () => {
    const env = makeEnv();
    let first: any;
    let reopened: any;
    try {
      first = makeRuntime(env);
      const sessionId = first.getSnapshot().activeConversationId;
      await first.shutdown();

      const db = new Database(path.join(env.dataRoot, 'a9-state.db'));
      const now = new Date().toISOString();
      db.prepare('INSERT INTO a9_tasks (task_id, session_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run('task-crash-manifest', sessionId, 'active', now, now);
      db.prepare('INSERT INTO a9_turns (turn_id, task_id, session_id, status, outcome_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run('turn-crash-manifest-full-id', 'task-crash-manifest', sessionId, 'active', '{}', now, now);
      db.prepare('INSERT INTO a9_runs (run_id, turn_id, session_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run('run-crash-manifest', 'turn-crash-manifest-full-id', sessionId, 'active', now, now);
      db.close();

      const { A9WorkspaceService } = require('../../../workspace/dist');
      const workspace = new A9WorkspaceService(env.workspaceRoot);
      await workspace.freezeTurnBaseline('turn-crash-manifest-full-id');
      fs.writeFileSync(path.join(env.workspaceRoot, 'note.txt'), 'changed before crash\n', 'utf8');

      reopened = makeRuntime(env);
      // A9-61: startup reconciliation validates manifests cooperatively; IPC serves snapshots once it settled.
      await reopened.whenReady();
      const snapshot = reopened.getSnapshot();
      expect(snapshot.checkpoints).toEqual(expect.arrayContaining([
        expect.objectContaining({ turnId: 'turn-crash-manifest-full-id' }),
      ]));
      expect(snapshot.interruptions).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'turn', id: 'turn-crash-manifest-full-id' }),
      ]));
      expect(fs.readFileSync(path.join(env.workspaceRoot, 'note.txt'), 'utf8')).toBe('changed before crash\n');
      const firstUndo = await reopened.undoTurn('turn-crash-manifest-full-id');
      expect(firstUndo.ok).toBe(true);
      expect(firstUndo.needsConfirmation).toBe(true);
      expect(firstUndo.externalChanges.changes).toContainEqual(expect.objectContaining({
        path: 'note.txt', kind: 'modified', recoverable: true,
      }));
      expect(fs.readFileSync(path.join(env.workspaceRoot, 'note.txt'), 'utf8')).toBe('changed before crash\n');
      const unconfirmedRetry = await reopened.undoTurn('turn-crash-manifest-full-id');
      expect(unconfirmedRetry.needsConfirmation).toBe(true);
      expect(unconfirmedRetry.confirmationId).toBe(firstUndo.confirmationId);
      expect(fs.readFileSync(path.join(env.workspaceRoot, 'note.txt'), 'utf8')).toBe('changed before crash\n');
      const confirmedUndo = await reopened.undoTurn('turn-crash-manifest-full-id', firstUndo.confirmationId);
      expect(confirmedUndo.ok).toBe(true);
      expect(confirmedUndo.needsConfirmation).toBeUndefined();
      expect(fs.readFileSync(path.join(env.workspaceRoot, 'note.txt'), 'utf8')).toBe('n\n');
    } finally {
      if (reopened) await reopened.shutdown();
      else if (first) await first.shutdown();
      fs.rmSync(env.root, { recursive: true, force: true });
    }
  }, 30_000);

  it('leaves an older unbound v4 checkpoint unknown to SQLite untouched without blocking new work', async () => {
    const env = makeEnv();
    const fixture = await startQuickFixture();
    const manifestDir = path.join(env.workspaceRoot, '.agent_recovery', 'checkpoints');
    fs.mkdirSync(manifestDir, { recursive: true });
    const now = new Date().toISOString();
    fs.writeFileSync(path.join(manifestDir, 'legacy-v4.json'), `${JSON.stringify({
      schemaVersion: 4,
      turnId: 'legacy-v4',
      createdAt: now,
      updatedAt: now,
      changes: {},
      unrecoverable: {},
    })}\n`, 'utf8');
    const runtime = makeRuntime(env);
    try {
      const initial = runtime.getSnapshot();
      // A9-21 M1: startup only reads manifests of interrupted Turns SQLite knows.
      // The legacy file is neither scanned nor quarantined and stays as evidence;
      // with no SQLite checkpoint its undo remains unavailable.
      expect(initial.checkpointRecoveryDiagnostics ?? null).toBeNull();
      expect(initial.checkpoints).toEqual([]);
      await expect(runtime.undoTurn('legacy-v4')).rejects.toMatchObject({ code: 'A9_CHECKPOINT_NOT_FOUND' });

      runtime.setMode('full_access');
      await runtime.configureProvider({ baseUrl: fixture.baseUrl, model: 'fixture', skipProbe: true });
      const result = await runtime.submitTurn('read note.txt');
      expect(result.ok).toBe(true);
      expect(result.result.outcome).toBe('completed');
      expect(fs.existsSync(path.join(manifestDir, 'legacy-v4.json'))).toBe(true);
    } finally {
      await runtime.shutdown();
      await fixture.close();
      fs.rmSync(env.root, { recursive: true, force: true });
    }
  }, 30_000);

  it('recovers only targeted interrupted Turns and reports missing or corrupt manifests without forging recovery', async () => {
    const env = makeEnv();
    let reopened: any;
    try {
      const first = makeRuntime(env);
      const sessionId = first.getSnapshot().activeConversationId;
      await first.shutdown();

      const { A9WorkspaceService } = require('../../../workspace/dist');
      const workspace = new A9WorkspaceService(env.workspaceRoot);
      await workspace.freezeTurnBaseline('turn-m1-valid');
      await workspace.freezeTurnBaseline('turn-m1-foreign');
      const manifestDir = path.join(env.workspaceRoot, '.agent_recovery', 'checkpoints');
      fs.writeFileSync(path.join(manifestDir, 'turn-m1-corrupt.json'), '{not-json', 'utf8');
      const db = new Database(path.join(env.dataRoot, 'a9-state.db'));
      const now = new Date().toISOString();
      db.prepare('INSERT INTO a9_sessions (session_id, workspace_path, created_at, updated_at, last_activated_at) VALUES (?, ?, ?, ?, ?)')
        .run('session-m1-foreign', path.join(env.root, 'other-workspace'), now, now, now);
      const insertTurn = (turnId: string, session: string) => {
        db.prepare('INSERT INTO a9_tasks (task_id, session_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
          .run(`task-${turnId}`, session, 'active', now, now);
        db.prepare('INSERT INTO a9_turns (turn_id, task_id, session_id, status, outcome_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(turnId, `task-${turnId}`, session, 'active', '{}', now, now);
      };
      for (const turnId of ['turn-m1-valid', 'turn-m1-corrupt', 'turn-m1-missing']) insertTurn(turnId, sessionId);
      insertTurn('turn-m1-foreign', 'session-m1-foreign');
      db.close();

      reopened = makeRuntime(env);
      // A9-61: startup reconciliation validates manifests cooperatively; IPC serves snapshots once it settled.
      await reopened.whenReady();
      const snapshot = reopened.getSnapshot();
      expect(snapshot.checkpoints).toEqual(expect.arrayContaining([
        expect.objectContaining({ turnId: 'turn-m1-valid' }),
      ]));
      expect(snapshot.checkpointRecoveryDiagnostics.code).toBe('A9_CHECKPOINT_TURNS_QUARANTINED');
      const rejected = snapshot.checkpointRecoveryDiagnostics.rejectedTurns;
      expect(rejected.map((entry: any) => [entry.turnId, entry.status]).sort()).toEqual([
        ['turn-m1-corrupt', 'quarantined'],
        ['turn-m1-missing', 'missing'],
      ]);
      for (const entry of rejected) expect(entry.detail.length).toBeLessThanOrEqual(300);

      const check = new Database(path.join(env.dataRoot, 'a9-state.db'), { readonly: true });
      const recovered = check.prepare('SELECT payload_json FROM a9_checkpoints WHERE turn_id = ?').get('turn-m1-valid') as any;
      expect(JSON.parse(recovered.payload_json).recoveredFromWorkspaceManifest).toBe(true);
      // Missing, corrupt and other-workspace Turns never get a forged recovery row.
      expect((check.prepare('SELECT COUNT(*) AS n FROM a9_checkpoints WHERE turn_id IN (?, ?, ?)')
        .get('turn-m1-corrupt', 'turn-m1-missing', 'turn-m1-foreign') as any).n).toBe(0);
      check.close();
    } finally {
      if (reopened) await reopened.shutdown();
      fs.rmSync(env.root, { recursive: true, force: true });
    }
  }, 30_000);

  it('keeps the workspace lock and allows shutdown retry while recovered PID cleanup is unresolved', async () => {
    const env = makeEnv();
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    let runtime: any;
    let contender: any;
    try {
      const seed = makeRuntime(env);
      await seed.shutdown();
      const db = new Database(path.join(env.dataRoot, 'a9-state.db'));
      db.prepare(`
        INSERT INTO a9_managed_processes
          (handle_id, workspace_path, pid, command, cwd, started_at, last_probe_status, pid_reuse_possible)
        VALUES (?, ?, ?, ?, ?, ?, 'running', 0)
      `).run('bg-recovered-shutdown', env.workspaceRoot, child.pid, 'previous command', env.workspaceRoot, new Date().toISOString());
      db.close();

      runtime = makeRuntime(env);
      const unresolved = await runtime.shutdown();
      expect(unresolved.leftToSystem[0]).toContain('recovered PID fact requires explicit stop confirmation');
      expect(runtime.getSnapshot().controls).toEqual({ canStop: true, stopKind: 'managed_process' });
      expect(runtime.getSnapshot().lock.held).toBe(true);

      contender = makeRuntime(env);
      expect(contender.getSnapshot().lock.held).toBe(false);
      await contender.shutdown();
      contender = null;

      const guarded = await runtime.stop();
      expect(guarded.ok).toBe(false);
      expect(guarded.errors[0].code).toBe('A9_RECOVERED_PROCESS_IDENTITY_UNCONFIRMED');
      expect(child.pid && (() => { try { process.kill(child.pid!, 0); return true; } catch (_error) { return false; } })()).toBe(true);

      child.kill();
      await new Promise<void>((resolve) => child.once('close', () => resolve()));
      expect((await runtime.stop()).ok).toBe(true);
      const retried = await runtime.shutdown();
      expect(retried.leftToSystem).toEqual([]);
      expect(runtime.getSnapshot().lock.held).toBe(false);
    } finally {
      if (contender) await contender.shutdown();
      if (runtime && runtime.getSnapshot().controls.canStop) await runtime.stop();
      if (runtime) await runtime.shutdown();
      if (child.pid && (() => { try { process.kill(child.pid, 0); return true; } catch (_err) { return false; } })()) child.kill('SIGKILL');
      fs.rmSync(env.root, { recursive: true, force: true });
    }
  }, 30_000);

  it('keeps persisted helper cleanup uncertainty visible and blocks clean exit after restart', async () => {
    const env = makeEnv();
    let runtime: any;
    try {
      const seed = makeRuntime(env);
      await seed.shutdown();
      const db = new Database(path.join(env.dataRoot, 'a9-state.db'));
      db.prepare(`
        INSERT INTO a9_managed_processes
          (handle_id, workspace_path, pid, command, cwd, started_at, last_probe_status, pid_reuse_possible)
        VALUES (?, ?, ?, ?, ?, ?, 'cleanup_required', 0)
      `).run('bg-helper-uncertain', env.workspaceRoot, process.pid, 'redacted helper command', env.workspaceRoot, new Date().toISOString());
      db.close();

      runtime = makeRuntime(env);
      expect(runtime.getSnapshot().managedProcesses).toEqual(expect.arrayContaining([
        expect.objectContaining({ handleId: 'bg-helper-uncertain', cleanupRequired: true }),
      ]));
      expect(runtime.getSnapshot().controls).toEqual({ canStop: true, stopKind: 'managed_process' });

      const guarded = await runtime.stop();
      expect(guarded.ok).toBe(false);
      expect(guarded.errors[0].code).toBe('A9_MANAGED_PROCESS_CLEANUP_UNCONFIRMED');

      const unresolved = await runtime.shutdown();
      expect(unresolved.leftToSystem[0]).toContain('recovered helper cleanup remains unconfirmed');
      expect(runtime.getSnapshot().lock.held).toBe(true);
    } finally {
      if (runtime) await runtime.shutdown();
      fs.rmSync(env.root, { recursive: true, force: true });
    }
  }, 30_000);
});

it('A9-32 permits a fresh continuation alongside a healthy owned background process without relaxing switching', async () => {
  const env = makeEnv(); const fixture = await startBackgroundFixture(); const runtime = makeRuntime(env, true);
  try {
    runtime.setMode('full_access'); await runtime.configureProvider({ baseUrl: fixture.baseUrl, model: 'fixture', skipProbe: true });
    await runtime.submitTurn('start managed process');
    const snapshot = runtime.getSnapshot(); expect(snapshot.managedProcesses.some((item: any) => item.lastProbeStatus === 'running')).toBe(true);
    const db = new Database(path.join(env.dataRoot, 'a9-state.db'));
    db.prepare("INSERT INTO a9_tasks(task_id,session_id,status,created_at,updated_at) VALUES('continue-task',?,'interrupted','2026-01-01','2026-01-01')").run(snapshot.activeConversationId);
    db.prepare("INSERT INTO a9_turns(turn_id,task_id,session_id,status,outcome_json,created_at,updated_at) VALUES('continue-old','continue-task',?,'interrupted','{}','2026-01-01','2026-01-01')").run(snapshot.activeConversationId);
    db.prepare("INSERT INTO a9_events(session_id,turn_id,kind,event_type,payload_json,created_at) VALUES(?,NULL,'model','conversation.request',?,'2026-01-01')").run(snapshot.activeConversationId, JSON.stringify({ taskId: 'continue-task', requestPrompt: 'continue' }));
    const recovery = runtime.getSnapshot().recoveryTasks.find((item: any) => item.taskId === 'continue-task');
    expect(recovery.canContinue).toBe(true); expect(runtime.canLeaveWorkspace().allowed).toBe(false);
    const result = await runtime.continueTask({ conversationId: recovery.conversationId, taskId: recovery.taskId, interruptedTurnId: recovery.interruptedTurnId, recoveryRevision: recovery.recoveryRevision });
    expect(result.ok).toBe(true); expect(result.continuation.turnId).not.toBe('continue-old'); expect(runtime.canLeaveWorkspace().allowed).toBe(false); db.close();
  } finally { await runtime.shutdown(); await fixture.close(); }
});

/** A9-34: real SQLite + current built Runner/State, without packaged/target runtime claims. */
async function recoveredCleanupEnv(mode = 'read_only', providerBaseUrl?: string) {
  const env = makeEnv(); const seed = makeRuntime(env);
  seed.setMode(mode);
  if (providerBaseUrl) await seed.configureProvider({ baseUrl: providerBaseUrl, model: 'fixture', skipProbe: true });
  const conversationId = seed.getSnapshot().activeConversationId;
  // Empty shutdown releases the actual SQLite workspace lock synchronously.
  void seed.shutdown();
  const { A9PersistenceManager } = require('../../../state/dist/a9-persistence');
  const opened = A9PersistenceManager.open({ databasePath: path.join(env.dataRoot, 'a9-state.db'), dataRoot: env.dataRoot,
    openDatabase: (p: string) => new Database(p) });
  if (opened.status !== 'ready') throw new Error(opened.status);
  const p = opened.manager;
  p.upsertTask('disposition-task', conversationId, 'completed');
  p.upsertTurn('disposition-turn', 'disposition-task', conversationId, 'completed');
  const owner = { workspace: env.workspaceRoot, conversationId, taskId: 'disposition-task', turnId: 'disposition-turn', toolCallId: 'disposition-call' };
  const fact = { handleId: 'recovered-cleanup', workspacePath: env.workspaceRoot, pid: 987654321,
    command: 'echo authorization=Bearer do-not-project', cwd: env.workspaceRoot, startedAt: '2026-10-27T00:00:00.000Z', lastProbeStatus: 'exited', cleanupRequired: true };
  p.recordManagedOwnership(fact, { schemaVersion: 1, owner, requestId: 'original-request', ownershipState: 'owned' });
  p.db.close();
  const db = new Database(path.join(env.dataRoot, 'a9-state.db'));
  return { env, db, owner, fact, open: () => makeRuntime(env), input: (runtime: any) => {
    const card = runtime.getSnapshot().managedProcesses.find((item: any) => item.handleId === fact.handleId);
    return { conversationId, handleId: fact.handleId, recoveryRevision: card.recoveryRevision };
  } };
}

it.each([
  ['released', 'cleanup_required', true],
  ['released', 'cleanup_required', false],
  ['release_intent', 'released', true],
  ['release_intent', 'released', false],
] as const)('A9-34 blocks ownership %s with fact %s at startup and stopManaged=%s', async (ownershipState, status, stopManaged) => {
  const f = await recoveredCleanupEnv();
  f.db.prepare('UPDATE a9_managed_processes SET last_probe_status = ? WHERE handle_id = ?').run(status, f.fact.handleId);
  f.db.prepare(`INSERT INTO a9_events (session_id, turn_id, kind, event_type, payload_json, created_at)
    VALUES (?, ?, 'tool', 'managed_process_ownership', ?, '2026-11-18')`)
    .run(f.owner.conversationId, f.owner.turnId, JSON.stringify({
      handleId: f.fact.handleId, schemaVersion: 1, owner: f.owner, requestId: 'original-request',
      ownershipState, releaseId: 'unconfirmed',
    }));
  const warn = jest.spyOn(process, 'emitWarning').mockImplementation(() => {});
  const runtime = f.open();
  try {
    expect(runtime.getSnapshot().managedProcesses[0]).toMatchObject({ cleanupRequired: true, canDismissRecovered: false });
    expect(() => runtime.createConversation()).toThrow('A9_CONVERSATION_BUSY');
    expect(() => runtime.setMode('full_access')).toThrow('A9_MODE_CHANGE_BLOCKED_MANAGED_PROCESS');
    expect(runtime.setMode('read_only')).toMatchObject({ unchanged: true });
    expect(await runtime.shutdown({ stopManaged })).toMatchObject({ unresolved: [expect.any(String)] });
    expect(f.db.prepare('SELECT owner_id FROM a9_workspace_locks').get()).toBeDefined();
  } finally { await runtime.shutdown({ stopManaged }); warn.mockRestore(); f.db.close(); fs.rmSync(f.env.root, { recursive: true, force: true }); }
});

it('A9-34 leaves a deleted ownership event missing and refuses the old card before and after a snapshot', async () => {
  const f = await recoveredCleanupEnv();
  const warn = jest.spyOn(process, 'emitWarning').mockImplementation(() => {});
  const runtime = f.open();
  try {
    const input = f.input(runtime);
    f.db.prepare("DELETE FROM a9_events WHERE event_type='managed_process_ownership'").run();
    expect(runtime.dismissRecovered(input)).toMatchObject({ ok: false, error: { code: 'A9_MANAGED_OWNERSHIP_UNCONFIRMED' } });
    expect(runtime.getSnapshot().managedProcesses[0]).toMatchObject({ cleanupRequired: true, canDismissRecovered: false });
    expect(runtime.dismissRecovered(input)).toMatchObject({ ok: false, error: { code: 'A9_MANAGED_OWNERSHIP_UNCONFIRMED' } });
    expect(f.db.prepare("SELECT count(*) AS n FROM a9_events WHERE event_type IN ('managed_process_ownership','managed_process_disposition')").get()).toEqual({ n: 0 });
    expect(await runtime.shutdown()).toMatchObject({ unresolved: [expect.any(String)] });
  } finally { await runtime.shutdown(); warn.mockRestore(); f.db.close(); fs.rmSync(f.env.root, { recursive: true, force: true }); }
});

it.each([
  ['started_at', '2026-11-18', 'A9_MANAGED_RECOVERY_STALE'],
  ['workspace_path', '/other', 'A9_MANAGED_HANDLE_WRONG_OWNER'],
])('A9-34 snapshot preserves persistent %s drift and rejects the old card', async (column, value, code) => {
  const f = await recoveredCleanupEnv();
  const warn = jest.spyOn(process, 'emitWarning').mockImplementation(() => {});
  const runtime = f.open();
  try {
    const input = f.input(runtime);
    f.db.prepare(`UPDATE a9_managed_processes SET ${column}=? WHERE handle_id=?`).run(value, f.fact.handleId);
    const expected = { ok: false, error: { code } };
    expect(runtime.dismissRecovered(input)).toMatchObject(expected);
    expect(runtime.getSnapshot().managedProcesses.some((item: any) => item.canDismissRecovered)).toBe(false);
    expect(runtime.dismissRecovered(input)).toMatchObject(expected);
    expect(f.db.prepare(`SELECT ${column} AS value FROM a9_managed_processes WHERE handle_id=?`).get(f.fact.handleId)).toEqual({ value });
    expect(f.db.prepare("SELECT count(*) AS n FROM a9_events WHERE event_type='managed_process_disposition'").get()).toEqual({ n: 0 });
  } finally { await runtime.shutdown(); warn.mockRestore(); f.db.close(); fs.rmSync(f.env.root, { recursive: true, force: true }); }
});

it('A9-34 preserves cleanup after restart with an unfinished release and absent PID', async () => {
  const f = await recoveredCleanupEnv();
  f.db.prepare("UPDATE a9_managed_processes SET last_probe_status='running' WHERE handle_id=?").run(f.fact.handleId);
  f.db.prepare(`INSERT INTO a9_events (session_id, turn_id, kind, event_type, payload_json, created_at)
    VALUES (?, ?, 'tool', 'managed_process_ownership', ?, '2026-11-18')`).run(f.owner.conversationId, f.owner.turnId,
    JSON.stringify({ handleId: f.fact.handleId, schemaVersion: 1, owner: f.owner, requestId: 'original-request',
      ownershipState: 'release_intent', releaseId: 'release-pending' }));
  const runtime = f.open();
  try {
    expect(runtime.getSnapshot().managedProcesses[0]).toMatchObject({
      cleanupRequired: true, ownershipState: 'release_intent', canDismissRecovered: false,
    });
    expect(() => runtime.setMode('full_access')).toThrow('A9_MODE_CHANGE_BLOCKED_MANAGED_PROCESS');
    expect(await runtime.shutdown({ stopManaged: false })).toMatchObject({ unresolved: [expect.any(String)] });
    expect(f.db.prepare('SELECT owner_id FROM a9_workspace_locks').get()).toBeDefined();
  } finally { await runtime.shutdown({ stopManaged: false }); f.db.close(); fs.rmSync(f.env.root, { recursive: true, force: true }); }
});

it('A9-34 refuses disposal after an ownership event with an object handle is appended', async () => {
  const f = await recoveredCleanupEnv();
  const warn = jest.spyOn(process, 'emitWarning').mockImplementation(() => {});
  const runtime = f.open();
  try {
    const input = f.input(runtime);
    f.db.prepare(`INSERT INTO a9_events (session_id, turn_id, kind, event_type, payload_json, created_at)
      VALUES (?, ?, 'tool', 'managed_process_ownership', ?, '2026-11-18')`).run(f.owner.conversationId, f.owner.turnId,
      JSON.stringify({ handleId: { value: f.fact.handleId }, schemaVersion: 1, owner: f.owner,
        requestId: 'original-request', ownershipState: 'owned' }));
    expect(runtime.getSnapshot().managedProcesses[0].canDismissRecovered).toBe(false);
    expect(runtime.dismissRecovered(input)).toMatchObject({ ok: false, error: { code: 'A9_MANAGED_OWNERSHIP_CORRUPT' } });
  } finally { await runtime.shutdown(); warn.mockRestore(); f.db.close(); fs.rmSync(f.env.root, { recursive: true, force: true }); }
});

it('A9-34 preserves wrong-owner refusal after a snapshot isolates the handle', async () => {
  const f = await recoveredCleanupEnv();
  const warn = jest.spyOn(process, 'emitWarning').mockImplementation(() => {});
  const runtime = f.open();
  try {
    const input = f.input(runtime);
    f.db.prepare(`UPDATE a9_events SET payload_json=json_set(payload_json,'$.owner.workspace','/other')
      WHERE event_type='managed_process_ownership'`).run();
    const expected = { ok: false, error: { code: 'A9_MANAGED_HANDLE_WRONG_OWNER' } };
    expect(runtime.dismissRecovered(input)).toMatchObject(expected);
    expect(runtime.getSnapshot().managedProcesses[0].canDismissRecovered).toBe(false);
    expect(runtime.dismissRecovered(input)).toMatchObject(expected);
  } finally { await runtime.shutdown(); warn.mockRestore(); f.db.close(); fs.rmSync(f.env.root, { recursive: true, force: true }); }
});

/** A durable intent -> released receipt chain, written through the real State API before restart. */
function releasedRestartEnv() {
  const env = makeEnv(); const seed = makeRuntime(env);
  const conversationId = seed.getSnapshot().activeConversationId;
  void seed.shutdown();
  const { A9PersistenceManager } = require('../../../state/dist/a9-persistence');
  const opened = A9PersistenceManager.open({ databasePath: path.join(env.dataRoot, 'a9-state.db'), dataRoot: env.dataRoot,
    openDatabase: (p: string) => new Database(p) });
  if (opened.status !== 'ready') throw new Error(opened.status);
  const p = opened.manager;
  p.upsertTask('release-task', conversationId, 'completed');
  p.upsertTask('other-task', conversationId, 'completed');
  p.upsertTurn('release-turn', 'release-task', conversationId, 'completed');
  const owner = { workspace: env.workspaceRoot, conversationId, taskId: 'release-task', turnId: 'release-turn', toolCallId: 'release-call' };
  const fact = { handleId: 'released-helper', workspacePath: env.workspaceRoot, pid: 987654320, command: 'serve', cwd: env.workspaceRoot,
    startedAt: '2026-11-18T00:00:00.000Z', lastProbeStatus: 'running' };
  const ownership = { schemaVersion: 1, owner, requestId: 'release-request', ownershipState: 'owned' };
  p.recordManagedOwnership(fact, ownership);
  p.recordManagedOwnership(fact, { ...ownership, ownershipState: 'release_intent', releaseId: 'release-1' });
  p.recordManagedOwnership({ ...fact, lastProbeStatus: 'released', cleanupRequired: false },
    { ...ownership, ownershipState: 'released', releaseId: 'release-1' });
  p.db.close();
  return { env, conversationId, db: new Database(path.join(env.dataRoot, 'a9-state.db')) };
}

it.each([
  ['a valid release in an archived conversation', "UPDATE a9_sessions SET state = 'archived'", true],
  ['every ownership event removed', "DELETE FROM a9_events WHERE event_type = 'managed_process_ownership'", false],
  ['owner.taskId no longer matching the persistent task', `UPDATE a9_events SET payload_json = json_set(payload_json, '$.owner.taskId', 'other-task')
    WHERE event_type = 'managed_process_ownership'`, false],
  ['its release intent removed', `DELETE FROM a9_events WHERE event_type = 'managed_process_ownership'
    AND json_extract(payload_json, '$.ownershipState') = 'release_intent'`, false],
] as const)('A9-34 restart shutdown with a released row and %s', async (_name, mutation, releasable) => {
  const f = releasedRestartEnv();
  f.db.exec(mutation);
  const warn = jest.spyOn(process, 'emitWarning').mockImplementation(() => {});
  const runtime = makeRuntime(f.env);
  try {
    expect(runtime.getSnapshot().managedProcesses[0]).toMatchObject({ handleId: 'released-helper', cleanupRequired: !releasable });
    // A refused attempt is retryable under either choice; a clean exit is cached for its choice.
    for (const stopManaged of releasable ? [false] : [true, false]) {
      const result = await runtime.shutdown({ stopManaged });
      expect(result.unresolved).toHaveLength(releasable ? 0 : 1);
      expect(f.db.prepare('SELECT count(*) AS n FROM a9_workspace_locks').get()).toEqual({ n: releasable ? 0 : 1 });
    }
    expect(f.db.prepare('SELECT last_probe_status FROM a9_managed_processes').get()).toEqual({ last_probe_status: 'released' });
  } finally { await runtime.shutdown({ stopManaged: false }); warn.mockRestore(); f.db.close(); fs.rmSync(f.env.root, { recursive: true, force: true }); }
});

it('A9-34 fast shutdown keeps the lock for a cleanup fact another SQLite connection committed', async () => {
  const f = releasedRestartEnv();
  const runtime = makeRuntime(f.env);
  try {
    expect(runtime.getSnapshot().managedProcesses[0]).toMatchObject({ cleanupRequired: false });
    // Not adopted by this Runtime's manager: only the final State transaction can see it.
    f.db.prepare(`INSERT INTO a9_managed_processes (handle_id, workspace_path, pid, command, cwd, started_at, last_probe_status, pid_reuse_possible)
      VALUES ('foreign-window', ?, 7, 'late', ?, '2026-11-19', 'cleanup_required', 0)`).run(f.env.workspaceRoot, f.env.workspaceRoot);
    const blocked = await runtime.shutdown({ stopManaged: false });
    expect(blocked.unresolved).toEqual([expect.stringContaining('foreign-window')]);
    expect(runtime.getSnapshot().lock.held).toBe(true);
    expect(f.db.prepare('SELECT count(*) AS n FROM a9_workspace_locks').get()).toEqual({ n: 1 });
    f.db.prepare("DELETE FROM a9_managed_processes WHERE handle_id = 'foreign-window'").run();
    expect(await runtime.shutdown({ stopManaged: false })).toEqual({ stopped: [], leftToSystem: [], unresolved: [] });
    expect(f.db.prepare('SELECT count(*) AS n FROM a9_workspace_locks').get()).toEqual({ n: 0 });
  } finally { await runtime.shutdown({ stopManaged: false }); f.db.close(); fs.rmSync(f.env.root, { recursive: true, force: true }); }
});

it('A9-34 disposition closes Stop, switching, shutdown, lock and restart without claiming cleanup', async () => {
  const f = await recoveredCleanupEnv(); let runtime = f.open(); let reopened: any;
  try {
    const input = f.input(runtime);
    const first = runtime.getSnapshot();
    expect(first.provider.configured).toBe(false); expect(first.mode).toBe('read_only');
    expect(first.managedProcesses[0]).toMatchObject({ canDismissRecovered: true, recoveryRevision: input.recoveryRevision });
    expect(first.managedProcesses[0].command).toContain('***redacted***');
    expect(first.managedProcesses[0].command).not.toContain('do-not-project');
    expect(runtime.getSnapshot().managedProcesses[0].recoveryRevision).toBe(input.recoveryRevision);
    expect(runtime.canLeaveWorkspace().allowed).toBe(false);
    expect(() => runtime.createConversation()).toThrow('CONVERSATION_BUSY');
    expect(() => runtime.setMode('full_access')).toThrow('MODE_CHANGE_BLOCKED_MANAGED_PROCESS');
    expect((await runtime.stop()).ok).toBe(false);
    const result = runtime.dismissRecovered(input);
    expect(result).toMatchObject({ ok: true, disposition: { disposition: 'user_attested_after_restart', requestId: 'original-request',
      pidProbe: { pid: f.fact.pid, status: 'absent' } } });
    expect(runtime.getSnapshot().controls).toEqual({ canStop: false, stopKind: 'none' });
    expect((await runtime.stop()).error.code).toBe('NO_ACTIVE_TURN_OR_MANAGED_PROCESS');
    expect(runtime.getSnapshot().managedProcesses[0]).toMatchObject({ lastProbeStatus: 'user_dismissed', cleanupRequired: false,
      disposition: result.disposition });
    expect(runtime.dismissRecovered(input)).toEqual(result);
    expect(runtime.dismissRecovered({ ...input, recoveryRevision: 'b'.repeat(64) })).toMatchObject({ ok: false, error: { code: 'A9_MANAGED_RECOVERY_STALE' } });
    expect(f.db.prepare("SELECT count(*) AS n FROM a9_events WHERE event_type='managed_process_disposition'").get()).toEqual({ n: 1 });
    expect(runtime.canLeaveWorkspace().allowed).toBe(true);
    const next = runtime.createConversation(); expect(next.ok).toBe(true);
    expect(runtime.activateConversation(f.owner.conversationId).ok).toBe(true);
    expect(runtime.setMode('full_access').ok).toBe(true);
    expect(await runtime.shutdown()).toEqual({ stopped: [], leftToSystem: [], unresolved: [] });
    expect(runtime.getSnapshot().lock.held).toBe(false);
    expect(f.db.prepare('SELECT count(*) AS n FROM a9_workspace_locks').get()).toEqual({ n: 0 });
    expect(f.db.prepare('SELECT last_probe_status FROM a9_managed_processes').get()).toEqual({ last_probe_status: 'user_dismissed' });
    reopened = f.open();
    expect(reopened.getSnapshot().controls.canStop).toBe(false);
    expect(reopened.getSnapshot().managedProcesses[0]).toMatchObject({ lastProbeStatus: 'user_dismissed', disposition: result.disposition });
    // Same identity remains idempotent across restart without a new PID probe.
    const kill = jest.spyOn(process, 'kill');
    expect(reopened.dismissRecovered(input)).toEqual(result);
    expect(kill).not.toHaveBeenCalled(); kill.mockRestore();
  } finally { if (reopened) await reopened.shutdown(); await runtime.shutdown(); f.db.close(); fs.rmSync(f.env.root, { recursive: true, force: true }); }
});

it.each(['wrong-conversation', 'wrong-workspace', 'unknown', 'revision', 'drift', 'owner-missing', 'release_intent', 'release_unknown', 'released',
  'lock-lost', 'live-pid', 'probe-unknown'])('A9-34 runtime rejects without removing recovered facts: %s', async (bad) => {
  const f = await recoveredCleanupEnv(); const runtime = f.open();
  const Runner = require('../../../runner/dist/background-process-manager').BackgroundProcessManager;
  const probe = Runner.probeProcessPresence;
  try {
    const input = f.input(runtime);
    if (bad === 'wrong-conversation') input.conversationId = 'other';
    if (bad === 'unknown') input.handleId = 'unknown';
    if (bad === 'revision') input.recoveryRevision = 'b'.repeat(64);
    if (bad === 'drift') f.db.prepare("UPDATE a9_managed_processes SET started_at='changed'").run();
    if (bad === 'wrong-workspace') f.db.prepare("UPDATE a9_managed_processes SET workspace_path='/other'").run();
    if (bad === 'owner-missing') f.db.prepare("DELETE FROM a9_events WHERE event_type='managed_process_ownership'").run();
    if (['release_intent', 'release_unknown', 'released'].includes(bad)) {
      f.db.prepare("UPDATE a9_events SET payload_json=json_set(payload_json,'$.ownershipState',?) WHERE event_type='managed_process_ownership'").run(bad);
    }
    if (bad === 'lock-lost') f.db.prepare("UPDATE a9_workspace_locks SET owner_id='other'").run();
    if (bad === 'live-pid') Runner.probeProcessPresence = () => 'alive';
    if (bad === 'probe-unknown') Runner.probeProcessPresence = () => 'unknown';
    expect(runtime.dismissRecovered(input).ok).toBe(false);
    expect(f.db.prepare("SELECT count(*) AS n FROM a9_events WHERE event_type='managed_process_disposition'").get()).toEqual({ n: 0 });
    // No snapshot sync here: the original durable rejection state must remain unchanged.
    expect(f.db.prepare('SELECT last_probe_status FROM a9_managed_processes').get()).toEqual({ last_probe_status: 'cleanup_required' });
    expect(runtime.canLeaveWorkspace().allowed).toBe(false);
    expect((await runtime.shutdown()).unresolved).toHaveLength(1);
  } finally { Runner.probeProcessPresence = probe; await runtime.shutdown(); f.db.close(); fs.rmSync(f.env.root, { recursive: true, force: true }); }
});

it('A9-34 required disposition audit failure rolls back and retains the memory blocker', async () => {
  const f = await recoveredCleanupEnv(); const runtime = f.open();
  try {
    const input = f.input(runtime);
    f.db.exec("CREATE TRIGGER fail_disposition AFTER INSERT ON a9_events WHEN NEW.event_type='managed_process_disposition' BEGIN SELECT RAISE(FAIL,'required audit failed'); END");
    expect(runtime.dismissRecovered(input)).toMatchObject({ ok: false, error: { code: 'A9_AUDIT_PERSISTENCE_FAILED' } });
    expect(f.db.prepare("SELECT count(*) AS n FROM a9_events WHERE event_type='managed_process_disposition'").get()).toEqual({ n: 0 });
    expect(runtime.getSnapshot().controls.canStop).toBe(true);
    expect((await runtime.shutdown()).unresolved).toHaveLength(1);
    expect(runtime.getSnapshot().lock.held).toBe(true);
    // Fixing storage and disposing this fact does not erase the independent audit failure.
    f.db.exec('DROP TRIGGER fail_disposition');
    expect(runtime.dismissRecovered(input).ok).toBe(true);
    expect((await runtime.submitTurn('do not dispatch')).error.code).toBe('A9_AUDIT_PERSISTENCE_FAILED');
  } finally { await runtime.shutdown(); f.db.close(); fs.rmSync(f.env.root, { recursive: true, force: true }); }
});

it('A9-34 disposition leaves another recovered blocker and rejects overlap with Stop or shutdown', async () => {
  const f = await recoveredCleanupEnv(); const runtime = f.open();
  try {
    const input = f.input(runtime);
    const stopping = runtime.stop();
    expect(runtime.dismissRecovered(input)).toMatchObject({ ok: false, error: { code: 'A9_MANAGED_DISPOSITION_BUSY' } });
    await stopping;
    const shuttingDown = runtime.shutdown();
    expect(runtime.dismissRecovered(input)).toMatchObject({ ok: false, error: { code: 'A9_MANAGED_DISPOSITION_BUSY' } });
    await shuttingDown;
    // A second original fact is adopted only on a fresh Runtime, as in a real restart.
    f.db.prepare("INSERT INTO a9_managed_processes SELECT 'other-recovered',workspace_path,pid,command,cwd,started_at,last_probe_status,pid_reuse_possible FROM a9_managed_processes WHERE handle_id=?").run(f.fact.handleId);
    // The failed shutdown retained the lock. Reopen after an explicit test-only lock release.
    f.db.prepare('DELETE FROM a9_workspace_locks').run();
    const other = f.open();
    try {
      expect(other.dismissRecovered(f.input(other)).ok).toBe(true);
      expect(other.getSnapshot().controls.canStop).toBe(true);
      expect(other.canLeaveWorkspace().allowed).toBe(false);
      expect(() => other.setMode('full_access')).toThrow('MODE_CHANGE_BLOCKED_MANAGED_PROCESS');
      const result = await other.shutdown(); expect(result.unresolved).toHaveLength(1);
      expect(result.unresolved[0]).toContain('other-recovered');
      expect(other.getSnapshot().lock.held).toBe(true);
    } finally { await other.shutdown(); }
  } finally { await runtime.shutdown(); f.db.close(); fs.rmSync(f.env.root, { recursive: true, force: true }); }
});

it.each(['turn', 'approval'])('A9-34 disposition preserves the independent %s blocker', async (kind) => {
  const fixture = kind === 'turn' ? await startDelayedFixture() : await startHeldApprovalFixture();
  const f = await recoveredCleanupEnv('full_access', fixture.baseUrl); const runtime = f.open();
  let turn: Promise<any> | undefined;
  try {
    const input = f.input(runtime);
    turn = runtime.submitTurn(kind === 'turn' ? 'read note' : 'delete note');
    if (kind === 'approval') expect((await turn).result.pendingApproval).toBeDefined();
    else expect(runtime.getSnapshot().agentStatus).toBe('running');
    expect(runtime.dismissRecovered(input).ok).toBe(true);
    expect(runtime.getSnapshot().managedProcesses[0].lastProbeStatus).toBe('user_dismissed');
    expect(runtime.canLeaveWorkspace().allowed).toBe(false);
    expect(() => runtime.createConversation()).toThrow('A9_CONVERSATION_BUSY');
    expect(() => runtime.setMode('read_only')).toThrow('A9_MODE_CHANGE_BLOCKED_ACTIVE_TURN');
    expect((await runtime.submitTurn('blocked')).error.code).toBe(kind === 'turn' ? 'A9_TURN_ALREADY_ACTIVE' : 'A9_APPROVAL_REQUIRED');
  } finally {
    fixture.release(); await runtime.stop(); if (turn) await turn;
    await runtime.shutdown(); await fixture.close(); f.db.close(); fs.rmSync(f.env.root, { recursive: true, force: true });
  }
});

it('A9-34 rejects a disposition after the workspace lock has been released', async () => {
  const f = await recoveredCleanupEnv(); const runtime = f.open();
  try {
    const input = f.input(runtime);
    expect(runtime.dismissRecovered(input).ok).toBe(true);
    await runtime.shutdown();
    expect(runtime.dismissRecovered(input)).toMatchObject({ ok: false, error: { code: 'A9_WORKSPACE_LOCKED' } });
  } finally { await runtime.shutdown(); f.db.close(); fs.rmSync(f.env.root, { recursive: true, force: true }); }
});

// ADR-0344 regressions. Real Runtime + file SQLite + current built Runner/State; the
// process.kill spy only scripts the probe of one never-signalled synthetic PID.
function scriptedPidProbe(pid: number) {
  const realKill = process.kill.bind(process);
  const state = { result: 'alive' as 'alive' | 'absent' | 'EINVAL' };
  const spy = jest.spyOn(process, 'kill').mockImplementation(((target: number, signal?: any) => {
    if (target !== pid) return realKill(target, signal);
    if (signal !== 0) throw new Error(`TEST_ONLY: signal ${signal} sent to synthetic PID`);
    if (state.result === 'alive') return true;
    throw Object.assign(new Error(state.result === 'absent' ? 'ESRCH' : 'EINVAL'), { code: state.result === 'absent' ? 'ESRCH' : 'EINVAL' });
  }) as any);
  return { state, restore: () => spy.mockRestore(), signals: () => spy.mock.calls.filter(([target]) => target === pid).map(([, signal]) => signal) };
}

async function legacyRecoveredEnv(pid: number) {
  const env = makeEnv(); const seed = makeRuntime(env); await seed.shutdown();
  const db = new Database(path.join(env.dataRoot, 'a9-state.db'));
  db.prepare(`INSERT INTO a9_managed_processes (handle_id, workspace_path, pid, command, cwd, started_at, last_probe_status, pid_reuse_possible)
    VALUES ('legacy-recovered', ?, ?, 'previous command', ?, '2026-11-18T00:00:00.000Z', 'running', 0)`).run(env.workspaceRoot, pid, env.workspaceRoot);
  const row = () => db.prepare("SELECT pid, started_at, last_probe_status FROM a9_managed_processes WHERE handle_id = 'legacy-recovered'").get();
  const lockRows = () => (db.prepare('SELECT count(*) AS n FROM a9_workspace_locks').get() as { n: number }).n;
  return { env, db, row, lockRows };
}

it.each([
  ['stop', 'identity replaced by another connection'],
  ['shutdown', 'identity replaced by another connection'],
  ['stop', 'probe unknown'],
  ['shutdown', 'probe unknown'],
  ['stop', 'same identity, PID gone'],
  ['shutdown', 'same identity, PID gone'],
] as const)('a recovered legacy PID settles only its own identity via %s (%s)', async (entry, variant) => {
  const pid = 987654300 + Math.floor(Math.random() * 99);
  const probe = scriptedPidProbe(pid);
  const f = await legacyRecoveredEnv(pid); let runtime: any;
  try {
    runtime = makeRuntime(f.env);
    expect(f.row()).toEqual({ pid, started_at: '2026-11-18T00:00:00.000Z', last_probe_status: 'running_unknown' });
    if (variant === 'identity replaced by another connection') {
      f.db.prepare("UPDATE a9_managed_processes SET pid = ?, started_at = '2026-11-19T00:00:00.000Z', last_probe_status = 'running' WHERE handle_id = 'legacy-recovered'").run(pid + 1);
    }
    probe.state.result = variant === 'probe unknown' ? 'EINVAL' : 'absent';
    const expectedRow = variant === 'identity replaced by another connection'
      ? { pid: pid + 1, started_at: '2026-11-19T00:00:00.000Z', last_probe_status: 'running' }
      : variant === 'probe unknown' ? { pid, started_at: '2026-11-18T00:00:00.000Z', last_probe_status: 'running_unknown' }
        : { pid, started_at: '2026-11-18T00:00:00.000Z', last_probe_status: 'exited' };
    if (entry === 'stop') {
      const stopped = await runtime.stop();
      if (variant === 'same identity, PID gone') expect(stopped).toEqual({ ok: true, stopped: ['legacy-recovered'] });
      else expect(stopped.errors).toEqual([expect.objectContaining({ handleId: 'legacy-recovered',
        code: variant === 'probe unknown' ? 'A9_MANAGED_PID_PROBE_UNKNOWN' : 'A9_MANAGED_RECOVERY_STALE' })]);
    }
    const closed = await runtime.shutdown({ stopManaged: true });
    expect(f.row()).toEqual(expectedRow);
    if (variant === 'same identity, PID gone') {
      expect(closed.unresolved).toEqual([]);
      expect(f.lockRows()).toBe(0);
    } else {
      expect(closed.unresolved.length).toBeGreaterThan(0);
      expect(f.lockRows()).toBe(1);
      expect(runtime.getSnapshot().lock.held).toBe(true);
      expect(runtime.getSnapshot().conversationControls.canSwitch).toBe(false);
      expect(runtime.canLeaveWorkspace().allowed).toBe(false);
    }
    expect(probe.signals().every((signal: unknown) => signal === 0)).toBe(true);
  } finally {
    probe.state.result = 'absent';
    if (runtime) { f.db.prepare("DELETE FROM a9_managed_processes WHERE handle_id = 'legacy-recovered'").run(); await runtime.shutdown({ stopManaged: true }); }
    probe.restore(); f.db.close(); fs.rmSync(f.env.root, { recursive: true, force: true });
  }
});

it.each([[null], [0], [-1]] as const)('a recovered legacy starting fact with invalid PID %p stays unknown and keeps every blocker', async (pid) => {
  const kill = jest.spyOn(process, 'kill');
  const f = await legacyRecoveredEnv(pid as unknown as number); let runtime: any;
  try {
    f.db.prepare("UPDATE a9_managed_processes SET last_probe_status = 'starting' WHERE handle_id = 'legacy-recovered'").run();
    runtime = makeRuntime(f.env);
    const unknown = { pid, started_at: '2026-11-18T00:00:00.000Z', last_probe_status: 'running_unknown' };
    expect(f.row()).toEqual(unknown);
    expect(runtime.getSnapshot().conversationControls.canSwitch).toBe(false);
    expect(runtime.getSnapshot({ bypassCache: true }).conversationControls.canSwitch).toBe(false);
    expect(runtime.canLeaveWorkspace().allowed).toBe(false);
    // The invalid PID is the persisted identity: adoption is neither isolated nor rewritten.
    expect(runtime.getSnapshot().managedProcesses).toEqual([expect.objectContaining({ handleId: 'legacy-recovered',
      pid, lastProbeStatus: 'running_unknown' })]);
    expect(runtime.getSnapshot().controls).toEqual({ canStop: true, stopKind: 'managed_process' });
    const stopped = await runtime.stop();
    expect(stopped.errors).toEqual([expect.objectContaining({ handleId: 'legacy-recovered', code: 'A9_MANAGED_PID_PROBE_UNKNOWN' })]);
    const closed = await runtime.shutdown({ stopManaged: true });
    expect(closed.unresolved.length).toBeGreaterThan(0);
    expect(f.row()).toEqual(unknown);
    expect(f.lockRows()).toBe(1);
    // No invalid PID is ever probed or signalled.
    expect(kill.mock.calls.filter(([target]) => !(Number.isSafeInteger(target) && Number(target) > 0))).toEqual([]);
  } finally {
    kill.mockRestore();
    if (runtime) { f.db.prepare("DELETE FROM a9_managed_processes WHERE handle_id = 'legacy-recovered'").run(); await runtime.shutdown({ stopManaged: true }); }
    f.db.close(); fs.rmSync(f.env.root, { recursive: true, force: true });
  }
});

it.each([
  ['stop', 'stop'], ['stop', 'shutdown'], ['shutdown', 'stop'], ['shutdown', 'shutdown'],
] as const)('an ignored recovered terminal write first seen by %s is retried by %s with its original identity', async (first, retry) => {
  const pid = 987654400 + Math.floor(Math.random() * 99);
  const probe = scriptedPidProbe(pid);
  const f = await legacyRecoveredEnv(pid); let runtime: any;
  const unknown = { pid, started_at: '2026-11-18T00:00:00.000Z', last_probe_status: 'running_unknown' };
  try {
    runtime = makeRuntime(f.env);
    expect(f.row()).toEqual(unknown);
    probe.state.result = 'absent';
    f.db.exec("CREATE TRIGGER ignore_exit BEFORE UPDATE ON a9_managed_processes WHEN NEW.last_probe_status='exited' BEGIN SELECT RAISE(IGNORE); END");
    if (first === 'stop') {
      const stopped = await runtime.stop();
      expect(stopped.errors).toEqual([expect.objectContaining({ handleId: 'legacy-recovered', code: 'A9_PERSISTENCE_WRITE_UNCONFIRMED' })]);
    } else {
      const closed = await runtime.shutdown({ stopManaged: true });
      expect(closed.unresolved).toEqual(expect.arrayContaining([expect.stringContaining('legacy-recovered')]));
    }
    expect(f.row()).toEqual(unknown);
    expect(f.lockRows()).toBe(1);
    expect(runtime.getSnapshot().conversationControls.canSwitch).toBe(false);
    expect(runtime.canLeaveWorkspace().allowed).toBe(false);
    f.db.exec('DROP TRIGGER ignore_exit');
    if (retry === 'stop') expect(await runtime.stop()).toEqual({ ok: true, stopped: ['legacy-recovered'] });
    const closed = await runtime.shutdown({ stopManaged: true });
    expect(closed.unresolved).toEqual([]);
    expect(f.row()).toEqual({ ...unknown, last_probe_status: 'exited' });
    expect(f.lockRows()).toBe(0);
    expect(probe.signals().every((signal: unknown) => signal === 0)).toBe(true);
  } finally {
    probe.state.result = 'absent';
    if (runtime) await runtime.shutdown({ stopManaged: true });
    probe.restore(); f.db.close(); fs.rmSync(f.env.root, { recursive: true, force: true });
  }
});

it('an unconfirmed recovered terminal write never settles an identity another connection replaced', async () => {
  const pid = 987654500 + Math.floor(Math.random() * 99);
  const probe = scriptedPidProbe(pid);
  const f = await legacyRecoveredEnv(pid); let runtime: any;
  try {
    runtime = makeRuntime(f.env);
    probe.state.result = 'absent';
    f.db.exec("CREATE TRIGGER ignore_exit BEFORE UPDATE ON a9_managed_processes WHEN NEW.last_probe_status='exited' BEGIN SELECT RAISE(IGNORE); END");
    expect((await runtime.stop()).errors[0].code).toBe('A9_PERSISTENCE_WRITE_UNCONFIRMED');
    f.db.exec('DROP TRIGGER ignore_exit');
    const replaced = { pid: pid + 1, started_at: '2026-11-19T00:00:00.000Z', last_probe_status: 'running' };
    f.db.prepare("UPDATE a9_managed_processes SET pid = ?, started_at = ?, last_probe_status = 'running' WHERE handle_id = 'legacy-recovered'")
      .run(replaced.pid, replaced.started_at);
    expect((await runtime.stop()).errors).toEqual([expect.objectContaining({ code: 'A9_MANAGED_RECOVERY_STALE' })]);
    expect((await runtime.shutdown({ stopManaged: true })).unresolved.length).toBeGreaterThan(0);
    expect(f.row()).toEqual(replaced);
    expect(f.lockRows()).toBe(1);
  } finally {
    probe.state.result = 'absent';
    if (runtime) { f.db.prepare("DELETE FROM a9_managed_processes WHERE handle_id = 'legacy-recovered'").run(); await runtime.shutdown({ stopManaged: true }); }
    probe.restore(); f.db.close(); fs.rmSync(f.env.root, { recursive: true, force: true });
  }
});

it.each([
  ['fact update', "CREATE TRIGGER ignore_w BEFORE UPDATE ON a9_managed_processes WHEN NEW.last_probe_status='user_dismissed' BEGIN SELECT RAISE(IGNORE); END"],
  ['disposition event', "CREATE TRIGGER ignore_w BEFORE INSERT ON a9_events WHEN NEW.event_type='managed_process_disposition' BEGIN SELECT RAISE(IGNORE); END"],
] as const)('A9-34 disposition with an ignored %s fails and keeps the adopted fact in memory', async (_name, trigger) => {
  const f = await recoveredCleanupEnv(); const runtime = f.open();
  try {
    const input = f.input(runtime);
    f.db.exec(trigger);
    expect(runtime.dismissRecovered(input)).toMatchObject({ ok: false, error: { code: 'A9_AUDIT_PERSISTENCE_FAILED' } });
    expect(f.db.prepare('SELECT last_probe_status FROM a9_managed_processes').get()).toEqual({ last_probe_status: 'cleanup_required' });
    expect(f.db.prepare("SELECT count(*) AS n FROM a9_events WHERE event_type='managed_process_disposition'").get()).toEqual({ n: 0 });
    expect(runtime.getSnapshot().controls).toEqual({ canStop: true, stopKind: 'managed_process' });
    expect((await runtime.stop()).errors[0].code).toBe('A9_MANAGED_PROCESS_CLEANUP_UNCONFIRMED');
    expect(runtime.canLeaveWorkspace().allowed).toBe(false);
    expect((await runtime.shutdown()).unresolved).toHaveLength(1);
    expect(f.db.prepare('SELECT count(*) AS n FROM a9_workspace_locks').get()).toEqual({ n: 1 });
  } finally { await runtime.shutdown(); f.db.close(); fs.rmSync(f.env.root, { recursive: true, force: true }); }
});

it.each(['damaged', 'handleId only'] as const)('A9-34 disposition, snapshots and close survive a %s disposition event of another workspace', async (variant) => {
  const f = await recoveredCleanupEnv(); const runtime = f.open();
  try {
    const input = f.input(runtime);
    const result = runtime.dismissRecovered(input);
    expect(result.ok).toBe(true);
    const otherRoot = path.join(f.env.root, 'other-ws'); fs.mkdirSync(otherRoot);
    f.db.prepare(`INSERT INTO a9_sessions (session_id, workspace_path, created_at, updated_at, last_activated_at)
      VALUES ('foreign-session', ?, '2026-11-19', '2026-11-19', '2026-11-19')`).run(otherRoot);
    f.db.prepare(`INSERT INTO a9_events (session_id, turn_id, kind, event_type, payload_json, created_at)
      VALUES ('foreign-session', NULL, 'tool', 'managed_process_disposition', ?, '2026-11-19')`)
      .run(variant === 'damaged' ? '{"handleId":' : JSON.stringify({ handleId: f.fact.handleId }));
    const snapshot = runtime.getSnapshot({ bypassCache: true });
    expect(snapshot.managedProcesses[0]).toMatchObject({ lastProbeStatus: 'user_dismissed', cleanupRequired: false,
      disposition: expect.objectContaining({ eventId: result.disposition.eventId }) });
    expect(snapshot.conversationControls.canSwitch).toBe(true);
    expect(runtime.dismissRecovered(input)).toEqual(result);
    expect(await runtime.shutdown()).toEqual({ stopped: [], leftToSystem: [], unresolved: [] });
    expect(f.db.prepare('SELECT count(*) AS n FROM a9_workspace_locks').get()).toEqual({ n: 0 });
  } finally { await runtime.shutdown(); f.db.close(); fs.rmSync(f.env.root, { recursive: true, force: true }); }
});

it('a persistent active fact outside the Runner blocks switching, leaving, new conversations and mode changes', async () => {
  const env = makeEnv(); const runtime = makeRuntime(env);
  const db = new Database(path.join(env.dataRoot, 'a9-state.db'));
  const insert = (handleId: string, workspace: string, status: string) => db.prepare(`INSERT INTO a9_managed_processes
    (handle_id, workspace_path, pid, command, cwd, started_at, last_probe_status, pid_reuse_possible)
    VALUES (?, ?, 7, 'late', ?, '2026-11-19', ?, 0)`).run(handleId, workspace, workspace, status);
  const allowed = () => {
    const first = runtime.getSnapshot(); const cached = runtime.getSnapshot();
    expect(cached.conversationControls.canSwitch).toBe(first.conversationControls.canSwitch);
    return first.conversationControls.canSwitch;
  };
  try {
    runtime.setMode('read_only');
    expect(allowed()).toBe(true);
    // Settled terminal facts and facts of another workspace keep everything available.
    insert('terminal', env.workspaceRoot, 'stopped');
    insert('elsewhere', path.join(env.root, 'other'), 'running');
    expect(allowed()).toBe(true);
    expect(runtime.canLeaveWorkspace().allowed).toBe(true);
    for (const status of ['running', 'running_unknown', 'identity_mismatch', 'cleanup_required']) {
      insert('late', env.workspaceRoot, status);
      expect(allowed()).toBe(false);
      expect(runtime.getSnapshot().conversationControls.reason).toBe('工作区仍有未结算的托管后台进程记录');
      expect(runtime.canLeaveWorkspace().allowed).toBe(false);
      expect(() => runtime.createConversation()).toThrow('A9_CONVERSATION_BUSY');
      expect(() => runtime.setMode('full_access')).toThrow('A9_MODE_CHANGE_BLOCKED_MANAGED_PROCESS');
      db.prepare("DELETE FROM a9_managed_processes WHERE handle_id = 'late'").run();
      expect(allowed()).toBe(true);
    }
    expect(runtime.createConversation().ok).toBe(true);
    expect(runtime.setMode('full_access').ok).toBe(true);
    expect(await runtime.shutdown()).toEqual({ stopped: [], leftToSystem: [], unresolved: [] });
  } finally { await runtime.shutdown(); db.close(); fs.rmSync(env.root, { recursive: true, force: true }); }
});

// ADR-0346 regressions.
it.each(['stop', 'shutdown'] as const)('an ignored terminal write of a PID found gone at startup adoption is retried by %s', async (retry) => {
  const pid = 987654600 + Math.floor(Math.random() * 99);
  const probe = scriptedPidProbe(pid);
  const f = await legacyRecoveredEnv(pid); let runtime: any;
  const running = { pid, started_at: '2026-11-18T00:00:00.000Z', last_probe_status: 'running' };
  // A persistent trigger fails the schema profile at open; the fault is a TEMP trigger
  // on the Runtime's own connection, present before its startup adoption runs.
  const connections: any[] = [];
  try {
    probe.state.result = 'absent';
    runtime = createA9AgentRuntime({
      workspaceRoot: f.env.workspaceRoot, dataRoot: f.env.dataRoot, ownerId: `adopt-${process.pid}-${Math.random()}`,
      openDatabase: (p: string, o?: { readonly?: boolean }) => {
        const db = new Database(p, o?.readonly ? { readonly: true } : {});
        if (!o?.readonly) {
          db.exec("CREATE TEMP TRIGGER ignore_exit BEFORE UPDATE ON main.a9_managed_processes WHEN NEW.last_probe_status='exited' BEGIN SELECT RAISE(IGNORE); END");
          connections.push(db);
        }
        return db;
      },
    });
    expect(runtime.status).toBe('ready');
    expect(f.row()).toEqual(running);
    expect(runtime.getSnapshot().conversationControls.canSwitch).toBe(false);
    expect(runtime.getSnapshot().controls).toEqual({ canStop: true, stopKind: 'managed_process' });
    expect(runtime.canLeaveWorkspace().allowed).toBe(false);
    expect(() => runtime.setMode('review')).toThrow('A9_MODE_CHANGE_BLOCKED_MANAGED_PROCESS');
    expect((await runtime.stop()).errors).toEqual([expect.objectContaining({ handleId: 'legacy-recovered', code: 'A9_PERSISTENCE_WRITE_UNCONFIRMED' })]);
    expect((await runtime.shutdown({ stopManaged: true })).unresolved).toEqual(expect.arrayContaining([expect.stringContaining('legacy-recovered')]));
    expect(f.row()).toEqual(running);
    expect(f.lockRows()).toBe(1);
    for (const db of connections) db.exec('DROP TRIGGER temp.ignore_exit');
    if (retry === 'stop') expect(await runtime.stop()).toEqual({ ok: true, stopped: ['legacy-recovered'] });
    expect(await runtime.shutdown({ stopManaged: true })).toEqual({ stopped: [], leftToSystem: [], unresolved: [] });
    expect(f.row()).toEqual({ ...running, last_probe_status: 'exited' });
    expect(f.lockRows()).toBe(0);
    expect(probe.signals().every((signal: unknown) => signal === 0)).toBe(true);
  } finally {
    probe.state.result = 'absent';
    if (runtime) await runtime.shutdown({ stopManaged: true });
    probe.restore(); f.db.close(); fs.rmSync(f.env.root, { recursive: true, force: true });
  }
});

// P1-2: the startup probe's ESRCH races a commit on another connection. State answers
// A9_MANAGED_RECOVERY_STALE; an exact same-identity settlement must not isolate the old
// handle (that blocked Stop, switching and close for good). Round 9: a replacing identity
// is no longer accepted here; it is covered by the strict settle-race test below.
it.each(['settled as stopped'] as const)(
  'startup adoption whose settle is stale (row %s by another connection) does not isolate the old handle', async (variant) => {
    const pid = 987654500 + Math.floor(Math.random() * 99);
    const f = await legacyRecoveredEnv(pid); let runtime: any;
    let fixture: Awaited<ReturnType<typeof startQuickFixture>> | undefined;
    const realKill = process.kill.bind(process);
    let raced = false;
    const spy = jest.spyOn(process, 'kill').mockImplementation(((target: number, signal?: any) => {
      if (target !== pid) return realKill(target, signal);
      if (signal !== 0) throw new Error(`TEST_ONLY: signal ${signal} sent to synthetic PID`);
      if (!raced) {
        raced = true;
        // Another SQLite connection commits before the Runtime writes the ESRCH terminal state.
        f.db.prepare("UPDATE a9_managed_processes SET last_probe_status = 'stopped' WHERE handle_id = 'legacy-recovered'").run();
      }
      throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    }) as any);
    try {
      runtime = makeRuntime(f.env);
      expect(runtime.status).toBe('ready');
      expect(raced).toBe(true);
      expect(variant).toBe('settled as stopped');
      {
        expect(f.row()).toEqual({ pid, started_at: '2026-11-18T00:00:00.000Z', last_probe_status: 'stopped' });
        expect(JSON.stringify(runtime.getSnapshot({ bypassCache: true }).persistenceDiagnostics)).toContain('A9_MANAGED_TERMINAL_ALREADY_SETTLED');
        expect(runtime.getSnapshot().conversationControls.canSwitch).toBe(true);
        expect(runtime.getSnapshot({ bypassCache: true }).conversationControls.canSwitch).toBe(true);
        expect(runtime.canLeaveWorkspace().allowed).toBe(true);
        // A row settled by another connection is no audit persistence failure:
        // the current Runtime still dispatches new turns (P1-2).
        fixture = await startQuickFixture();
        fs.writeFileSync(path.join(f.env.workspaceRoot, 'note.txt'), 'after settled race');
        expect(runtime.setMode('full_access')).toMatchObject({ ok: true, mode: 'full_access' });
        await runtime.configureProvider({ baseUrl: fixture.baseUrl, model: 'fixture', skipProbe: true });
        const turn = await runtime.submitTurn('dispatch after the settled startup race');
        expect(turn).toMatchObject({ ok: true });
        expect(JSON.stringify(turn)).not.toContain('A9_AUDIT_PERSISTENCE_FAILED');
        expect(fixture.requests.length).toBeGreaterThan(0);
        expect(JSON.stringify(runtime.getSnapshot({ bypassCache: true }))).not.toContain('A9_AUDIT_PERSISTENCE_FAILED');
        expect(runtime.getSnapshot().controls).toEqual({ canStop: false, stopKind: 'none' });
        expect(await runtime.stop()).toMatchObject({ ok: false, error: { code: 'NO_ACTIVE_TURN_OR_MANAGED_PROCESS' } });
        expect(runtime.setMode('review')).toMatchObject({ ok: true, mode: 'review' });
        expect(await runtime.shutdown({ stopManaged: true })).toEqual({ stopped: [], leftToSystem: [], unresolved: [] });
        expect(f.lockRows()).toBe(0);
        expect(f.row()).toEqual({ pid, started_at: '2026-11-18T00:00:00.000Z', last_probe_status: 'stopped' });
      }
      expect(spy.mock.calls.filter(([target]) => target === pid).every(([, signal]) => signal === 0)).toBe(true);
    } finally {
      if (runtime) { f.db.prepare("DELETE FROM a9_managed_processes WHERE handle_id = 'legacy-recovered'").run(); await runtime.shutdown({ stopManaged: true }); }
      if (fixture) await fixture.close();
      spy.mockRestore(); f.db.close(); fs.rmSync(f.env.root, { recursive: true, force: true });
    }
  });

// P1 (round 9): a legacy handle whose startup probe answers ESRCH takes the settle
// branch (settleManagedTerminal), not reconcile. When another connection commits a NULL
// status, a `stopped` row with a damaged ownership record, or replaces the PID/start time
// in that window, the STALE settle must run the same strict re-read as reconcile: the
// handle stays isolated, switching/leaving stay blocked and close keeps the SQLite lock.
it.each([
  'a NULL status',
  'stopped with a damaged ownership record',
  // Round 10: the same identity already `exited` (the settle's own status) must not take
  // the idempotent success path before ownership is verified.
  'exited with a damaged ownership record',
  'stopped with a different PID and start time',
  'a new live identity',
  // Round 12: the row is still `running` (no idempotent path) and another connection wrote a
  // valid `owned` record for the same identity; the legacy settle must not UPDATE it to exited.
  'a valid owned record for the same running identity',
] as const)('startup settle race (legacy ESRCH) with %s keeps isolation and the lock', async (mutation) => {
  const pid = 987655000 + Math.floor(Math.random() * 99);
  const f = await legacyRecoveredEnv(pid); let runtime: any;
  const realKill = process.kill.bind(process);
  let raced = false; let raceError: unknown;
  let other: any;
  if (mutation === 'a valid owned record for the same running identity') {
    const { A9PersistenceManager } = require('../../../state/dist/a9-persistence');
    const opened = A9PersistenceManager.open({ databasePath: path.join(f.env.dataRoot, 'a9-state.db'), dataRoot: f.env.dataRoot,
      openDatabase: (p: string) => new Database(p) });
    if (opened.status !== 'ready') throw new Error(opened.status);
    other = opened.manager;
  }
  const spy = jest.spyOn(process, 'kill').mockImplementation(((target: number, signal?: any) => {
    if (target !== pid) return realKill(target, signal);
    if (signal !== 0) throw new Error(`TEST_ONLY: signal ${signal} sent to synthetic PID`);
    if (!raced) {
      raced = true;
      // Another SQLite connection commits before the Runtime writes the ESRCH terminal state.
      if (mutation === 'a NULL status') {
        f.db.prepare("UPDATE a9_managed_processes SET last_probe_status = NULL WHERE handle_id = 'legacy-recovered'").run();
      } else if (mutation === 'a valid owned record for the same running identity') {
        try {
          const session = f.db.prepare('SELECT session_id FROM a9_sessions LIMIT 1').get() as { session_id: string };
          other.upsertTask('race-task', session.session_id, 'active');
          other.upsertTurn('race-turn', 'race-task', session.session_id, 'active');
          const owner = { workspace: f.env.workspaceRoot, conversationId: session.session_id, taskId: 'race-task', turnId: 'race-turn', toolCallId: 'race-call' };
          other.recordManagedOwnership({ handleId: 'legacy-recovered', workspacePath: f.env.workspaceRoot, pid, command: 'previous command',
            cwd: f.env.workspaceRoot, startedAt: '2026-11-18T00:00:00.000Z', lastProbeStatus: 'running' },
          { schemaVersion: 1, owner, requestId: 'race-request', ownershipState: 'owned' });
        } catch (error) { raceError = error; }
      } else if (mutation === 'stopped with a damaged ownership record' || mutation === 'exited with a damaged ownership record') {
        f.db.prepare("UPDATE a9_managed_processes SET last_probe_status = ? WHERE handle_id = 'legacy-recovered'")
          .run(mutation.startsWith('exited') ? 'exited' : 'stopped');
        const session = f.db.prepare('SELECT session_id FROM a9_sessions LIMIT 1').get() as { session_id: string };
        f.db.prepare(`INSERT INTO a9_events (session_id, turn_id, kind, event_type, payload_json, created_at)
          VALUES (?, NULL, 'tool', 'managed_process_ownership', ?, '2026-11-19')`)
          .run(session.session_id, JSON.stringify({ handleId: 'legacy-recovered', schemaVersion: 2, ownershipState: 'owned' }));
      } else {
        f.db.prepare(`UPDATE a9_managed_processes SET pid = ?, started_at = '2026-11-19T00:00:00.000Z', last_probe_status = ?
          WHERE handle_id = 'legacy-recovered'`).run(pid + 1, mutation === 'a new live identity' ? 'running' : 'stopped');
      }
    }
    throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
  }) as any);
  const warn = jest.spyOn(process, 'emitWarning').mockImplementation(() => {});
  try {
    runtime = makeRuntime(f.env);
    expect(raced).toBe(true);
    expect(raceError).toBeUndefined();
    const mutated = f.row();
    const diagnostics = JSON.stringify(runtime.getSnapshot({ bypassCache: true }).persistenceDiagnostics);
    expect(diagnostics).toContain('A9_MANAGED_HANDLE_ADOPT_FAILED');
    expect(diagnostics).not.toContain('A9_MANAGED_TERMINAL_ALREADY_SETTLED');
    if (mutation === 'a valid owned record for the same running identity') {
      // The legacy settle answered UNCONFIRMED and wrote nothing: the owned row stays running.
      expect(diagnostics).toContain('A9_MANAGED_OWNERSHIP_UNCONFIRMED');
      expect(mutated).toEqual({ pid, started_at: '2026-11-18T00:00:00.000Z', last_probe_status: 'running' });
    }
    for (const options of [{}, { bypassCache: true }]) {
      expect(runtime.getSnapshot(options).conversationControls.canSwitch).toBe(false);
    }
    expect(runtime.canLeaveWorkspace().allowed).toBe(false);
    expect(() => runtime.createConversation()).toThrow('A9_CONVERSATION_BUSY');
    expect(() => runtime.setMode('full_access')).toThrow('A9_MODE_CHANGE_BLOCKED_MANAGED_PROCESS');
    for (const stopManaged of [true, false]) {
      const closed = await runtime.shutdown({ stopManaged });
      expect(closed.unresolved.length).toBeGreaterThan(0);
      expect(f.lockRows()).toBe(1);
    }
    expect(f.row()).toEqual(mutated);
    expect(spy.mock.calls.filter(([target]) => target === pid).every(([, signal]) => signal === 0)).toBe(true);
  } finally {
    if (runtime) await runtime.shutdown({ stopManaged: false });
    warn.mockRestore(); spy.mockRestore(); other?.db.close(); f.db.close(); fs.rmSync(f.env.root, { recursive: true, force: true });
  }
});

// P1 (round 12): the operation pre-checks (leave, new conversation, mode change) read
// managed facts in 'recovery' mode. That read must load ordinary terminal ownership too:
// after the Runtime starts, another connection commits a well-formed release_intent /
// release_unknown for the `exited` row, and every pre-check must block like the final lock.
it.each(['release_intent', 'release_unknown'] as const)(
  'exited with a %s ownership committed by another connection blocks leave, new conversation and mode change', async (state) => {
    const f = await recoveredCleanupEnv();
    const { handleId } = f.fact;
    f.db.prepare("UPDATE a9_managed_processes SET last_probe_status = 'exited' WHERE handle_id = ?").run(handleId);
    const lockRows = () => (f.db.prepare('SELECT count(*) AS n FROM a9_workspace_locks').get() as { n: number }).n;
    const warn = jest.spyOn(process, 'emitWarning').mockImplementation(() => {});
    let runtime: any;
    try {
      runtime = f.open();
      expect(runtime.status).toBe('ready');
      // Control: exited with its `owned` record is settled.
      expect(runtime.canLeaveWorkspace().allowed).toBe(true);
      // Another SQLite connection commits a well-formed release record for the same handle.
      const insert = f.db.prepare(`INSERT INTO a9_events (session_id, turn_id, kind, event_type, payload_json, created_at)
        VALUES (?, ?, 'tool', 'managed_process_ownership', ?, '2026-11-19')`);
      for (const ownershipState of state === 'release_unknown' ? ['release_intent', 'release_unknown'] : ['release_intent']) {
        insert.run(f.owner.conversationId, f.owner.turnId, JSON.stringify({ handleId, schemaVersion: 1, owner: f.owner,
          requestId: 'original-request', ownershipState, releaseId: 'other-release' }));
      }
      expect(runtime.canLeaveWorkspace().allowed).toBe(false);
      expect(() => runtime.createConversation()).toThrow('A9_CONVERSATION_BUSY');
      expect(() => runtime.setMode('full_access')).toThrow('A9_MODE_CHANGE_BLOCKED_MANAGED_PROCESS');
      for (const options of [{}, { bypassCache: true }]) {
        expect(runtime.getSnapshot(options).conversationControls.canSwitch).toBe(false);
      }
      for (const stopManaged of [true, false]) {
        const closed = await runtime.shutdown({ stopManaged });
        expect(JSON.stringify(closed.unresolved)).toContain(handleId);
        expect(lockRows()).toBe(1);
      }
    } finally {
      if (runtime) await runtime.shutdown({ stopManaged: false });
      warn.mockRestore(); f.db.close(); fs.rmSync(f.env.root, { recursive: true, force: true });
    }
  });

// P1-2 (round 7): the two adoption paths that skip the exited/settle branch also reach a
// recovery-mode reconcile: an owned handle whose ESRCH keeps cleanupRequired (A9-34) and an
// unowned handle whose probe is unknown (EINVAL). When another connection already committed
// `stopped`, the STALE reconcile must re-read SQLite and withdraw the old handle instead of
// isolating it and blocking audit; new turns dispatch and close releases the lock.
it.each([
  ['owned handle, ESRCH with cleanupRequired', 'ESRCH'],
  ['unowned handle, unknown probe (EINVAL)', 'EINVAL'],
] as const)('startup reconcile STALE after another connection committed stopped (%s) withdraws the stale handle', async (_name, errno) => {
  let runtime: any; let fixture: Awaited<ReturnType<typeof startQuickFixture>> | undefined;
  const owned = errno === 'ESRCH';
  const cleanup = owned ? await recoveredCleanupEnv() : undefined;
  const legacyPid = 987654800 + Math.floor(Math.random() * 99);
  const legacy = owned ? undefined : await legacyRecoveredEnv(legacyPid);
  const env = owned ? cleanup!.env : legacy!.env;
  const db = owned ? cleanup!.db : legacy!.db;
  const handleId = owned ? cleanup!.fact.handleId : 'legacy-recovered';
  const pid = owned ? cleanup!.fact.pid : legacyPid;
  const row = () => db.prepare('SELECT pid, started_at, last_probe_status FROM a9_managed_processes WHERE handle_id = ?').get(handleId);
  const lockRows = () => (db.prepare('SELECT count(*) AS n FROM a9_workspace_locks').get() as { n: number }).n;
  const before = row() as { pid: number; started_at: string };
  const realKill = process.kill.bind(process);
  let raced = false;
  const spy = jest.spyOn(process, 'kill').mockImplementation(((target: number, signal?: any) => {
    if (target !== pid) return realKill(target, signal);
    if (signal !== 0) throw new Error(`TEST_ONLY: signal ${signal} sent to synthetic PID`);
    if (!raced) {
      raced = true;
      // Another SQLite connection commits `stopped` before the Runtime's reconcile write.
      db.prepare("UPDATE a9_managed_processes SET last_probe_status = 'stopped' WHERE handle_id = ?").run(handleId);
    }
    throw Object.assign(new Error(errno), { code: errno });
  }) as any);
  try {
    runtime = makeRuntime(env);
    expect(runtime.status).toBe('ready');
    expect(raced).toBe(true);
    const settled = { pid: before.pid, started_at: before.started_at, last_probe_status: 'stopped' };
    expect(row()).toEqual(settled);
    const diagnostics = JSON.stringify(runtime.getSnapshot({ bypassCache: true }).persistenceDiagnostics);
    expect(diagnostics).toContain('A9_MANAGED_TERMINAL_ALREADY_SETTLED');
    expect(diagnostics).not.toContain('A9_MANAGED_HANDLE_ADOPT_FAILED');
    for (const options of [{}, { bypassCache: true }]) {
      const snapshot = runtime.getSnapshot(options);
      expect(snapshot.conversationControls.canSwitch).toBe(true);
      expect(snapshot.controls).toEqual({ canStop: false, stopKind: 'none' });
      expect(snapshot.managedProcesses.find((item: any) => item.handleId === handleId)).not.toHaveProperty('cleanupRequired', true);
    }
    expect(runtime.canLeaveWorkspace().allowed).toBe(true);
    fixture = await startQuickFixture();
    fs.writeFileSync(path.join(env.workspaceRoot, 'note.txt'), 'after settled reconcile race');
    expect(runtime.setMode('full_access')).toMatchObject({ ok: true, mode: 'full_access' });
    await runtime.configureProvider({ baseUrl: fixture.baseUrl, model: 'fixture', skipProbe: true });
    const turn = await runtime.submitTurn('dispatch after the settled reconcile race');
    expect(turn).toMatchObject({ ok: true });
    expect(JSON.stringify(turn)).not.toContain('A9_AUDIT_PERSISTENCE_FAILED');
    expect(fixture.requests.length).toBeGreaterThan(0);
    expect(JSON.stringify(runtime.getSnapshot({ bypassCache: true }))).not.toContain('A9_AUDIT_PERSISTENCE_FAILED');
    expect(await runtime.stop()).toMatchObject({ ok: false, error: { code: 'NO_ACTIVE_TURN_OR_MANAGED_PROCESS' } });
    expect(runtime.setMode('review')).toMatchObject({ ok: true, mode: 'review' });
    expect(await runtime.shutdown({ stopManaged: true })).toEqual({ stopped: [], leftToSystem: [], unresolved: [] });
    expect(lockRows()).toBe(0);
    expect(row()).toEqual(settled);
    expect(spy.mock.calls.filter(([target]) => target === pid).every(([, signal]) => signal === 0)).toBe(true);
  } finally {
    if (runtime) await runtime.shutdown({ stopManaged: true });
    if (fixture) await fixture.close();
    spy.mockRestore(); db.close(); fs.rmSync(env.root, { recursive: true, force: true });
  }
});

// P1 (round 8): the STALE/UNCONFIRMED re-read must prove the exact adopted identity.
// Another connection's terminal row for a different PID/start time, a NULL status, or a
// `stopped` row whose ownership record is damaged is no settlement of the old handle:
// it stays isolated, Stop/close keep reporting it and the workspace lock is kept.
it.each([
  ['owned', 'stopped with a different PID and start time'],
  ['owned', 'a NULL status'],
  ['owned', 'stopped with a damaged ownership record'],
  ['legacy', 'stopped with a different PID and start time'],
  ['legacy', 'a NULL status'],
  ['legacy', 'stopped with a damaged ownership record'],
] as const)('startup reconcile race with %s handle and %s keeps isolation and the lock', async (kind, mutation) => {
  let runtime: any;
  const owned = kind === 'owned';
  const cleanup = owned ? await recoveredCleanupEnv() : undefined;
  const legacyPid = 987654900 + Math.floor(Math.random() * 99);
  const legacy = owned ? undefined : await legacyRecoveredEnv(legacyPid);
  const env = owned ? cleanup!.env : legacy!.env;
  const db = owned ? cleanup!.db : legacy!.db;
  const handleId = owned ? cleanup!.fact.handleId : 'legacy-recovered';
  const pid = owned ? cleanup!.fact.pid : legacyPid;
  const errno = owned ? 'ESRCH' : 'EINVAL';
  const row = () => db.prepare('SELECT pid, started_at, last_probe_status FROM a9_managed_processes WHERE handle_id = ?').get(handleId);
  const lockRows = () => (db.prepare('SELECT count(*) AS n FROM a9_workspace_locks').get() as { n: number }).n;
  const realKill = process.kill.bind(process);
  let raced = false;
  const spy = jest.spyOn(process, 'kill').mockImplementation(((target: number, signal?: any) => {
    if (target !== pid) return realKill(target, signal);
    if (signal !== 0) throw new Error(`TEST_ONLY: signal ${signal} sent to synthetic PID`);
    if (!raced) {
      raced = true;
      if (mutation === 'stopped with a different PID and start time') {
        db.prepare("UPDATE a9_managed_processes SET pid = ?, started_at = '2026-11-19T01:00:00.000Z', last_probe_status = 'stopped' WHERE handle_id = ?")
          .run(pid + 1, handleId);
      } else if (mutation === 'a NULL status') {
        db.prepare('UPDATE a9_managed_processes SET last_probe_status = NULL WHERE handle_id = ?').run(handleId);
      } else {
        db.prepare("UPDATE a9_managed_processes SET last_probe_status = 'stopped' WHERE handle_id = ?").run(handleId);
        if (owned) {
          db.prepare(`UPDATE a9_events SET payload_json = json_remove(payload_json, '$.requestId')
            WHERE event_type = 'managed_process_ownership'`).run();
        } else {
          // The legacy reconcile answers STALE before it reads ownership; the re-read must not skip it.
          const session = db.prepare('SELECT session_id FROM a9_sessions LIMIT 1').get() as { session_id: string };
          db.prepare(`INSERT INTO a9_events (session_id, turn_id, kind, event_type, payload_json, created_at)
            VALUES (?, NULL, 'tool', 'managed_process_ownership', ?, '2026-11-19')`)
            .run(session.session_id, JSON.stringify({ handleId, schemaVersion: 2, ownershipState: 'owned' }));
        }
      }
    }
    throw Object.assign(new Error(errno), { code: errno });
  }) as any);
  const warn = jest.spyOn(process, 'emitWarning').mockImplementation(() => {});
  try {
    runtime = makeRuntime(env);
    expect(raced).toBe(true);
    const mutated = row();
    const diagnostics = JSON.stringify(runtime.getSnapshot({ bypassCache: true }).persistenceDiagnostics);
    expect(diagnostics).toContain('A9_MANAGED_HANDLE_ADOPT_FAILED');
    expect(diagnostics).not.toContain('A9_MANAGED_TERMINAL_ALREADY_SETTLED');
    for (const options of [{}, { bypassCache: true }]) {
      expect(runtime.getSnapshot(options).conversationControls.canSwitch).toBe(false);
    }
    expect(runtime.canLeaveWorkspace().allowed).toBe(false);
    expect(() => runtime.createConversation()).toThrow('A9_CONVERSATION_BUSY');
    for (const stopManaged of [true, false]) {
      const closed = await runtime.shutdown({ stopManaged });
      expect(closed.unresolved.length).toBeGreaterThan(0);
      expect(lockRows()).toBe(1);
    }
    expect(row()).toEqual(mutated);
    expect(spy.mock.calls.filter(([target]) => target === pid).every(([, signal]) => signal === 0)).toBe(true);
  } finally {
    if (runtime) await runtime.shutdown({ stopManaged: false });
    warn.mockRestore(); spy.mockRestore(); db.close(); fs.rmSync(env.root, { recursive: true, force: true });
  }
});

// P1 (round 8), scenario A: while the startup probe runs, another connection commits a
// verified terminal settlement of the same owned identity (user_dismissed through the
// A9-34 disposition, or the owned -> release_intent -> released chain). The reconcile
// answers A9_MANAGED_OWNERSHIP_UNCONFIRMED; the re-read proves the exact settlement, so
// the old handle is withdrawn without isolation, new turns dispatch and close releases the lock.
it.each(['user_dismissed', 'released'] as const)(
  'startup reconcile UNCONFIRMED after another connection committed a verified %s withdraws the stale handle', async (settlement) => {
    let runtime: any; let fixture: Awaited<ReturnType<typeof startQuickFixture>> | undefined;
    const f = await recoveredCleanupEnv();
    const { A9PersistenceManager } = require('../../../state/dist/a9-persistence');
    const opened = A9PersistenceManager.open({ databasePath: path.join(f.env.dataRoot, 'a9-state.db'), dataRoot: f.env.dataRoot,
      openDatabase: (p: string) => new Database(p) });
    if (opened.status !== 'ready') throw new Error(opened.status);
    const other = opened.manager;
    const handleId = f.fact.handleId; const pid = f.fact.pid;
    const row = () => f.db.prepare('SELECT pid, started_at, last_probe_status FROM a9_managed_processes WHERE handle_id = ?').get(handleId);
    const lockRows = () => (f.db.prepare('SELECT count(*) AS n FROM a9_workspace_locks').get() as { n: number }).n;
    const ownership = { schemaVersion: 1, owner: f.owner, requestId: 'original-request' };
    const realKill = process.kill.bind(process);
    let raced = false; let raceError: unknown;
    const spy = jest.spyOn(process, 'kill').mockImplementation(((target: number, signal?: any) => {
      if (target !== pid) return realKill(target, signal);
      if (signal !== 0) throw new Error(`TEST_ONLY: signal ${signal} sent to synthetic PID`);
      if (!raced) {
        raced = true;
        try {
          if (settlement === 'user_dismissed') {
            const lock = f.db.prepare('SELECT owner_id FROM a9_workspace_locks').get() as { owner_id: string };
            const identity = other.getManagedProcessRecoveryIdentity(handleId);
            other.dismissRecoveredManagedProcess({ workspace: f.env.workspaceRoot, conversationId: f.owner.conversationId,
              lockOwnerId: lock.owner_id, handleId, recoveryRevision: identity.recoveryRevision,
              identity: { owner: f.owner, requestId: 'original-request', pid, startedAt: f.fact.startedAt },
              pidProbe: { pid, status: 'absent', checkedAt: new Date().toISOString() } });
          } else {
            other.recordManagedOwnership(f.fact, { ...ownership, ownershipState: 'release_intent', releaseId: 'other-release' });
            other.recordManagedOwnership({ ...f.fact, lastProbeStatus: 'released', cleanupRequired: false },
              { ...ownership, ownershipState: 'released', releaseId: 'other-release' });
          }
        } catch (error) { raceError = error; }
      }
      throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    }) as any);
    try {
      runtime = makeRuntime(f.env);
      expect(raceError).toBeUndefined();
      expect(runtime.status).toBe('ready');
      expect(raced).toBe(true);
      const settled = { pid, started_at: f.fact.startedAt, last_probe_status: settlement };
      expect(row()).toEqual(settled);
      const diagnostics = JSON.stringify(runtime.getSnapshot({ bypassCache: true }).persistenceDiagnostics);
      expect(diagnostics).toContain('A9_MANAGED_TERMINAL_ALREADY_SETTLED');
      expect(diagnostics).not.toContain('A9_MANAGED_HANDLE_ADOPT_FAILED');
      for (const options of [{}, { bypassCache: true }]) {
        const snapshot = runtime.getSnapshot(options);
        expect(snapshot.conversationControls.canSwitch).toBe(true);
        expect(snapshot.controls).toEqual({ canStop: false, stopKind: 'none' });
        expect(snapshot.managedProcesses.find((item: any) => item.handleId === handleId)).not.toHaveProperty('cleanupRequired', true);
      }
      expect(runtime.canLeaveWorkspace().allowed).toBe(true);
      fixture = await startQuickFixture();
      fs.writeFileSync(path.join(f.env.workspaceRoot, 'note.txt'), `after ${settlement} reconcile race`);
      expect(runtime.setMode('full_access')).toMatchObject({ ok: true, mode: 'full_access' });
      await runtime.configureProvider({ baseUrl: fixture.baseUrl, model: 'fixture', skipProbe: true });
      const turn = await runtime.submitTurn(`dispatch after the ${settlement} reconcile race`);
      expect(turn).toMatchObject({ ok: true });
      expect(JSON.stringify(turn)).not.toContain('A9_AUDIT_PERSISTENCE_FAILED');
      expect(fixture.requests.length).toBeGreaterThan(0);
      expect(JSON.stringify(runtime.getSnapshot({ bypassCache: true }))).not.toContain('A9_AUDIT_PERSISTENCE_FAILED');
      expect(await runtime.stop()).toMatchObject({ ok: false, error: { code: 'NO_ACTIVE_TURN_OR_MANAGED_PROCESS' } });
      expect(runtime.setMode('review')).toMatchObject({ ok: true, mode: 'review' });
      expect(await runtime.shutdown({ stopManaged: true })).toEqual({ stopped: [], leftToSystem: [], unresolved: [] });
      expect(lockRows()).toBe(0);
      expect(row()).toEqual(settled);
      expect(spy.mock.calls.filter(([target]) => target === pid).every(([, signal]) => signal === 0)).toBe(true);
    } finally {
      if (runtime) await runtime.shutdown({ stopManaged: true });
      if (fixture) await fixture.close();
      spy.mockRestore(); other.db.close(); f.db.close(); fs.rmSync(f.env.root, { recursive: true, force: true });
    }
  });

it('a pending terminal settlement blocks mode changes and keeps Stop after another connection settled the same identity', async () => {
  const pid = 987654700 + Math.floor(Math.random() * 99);
  const probe = scriptedPidProbe(pid);
  const f = await legacyRecoveredEnv(pid); let runtime: any;
  try {
    runtime = makeRuntime(f.env);
    probe.state.result = 'absent';
    f.db.exec("CREATE TRIGGER ignore_exit BEFORE UPDATE ON a9_managed_processes WHEN NEW.last_probe_status='exited' BEGIN SELECT RAISE(IGNORE); END");
    expect((await runtime.stop()).errors[0].code).toBe('A9_PERSISTENCE_WRITE_UNCONFIRMED');
    f.db.exec('DROP TRIGGER ignore_exit');
    // Another SQLite connection commits the same identity's terminal state.
    f.db.prepare("UPDATE a9_managed_processes SET last_probe_status = 'exited', pid_reuse_possible = 0 WHERE handle_id = 'legacy-recovered'").run();
    for (const options of [{}, { bypassCache: true }]) {
      const snapshot = runtime.getSnapshot(options);
      expect(snapshot.conversationControls.canSwitch).toBe(false);
      expect(snapshot.controls).toEqual({ canStop: true, stopKind: 'managed_process' });
    }
    expect(() => runtime.createConversation()).toThrow('A9_CONVERSATION_BUSY');
    expect(() => runtime.setMode('review')).toThrow('A9_MODE_CHANGE_BLOCKED_MANAGED_PROCESS');
    expect(await runtime.stop()).toEqual({ ok: true, stopped: ['legacy-recovered'] });
    expect(runtime.getSnapshot().controls).toEqual({ canStop: false, stopKind: 'none' });
    expect(runtime.setMode('review')).toMatchObject({ ok: true, mode: 'review' });
    expect(await runtime.shutdown({ stopManaged: true })).toEqual({ stopped: [], leftToSystem: [], unresolved: [] });
    expect(f.lockRows()).toBe(0);
  } finally {
    probe.state.result = 'absent';
    if (runtime) await runtime.shutdown({ stopManaged: true });
    probe.restore(); f.db.close(); fs.rmSync(f.env.root, { recursive: true, force: true });
  }
});

it('a helper-proven Stop whose terminal audit write is ignored fails Stop and close until the write is confirmed', async () => {
  const env = makeEnv(); const fixture = await startBackgroundFixture(); const runtime = makeRuntime(env, true);
  const db = new Database(path.join(env.dataRoot, 'a9-state.db'));
  const lockRows = () => (db.prepare('SELECT count(*) AS n FROM a9_workspace_locks').get() as { n: number }).n;
  try {
    runtime.setMode('full_access');
    await runtime.configureProvider({ baseUrl: fixture.baseUrl, model: 'fixture', skipProbe: true });
    await runtime.submitTurn('start a managed background process');
    const running = runtime.getSnapshot().managedProcesses.find((item: any) => item.lastProbeStatus === 'running');
    expect(running).toBeDefined();
    const row = () => db.prepare('SELECT last_probe_status FROM a9_managed_processes WHERE handle_id = ?').get(running.handleId);
    db.exec("CREATE TRIGGER ignore_stop BEFORE INSERT ON a9_managed_processes WHEN NEW.last_probe_status='stopped' BEGIN SELECT RAISE(IGNORE); END");
    const stopped = await runtime.stop();
    expect(stopped).toMatchObject({ ok: false, errors: [expect.objectContaining({ handleId: running.handleId, code: 'A9_BACKGROUND_STATE_PERSIST_FAILED' })] });
    // The process is gone, but neither stopped nor a cleanup_required substitute was persisted.
    expect(() => process.kill(running.pid, 0)).toThrow();
    expect(row()).toEqual({ last_probe_status: 'running' });
    expect(runtime.getSnapshot().controls).toEqual({ canStop: true, stopKind: 'managed_process' });
    expect(runtime.canLeaveWorkspace().allowed).toBe(false);
    const closed = await runtime.shutdown();
    expect(closed.unresolved.length).toBeGreaterThan(0);
    expect(lockRows()).toBe(1);
    expect(row()).toEqual({ last_probe_status: 'running' });
    db.exec('DROP TRIGGER ignore_stop');
    expect(await runtime.stop()).toEqual({ ok: true, stopped: [running.handleId] });
    expect(row()).toEqual({ last_probe_status: 'stopped' });
    expect(await runtime.shutdown()).toEqual({ stopped: [], leftToSystem: [], unresolved: [] });
    expect(lockRows()).toBe(0);
  } finally {
    try { db.exec('DROP TRIGGER IF EXISTS ignore_stop'); } catch { /* closed */ }
    await runtime.shutdown(); await fixture.close(); db.close(); fs.rmSync(env.root, { recursive: true, force: true });
  }
}, 30_000);

it('shutdown with an ignored helper terminal write keeps unresolved and the lock, then settles on retry', async () => {
  const env = makeEnv(); const fixture = await startBackgroundFixture(); const runtime = makeRuntime(env, true);
  const db = new Database(path.join(env.dataRoot, 'a9-state.db'));
  const lockRows = () => (db.prepare('SELECT count(*) AS n FROM a9_workspace_locks').get() as { n: number }).n;
  try {
    runtime.setMode('full_access');
    await runtime.configureProvider({ baseUrl: fixture.baseUrl, model: 'fixture', skipProbe: true });
    await runtime.submitTurn('start a managed background process');
    const running = runtime.getSnapshot().managedProcesses.find((item: any) => item.lastProbeStatus === 'running');
    db.exec("CREATE TRIGGER ignore_stop BEFORE INSERT ON a9_managed_processes WHEN NEW.last_probe_status='stopped' BEGIN SELECT RAISE(IGNORE); END");
    const closed = await runtime.shutdown();
    expect(closed.unresolved).toEqual(expect.arrayContaining([expect.stringContaining(running.handleId)]));
    expect(lockRows()).toBe(1);
    expect(runtime.getSnapshot().lock.held).toBe(true);
    db.exec('DROP TRIGGER ignore_stop');
    expect(await runtime.shutdown()).toMatchObject({ unresolved: [] });
    expect(db.prepare('SELECT last_probe_status FROM a9_managed_processes WHERE handle_id = ?').get(running.handleId))
      .toEqual({ last_probe_status: 'stopped' });
    expect(lockRows()).toBe(0);
  } finally {
    try { db.exec('DROP TRIGGER IF EXISTS ignore_stop'); } catch { /* closed */ }
    await runtime.shutdown(); await fixture.close(); db.close(); fs.rmSync(env.root, { recursive: true, force: true });
  }
}, 30_000);

// P1 (round 12): a conversation legitimately rebound to another workspace leaves its
// original ownership event in the old workspace. With that record damaged (schemaVersion),
// the handle is not a legacy handle: the startup settle must not write `exited` (running)
// or succeed idempotently (exited), and every pre-check plus the final lock must block.
it.each(['running', 'exited'] as const)(
  'a rebound conversation with a damaged original ownership record (fact %s) blocks leave, new conversation, mode change and close',
  async (status) => {
    const pid = 987655200 + Math.floor(Math.random() * 99);
    const probe = scriptedPidProbe(pid);
    const f = await legacyRecoveredEnv(pid); let runtime: any;
    const warn = jest.spyOn(process, 'emitWarning').mockImplementation(() => {});
    try {
      const { A9PersistenceManager } = require('../../../state/dist/a9-persistence');
      const opened = A9PersistenceManager.open({ databasePath: path.join(f.env.dataRoot, 'a9-state.db'), dataRoot: f.env.dataRoot,
        openDatabase: (p: string) => new Database(p) });
      if (opened.status !== 'ready') throw new Error(opened.status);
      const p = opened.manager;
      const session = f.db.prepare('SELECT session_id FROM a9_sessions LIMIT 1').get() as { session_id: string };
      p.upsertTask('rebind-task', session.session_id, 'completed');
      p.upsertTurn('rebind-turn', 'rebind-task', session.session_id, 'completed');
      const owner = { workspace: f.env.workspaceRoot, conversationId: session.session_id, taskId: 'rebind-task', turnId: 'rebind-turn', toolCallId: 'rebind-call' };
      p.recordManagedOwnership({ handleId: 'legacy-recovered', workspacePath: f.env.workspaceRoot, pid, command: 'previous command',
        cwd: f.env.workspaceRoot, startedAt: '2026-11-18T00:00:00.000Z', lastProbeStatus: 'running' },
      { schemaVersion: 1, owner, requestId: 'rebind-request', ownershipState: 'owned' });
      p.db.close();
      // Legitimate rebinding: the conversation now belongs to another workspace.
      const otherRoot = path.join(f.env.root, 'rebound-ws'); fs.mkdirSync(otherRoot);
      f.db.prepare('UPDATE a9_sessions SET workspace_path = ? WHERE session_id = ?').run(otherRoot, session.session_id);
      // The original ownership record is damaged.
      f.db.prepare(`UPDATE a9_events SET payload_json = json_set(payload_json, '$.schemaVersion', 2)
        WHERE event_type = 'managed_process_ownership'`).run();
      if (status === 'exited') {
        f.db.prepare("UPDATE a9_managed_processes SET last_probe_status = 'exited' WHERE handle_id = 'legacy-recovered'").run();
      }
      const before = f.row();
      probe.state.result = 'absent';
      runtime = makeRuntime(f.env);
      expect(runtime.status).toBe('ready');
      expect(f.row()).toEqual(before);
      expect(JSON.stringify(runtime.getSnapshot({ bypassCache: true }).persistenceDiagnostics)).toContain('A9_MANAGED_OWNERSHIP_CORRUPT');
      if (status === 'running') {
        // The isolated running handle keeps switching closed; Stop cannot confirm its cleanup.
        for (const options of [{}, { bypassCache: true }]) {
          expect(runtime.getSnapshot(options).conversationControls.canSwitch).toBe(false);
        }
        expect(await runtime.stop()).toMatchObject({ ok: false, error: { code: 'A9_MANAGED_PROCESS_CLEANUP_UNCONFIRMED' } });
      }
      expect(runtime.canLeaveWorkspace().allowed).toBe(false);
      expect(() => runtime.createConversation()).toThrow('A9_CONVERSATION_BUSY');
      expect(() => runtime.setMode('full_access')).toThrow('A9_MODE_CHANGE_BLOCKED_MANAGED_PROCESS');
      for (const stopManaged of [true, false]) {
        const closed = await runtime.shutdown({ stopManaged });
        expect(closed.unresolved.length).toBeGreaterThan(0);
        expect(f.lockRows()).toBe(1);
      }
      expect(f.row()).toEqual(before);
      expect(probe.signals().every((signal: unknown) => signal === 0)).toBe(true);
    } finally {
      probe.state.result = 'absent';
      if (runtime) await runtime.shutdown({ stopManaged: false });
      warn.mockRestore(); probe.restore(); f.db.close(); fs.rmSync(f.env.root, { recursive: true, force: true });
    }
  });

// P1 (round 13): the conversation is rebound with a real `changeWorkdir`; its ownership
// record still names the original workspace. Another connection then (1) removes the
// record's handleId or (2) points its owner task at a task that does not exist. Neither is
// an unrelated foreign claim: the original workspace treats the handle as damaged/unconfirmed.
// Round 14 (P1): (3) the record is truncated JSON -- no readable handleId and JSON.parse fails --
// yet it still names the original workspace, so it is damaged evidence, never a legacy handle.
// Round 15 (P1): (4) the top-level handleId survives but the truncation falls inside the
// workspace path or before the workspace field; the record stays this handle's damaged evidence.
it.each([
  ['missing handleId', "UPDATE a9_events SET payload_json = json_remove(payload_json, '$.handleId') WHERE event_type = 'managed_process_ownership'",
    'A9_MANAGED_OWNERSHIP_CORRUPT'],
  ['stale owner task', `UPDATE a9_events SET payload_json = json_set(payload_json, '$.owner.taskId', 'missing-task')
    WHERE event_type = 'managed_process_ownership'`, 'A9_MANAGED_OWNER_MISMATCH'],
  ['truncated JSON (last brace lost)', `UPDATE a9_events SET payload_json = substr(payload_json, 1, length(payload_json) - 1)
    WHERE event_type = 'managed_process_ownership'`, 'A9_MANAGED_OWNERSHIP_CORRUPT'],
  ['truncated JSON (owner left open)', `UPDATE a9_events SET payload_json = '{"schemaVersion":1,"handleId":"' || json_extract(payload_json, '$.handleId')
    || '","owner":{"workspace":' || json_quote(json_extract(payload_json, '$.owner.workspace')) WHERE event_type = 'managed_process_ownership'`,
    'A9_MANAGED_OWNERSHIP_CORRUPT'],
  ['truncated JSON (inside workspace path)', `UPDATE a9_events SET payload_json = '{"schemaVersion":1,"handleId":"' || json_extract(payload_json, '$.handleId')
    || '","owner":{"workspace":' || substr(json_quote(json_extract(payload_json, '$.owner.workspace')), 1,
      length(json_quote(json_extract(payload_json, '$.owner.workspace'))) - 2) WHERE event_type = 'managed_process_ownership'`,
    'A9_MANAGED_OWNERSHIP_CORRUPT'],
  ['truncated JSON (before workspace field)', `UPDATE a9_events SET payload_json = '{"schemaVersion":1,"handleId":"' || json_extract(payload_json, '$.handleId')
    || '","owner":{' WHERE event_type = 'managed_process_ownership'`, 'A9_MANAGED_OWNERSHIP_CORRUPT'],
] as const)('after changeWorkdir a damaged original ownership record (%s) blocks leave, mode change, settle and close',
  async (_name, damage, code) => {
    const pid = 987655300 + Math.floor(Math.random() * 99);
    const probe = scriptedPidProbe(pid);
    const f = await legacyRecoveredEnv(pid); let runtime: any;
    const warn = jest.spyOn(process, 'emitWarning').mockImplementation(() => {});
    const { A9PersistenceManager } = require('../../../state/dist/a9-persistence');
    const openManager = () => {
      const opened = A9PersistenceManager.open({ databasePath: path.join(f.env.dataRoot, 'a9-state.db'), dataRoot: f.env.dataRoot,
        openDatabase: (p: string) => new Database(p) });
      if (opened.status !== 'ready') throw new Error(opened.status);
      return opened.manager;
    };
    try {
      const p = openManager();
      const session = f.db.prepare('SELECT session_id FROM a9_sessions LIMIT 1').get() as { session_id: string };
      p.upsertTask('rebind-task', session.session_id, 'completed');
      p.upsertTurn('rebind-turn', 'rebind-task', session.session_id, 'completed');
      const owner = { workspace: f.env.workspaceRoot, conversationId: session.session_id, taskId: 'rebind-task', turnId: 'rebind-turn', toolCallId: 'rebind-call' };
      const fact = { handleId: 'legacy-recovered', workspacePath: f.env.workspaceRoot, pid, command: 'previous command',
        cwd: f.env.workspaceRoot, startedAt: '2026-11-18T00:00:00.000Z' };
      p.recordManagedOwnership({ ...fact, lastProbeStatus: 'stopped' }, { schemaVersion: 1, owner, requestId: 'rebind-request', ownershipState: 'owned' });
      const otherRoot = path.join(f.env.root, 'rebound-ws'); fs.mkdirSync(otherRoot);
      p.changeWorkdir(session.session_id, f.env.workspaceRoot, otherRoot, false);
      expect(p.listConversations(otherRoot).map((item: any) => item.sessionId)).toEqual([session.session_id]);
      p.db.close();
      // Another connection damages the original record and reports the identity running again.
      f.db.exec(damage);
      f.db.prepare("UPDATE a9_managed_processes SET last_probe_status = 'running' WHERE handle_id = 'legacy-recovered'").run();
      const before = f.row();
      probe.state.result = 'absent';
      runtime = makeRuntime(f.env);
      expect(runtime.status).toBe('ready');
      expect(f.row()).toEqual(before);
      expect(JSON.stringify(runtime.getSnapshot({ bypassCache: true }).persistenceDiagnostics)).toContain(code);
      for (const options of [{}, { bypassCache: true }]) {
        expect(runtime.getSnapshot(options).conversationControls.canSwitch).toBe(false);
      }
      expect(runtime.canLeaveWorkspace().allowed).toBe(false);
      expect(() => runtime.setMode('full_access')).toThrow('A9_MODE_CHANGE_BLOCKED_MANAGED_PROCESS');
      expect((await runtime.stop()).ok).toBe(false);
      // A legacy settle from another connection rejects and never turns `running` into `exited`.
      const q = openManager();
      try {
        expect(() => q.settleRecoveredManagedProcess({ ...fact, lastProbeStatus: 'exited', pidReusePossible: false })).toThrow(code);
      } finally { q.db.close(); }
      expect(f.row()).toEqual(before);
      for (const stopManaged of [true, false]) {
        const closed = await runtime.shutdown({ stopManaged });
        expect(closed.unresolved.length).toBeGreaterThan(0);
        expect(f.lockRows()).toBe(1);
      }
      expect(f.row()).toEqual(before);
      expect((f.row() as any).last_probe_status).toBe('running');
      expect(probe.signals().every((signal: unknown) => signal === 0)).toBe(true);
    } finally {
      probe.state.result = 'absent';
      if (runtime) await runtime.shutdown({ stopManaged: false });
      warn.mockRestore(); probe.restore(); f.db.close(); fs.rmSync(f.env.root, { recursive: true, force: true });
    }
  });

// P1 (round 16): an older truncated ownership record of the handle is followed by complete
// records (a later copy of the owned record, then the release chain for `released`). After a
// real `changeWorkdir` the stable-history fallback must not skip that older damage: the
// original workspace reports A9_MANAGED_OWNERSHIP_CORRUPT, leave stays blocked and both
// shutdown modes keep the workspace lock.
it.each([
  ['stopped', 'last brace lost', `substr(payload_json, 1, length(payload_json) - 1)`],
  ['stopped', 'before workspace field', `'{"schemaVersion":1,"handleId":"' || json_extract(payload_json, '$.handleId') || '","owner":{'`],
  ['released', 'last brace lost', `substr(payload_json, 1, length(payload_json) - 1)`],
  ['released', 'before workspace field', `'{"schemaVersion":1,"handleId":"' || json_extract(payload_json, '$.handleId') || '","owner":{'`],
  // Round 17 (P1): the cut falls right after the handleId characters, before its closing quote.
  ['stopped', 'handleId closing quote lost', `'{"schemaVersion":1,"handleId":"' || json_extract(payload_json, '$.handleId')`],
  ['released', 'handleId closing quote lost', `'{"schemaVersion":1,"handleId":"' || json_extract(payload_json, '$.handleId')`],
] as const)('after changeWorkdir an older truncated ownership record (%s fact, %s) blocks leave and close',
  async (status, _name, truncated) => {
    const pid = 987655400 + Math.floor(Math.random() * 99);
    const probe = scriptedPidProbe(pid);
    const f = await legacyRecoveredEnv(pid); let runtime: any;
    const warn = jest.spyOn(process, 'emitWarning').mockImplementation(() => {});
    try {
      const { A9PersistenceManager } = require('../../../state/dist/a9-persistence');
      const opened = A9PersistenceManager.open({ databasePath: path.join(f.env.dataRoot, 'a9-state.db'), dataRoot: f.env.dataRoot,
        openDatabase: (p: string) => new Database(p) });
      if (opened.status !== 'ready') throw new Error(opened.status);
      const p = opened.manager;
      const session = f.db.prepare('SELECT session_id FROM a9_sessions LIMIT 1').get() as { session_id: string };
      p.upsertTask('rebind-task', session.session_id, 'completed');
      p.upsertTurn('rebind-turn', 'rebind-task', session.session_id, 'completed');
      const owner = { workspace: f.env.workspaceRoot, conversationId: session.session_id, taskId: 'rebind-task', turnId: 'rebind-turn', toolCallId: 'rebind-call' };
      const ownership = { schemaVersion: 1, owner, requestId: 'rebind-request', ownershipState: 'owned' };
      const fact = { handleId: 'legacy-recovered', workspacePath: f.env.workspaceRoot, pid, command: 'previous command',
        cwd: f.env.workspaceRoot, startedAt: '2026-11-18T00:00:00.000Z', lastProbeStatus: 'running' };
      p.recordManagedOwnership(fact, ownership);
      // A later complete copy of the owned record: the history goes on past the damage.
      f.db.prepare(`INSERT INTO a9_events (session_id, turn_id, kind, event_type, payload_json, created_at)
        SELECT session_id, turn_id, kind, event_type, payload_json, created_at FROM a9_events
        WHERE event_type = 'managed_process_ownership'`).run();
      if (status === 'released') {
        p.recordManagedOwnership(fact, { ...ownership, ownershipState: 'release_intent', releaseId: 'rel' });
        p.recordManagedOwnership({ ...fact, lastProbeStatus: 'released' }, { ...ownership, ownershipState: 'released', releaseId: 'rel' });
      } else {
        p.recordManagedOwnership({ ...fact, lastProbeStatus: 'stopped' }, ownership);
      }
      const otherRoot = path.join(f.env.root, 'rebound-ws'); fs.mkdirSync(otherRoot);
      p.changeWorkdir(session.session_id, f.env.workspaceRoot, otherRoot, false);
      expect(p.listConversations(otherRoot).map((item: any) => item.sessionId)).toEqual([session.session_id]);
      p.db.close();
      // Another connection truncates only the oldest ownership record of the handle.
      f.db.exec(`UPDATE a9_events SET payload_json = ${truncated} WHERE id = (SELECT min(id) FROM a9_events
        WHERE event_type = 'managed_process_ownership')`);
      const valid = f.db.prepare(`SELECT json_valid(payload_json) AS valid FROM a9_events
        WHERE event_type = 'managed_process_ownership' ORDER BY id`).all().map((event: any) => event.valid);
      expect(valid).toEqual(status === 'released' ? [0, 1, 1, 1] : [0, 1]);
      const before = f.row();
      expect((before as any).last_probe_status).toBe(status);
      probe.state.result = 'absent';
      runtime = makeRuntime(f.env);
      expect(runtime.status).toBe('ready');
      expect(JSON.stringify(runtime.getSnapshot({ bypassCache: true }).persistenceDiagnostics)).toContain('A9_MANAGED_OWNERSHIP_CORRUPT');
      expect(runtime.canLeaveWorkspace().allowed).toBe(false);
      for (const stopManaged of [true, false]) {
        const closed = await runtime.shutdown({ stopManaged });
        expect(closed.unresolved.length).toBeGreaterThan(0);
        expect(f.lockRows()).toBe(1);
      }
      expect(f.row()).toEqual(before);
      expect(probe.signals().every((signal: unknown) => signal === 0)).toBe(true);
    } finally {
      probe.state.result = 'absent';
      if (runtime) await runtime.shutdown({ stopManaged: false });
      warn.mockRestore(); probe.restore(); f.db.close(); fs.rmSync(f.env.root, { recursive: true, force: true });
    }
  });

// P1 (round 17): the original conversation is rebound with a real `changeWorkdir` and its oldest
// ownership record is truncated; another conversation of the original workspace then writes a
// complete `owned` record of the same handle. That record must not shadow the older damaged
// history of the stopped fact: leave stays blocked and both shutdown modes keep the lock.
// P1 (round 18): the deduplicated real flow leaves the original conversation exactly one
// ownership record; that single damaged record must fail closed as well as a duplicated one.
// P1 (round 19): that single record cut before its handleId (or the value's first character)
// names neither handle nor workspace; it still blocks stopped and exited facts.
it.each(([
  ['opening brace only', `'{'`],
  ['handleId key only', `'{"handleId":"'`],
  ['handleId closing quote lost', `'{"schemaVersion":1,"handleId":"' || json_extract(payload_json, '$.handleId')`],
  ['before workspace field', `'{"schemaVersion":1,"handleId":"' || json_extract(payload_json, '$.handleId') || '","owner":{'`],
] as const).flatMap(([name, truncated]) => (['stopped', 'exited'] as const).flatMap(status => [
  [`${status}, ${name}, single original record`, truncated, false, status],
  [`${status}, ${name}, duplicated original record`, truncated, true, status],
] as const)))('a complete owned record of another conversation does not shadow older damage of a terminal fact (%s)',
  async (_name, truncated, duplicated, status) => {
    const pid = 987655500 + Math.floor(Math.random() * 99);
    const probe = scriptedPidProbe(pid);
    const f = await legacyRecoveredEnv(pid); let runtime: any;
    const warn = jest.spyOn(process, 'emitWarning').mockImplementation(() => {});
    try {
      const { A9PersistenceManager } = require('../../../state/dist/a9-persistence');
      const opened = A9PersistenceManager.open({ databasePath: path.join(f.env.dataRoot, 'a9-state.db'), dataRoot: f.env.dataRoot,
        openDatabase: (p: string) => new Database(p) });
      if (opened.status !== 'ready') throw new Error(opened.status);
      const p = opened.manager;
      const session = f.db.prepare('SELECT session_id FROM a9_sessions LIMIT 1').get() as { session_id: string };
      p.upsertTask('rebind-task', session.session_id, 'completed');
      p.upsertTurn('rebind-turn', 'rebind-task', session.session_id, 'completed');
      const owner = { workspace: f.env.workspaceRoot, conversationId: session.session_id, taskId: 'rebind-task', turnId: 'rebind-turn', toolCallId: 'rebind-call' };
      const ownership = { schemaVersion: 1, owner, requestId: 'rebind-request', ownershipState: 'owned' };
      const fact = { handleId: 'legacy-recovered', workspacePath: f.env.workspaceRoot, pid, command: 'previous command',
        cwd: f.env.workspaceRoot, startedAt: '2026-11-18T00:00:00.000Z', lastProbeStatus: 'running' };
      p.recordManagedOwnership(fact, ownership);
      if (duplicated) {
        f.db.prepare(`INSERT INTO a9_events (session_id, turn_id, kind, event_type, payload_json, created_at)
          SELECT session_id, turn_id, kind, event_type, payload_json, created_at FROM a9_events
          WHERE event_type = 'managed_process_ownership'`).run();
      }
      p.recordManagedOwnership({ ...fact, lastProbeStatus: status }, ownership);
      const otherRoot = path.join(f.env.root, 'rebound-ws'); fs.mkdirSync(otherRoot);
      p.changeWorkdir(session.session_id, f.env.workspaceRoot, otherRoot, false);
      expect(p.listConversations(otherRoot).map((item: any) => item.sessionId)).toEqual([session.session_id]);
      // Another conversation of the original workspace writes a complete owned record of the handle.
      p.createConversation('shadow-session', f.env.workspaceRoot);
      p.upsertTask('shadow-task', 'shadow-session', 'completed');
      p.upsertTurn('shadow-turn', 'shadow-task', 'shadow-session', 'completed');
      p.recordToolEvent('shadow-session', 'shadow-turn', 'managed_process_ownership', { ...ownership, handleId: fact.handleId,
        owner: { workspace: f.env.workspaceRoot, conversationId: 'shadow-session', taskId: 'shadow-task', turnId: 'shadow-turn', toolCallId: 'shadow-call' } });
      p.db.close();
      // Another connection truncates only the original conversation's oldest ownership record.
      f.db.exec(`UPDATE a9_events SET payload_json = ${truncated} WHERE id = (SELECT min(id) FROM a9_events
        WHERE event_type = 'managed_process_ownership')`);
      const events = f.db.prepare(`SELECT session_id, json_valid(payload_json) AS valid FROM a9_events
        WHERE event_type = 'managed_process_ownership' ORDER BY id`).all();
      expect(events).toEqual([{ session_id: session.session_id, valid: 0 },
        ...(duplicated ? [{ session_id: session.session_id, valid: 1 }] : []), { session_id: 'shadow-session', valid: 1 }]);
      const before = f.row();
      expect((before as any).last_probe_status).toBe(status);
      probe.state.result = 'absent';
      runtime = makeRuntime(f.env);
      expect(runtime.status).toBe('ready');
      expect(JSON.stringify(runtime.getSnapshot({ bypassCache: true }).persistenceDiagnostics)).toContain('A9_MANAGED_OWNERSHIP_CORRUPT');
      expect(runtime.canLeaveWorkspace().allowed).toBe(false);
      for (const stopManaged of [true, false]) {
        const closed = await runtime.shutdown({ stopManaged });
        expect(closed.unresolved.length).toBeGreaterThan(0);
        expect(f.lockRows()).toBe(1);
      }
      expect(f.row()).toEqual(before);
      expect(probe.signals().every((signal: unknown) => signal === 0)).toBe(true);
    } finally {
      probe.state.result = 'absent';
      if (runtime) await runtime.shutdown({ stopManaged: false });
      warn.mockRestore(); probe.restore(); f.db.close(); fs.rmSync(f.env.root, { recursive: true, force: true });
    }
  });

// P1 (round 20): the original conversation is rebound more than once (A -> B -> C), or renamed in
// place and then rebound, before its single ownership record of A is cut before its handleId.
// Its ordered workspace history still places that record in A: a later complete record of
// another conversation of A never shadows it, leave stays blocked and both shutdowns keep the lock.
it.each((['A -> B -> C', 'rename A -> A2, then link A2 -> B'] as const).flatMap(route => (['stopped', 'exited'] as const).flatMap(status =>
  ([['opening brace only', `'{'`], ['handleId key only', `'{"handleId":"'`]] as const).map(([name, truncated]) =>
    [`${route}, ${status}, ${name}`, route, status, truncated] as const))))(
  'round 20: repeated rebinds keep older damage of a terminal fact in its original workspace (%s)',
  async (_name, route, status, truncated) => {
    const pid = 987655600 + Math.floor(Math.random() * 99);
    const probe = scriptedPidProbe(pid);
    const f = await legacyRecoveredEnv(pid); let runtime: any;
    const warn = jest.spyOn(process, 'emitWarning').mockImplementation(() => {});
    try {
      const { A9PersistenceManager } = require('../../../state/dist/a9-persistence');
      const opened = A9PersistenceManager.open({ databasePath: path.join(f.env.dataRoot, 'a9-state.db'), dataRoot: f.env.dataRoot,
        openDatabase: (p: string) => new Database(p) });
      if (opened.status !== 'ready') throw new Error(opened.status);
      const p = opened.manager;
      const session = f.db.prepare('SELECT session_id FROM a9_sessions LIMIT 1').get() as { session_id: string };
      p.upsertTask('rebind-task', session.session_id, 'completed');
      p.upsertTurn('rebind-turn', 'rebind-task', session.session_id, 'completed');
      const owner = { workspace: f.env.workspaceRoot, conversationId: session.session_id, taskId: 'rebind-task', turnId: 'rebind-turn', toolCallId: 'rebind-call' };
      const ownership = { schemaVersion: 1, owner, requestId: 'rebind-request', ownershipState: 'owned' };
      const fact = { handleId: 'legacy-recovered', workspacePath: f.env.workspaceRoot, pid, command: 'previous command',
        cwd: f.env.workspaceRoot, startedAt: '2026-11-18T00:00:00.000Z', lastProbeStatus: 'running' };
      p.recordManagedOwnership(fact, ownership);
      p.recordManagedOwnership({ ...fact, lastProbeStatus: status }, ownership);
      const firstRoot = path.join(f.env.root, 'rebound-ws-1'); fs.mkdirSync(firstRoot);
      const secondRoot = path.join(f.env.root, 'rebound-ws-2'); fs.mkdirSync(secondRoot);
      p.changeWorkdir(session.session_id, f.env.workspaceRoot, firstRoot, route !== 'A -> B -> C');
      p.changeWorkdir(session.session_id, firstRoot, secondRoot, false);
      expect(p.listConversations(secondRoot).map((item: any) => item.sessionId)).toEqual([session.session_id]);
      expect(p.getConversationMetadata(session.session_id).workdir.workspaceHistory[0]).toMatchObject({ workspace: f.env.workspaceRoot });
      // Another conversation of the original workspace writes a complete owned record of the handle.
      p.createConversation('shadow-session', f.env.workspaceRoot);
      p.upsertTask('shadow-task', 'shadow-session', 'completed');
      p.upsertTurn('shadow-turn', 'shadow-task', 'shadow-session', 'completed');
      p.recordToolEvent('shadow-session', 'shadow-turn', 'managed_process_ownership', { ...ownership, handleId: fact.handleId,
        owner: { workspace: f.env.workspaceRoot, conversationId: 'shadow-session', taskId: 'shadow-task', turnId: 'shadow-turn', toolCallId: 'shadow-call' } });
      p.db.close();
      f.db.exec(`UPDATE a9_events SET payload_json = ${truncated} WHERE id = (SELECT min(id) FROM a9_events
        WHERE event_type = 'managed_process_ownership')`);
      expect(f.db.prepare(`SELECT session_id, json_valid(payload_json) AS valid FROM a9_events
        WHERE event_type = 'managed_process_ownership' ORDER BY id`).all()).toEqual([
        { session_id: session.session_id, valid: 0 }, { session_id: 'shadow-session', valid: 1 }]);
      const before = f.row();
      expect((before as any).last_probe_status).toBe(status);
      probe.state.result = 'absent';
      runtime = makeRuntime(f.env);
      expect(runtime.status).toBe('ready');
      expect(JSON.stringify(runtime.getSnapshot({ bypassCache: true }).persistenceDiagnostics)).toContain('A9_MANAGED_OWNERSHIP_CORRUPT');
      expect(runtime.canLeaveWorkspace().allowed).toBe(false);
      for (const stopManaged of [true, false]) {
        const closed = await runtime.shutdown({ stopManaged });
        expect(closed.unresolved.length).toBeGreaterThan(0);
        expect(f.lockRows()).toBe(1);
      }
      expect(f.row()).toEqual(before);
      expect(probe.signals().every((signal: unknown) => signal === 0)).toBe(true);
    } finally {
      probe.state.result = 'absent';
      if (runtime) await runtime.shutdown({ stopManaged: false });
      warn.mockRestore(); probe.restore(); f.db.close(); fs.rmSync(f.env.root, { recursive: true, force: true });
    }
  });

// P1 (round 20): after the original conversation is rebound A -> B it writes an ownership record
// of a new handle in B, which is cut before its handleId. Another conversation of A owns a healthy
// handle there (stopped, or the full release chain), written before or after that damage. The
// damage of B never blocks A: leave is allowed and both shutdown modes release A's lock.
it.each((['stopped', 'released'] as const).flatMap(status => (['before', 'after'] as const).flatMap(order =>
  ([['opening brace only', `'{'`], ['handleId key only', `'{"handleId":"'`]] as const).map(([name, truncated]) =>
    [`${status}, healthy handle written ${order} the damage, ${name}`, status, order, truncated] as const))))(
  'round 20: damage written in the new workspace never blocks a healthy handle of the old one (%s)',
  async (_name, status, order, truncated) => {
    const pid = 987655700 + Math.floor(Math.random() * 99);
    const probe = scriptedPidProbe(pid);
    const f = await legacyRecoveredEnv(pid); let runtime: any;
    const warn = jest.spyOn(process, 'emitWarning').mockImplementation(() => {});
    try {
      const { A9PersistenceManager } = require('../../../state/dist/a9-persistence');
      const opened = A9PersistenceManager.open({ databasePath: path.join(f.env.dataRoot, 'a9-state.db'), dataRoot: f.env.dataRoot,
        openDatabase: (p: string) => new Database(p) });
      if (opened.status !== 'ready') throw new Error(opened.status);
      const p = opened.manager;
      const session = f.db.prepare('SELECT session_id FROM a9_sessions LIMIT 1').get() as { session_id: string };
      p.createConversation('healthy-session', f.env.workspaceRoot);
      const healthy = () => {
        p.upsertTask('healthy-task', 'healthy-session', 'active');
        p.upsertTurn('healthy-turn', 'healthy-task', 'healthy-session', 'active');
        const ownership = { schemaVersion: 1, requestId: 'healthy-request', ownershipState: 'owned',
          owner: { workspace: f.env.workspaceRoot, conversationId: 'healthy-session', taskId: 'healthy-task', turnId: 'healthy-turn', toolCallId: 'healthy-call' } };
        const fact = { handleId: 'legacy-recovered', workspacePath: f.env.workspaceRoot, pid, command: 'previous command',
          cwd: f.env.workspaceRoot, startedAt: '2026-11-18T00:00:00.000Z', lastProbeStatus: 'running' };
        p.recordManagedOwnership(fact, ownership);
        if (status === 'released') {
          p.recordManagedOwnership(fact, { ...ownership, ownershipState: 'release_intent', releaseId: 'healthy-release' });
          p.recordManagedOwnership({ ...fact, lastProbeStatus: 'released', cleanupRequired: false },
            { ...ownership, ownershipState: 'released', releaseId: 'healthy-release' });
        } else {
          p.recordManagedOwnership({ ...fact, lastProbeStatus: status }, ownership);
        }
        p.upsertTurn('healthy-turn', 'healthy-task', 'healthy-session', 'completed');
        p.upsertTask('healthy-task', 'healthy-session', 'completed');
      };
      if (order === 'before') healthy();
      // The seeded running row would keep A busy; the healthy handle is recorded afresh after the rebind.
      else f.db.prepare("DELETE FROM a9_managed_processes WHERE handle_id = 'legacy-recovered'").run();
      const newRoot = path.join(f.env.root, 'rebound-ws'); fs.mkdirSync(newRoot);
      p.changeWorkdir(session.session_id, f.env.workspaceRoot, newRoot, false);
      // The rebound conversation records a new handle in B; that record is damaged afterwards.
      p.upsertTask('new-task', session.session_id, 'active'); p.upsertTurn('new-turn', 'new-task', session.session_id, 'active');
      p.recordManagedOwnership({ handleId: 'new-handle', workspacePath: newRoot, pid: pid + 1000, command: 'new command', cwd: newRoot,
        startedAt: '2026-11-19T00:00:00.000Z', lastProbeStatus: 'stopped' }, { schemaVersion: 1, requestId: 'new-request', ownershipState: 'owned',
        owner: { workspace: newRoot, conversationId: session.session_id, taskId: 'new-task', turnId: 'new-turn', toolCallId: 'new-call' } });
      const damagedId = (f.db.prepare(`SELECT max(id) AS id FROM a9_events WHERE event_type = 'managed_process_ownership'`).get() as { id: number }).id;
      p.upsertTurn('new-turn', 'new-task', session.session_id, 'completed'); p.upsertTask('new-task', session.session_id, 'completed');
      if (order === 'after') healthy();
      p.db.close();
      f.db.prepare(`UPDATE a9_events SET payload_json = ${truncated} WHERE id = ?`).run(damagedId);
      expect((f.db.prepare('SELECT session_id, json_valid(payload_json) AS valid FROM a9_events WHERE id = ?').get(damagedId)))
        .toEqual({ session_id: session.session_id, valid: 0 });
      expect((f.row() as any).last_probe_status).toBe(status);
      probe.state.result = 'absent';
      for (const stopManaged of [true, false]) {
        runtime = makeRuntime(f.env);
        expect(runtime.status).toBe('ready');
        expect(JSON.stringify(runtime.getSnapshot({ bypassCache: true }).persistenceDiagnostics || [])).not.toContain('A9_MANAGED_OWNERSHIP_CORRUPT');
        expect(runtime.canLeaveWorkspace()).toMatchObject({ allowed: true });
        expect(f.lockRows()).toBe(1);
        const closed = await runtime.shutdown({ stopManaged });
        runtime = null;
        expect(closed.unresolved).toEqual([]);
        expect(f.lockRows()).toBe(0);
      }
      expect((f.row() as any).last_probe_status).toBe(status);
      expect(probe.signals().every((signal: unknown) => signal === 0)).toBe(true);
    } finally {
      probe.state.result = 'absent';
      if (runtime) await runtime.shutdown({ stopManaged: false });
      warn.mockRestore(); probe.restore(); f.db.close(); fs.rmSync(f.env.root, { recursive: true, force: true });
    }
  });

// P1 (round 21): the same conversation owns a settled handle in A (stopped, or the full release
// chain), is rebound A -> B (or A -> B -> C -> D) and writes an ownership record of a new handle
// in B, which is cut before its handleId. That anonymous record of the anchor's own conversation
// was written in B, never in A: leave of A is allowed and both shutdown modes release A's lock.
it.each((['A -> B', 'A -> B -> C -> D'] as const).flatMap(route => (['stopped', 'released'] as const).flatMap(status =>
  ([['opening brace only', `'{'`], ['handleId key only', `'{"handleId":"'`]] as const).map(([name, truncated]) =>
    [`${route}, ${status}, ${name}`, route, status, truncated] as const))))(
  'round 21: damage the same conversation writes in a new workspace never blocks its settled handle of the old one (%s)',
  async (_name, route, status, truncated) => {
    const pid = 987655800 + Math.floor(Math.random() * 99);
    const probe = scriptedPidProbe(pid);
    const f = await legacyRecoveredEnv(pid); let runtime: any;
    const warn = jest.spyOn(process, 'emitWarning').mockImplementation(() => {});
    try {
      const { A9PersistenceManager } = require('../../../state/dist/a9-persistence');
      const opened = A9PersistenceManager.open({ databasePath: path.join(f.env.dataRoot, 'a9-state.db'), dataRoot: f.env.dataRoot,
        openDatabase: (p: string) => new Database(p) });
      if (opened.status !== 'ready') throw new Error(opened.status);
      const p = opened.manager;
      const session = f.db.prepare('SELECT session_id FROM a9_sessions LIMIT 1').get() as { session_id: string };
      p.upsertTask('own-task', session.session_id, 'active');
      p.upsertTurn('own-turn', 'own-task', session.session_id, 'active');
      const ownership = { schemaVersion: 1, requestId: 'own-request', ownershipState: 'owned',
        owner: { workspace: f.env.workspaceRoot, conversationId: session.session_id, taskId: 'own-task', turnId: 'own-turn', toolCallId: 'own-call' } };
      const fact = { handleId: 'legacy-recovered', workspacePath: f.env.workspaceRoot, pid, command: 'previous command',
        cwd: f.env.workspaceRoot, startedAt: '2026-11-18T00:00:00.000Z', lastProbeStatus: 'running' };
      p.recordManagedOwnership(fact, ownership);
      if (status === 'released') {
        p.recordManagedOwnership(fact, { ...ownership, ownershipState: 'release_intent', releaseId: 'own-release' });
        p.recordManagedOwnership({ ...fact, lastProbeStatus: 'released', cleanupRequired: false },
          { ...ownership, ownershipState: 'released', releaseId: 'own-release' });
      } else {
        p.recordManagedOwnership({ ...fact, lastProbeStatus: status, cleanupRequired: false }, ownership);
      }
      p.upsertTurn('own-turn', 'own-task', session.session_id, 'completed');
      p.upsertTask('own-task', session.session_id, 'completed');
      const roots = ['rebound-ws-b', 'rebound-ws-c', 'rebound-ws-d'].map(name => {
        const dir = path.join(f.env.root, name); fs.mkdirSync(dir); return dir;
      });
      const hops = route === 'A -> B' ? [roots[0]] : roots;
      let current = f.env.workspaceRoot;
      // The new handle is recorded in B; on the long route the conversation then moves on to C and D.
      p.changeWorkdir(session.session_id, current, hops[0], false); current = hops[0];
      p.upsertTask('new-task', session.session_id, 'active'); p.upsertTurn('new-turn', 'new-task', session.session_id, 'active');
      p.recordManagedOwnership({ handleId: 'new-handle', workspacePath: current, pid: pid + 1000, command: 'new command', cwd: current,
        startedAt: '2026-11-19T00:00:00.000Z', lastProbeStatus: 'stopped', cleanupRequired: false }, { schemaVersion: 1, requestId: 'new-request',
        ownershipState: 'owned', owner: { workspace: current, conversationId: session.session_id, taskId: 'new-task', turnId: 'new-turn', toolCallId: 'new-call' } });
      const damagedId = (f.db.prepare(`SELECT max(id) AS id FROM a9_events WHERE event_type = 'managed_process_ownership'`).get() as { id: number }).id;
      p.upsertTurn('new-turn', 'new-task', session.session_id, 'completed'); p.upsertTask('new-task', session.session_id, 'completed');
      for (const next of hops.slice(1)) { p.changeWorkdir(session.session_id, current, next, false); current = next; }
      expect(p.listConversations(current).map((item: any) => item.sessionId)).toEqual([session.session_id]);
      p.db.close();
      f.db.prepare(`UPDATE a9_events SET payload_json = ${truncated} WHERE id = ?`).run(damagedId);
      expect((f.db.prepare('SELECT session_id, json_valid(payload_json) AS valid FROM a9_events WHERE id = ?').get(damagedId)))
        .toEqual({ session_id: session.session_id, valid: 0 });
      expect((f.row() as any).last_probe_status).toBe(status);
      probe.state.result = 'absent';
      for (const stopManaged of [true, false]) {
        runtime = makeRuntime(f.env);
        expect(runtime.status).toBe('ready');
        expect(JSON.stringify(runtime.getSnapshot({ bypassCache: true }).persistenceDiagnostics || [])).not.toContain('A9_MANAGED_OWNERSHIP_CORRUPT');
        expect(runtime.canLeaveWorkspace()).toMatchObject({ allowed: true });
        expect(f.lockRows()).toBe(1);
        const closed = await runtime.shutdown({ stopManaged });
        runtime = null;
        expect(closed.unresolved).toEqual([]);
        expect(f.lockRows()).toBe(0);
      }
      expect((f.row() as any).last_probe_status).toBe(status);
      expect(probe.signals().every((signal: unknown) => signal === 0)).toBe(true);
    } finally {
      probe.state.result = 'absent';
      if (runtime) await runtime.shutdown({ stopManaged: false });
      warn.mockRestore(); probe.restore(); f.db.close(); fs.rmSync(f.env.root, { recursive: true, force: true });
    }
  });

// P1 (round 22): the same conversation owns a settled handle in A (stopped, or the full release
// chain) and, still in A, records and stops a new handle. A legacy build then rebinds it to B
// (`workdir: { origin: 'linked' }` without segments or previousWorkspace), or its session metadata
// is damaged, and the record of the new handle written in A is truncated. No segment proves that
// record was written outside A, so it stays damage of A: leave is refused and both shutdown modes
// keep A's lock with a non-empty `unresolved`.
it.each(([
  ['legacy linked metadata', JSON.stringify({ workdir: { version: 1, origin: 'linked', createdAt: null } })],
  ['damaged metadata_json', '{'],
] as const).flatMap(([route, metadata]) => (['stopped', 'released'] as const).flatMap(status =>
  ([['opening brace only', `'{'`], ['handleId key only', `'{"handleId":"'`]] as const).map(([name, truncated]) =>
    [`${route}, ${status}, ${name}`, metadata, status, truncated] as const))))(
  'round 22: damage the same conversation wrote in A before a legacy rebind keeps blocking leave of A (%s)',
  async (_name, metadata, status, truncated) => {
    const pid = 987655900 + Math.floor(Math.random() * 99);
    const probe = scriptedPidProbe(pid);
    const f = await legacyRecoveredEnv(pid); let runtime: any;
    const warn = jest.spyOn(process, 'emitWarning').mockImplementation(() => {});
    try {
      const { A9PersistenceManager } = require('../../../state/dist/a9-persistence');
      const opened = A9PersistenceManager.open({ databasePath: path.join(f.env.dataRoot, 'a9-state.db'), dataRoot: f.env.dataRoot,
        openDatabase: (p: string) => new Database(p) });
      if (opened.status !== 'ready') throw new Error(opened.status);
      const p = opened.manager;
      const session = f.db.prepare('SELECT session_id FROM a9_sessions LIMIT 1').get() as { session_id: string };
      p.upsertTask('own-task', session.session_id, 'active');
      p.upsertTurn('own-turn', 'own-task', session.session_id, 'active');
      const ownership = { schemaVersion: 1, requestId: 'own-request', ownershipState: 'owned',
        owner: { workspace: f.env.workspaceRoot, conversationId: session.session_id, taskId: 'own-task', turnId: 'own-turn', toolCallId: 'own-call' } };
      const fact = { handleId: 'legacy-recovered', workspacePath: f.env.workspaceRoot, pid, command: 'previous command',
        cwd: f.env.workspaceRoot, startedAt: '2026-11-18T00:00:00.000Z', lastProbeStatus: 'running' };
      p.recordManagedOwnership(fact, ownership);
      if (status === 'released') {
        p.recordManagedOwnership(fact, { ...ownership, ownershipState: 'release_intent', releaseId: 'own-release' });
        p.recordManagedOwnership({ ...fact, lastProbeStatus: 'released', cleanupRequired: false },
          { ...ownership, ownershipState: 'released', releaseId: 'own-release' });
      } else {
        p.recordManagedOwnership({ ...fact, lastProbeStatus: status, cleanupRequired: false }, ownership);
      }
      p.upsertTurn('own-turn', 'own-task', session.session_id, 'completed');
      p.upsertTask('own-task', session.session_id, 'completed');
      // The new handle is recorded and stopped while the conversation is still bound to A.
      p.upsertTask('new-task', session.session_id, 'active'); p.upsertTurn('new-turn', 'new-task', session.session_id, 'active');
      p.recordManagedOwnership({ handleId: 'new-handle', workspacePath: f.env.workspaceRoot, pid: pid + 1000, command: 'new command',
        cwd: f.env.workspaceRoot, startedAt: '2026-11-19T00:00:00.000Z', lastProbeStatus: 'stopped', cleanupRequired: false }, {
        schemaVersion: 1, requestId: 'new-request', ownershipState: 'owned',
        owner: { workspace: f.env.workspaceRoot, conversationId: session.session_id, taskId: 'new-task', turnId: 'new-turn', toolCallId: 'new-call' } });
      const damagedId = (f.db.prepare(`SELECT max(id) AS id FROM a9_events WHERE event_type = 'managed_process_ownership'`).get() as { id: number }).id;
      p.upsertTurn('new-turn', 'new-task', session.session_id, 'completed'); p.upsertTask('new-task', session.session_id, 'completed');
      p.db.close();
      // A legacy rebind to B: no workspaceHistory segments and no previousWorkspace (or damaged metadata).
      const reboundRoot = path.join(f.env.root, 'rebound-ws-b'); fs.mkdirSync(reboundRoot);
      f.db.prepare('UPDATE a9_sessions SET workspace_path = ?, metadata_json = ? WHERE session_id = ?').run(reboundRoot, metadata, session.session_id);
      f.db.prepare(`UPDATE a9_events SET payload_json = ${truncated} WHERE id = ?`).run(damagedId);
      expect((f.db.prepare('SELECT session_id, json_valid(payload_json) AS valid FROM a9_events WHERE id = ?').get(damagedId)))
        .toEqual({ session_id: session.session_id, valid: 0 });
      const before = f.row();
      expect((before as any).last_probe_status).toBe(status);
      probe.state.result = 'absent';
      runtime = makeRuntime(f.env);
      expect(runtime.status).toBe('ready');
      expect(JSON.stringify(runtime.getSnapshot({ bypassCache: true }).persistenceDiagnostics)).toContain('A9_MANAGED_OWNERSHIP_CORRUPT');
      expect(runtime.canLeaveWorkspace().allowed).toBe(false);
      for (const stopManaged of [true, false]) {
        const closed = await runtime.shutdown({ stopManaged });
        expect(closed.unresolved.length).toBeGreaterThan(0);
        expect(f.lockRows()).toBe(1);
      }
      expect(f.row()).toEqual(before);
      expect(probe.signals().every((signal: unknown) => signal === 0)).toBe(true);
    } finally {
      probe.state.result = 'absent';
      if (runtime) await runtime.shutdown({ stopManaged: false });
      warn.mockRestore(); probe.restore(); f.db.close(); fs.rmSync(f.env.root, { recursive: true, force: true });
    }
  });

// P1 (round 23): shared fixture. A9's own (settled) handle `ownHandle` of the seeded conversation in
// A (stopped, or the full release chain) and a second handle of the same conversation, recorded by
// `recordOther` before or after it. The fact row of the seed is renamed to `ownHandle`.
async function round23Env(pid: number, ownHandle: string) {
  const f = await legacyRecoveredEnv(pid);
  f.db.prepare("UPDATE a9_managed_processes SET handle_id = ? WHERE handle_id = 'legacy-recovered'").run(ownHandle);
  const row = () => f.db.prepare('SELECT pid, started_at, last_probe_status FROM a9_managed_processes WHERE handle_id = ?').get(ownHandle);
  const { A9PersistenceManager } = require('../../../state/dist/a9-persistence');
  const opened = A9PersistenceManager.open({ databasePath: path.join(f.env.dataRoot, 'a9-state.db'), dataRoot: f.env.dataRoot,
    openDatabase: (p: string) => new Database(p) });
  if (opened.status !== 'ready') throw new Error(opened.status);
  const p = opened.manager;
  const session = (f.db.prepare('SELECT session_id FROM a9_sessions LIMIT 1').get() as { session_id: string }).session_id;
  const recordOwn = (status: 'stopped' | 'released', turn = 'own-turn') => {
    p.upsertTask(`${turn}-task`, session, 'active'); p.upsertTurn(turn, `${turn}-task`, session, 'active');
    const ownership = { schemaVersion: 1, requestId: 'own-request', ownershipState: 'owned',
      owner: { workspace: f.env.workspaceRoot, conversationId: session, taskId: `${turn}-task`, turnId: turn, toolCallId: 'own-call' } };
    const fact = { handleId: ownHandle, workspacePath: f.env.workspaceRoot, pid, command: 'previous command',
      cwd: f.env.workspaceRoot, startedAt: '2026-11-18T00:00:00.000Z', lastProbeStatus: 'running' };
    p.recordManagedOwnership(fact, ownership);
    if (status === 'released') {
      p.recordManagedOwnership(fact, { ...ownership, ownershipState: 'release_intent', releaseId: 'own-release' });
      p.recordManagedOwnership({ ...fact, lastProbeStatus: 'released', cleanupRequired: false },
        { ...ownership, ownershipState: 'released', releaseId: 'own-release' });
    } else {
      p.recordManagedOwnership({ ...fact, lastProbeStatus: status, cleanupRequired: false }, ownership);
    }
    p.upsertTurn(turn, `${turn}-task`, session, 'completed'); p.upsertTask(`${turn}-task`, session, 'completed');
  };
  /** Records and stops `handleId` in `workspace`; returns its ownership event ids. */
  const recordOther = (handleId: string, workspace: string, turn = 'new-turn') => {
    p.upsertTask(`${turn}-task`, session, 'active'); p.upsertTurn(turn, `${turn}-task`, session, 'active');
    p.recordManagedOwnership({ handleId, workspacePath: workspace, pid: pid + 1000, command: 'new command', cwd: workspace,
      startedAt: '2026-11-19T00:00:00.000Z', lastProbeStatus: 'stopped', cleanupRequired: false }, { schemaVersion: 1, requestId: 'new-request',
      ownershipState: 'owned', owner: { workspace, conversationId: session, taskId: `${turn}-task`, turnId: turn, toolCallId: 'new-call' } });
    p.upsertTurn(turn, `${turn}-task`, session, 'completed'); p.upsertTask(`${turn}-task`, session, 'completed');
    return (f.db.prepare(`SELECT id FROM a9_events WHERE event_type = 'managed_process_ownership'
      AND json_extract(payload_json, '$.handleId') = ?`).all(handleId) as Array<{ id: number }>).map(item => item.id);
  };
  const mkdir = (name: string) => { const dir = path.join(f.env.root, name); fs.mkdirSync(dir); return dir; };
  const truncate = (ids: number[], payload: string) => {
    for (const id of ids) f.db.prepare('UPDATE a9_events SET payload_json = ? WHERE id = ?').run(payload, id);
  };
  return { ...f, row, p, session, recordOwn, recordOther, mkdir, truncate };
}

async function expectLeaveBlocked(f: Awaited<ReturnType<typeof round23Env>>) {
  const before = f.row();
  const runtime = makeRuntime(f.env);
  try {
    expect(runtime.status).toBe('ready');
    expect(JSON.stringify(runtime.getSnapshot({ bypassCache: true }).persistenceDiagnostics)).toContain('A9_MANAGED_OWNERSHIP_CORRUPT');
    expect(runtime.canLeaveWorkspace().allowed).toBe(false);
    for (const stopManaged of [true, false]) {
      const closed = await runtime.shutdown({ stopManaged });
      expect(closed.unresolved.length).toBeGreaterThan(0);
      expect(f.lockRows()).toBe(1);
    }
  } finally { await runtime.shutdown({ stopManaged: false }); }
  expect(f.row()).toEqual(before);
}

// (1) The conversation settles its own handle and then a new handle in A; a legacy build rebinds
// it to B (`workdir: { origin: 'linked' }`, no segments) and the new handle's records are cut.
// The current build then rebinds it B -> C (the registry's State call). The events written before
// that are closed in an unknown prior segment, never attributed to B: leave of A stays refused and
// both shutdown modes keep A's lock.
it.each((['stopped', 'released'] as const).flatMap(status =>
  ([['opening brace only', '{'], ['handleId key only', '{"handleId":"']] as const).map(([name, truncated]) =>
    [`${status}, ${name}`, status, truncated] as const)))(
  'round 23: a rebind B -> C after a legacy rebind A -> B keeps damage written in A blocking leave of A (%s)',
  async (_name, status, truncated) => {
    const pid = 987656000 + Math.floor(Math.random() * 99);
    const probe = scriptedPidProbe(pid);
    const f = await round23Env(pid, 'legacy-recovered');
    const warn = jest.spyOn(process, 'emitWarning').mockImplementation(() => {});
    try {
      f.recordOwn(status);
      const damaged = f.recordOther('new-handle', f.env.workspaceRoot);
      const b = f.mkdir('rebound-ws-b'); const c = f.mkdir('rebound-ws-c');
      f.db.prepare('UPDATE a9_sessions SET workspace_path = ?, metadata_json = ? WHERE session_id = ?')
        .run(b, JSON.stringify({ workdir: { version: 1, origin: 'linked', createdAt: null } }), f.session);
      f.truncate(damaged, truncated);
      f.p.changeWorkdir(f.session, b, c, false);
      expect(f.p.listConversations(c).map((item: any) => item.sessionId)).toEqual([f.session]);
      expect((f.p.getConversationMetadata(f.session).workdir as any).workspaceHistory.map((entry: any) => entry.workspace))
        .toEqual(['#a9-unknown-prior', b]);
      f.p.db.close();
      expect((f.row() as any).last_probe_status).toBe(status);
      probe.state.result = 'absent';
      await expectLeaveBlocked(f);
      expect(probe.signals().every((signal: unknown) => signal === 0)).toBe(true);
    } finally {
      probe.state.result = 'absent';
      warn.mockRestore(); probe.restore(); f.db.close(); fs.rmSync(f.env.root, { recursive: true, force: true });
    }
  });

// (2) The conversation stops a new handle in turn 1 and settles its own handle in turn 2, both in
// A. It stays in A, or is rebound A -> B -> C and its first segment is damaged; the new handle's
// older records (another turn) are cut. That damage is not proven written outside A: leave of A
// stays refused and both shutdown modes keep A's lock.
it.each((['stopped', 'released'] as const).flatMap(status =>
  ([['opening brace only', '{'], ['handleId key only', '{"handleId":"']] as const).flatMap(([name, truncated]) =>
    (['no rebind', 'A -> B -> C, damaged first segment'] as const).map(route =>
      [`${status}, ${name}, ${route}`, status, truncated, route] as const))))(
  'round 23: an older damaged record of another turn of the same conversation keeps blocking leave of A (%s)',
  async (_name, status, truncated, route) => {
    const pid = 987656100 + Math.floor(Math.random() * 99);
    const probe = scriptedPidProbe(pid);
    const f = await round23Env(pid, 'legacy-recovered');
    const warn = jest.spyOn(process, 'emitWarning').mockImplementation(() => {});
    try {
      const damaged = f.recordOther('new-handle', f.env.workspaceRoot, 'turn-1');
      f.recordOwn(status, 'turn-2');
      if (route !== 'no rebind') {
        const b = f.mkdir('rebound-ws-b'); const c = f.mkdir('rebound-ws-c');
        f.p.changeWorkdir(f.session, f.env.workspaceRoot, b, false); f.p.changeWorkdir(f.session, b, c, false);
        const workdir = f.p.getConversationMetadata(f.session).workdir as any;
        f.p.mergeConversationMetadata(f.session, { workdir: { ...workdir,
          workspaceHistory: [{ workspace: f.env.workspaceRoot }, workdir.workspaceHistory[1]] } });
      }
      f.p.db.close();
      f.truncate(damaged, truncated);
      // Only the settled handle's history decides: the new handle has no fact row of its own left.
      f.db.prepare("DELETE FROM a9_managed_processes WHERE handle_id = 'new-handle'").run();
      expect((f.row() as any).last_probe_status).toBe(status);
      probe.state.result = 'absent';
      await expectLeaveBlocked(f);
      expect(probe.signals().every((signal: unknown) => signal === 0)).toBe(true);
    } finally {
      probe.state.result = 'absent';
      warn.mockRestore(); probe.restore(); f.db.close(); fs.rmSync(f.env.root, { recursive: true, force: true });
    }
  });

// (3) The conversation settles `sh-aaa` in A, is rebound A -> B and records `sh-bbb` there, whose
// record is cut to `{"handleId":"sh-` (a prefix of both). Segments prove it was written in B, so it
// is never damage of A: leave of A is allowed and both shutdown modes release A's lock. The same
// damage written while still bound to A keeps blocking (control).
it.each((['stopped', 'released'] as const).flatMap(status => (['written in B', 'written in A (control)'] as const).map(where =>
  [`${status}, ${where}`, status, where] as const)))(
  'round 23: a handleId prefix cut from a record written in B never blocks leave of A (%s)',
  async (_name, status, where) => {
    const pid = 987656200 + Math.floor(Math.random() * 99);
    const probe = scriptedPidProbe(pid);
    const f = await round23Env(pid, 'sh-aaa'); let runtime: any;
    const warn = jest.spyOn(process, 'emitWarning').mockImplementation(() => {});
    try {
      f.recordOwn(status);
      let workspace = f.env.workspaceRoot;
      if (where === 'written in B') {
        workspace = f.mkdir('rebound-ws-b');
        f.p.changeWorkdir(f.session, f.env.workspaceRoot, workspace, false);
      }
      const damaged = f.recordOther('sh-bbb', workspace);
      f.p.db.close();
      f.truncate(damaged, '{"handleId":"sh-');
      expect((f.row() as any).last_probe_status).toBe(status);
      probe.state.result = 'absent';
      if (where !== 'written in B') { await expectLeaveBlocked(f); return; }
      for (const stopManaged of [true, false]) {
        runtime = makeRuntime(f.env);
        expect(runtime.status).toBe('ready');
        expect(JSON.stringify(runtime.getSnapshot({ bypassCache: true }).persistenceDiagnostics || [])).not.toContain('A9_MANAGED_OWNERSHIP_CORRUPT');
        expect(runtime.canLeaveWorkspace()).toMatchObject({ allowed: true });
        expect(f.lockRows()).toBe(1);
        const closed = await runtime.shutdown({ stopManaged });
        runtime = null;
        expect(closed.unresolved).toEqual([]);
        expect(f.lockRows()).toBe(0);
      }
      expect((f.row() as any).last_probe_status).toBe(status);
      expect(probe.signals().every((signal: unknown) => signal === 0)).toBe(true);
    } finally {
      probe.state.result = 'absent';
      if (runtime) await runtime.shutdown({ stopManaged: false });
      warn.mockRestore(); probe.restore(); f.db.close(); fs.rmSync(f.env.root, { recursive: true, force: true });
    }
  });
