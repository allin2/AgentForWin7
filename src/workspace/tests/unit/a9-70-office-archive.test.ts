import fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import type {
  OfficeArchiveApprovalBinding,
  OfficeArchiveExecuteOptions,
  OfficeArchivePlanInput,
  OfficeZipWorkerInput,
  OfficeZipWorkerPort,
} from '../../src/a9-office-archive';
import type { OfficeBatchIdentity } from '../../src/a9-office-batch';

const {
  A9WorkspaceService,
  OFFICE_ARCHIVE_LIMITS,
} = require('../../dist') as typeof import('../../src');

const identity: OfficeBatchIdentity = {
  workspaceId: 'workspace-70-zip',
  conversationId: 'conversation-70-zip',
  turnId: 'turn-70-zip',
};
const roots: string[] = [];

afterEach(() => {
  jest.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function sha256(bytes: Buffer | string): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function defaultWorker(): OfficeZipWorkerPort {
  return {
    async createZip(input: OfficeZipWorkerInput, signal?: AbortSignal) {
      if (signal?.aborted) throw Object.assign(new Error('ARCHIVE_CANCELLED'), { code: 'ARCHIVE_CANCELLED', workerExitCode: 1 });
      const payload = Buffer.from(JSON.stringify(input.entries.map(e => ({
        archivePath: e.archivePath,
        sha256: e.sha256,
        bytes: fs.readFileSync(e.absolutePath).toString('base64'),
      }))), 'utf8');
      const fd = fs.openSync(input.tempZipPath, 'r+');
      try {
        const st = fs.fstatSync(fd);
        if (st.dev !== input.tempIdentity.dev || st.ino !== input.tempIdentity.ino) {
          throw Object.assign(new Error('ARCHIVE_TEMP_IDENTITY_CHANGED'), { code: 'ARCHIVE_TEMP_IDENTITY_CHANGED', workerExitCode: 1 });
        }
        fs.writeSync(fd, payload, 0, payload.length, 0);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      return {
        entryCount: input.entries.length,
        archiveBytes: payload.length,
        archiveSha256: sha256(payload),
        zipFormat: 'ZIP32',
        workerExitCode: 0,
      };
    },
  };
}

function fixture(options: { approved?: boolean; worker?: OfficeZipWorkerPort } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'a9-70-archive-')));
  roots.push(root);
  const bindings: OfficeArchiveApprovalBinding[] = [];
  const service = new A9WorkspaceService(root, {
    ...(options.approved !== false
      ? {
        officeArchiveApproval: {
          async consume(id, binding) {
            bindings.push(binding);
            if (id !== 'ui-authorized') throw Object.assign(new Error('denied'), { code: 'UI_DENIED' });
            return { status: 'approved', bindingSha256: binding.bindingSha256 };
          },
        },
      }
      : {}),
    officeArchiveWorker: options.worker ?? defaultWorker(),
  });
  function write(name: string, bytes: string | Buffer) {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
    return file;
  }
  async function plan(input: OfficeArchivePlanInput) {
    return service.planArchive(identity, input);
  }
  async function exec(planId: string, override: Partial<OfficeArchiveExecuteOptions> = {}) {
    return service.executeArchive({ planId, identity, approvalId: 'ui-authorized', ...override });
  }
  return { root, service, write, plan, exec, bindings };
}

describe('OfficeArchiveService P2 contract', () => {
  it('loads the current dist and plans read-only manifests excluding git, recovery, locks, temps, quarantine and symlinks', async () => {
    expect(require.resolve('../../dist')).toBe(path.join(__dirname, '../../dist/index.js'));
    const f = fixture();
    f.write('中文 目录/报告 草稿 #1%.txt', '中文内容-1');
    f.write('空文件.bin', Buffer.alloc(0));
    f.write('.git/config', 'secret-git');
    f.write('.agent_recovery/checkpoints/t.json', 'recovery');
    f.write('_待清理隔离区_20261116/old.txt', 'quarantine');
    f.write('中文 目录/~$报告.docx', 'lock');
    f.write('中文 目录/.a9-archive-old12345.tmp', 'tmp');
    f.write('中文 目录/.office-old.tmp', 'office-tmp');
    fs.symlinkSync(f.root, path.join(f.root, 'loop-link'), 'dir');

    const beforeRoot = fs.readdirSync(f.root).sort();
    const plan = await f.plan({
      sources: [''],
      destination: '交付/中文 归档 #%.zip',
      manifestPath: '交付/交接清单.md',
    });

    expect(Object.isFrozen(plan)).toBe(true);
    expect(plan.zipFormat).toBe('ZIP32');
    expect(plan.entryCount).toBe(2);
    expect(plan.entries.map(e => e.archivePath)).toEqual(['中文 目录/报告 草稿 #1%.txt', '空文件.bin']);
    expect(plan.entries[0].sha256).toBe(sha256('中文内容-1'));
    expect(plan.entries[1].sha256).toBe(sha256(Buffer.alloc(0)));
    expect(plan.excluded).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '.git', reason: 'excluded_git' }),
      expect.objectContaining({ path: '.agent_recovery', reason: 'excluded_recovery' }),
      expect.objectContaining({ path: '_待清理隔离区_20261116', reason: 'excluded_quarantine' }),
      expect.objectContaining({ path: '中文 目录/~$报告.docx', reason: 'excluded_office_lock' }),
      expect.objectContaining({ path: '中文 目录/.a9-archive-old12345.tmp', reason: 'excluded_temp' }),
      expect.objectContaining({ path: '中文 目录/.office-old.tmp', reason: 'excluded_temp' }),
      expect.objectContaining({ path: 'loop-link', reason: 'reparse_or_symlink' }),
    ]));
    expect(plan.limitations).toEqual(expect.arrayContaining([
      'ZIP32_ONLY_NO_ZIP64',
      'WINDOWS_EXPLORER_NOT_VERIFIED',
    ]));
    expect(fs.readdirSync(f.root).sort()).toEqual(beforeRoot);
    expect(fs.existsSync(path.join(f.root, '交付'))).toBe(false);
  });

  it('rejects unsafe destinations, non-zip extensions, existing targets, path length limits and ZIP32 caps', async () => {
    const f = fixture();
    f.write('a.txt', 'hello');
    f.write('existing.zip', 'already');

    await expect(f.plan({ sources: ['a.txt'], destination: 'existing.zip' })).rejects.toMatchObject({ code: 'ARCHIVE_TARGET_EXISTS' });
    await expect(f.plan({ sources: ['a.txt'], destination: 'bad.txt' })).rejects.toMatchObject({ code: 'ARCHIVE_PATH_INVALID' });
    await expect(f.plan({ sources: ['a.txt'], destination: 'CON.zip' })).rejects.toMatchObject({ code: 'ARCHIVE_PATH_INVALID' });
    await expect(f.plan({ sources: ['a.txt'], destination: '../escape.zip' })).rejects.toMatchObject({ code: 'ARCHIVE_PATH_INVALID' });
    await expect(f.plan({ sources: ['a.txt'], destination: '.git/out.zip' })).rejects.toMatchObject({ code: 'ARCHIVE_PATH_INVALID' });
    await expect(f.plan({ sources: ['a.txt'], destination: 'out.zip', manifestPath: 'out.zip' })).rejects.toMatchObject({ code: 'ARCHIVE_PATH_INVALID' });
    await expect(f.plan({ sources: ['.git'], destination: 'out.zip' })).rejects.toMatchObject({ code: 'ARCHIVE_PATH_EXCLUDED' });
    await expect(f.plan({ sources: ['a.txt'], destination: `${'深'.repeat(120)}/out.zip` })).rejects.toMatchObject({ code: 'ARCHIVE_PATH_TOO_LONG' });
    await expect(f.plan({ sources: ['a.txt'], destination: 'out.zip', maxFileBytes: 2 })).rejects.toMatchObject({ code: 'ARCHIVE_FILE_BYTE_LIMIT' });
    await expect(f.plan({ sources: ['a.txt'], destination: 'out.zip', maxFiles: OFFICE_ARCHIVE_LIMITS.files + 1 })).rejects.toMatchObject({ code: 'ARCHIVE_LIMIT_INVALID' });
  });

  it('requires trusted host approval, detects source drift, rejects target conflict and supports checkpoint undo without copying large blobs', async () => {
    const unapproved = fixture({ approved: false });
    unapproved.write('a.txt', 'alpha');
    const p0 = await unapproved.plan({ sources: ['a.txt'], destination: 'out.zip' });
    await expect(unapproved.exec(p0.planId)).rejects.toMatchObject({ code: 'ARCHIVE_APPROVAL_REQUIRED' });
    expect(fs.existsSync(path.join(unapproved.root, '.agent_recovery'))).toBe(false);

    const driftF = fixture();
    driftF.write('a.txt', 'alpha');
    const p1 = await driftF.plan({ sources: ['a.txt'], destination: 'out.zip' });
    driftF.write('a.txt', 'tampered');
    await expect(driftF.service.prepareArchive(p1.planId, identity)).rejects.toMatchObject({ code: 'ARCHIVE_SOURCE_DRIFT' });
    await expect(driftF.exec(p1.planId)).rejects.toMatchObject({ code: 'ARCHIVE_SOURCE_DRIFT' });

    const conflictF = fixture({
      worker: {
        async createZip(input) {
          // Race a conflicting file into the destination right as the worker finishes.
          fs.writeFileSync(path.join(conflictF.root, 'out.zip'), 'raced-existing');
          const fd = fs.openSync(input.tempZipPath, 'r+');
          try { fs.writeSync(fd, Buffer.from('zip-bytes'), 0, 9, 0); } finally { fs.closeSync(fd); }
          return { entryCount: 1, archiveBytes: 9, archiveSha256: sha256('zip-bytes'), zipFormat: 'ZIP32', workerExitCode: 0 };
        },
      },
    });
    conflictF.write('a.txt', 'alpha');
    const p2 = await conflictF.plan({ sources: ['a.txt'], destination: 'out.zip' });
    const conflictRes = await conflictF.exec(p2.planId);
    expect(conflictRes.status).toBe('failed');
    expect(conflictRes.code).toBe('ARCHIVE_TARGET_EXISTS');
    expect(conflictRes.zipPublished).toBe(false);
    expect(conflictRes.residualTemporary).toBeUndefined();
    expect(fs.readFileSync(path.join(conflictF.root, 'out.zip'), 'utf8')).toBe('raced-existing');
    expect(fs.readdirSync(conflictF.root).filter(n => n.startsWith('.a9-archive-'))).toEqual([]);

    const okF = fixture();
    okF.write('中文.txt', '内容');
    const p3 = await okF.plan({ sources: ['中文.txt'], destination: '归档/结果.zip', manifestPath: '归档/清单.md' });
    const res = await okF.exec(p3.planId);
    expect(res).toMatchObject({
      status: 'completed',
      code: 'ARCHIVE_OK',
      zipPublished: true,
      manifestPublished: true,
      recovery: 'recorded',
      checkpointStatus: 'recorded',
      workerExitCode: 0,
    });
    expect(res.residualTemporary).toBeUndefined();
    expect(res.manifestMarkdown).toContain('中文.txt');
    expect(res.manifestCsv).toContain('中文.txt');
    expect(fs.existsSync(path.join(okF.root, '归档/结果.zip'))).toBe(true);
    expect(fs.existsSync(path.join(okF.root, '归档/清单.md'))).toBe(true);
    expect(fs.readdirSync(path.join(okF.root, '归档')).filter(n => n.startsWith('.a9-archive-'))).toEqual([]);
    const cp = okF.service.getCheckpointManager().loadCheckpoint(identity.turnId)!;
    expect(cp.changes['归档/结果.zip'].newBlobPath).toBeUndefined();
    expect(cp.changes['归档/结果.zip'].newHash).toBe(res.archiveSha256);

    // Drift refuses undo; clean state removes created files cleanly.
    const originalZip = fs.readFileSync(path.join(okF.root, '归档/结果.zip'));
    fs.writeFileSync(path.join(okF.root, '归档/结果.zip'), 'edited');
    const drifted = okF.service.getCheckpointManager().undoTurn(identity.turnId);
    expect(drifted.drifted.length).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(okF.root, '归档/结果.zip'))).toBe(true);

    fs.writeFileSync(path.join(okF.root, '归档/结果.zip'), originalZip);
    const undone = okF.service.getCheckpointManager().undoTurn(identity.turnId);
    expect(undone.errors).toEqual([]);
    expect(undone.drifted).toEqual([]);
    expect(fs.existsSync(path.join(okF.root, '归档/结果.zip'))).toBe(false);
    expect(fs.existsSync(path.join(okF.root, '归档/清单.md'))).toBe(false);
  });

  it('honestly reports cancellation, worker exit failure, partial success and checkpoint persistence failure', async () => {
    const cancelController = new AbortController();
    const cancelF = fixture({
      worker: {
        async createZip(_input, signal) {
          cancelController.abort();
          if (signal?.aborted) throw Object.assign(new Error('ARCHIVE_CANCELLED'), { code: 'ARCHIVE_CANCELLED', workerExitCode: 1, workerSignal: 'SIGTERM' });
          throw new Error('unreachable');
        },
      },
    });
    cancelF.write('a.txt', 'alpha');
    const cp1 = await cancelF.plan({ sources: ['a.txt'], destination: 'out.zip' });
    const cancelRes = await cancelF.exec(cp1.planId, { signal: cancelController.signal });
    expect(cancelRes.status).toBe('cancelled');
    expect(cancelRes.code).toBe('ARCHIVE_CANCELLED');
    expect(cancelRes.zipPublished).toBe(false);
    expect(cancelRes.residualTemporary).toBeUndefined();
    expect(fs.existsSync(path.join(cancelF.root, 'out.zip'))).toBe(false);

    const crashF = fixture({
      worker: {
        async createZip() {
          throw Object.assign(new Error('ARCHIVE_WORKER_FAILED'), { code: 'ARCHIVE_WORKER_FAILED', workerExitCode: 137, workerSignal: 'SIGKILL' });
        },
      },
    });
    crashF.write('a.txt', 'alpha');
    const cp2 = await crashF.plan({ sources: ['a.txt'], destination: 'out.zip' });
    const crashRes = await crashF.exec(cp2.planId);
    expect(crashRes.status).toBe('failed');
    expect(crashRes.code).toBe('ARCHIVE_WORKER_FAILED');
    expect(crashRes.workerExitCode).toBe(137);
    expect(crashRes.workerSignal).toBe('SIGKILL');
    expect(crashRes.zipPublished).toBe(false);
    expect(crashRes.residualTemporary).toBeUndefined();

    // Partial success: ZIP succeeds and records checkpoint, then manifest target conflicts.
    const partialF = fixture({
      worker: {
        async createZip(input) {
          const buf = Buffer.from('zip-ok');
          const fd = fs.openSync(input.tempZipPath, 'r+');
          try { fs.writeSync(fd, buf, 0, buf.length, 0); } finally { fs.closeSync(fd); }
          fs.writeFileSync(path.join(partialF.root, '清单.md'), 'conflict');
          return { entryCount: 1, archiveBytes: buf.length, archiveSha256: sha256(buf), zipFormat: 'ZIP32', workerExitCode: 0 };
        },
      },
    });
    partialF.write('a.txt', 'alpha');
    const cp3 = await partialF.plan({ sources: ['a.txt'], destination: 'out.zip', manifestPath: '清单.md' });
    const partialRes = await partialF.exec(cp3.planId);
    expect(partialRes.status).toBe('partial');
    expect(partialRes.code).toBe('ARCHIVE_TARGET_EXISTS');
    expect(partialRes.zipPublished).toBe(true);
    expect(partialRes.manifestPublished).toBe(false);
    expect(partialRes.recovery).toBe('recorded');
    expect(fs.readFileSync(path.join(partialF.root, '清单.md'), 'utf8')).toBe('conflict');

    // Checkpoint persistence failure after ZIP publication.
    const persistF = fixture();
    persistF.write('a.txt', 'alpha');
    const cp4 = await persistF.plan({ sources: ['a.txt'], destination: 'out.zip', manifestPath: '清单.md' });
    const mgr = persistF.service.getCheckpointManager();
    const origRecordPost = mgr.recordPostMutationAsync.bind(mgr);
    jest.spyOn(mgr, 'recordPostMutationAsync').mockImplementation(async (turnId, targetPath, action, opts) => {
      if (targetPath === 'out.zip' && action === 'create') throw new Error('DISK_FULL_SIMULATED');
      return origRecordPost(turnId, targetPath, action, opts);
    });
    const persistRes = await persistF.exec(cp4.planId);
    expect(persistRes.status).toBe('partial');
    expect(persistRes.code).toBe('ARCHIVE_CHECKPOINT_PERSIST_FAILED');
    expect(persistRes.zipPublished).toBe(true);
    expect(persistRes.manifestPublished).toBe(false);
    expect(persistRes.recovery).toBe('unknown');
    expect(persistRes.checkpointStatus).toBe('persistence_failed');
    expect(persistRes.persistenceError).toContain('DISK_FULL_SIMULATED');
    expect(fs.existsSync(path.join(persistF.root, '清单.md'))).toBe(false);
  });
});
