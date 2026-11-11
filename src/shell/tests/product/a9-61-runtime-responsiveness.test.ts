/**
 * A9-61: real Runtime/Workspace/SQLite paths stay responsive during bulk
 * Shell accounting, Stop, cold restart recovery and the first Diff read.
 *
 * TEST_ONLY: a real short POSIX /bin/sh runs behind the product loop adapter and
 * a loopback fixture model answers. Windows transport/Job and Win7 timing are
 * NOT_PERFORMED here. Assertions are behavioral (write counts, event ordering,
 * disk facts, request counts), not millisecond thresholds.
 */
/// <reference path="./better-sqlite3.d.ts" />
import { execFileSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';

const { createA9AgentRuntime } = require('../../product/a9-agent-runtime') as any;
// Spies go on the real module object that compiled product modules read.
const nodeFs: typeof fs = require('fs');

const FILES = 512;
const FILE_BYTES = 2 * 1024;
const SKIPPED_BYTES = 3 * 1024 * 1024;
const COMMAND = 'mkdir dst && mv src/* dst/';
const sha = (value: Buffer | string) => crypto.createHash('sha256').update(value).digest('hex');

const roots: string[] = [];
afterEach(() => {
  jest.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function makeEnv() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a9-61-rt-'));
  roots.push(root);
  const workspaceRoot = path.join(root, 'ws');
  const dataRoot = path.join(root, 'data');
  fs.mkdirSync(path.join(workspaceRoot, 'src'), { recursive: true });
  fs.mkdirSync(dataRoot, { recursive: true });
  const contents = new Map<string, string>();
  for (let index = 0; index < FILES; index += 1) {
    const rel = `src/f-${String(index).padStart(4, '0')}.txt`;
    const body = `fixture ${index}\n`.padEnd(FILE_BYTES, String.fromCharCode(97 + (index % 26)));
    fs.writeFileSync(path.join(workspaceRoot, rel), body);
    contents.set(rel, sha(body));
  }
  const fd = fs.openSync(path.join(workspaceRoot, 'big.bin'), 'w');
  fs.ftruncateSync(fd, SKIPPED_BYTES);
  fs.closeSync(fd);
  return { root, workspaceRoot, dataRoot, contents };
}

function sse(res: http.ServerResponse, value: unknown) { res.write(`data: ${JSON.stringify(value)}\n\n`); }

/** Loopback model: one shell call, then a final answer. Counts every request. */
function startShellFixture(): Promise<{ baseUrl: string; requests: any[]; close: () => Promise<void> }> {
  const requests: any[] = [];
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString('utf8'); });
      req.on('end', () => {
        const parsed = JSON.parse(body);
        requests.push(parsed);
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const toolMessages = (parsed.messages ?? []).filter((m: any) => m.role === 'tool');
        if (toolMessages.length === 0) {
          sse(res, { choices: [{ delta: { tool_calls: [{ index: 0, id: 's1', function: { name: 'shell', arguments: JSON.stringify({ command: COMMAND }) } }] }, finish_reason: 'tool_calls' }] });
        } else {
          sse(res, { choices: [{ delta: { content: 'moved' }, finish_reason: 'stop' }] });
        }
        res.write('data: [DONE]\n\n');
        res.end();
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({
      baseUrl: `http://127.0.0.1:${(server.address() as any).port}`,
      requests,
      close: () => new Promise<void>((done) => server.close(() => done())),
    }));
  });
}

function makeRuntime(env: ReturnType<typeof makeEnv>, onExecuted: () => void = () => {}) {
  const runner = require('../../../runner/dist');
  const modules = {
    core: require('../../../core/dist'), gateway: require('../../../gateway/dist'), state: require('../../../state/dist'),
    workspace: require('../../../workspace/dist'), gitAdapter: require('../../../git-adapter/dist'),
    runner: { ...runner, createTrustedShellLoopAdapter: (instance: any) => ({
      ...runner.createTrustedShellLoopAdapter(instance),
      execute: async (command: string, options: any) => {
        const stdout = execFileSync('/bin/sh', ['-c', command], { cwd: options.cwd || env.workspaceRoot, encoding: 'utf8', timeout: 10_000 });
        onExecuted();
        return { status: 'completed', exitCode: 0, stdout, stderr: '', durationMs: 1, timedOut: false, cancelled: false, processTreeReaped: true };
      },
    }) },
  };
  return createA9AgentRuntime({ modules, workspaceRoot: env.workspaceRoot, dataRoot: env.dataRoot,
    ownerId: `a9-61-${process.pid}-${Date.now()}-${Math.random()}`,
    openDatabase: (p: string, o?: { readonly?: boolean }) => new Database(p, o?.readonly ? { readonly: true } : {}) });
}

/** Ordered log of manifest writes, recovery artifact reads and event-loop heartbeats. */
function instrument() {
  const log: string[] = [];
  const manifests = `${path.sep}.agent_recovery${path.sep}checkpoints${path.sep}`;
  const artifacts = `${path.sep}.agent_recovery${path.sep}snapshots${path.sep}`;
  const realRename = nodeFs.renameSync;
  jest.spyOn(nodeFs, 'renameSync').mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
    realRename(from, to);
    if (typeof to === 'string' && to.includes(manifests) && to.endsWith('.json')) log.push('persist');
  }) as typeof fs.renameSync);
  const realRead = nodeFs.readFileSync;
  jest.spyOn(nodeFs, 'readFileSync').mockImplementation(((target: any, options?: any) => {
    if (typeof target === 'string' && target.includes(artifacts)) log.push('artifact');
    return realRead(target, options);
  }) as typeof fs.readFileSync);
  let beating = false;
  const tick = () => { if (!beating) return; log.push('beat'); setImmediate(tick); };
  const between = (kind: string, from = 0) => {
    const first = log.indexOf(kind, from);
    const last = log.lastIndexOf(kind);
    return first < 0 ? 0 : log.slice(first, last).filter((entry) => entry === 'beat').length;
  };
  return {
    log,
    start: () => { beating = true; setImmediate(tick); },
    stop: () => { beating = false; },
    count: (kind: string, from = 0) => log.slice(from).filter((entry) => entry === kind).length,
    between,
  };
}

function manifestFacts(workspaceRoot: string, turnId: string) {
  const { CheckpointManager } = require('../../../workspace/dist');
  return new CheckpointManager(workspaceRoot).loadCheckpoint(turnId);
}

describe('A9-61 real Runtime responsiveness', () => {
  it('handles Stop during bulk Shell accounting, records every fact durably and serves the cold Diff cooperatively', async () => {
    const env = makeEnv();
    const fixture = await startShellFixture();
    const probe = instrument();
    let runtime: any;
    let collectionStart = -1;
    let stopAt = -1;
    let stopResult: any;
    runtime = makeRuntime(env, () => {
      collectionStart = probe.log.length;
      probe.start();
      // Stop arrives as soon as the main thread can serve it after the Shell returned.
      setImmediate(() => { stopAt = probe.log.length; stopResult = runtime.stop(); });
    });
    let restarted: any;
    try {
      runtime.setMode('full_access');
      await runtime.configureProvider({ baseUrl: fixture.baseUrl, model: 'fixture', skipProbe: true });
      const result = await runtime.submitTurn('move every source file into dst');
      probe.stop();
      expect(result.ok).toBe(true);
      const turnId = result.result.turnId;
      const collectionWrites = probe.count('persist', collectionStart);
      const writesBeforeStop = probe.count('persist', collectionStart) - probe.count('persist', stopAt);
      const operations = FILES * 2 + 1;
      console.log(`A9-61 runtime bulk Stop: outcome=${result.result.outcome} collectionManifestWrites=${collectionWrites} ` +
        `writesBeforeStop=${writesBeforeStop} beatsBetweenWrites=${probe.between('persist', collectionStart)} modelRequests=${fixture.requests.length}`);

      // Stop was served while accounting was still pending, and accounting was not abandoned.
      expect(stopResult).toEqual({ ok: true });
      expect(stopAt).toBeGreaterThan(collectionStart);
      expect(writesBeforeStop).toBeLessThan(collectionWrites);
      expect(collectionWrites).toBeLessThanOrEqual(Math.ceil(operations / 256));
      expect(probe.between('persist', collectionStart)).toBeGreaterThan(0);
      expect(fixture.requests.length).toBe(1); // cancelled after the tool: no further model step

      const checkpoint = manifestFacts(env.workspaceRoot, turnId);
      expect(checkpoint.externalBaseline.collectionStatus).toBe('complete');
      expect(Object.keys(checkpoint.changes)).toHaveLength(operations);
      for (const [rel, hash] of env.contents) {
        expect(checkpoint.changes[rel]).toMatchObject({ action: 'delete', originalHash: hash });
        expect(checkpoint.changes[rel.replace(/^src\//, 'dst/')]).toMatchObject({ action: 'create', newHash: hash });
      }
      await runtime.shutdown();
      runtime = null;

      // Restart: the first Diff read validates the cold manifest in yielded slices.
      restarted = makeRuntime(env);
      await restarted.whenReady();
      const from = probe.log.length;
      probe.start();
      const diff = await restarted.getDiff(turnId);
      probe.stop();
      console.log(`A9-61 runtime cold Diff: artifactReads=${probe.count('artifact', from)} beatsBetweenArtifactReads=${probe.between('artifact', from)}`);
      expect(diff.ok).toBe(true);
      expect(diff.diff).toHaveLength(operations);
      expect(diff.review.externalBaselineStatus).toBe('complete');
      expect(probe.count('artifact', from)).toBeGreaterThanOrEqual(FILES);
      expect(probe.between('artifact', from)).toBeGreaterThan(0);

      const undo = await restarted.undoTurn(turnId);
      expect(undo.outcome.errors).toEqual([]);
      expect(undo.outcome.drifted).toEqual([]);
      for (const [rel, hash] of env.contents) expect(sha(fs.readFileSync(path.join(env.workspaceRoot, rel)))).toBe(hash);
      expect(fs.existsSync(path.join(env.workspaceRoot, 'dst'))).toBe(false);
      expect(fixture.requests.length).toBe(1); // restart, Diff and Undo replay no model or tool
    } finally {
      probe.stop();
      if (runtime) await runtime.shutdown();
      if (restarted) await restarted.shutdown();
      await fixture.close();
    }
  }, 120_000);

  it('reconciles a crash-time Turn during startup in yielded slices, then recovers without replay', async () => {
    const env = makeEnv();
    const fixture = await startShellFixture();
    let executions = 0;
    const first = makeRuntime(env, () => { executions += 1; });
    const sessionId = first.getSnapshot().activeConversationId;
    await first.shutdown();

    // Crash after the Shell moved every file but before post-Shell collection.
    const turnId = 'turn-a9-61-crash';
    const { A9WorkspaceService } = require('../../../workspace/dist');
    await new A9WorkspaceService(env.workspaceRoot).freezeTurnBaseline(turnId);
    execFileSync('/bin/sh', ['-c', COMMAND], { cwd: env.workspaceRoot });
    const db = new Database(path.join(env.dataRoot, 'a9-state.db'));
    const now = new Date().toISOString();
    db.prepare('INSERT INTO a9_tasks (task_id, session_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(`task-${turnId}`, sessionId, 'active', now, now);
    db.prepare('INSERT INTO a9_turns (turn_id, task_id, session_id, status, outcome_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(turnId, `task-${turnId}`, sessionId, 'active', '{}', now, now);
    db.close();

    const probe = instrument();
    probe.start();
    let reopened: any;
    try {
      reopened = makeRuntime(env, () => { executions += 1; });
      await reopened.whenReady();
      probe.stop();
      console.log(`A9-61 runtime startup recovery: artifactReads=${probe.count('artifact')} beatsBetweenArtifactReads=${probe.between('artifact')}`);
      expect(probe.count('artifact')).toBeGreaterThanOrEqual(FILES);
      expect(probe.between('artifact')).toBeGreaterThan(0);

      const snapshot = reopened.getSnapshot();
      expect(snapshot.status).toBe('ready');
      expect(snapshot.checkpointRecoveryDiagnostics ?? null).toBeNull();
      expect(snapshot.checkpoints).toEqual(expect.arrayContaining([expect.objectContaining({ turnId })]));
      const check = new Database(path.join(env.dataRoot, 'a9-state.db'), { readonly: true });
      const row = check.prepare('SELECT payload_json FROM a9_checkpoints WHERE turn_id = ?').get(turnId) as any;
      check.close();
      expect(JSON.parse(row.payload_json).recoveredFromWorkspaceManifest).toBe(true);

      reopened.setMode('full_access');
      await reopened.configureProvider({ baseUrl: fixture.baseUrl, model: 'fixture', skipProbe: true });
      const preview = await reopened.undoTurn(turnId);
      expect(preview.needsConfirmation).toBe(true);
      expect(preview.externalChanges.changes.filter((change: any) => change.kind === 'renamed')).toHaveLength(FILES * 2);
      expect(fs.existsSync(path.join(env.workspaceRoot, 'dst'))).toBe(true); // preview never rewrites files
      const confirmed = await reopened.undoTurn(turnId, preview.confirmationId);
      expect(confirmed.outcome.errors).toEqual([]);
      for (const [rel, hash] of env.contents) expect(sha(fs.readFileSync(path.join(env.workspaceRoot, rel)))).toBe(hash);
      expect(manifestFacts(env.workspaceRoot, turnId).externalBaseline.collectionStatus).toBe('complete');
      expect(fixture.requests.length).toBe(0);
      expect(executions).toBe(0);
    } finally {
      probe.stop();
      if (reopened) await reopened.shutdown();
      await fixture.close();
    }
  }, 120_000);
});
