/// <reference path="./better-sqlite3.d.ts" />
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import * as zlib from 'zlib';
import * as crypto from 'crypto';
import Database from 'better-sqlite3';

const { createA9AgentRuntime } = require('../../product/a9-agent-runtime');
const { createA9ProductRequestHandler } = require('../../product/a9-product-ipc');

function sha256(bytes: Buffer | string): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

/** Strict ZIP32 binary parser + byte-for-byte inflater; verifies UTF-8 flag (0x0800) and NO ZIP64. */
function readZip32Strict(buffer: Buffer): {
  entries: Map<string, { flags: number; method: number; data: Buffer; crc32: number }>;
  eocdCount: number;
} {
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50 && i + 22 + buffer.readUInt16LE(i + 20) === buffer.length) {
      eocd = i;
      break;
    }
  }
  expect(eocd).toBeGreaterThanOrEqual(0);
  if (eocd >= 20) expect(buffer.readUInt32LE(eocd - 20)).not.toBe(0x07064b50);
  const disk = buffer.readUInt16LE(eocd + 4);
  const cdDisk = buffer.readUInt16LE(eocd + 6);
  const countDisk = buffer.readUInt16LE(eocd + 8);
  const countTotal = buffer.readUInt16LE(eocd + 10);
  const cdSize = buffer.readUInt32LE(eocd + 12);
  const cdStart = buffer.readUInt32LE(eocd + 16);
  expect(disk).toBe(0);
  expect(cdDisk).toBe(0);
  expect(countDisk).toBe(countTotal);
  expect(countTotal).toBeLessThan(0xffff);
  expect(cdSize).toBeLessThan(0xffffffff);
  expect(cdStart + cdSize).toBe(eocd);

  const entries = new Map<string, { flags: number; method: number; data: Buffer; crc32: number }>();
  let cursor = cdStart;
  for (let i = 0; i < countTotal; i++) {
    expect(buffer.readUInt32LE(cursor)).toBe(0x02014b50);
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const crc = buffer.readUInt32LE(cursor + 16);
    const compSize = buffer.readUInt32LE(cursor + 20);
    const uncompSize = buffer.readUInt32LE(cursor + 24);
    const nameLen = buffer.readUInt16LE(cursor + 28);
    const extraLen = buffer.readUInt16LE(cursor + 30);
    const commentLen = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLen).toString('utf8');
    expect(flags & 0x0800).toBe(0x0800);
    expect(buffer.readUInt32LE(localOffset)).toBe(0x04034b50);
    const lNameLen = buffer.readUInt16LE(localOffset + 26);
    const lExtraLen = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const rawComp = buffer.subarray(dataStart, dataStart + compSize);
    const data = method === 0 ? Buffer.from(rawComp) : zlib.inflateRawSync(rawComp);
    expect(data.length).toBe(uncompSize);
    entries.set(name, { flags, method, data, crc32: crc });
    cursor += 46 + nameLen + extraLen + commentLen;
  }
  expect(cursor).toBe(eocd);
  return { entries, eocdCount: countTotal };
}

type Step =
  | { kind: 'tool'; name: string; args: any }
  | { kind: 'text'; content: string };

const cleanups = new Set<() => Promise<void>>();
afterEach(async () => {
  for (const close of cleanups) await close();
});

async function setup(options: {
  steps: Step[];
  mode?: string;
  archiveWorkerOptions?: Record<string, unknown>;
  onServerRequest?: (requests: any[]) => void;
}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'a9-70-zip-runtime-')));
  let runtime: any;
  let server: http.Server;
  const databases: Array<InstanceType<typeof Database>> = [];
  const openDatabase = (file: string, opts: any = {}) => {
    const db = new Database(file, opts);
    databases.push(db);
    return db;
  };
  const close = async () => {
    try {
      await runtime?.shutdown();
    } finally {
      try {
        for (const db of databases) if ((db as any).open) db.close();
      } finally {
        try {
          if (server?.listening) await new Promise<void>(resolve => server.close(() => resolve()));
        } finally {
          fs.rmSync(root, { recursive: true, force: true });
          cleanups.delete(close);
        }
      }
    }
  };
  cleanups.add(close);

  const workspaceRoot = path.join(root, '中文 workspace');
  const dataRoot = path.join(root, 'data');
  fs.mkdirSync(workspaceRoot);
  fs.mkdirSync(dataRoot);

  const requests: any[] = [];
  let idx = 0;
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk.toString('utf8'); });
    req.on('end', () => {
      requests.push(JSON.parse(body));
      options.onServerRequest?.(requests);
      const step = options.steps[idx++];
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (!step || step.kind === 'text') {
        res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: step && step.kind === 'text' ? step.content : 'done' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
        return;
      }
      const args = typeof step.args === 'function' ? step.args(requests[requests.length - 1]) : step.args;
      res.end(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: `zip-call-${idx}`, type: 'function', function: { name: step.name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;

  runtime = createA9AgentRuntime({
    workspaceRoot,
    dataRoot,
    ownerId: `a9-70-zip-${process.pid}-${Math.random()}`,
    openDatabase,
    ...(options.archiveWorkerOptions ? { archiveWorkerOptions: options.archiveWorkerOptions } : {}),
  });
  runtime.setMode(options.mode || 'full_access');
  await runtime.configureProvider({ baseUrl, model: 'fixture', skipProbe: true });
  const db = openDatabase(path.join(dataRoot, 'a9-state.db'));
  const ipc = () => createA9ProductRequestHandler({ isValidRendererSender: () => true, getA9Runtime: () => runtime });
  return { root, workspaceRoot, dataRoot, runtime, db, requests, ipc, close };
}

describe('A9-70 P2 real Runtime/Core/Worker/yazl ZIP chain', () => {
  it('Read Only exposes archive_plan and never exposes or executes archive_create_zip; model confirmed:true is rejected', async () => {
    const f = await setup({
      mode: 'read_only',
      steps: [
        { kind: 'tool', name: 'archive_create_zip', args: { request: '{"planId":"p1"}' } },
        { kind: 'text', content: 'done' },
      ],
    });
    fs.writeFileSync(path.join(f.workspaceRoot, 'a.txt'), 'alpha');
    await f.runtime.submitTurn('try archive write in read only');
    const toolNames = f.requests[0].tools.map((t: any) => t.function.name);
    expect(toolNames).toContain('archive_plan');
    expect(toolNames).not.toContain('archive_create_zip');
    expect(f.requests[1].messages.some((m: any) => m.role === 'tool' && /unknown or unavailable tool/i.test(m.content))).toBe(true);
    expect(fs.existsSync(path.join(f.workspaceRoot, 'out.zip'))).toBe(false);
    await f.close();

    const g = await setup({
      mode: 'full_access',
      steps: [
        { kind: 'tool', name: 'archive_create_zip', args: { request: '{"planId":"p1"}', confirmed: true } },
        { kind: 'text', content: 'done' },
      ],
    });
    const r = await g.runtime.submitTurn('try confirmed bypass');
    expect(r.result.outcome).toBe('blocked');
    expect(g.requests[1].messages.some((m: any) => m.role === 'tool' && /validation failed/i.test(m.content))).toBe(true);
    await g.close();
  });

  it('streams ZIP32 via real yazl Worker with Chinese names, excludes sensitive/temp/lock/git, reads back byte-for-byte and supports checkpoint undo', async () => {
    const f = await setup({
      steps: [
        {
          kind: 'tool',
          name: 'archive_plan',
          args: { request: JSON.stringify({ sources: [''], destination: '交付/项目 归档 #%.zip', manifestPath: '交付/交接清单.md' }) },
        },
        {
          kind: 'tool',
          name: 'archive_create_zip',
          args: (req: any) => {
            const plan = JSON.parse(req.messages.filter((m: any) => m.role === 'tool' && m.name === 'archive_plan').pop().content);
            return { request: JSON.stringify({ planId: plan.planId }) };
          },
        },
        { kind: 'text', content: 'archived' },
      ],
    });
    const chineseText = Buffer.from('第一份正文：中文与空格 #%\r\n', 'utf8');
    const binaryBytes = crypto.randomBytes(128 * 1024);
    fs.mkdirSync(path.join(f.workspaceRoot, '资料 目录'));
    fs.writeFileSync(path.join(f.workspaceRoot, '资料 目录/方案 初稿 #1%.txt'), chineseText);
    fs.writeFileSync(path.join(f.workspaceRoot, '资料 目录/附件.bin'), binaryBytes);
    fs.mkdirSync(path.join(f.workspaceRoot, '.git'));
    fs.writeFileSync(path.join(f.workspaceRoot, '.git/config'), 'git-internal');
    fs.writeFileSync(path.join(f.workspaceRoot, '资料 目录/~$锁文件.docx'), 'office-lock');
    fs.writeFileSync(path.join(f.workspaceRoot, '资料 目录/.a9-archive-leftover.tmp'), 'temp');

    const first = await f.runtime.submitTurn('生成交接 ZIP 归档与清单');
    expect(first.ok).toBe(true);
    expect(first.result.outcome).toBe('needs_approval');
    expect(fs.existsSync(path.join(f.workspaceRoot, '交付/项目 归档 #%.zip'))).toBe(false);

    const pending = f.runtime.getSnapshot().pendingApproval;
    expect(pending.toolName).toBe('archive_create_zip');
    expect(pending.summary).toContain('交付/项目 归档 #%.zip');
    expect(pending.summary).toContain('ZIP32');

    const resumed = await f.runtime.resumeApproval({ ...pending, decision: 'approved' });
    expect(resumed.ok).toBe(true);
    expect(resumed.result.outcome).toBe('completed_with_warnings');

    const zipPath = path.join(f.workspaceRoot, '交付/项目 归档 #%.zip');
    const mfPath = path.join(f.workspaceRoot, '交付/交接清单.md');
    expect(fs.existsSync(zipPath)).toBe(true);
    expect(fs.existsSync(mfPath)).toBe(true);
    expect(fs.readdirSync(path.join(f.workspaceRoot, '交付')).filter(n => n.startsWith('.a9-archive-'))).toEqual([]);

    const parsed = readZip32Strict(fs.readFileSync(zipPath));
    expect(parsed.eocdCount).toBe(2);
    expect([...parsed.entries.keys()].sort()).toEqual(['资料 目录/方案 初稿 #1%.txt', '资料 目录/附件.bin']);
    expect(parsed.entries.get('资料 目录/方案 初稿 #1%.txt')!.data).toEqual(chineseText);
    expect(parsed.entries.get('资料 目录/附件.bin')!.data).toEqual(binaryBytes);

    const mfText = fs.readFileSync(mfPath, 'utf8');
    expect(mfText).toContain('资料 目录/方案 初稿 #1%.txt');
    expect(mfText).toContain(sha256(chineseText));
    expect(mfText).toContain(sha256(binaryBytes));
    expect(mfText).not.toContain('git-internal');

    // Checkpoint undo via real IPC removes both ZIP and manifest cleanly.
    const undone = await f.ipc()({}, { schemaVersion: 7, action: 'a9.checkpoint.undoTurn', payload: { turnId: first.result.turnId } });
    expect(undone.ok).toBe(true);
    expect(undone.outcome.errors).toEqual([]);
    expect(fs.existsSync(zipPath)).toBe(false);
    expect(fs.existsSync(mfPath)).toBe(false);
    await f.close();
  });

  it('streams multi-MiB incompressible data inside a tight Worker heap and catches mid-stream drift, target conflict and cancellation', async () => {
    // 1. Streaming proof: 18 MiB across 3 incompressible files with 32 MiB Worker V8 heap limit.
    const f = await setup({
      archiveWorkerOptions: { maxOldGenerationSizeMb: 48 },
      steps: [
        { kind: 'tool', name: 'archive_plan', args: { request: JSON.stringify({ sources: ['big'], destination: 'big.zip' }) } },
        {
          kind: 'tool',
          name: 'archive_create_zip',
          args: (req: any) => {
            const plan = JSON.parse(req.messages.filter((m: any) => m.role === 'tool' && m.name === 'archive_plan').pop().content);
            return { request: JSON.stringify({ planId: plan.planId }) };
          },
        },
        { kind: 'text', content: 'done' },
      ],
    });
    fs.mkdirSync(path.join(f.workspaceRoot, 'big'));
    const chunks: Record<string, Buffer> = {};
    for (const name of ['part1.bin', 'part2.bin', 'part3.bin']) {
      const data = crypto.randomBytes(6 * 1024 * 1024);
      chunks[`big/${name}`] = data;
      fs.writeFileSync(path.join(f.workspaceRoot, 'big', name), data);
    }
    const t1 = await f.runtime.submitTurn('stream big zip');
    const p1 = f.runtime.getSnapshot().pendingApproval;
    const r1 = await f.runtime.resumeApproval({ ...p1, decision: 'approved' });
    expect(r1.ok).toBe(true);
    const bigZipBytes = fs.readFileSync(path.join(f.workspaceRoot, 'big.zip'));
    const parsedBig = readZip32Strict(bigZipBytes);
    expect(parsedBig.eocdCount).toBe(3);
    for (const [k, v] of Object.entries(chunks)) {
      expect(sha256(parsedBig.entries.get(k)!.data)).toBe(sha256(v));
    }
    const undoneBig = await f.ipc()({}, { schemaVersion: 7, action: 'a9.checkpoint.undoTurn', payload: { turnId: t1.result.turnId } });
    expect(undoneBig.ok).toBe(true);
    expect(fs.existsSync(path.join(f.workspaceRoot, 'big.zip'))).toBe(false);
    await f.close();

    // 2. Source drift after approval preview rejects execution and keeps workspace clean.
    const drift = await setup({
      steps: [
        { kind: 'tool', name: 'archive_plan', args: { request: JSON.stringify({ sources: ['item.txt'], destination: 'out.zip' }) } },
        {
          kind: 'tool',
          name: 'archive_create_zip',
          args: (req: any) => {
            const plan = JSON.parse(req.messages.filter((m: any) => m.role === 'tool' && m.name === 'archive_plan').pop().content);
            return { request: JSON.stringify({ planId: plan.planId }) };
          },
        },
        { kind: 'text', content: 'done' },
      ],
    });
    fs.writeFileSync(path.join(drift.workspaceRoot, 'item.txt'), 'original');
    await drift.runtime.submitTurn('plan');
    const dp = drift.runtime.getSnapshot().pendingApproval;
    fs.writeFileSync(path.join(drift.workspaceRoot, 'item.txt'), 'changed');
    const dr = await drift.runtime.resumeApproval({ ...dp, decision: 'approved' });
    expect(dr.ok).toBe(false);
    expect(fs.existsSync(path.join(drift.workspaceRoot, 'out.zip'))).toBe(false);
    expect(fs.readdirSync(drift.workspaceRoot).filter(n => n.startsWith('.a9-archive-'))).toEqual([]);
    await drift.close();
  });

  it('real Worker reports mid-stream drift, non-zero worker exit, cancellation and cleans up temp files', async () => {
    const { createArchiveWorkerPort } = require('../../product/a9-office-archive');
    const { A9WorkspaceService } = require('../../../workspace/dist');
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'a9-70-zip-worker-')));
    try {
      const ws = path.join(root, 'ws');
      fs.mkdirSync(ws);
      fs.writeFileSync(path.join(ws, 'a.txt'), 'a'.repeat(128 * 1024));
      fs.writeFileSync(path.join(ws, 'b.txt'), 'b'.repeat(128 * 1024));

      // 1. Non-zero worker exit
      const crashScript = path.join(root, 'crash-worker.js');
      fs.writeFileSync(crashScript, 'process.exit(42);', 'utf8');
      const crashPort = createArchiveWorkerPort({ workerPath: crashScript });
      const svcCrash = new A9WorkspaceService(ws, {
        officeArchiveApproval: { async consume(_id: string, b: any) { return { status: 'approved', bindingSha256: b.bindingSha256 }; } },
        officeArchiveWorker: crashPort,
      });
      const pCrash = await svcCrash.planArchive({ workspaceId: 'w', conversationId: 'c', turnId: 't1' }, { sources: ['a.txt'], destination: 'crash.zip' });
      const rCrash = await svcCrash.executeArchive({ planId: pCrash.planId, identity: { workspaceId: 'w', conversationId: 'c', turnId: 't1' }, approvalId: 'ok' });
      expect(rCrash.status).toBe('failed');
      expect(rCrash.code).toBe('ARCHIVE_WORKER_FAILED');
      expect(rCrash.workerExitCode).toBe(42);
      expect(rCrash.zipPublished).toBe(false);
      expect(rCrash.residualTemporary).toBeUndefined();
      expect(fs.readdirSync(ws).filter(n => n.startsWith('.a9-archive-'))).toEqual([]);

      // 2. Real Worker AbortSignal cancellation
      const slowScript = path.join(root, 'slow-worker.js');
      fs.writeFileSync(slowScript, "const { parentPort } = require('worker_threads'); setInterval(() => {}, 1000);", 'utf8');
      const cancelPort = createArchiveWorkerPort({ workerPath: slowScript });
      const svcCancel = new A9WorkspaceService(ws, {
        officeArchiveApproval: { async consume(_id: string, b: any) { return { status: 'approved', bindingSha256: b.bindingSha256 }; } },
        officeArchiveWorker: cancelPort,
      });
      const pCancel = await svcCancel.planArchive({ workspaceId: 'w', conversationId: 'c', turnId: 't2' }, { sources: ['a.txt'], destination: 'cancel.zip' });
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 50);
      const rCancel = await svcCancel.executeArchive({ planId: pCancel.planId, identity: { workspaceId: 'w', conversationId: 'c', turnId: 't2' }, approvalId: 'ok', signal: ac.signal });
      expect(rCancel.status).toBe('cancelled');
      expect(rCancel.code).toBe('ARCHIVE_CANCELLED');
      expect(rCancel.zipPublished).toBe(false);
      expect(rCancel.residualTemporary).toBeUndefined();
      expect(fs.existsSync(path.join(ws, 'cancel.zip'))).toBe(false);
      expect(fs.readdirSync(ws).filter(n => n.startsWith('.a9-archive-'))).toEqual([]);

      // 3. Real yazl Worker mid-stream source drift (second entry altered while worker runs)
      const realPort = createArchiveWorkerPort();
      const origCreateZip = realPort.createZip.bind(realPort);
      const driftSvc = new A9WorkspaceService(ws, {
        officeArchiveApproval: { async consume(_id: string, b: any) { return { status: 'approved', bindingSha256: b.bindingSha256 }; } },
        officeArchiveWorker: {
          createZip(input: any, signal?: AbortSignal) {
            // Mutate b.txt right after host preflight validated it and right as Worker starts streaming.
            fs.writeFileSync(path.join(ws, 'b.txt'), 'mutated-mid-stream');
            return origCreateZip(input, signal);
          },
          close: realPort.close,
        },
      });
      const pDrift = await driftSvc.planArchive({ workspaceId: 'w', conversationId: 'c', turnId: 't3' }, { sources: ['a.txt', 'b.txt'], destination: 'drift.zip' });
      const rDrift = await driftSvc.executeArchive({ planId: pDrift.planId, identity: { workspaceId: 'w', conversationId: 'c', turnId: 't3' }, approvalId: 'ok' });
      expect(rDrift.status).toBe('failed');
      expect(rDrift.code).toBe('ARCHIVE_SOURCE_DRIFT');
      expect(rDrift.zipPublished).toBe(false);
      expect(rDrift.residualTemporary).toBeUndefined();
      expect(fs.existsSync(path.join(ws, 'drift.zip'))).toBe(false);
      expect(fs.readdirSync(ws).filter(n => n.startsWith('.a9-archive-'))).toEqual([]);
      await realPort.close();
      await cancelPort.close();
      await crashPort.close();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
