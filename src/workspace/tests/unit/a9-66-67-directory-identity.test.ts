/**
 * A9-66/67 repair: directory identity binding of the asynchronous
 * copy/move/delete, snapshot and recovery paths.
 *
 * Real filesystem, real native event loop, no mocks. A setImmediate poller
 * (the same mechanism the awaiting code yields with) performs a root /
 * ancestor / parent / recovery-store replacement at a chosen phase of the
 * operation. The assertions are about the *external* directory: it must stay
 * byte-identical and must never receive recovery data, and the operation must
 * not report success under the old ownership.
 *
 * Boundary (A9-64, unchanged): no claim of an atomic sandbox against another
 * process racing the kernel path lookup.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { A9WorkspaceService } from '../../src';

const FILES = 200;
const REJECT_CODES = ['DIRECTORY_IDENTITY_CHANGED', 'OPERATION_INCOMPLETE'];

type Method = 'copy' | 'move' | 'delete';
type Kind = 'root' | 'dest-parent' | 'src-parent' | 'recovery';
type Phase = 'snapshot' | 'iteration';

function fill(root: string, label: string): void {
  for (const dir of ['sp/source', 'dp/dest']) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
    for (let i = 0; i < FILES; i += 1) {
      fs.writeFileSync(path.join(root, dir, `f${i}.txt`), `${label} ${dir} ${i}`);
    }
  }
}

/** path -> sha256 (files) / 'dir' / 'link:target'. */
function fingerprint(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const visit = (dir: string, rel: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      const r = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) out[r] = `link:${fs.readlinkSync(abs)}`;
      else if (entry.isDirectory()) { out[r] = 'dir'; visit(abs, r); }
      else out[r] = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
    }
  };
  visit(root, '');
  return out;
}

const pollers = new Set<() => void>();

/** Runs `swap` once from a real setImmediate poll as soon as `ready()` holds. */
function armSwap(ready: () => boolean, swap: () => void): { swapped: () => boolean; stop: () => void } {
  let done = false;
  let stopped = false;
  const stop = () => { stopped = true; pollers.delete(stop); };
  pollers.add(stop);
  const poll = () => {
    if (stopped || done) return;
    let go = false;
    try { go = ready(); } catch (_error) { go = false; }
    if (go) { done = true; swap(); return; }
    setImmediate(poll);
  };
  setImmediate(poll);
  return { swapped: () => done, stop };
}

describe('A9-66/67 repair: directory identity of async copy/move/delete', () => {
  let sandbox: string;
  let work: string;
  let outside: string;
  let held: string;
  let service: A9WorkspaceService;

  beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'a9-66-67-identity-'));
    work = path.join(sandbox, 'workspace');
    outside = path.join(sandbox, 'outside');
    held = path.join(sandbox, 'workspace-held');
    fs.mkdirSync(work);
    fs.mkdirSync(outside);
    fill(work, 'workspace');
    fill(outside, 'outside');
    service = new A9WorkspaceService(work);
  });

  /** Read-only fixtures (and their recovery copies, which keep modes) must not block cleanup. */
  function makeWritable(dir: string): void {
    let entries: fs.Dirent[];
    try { fs.chmodSync(dir, 0o755); entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_error) { return; }
    for (const entry of entries) if (entry.isDirectory()) makeWritable(path.join(dir, entry.name));
  }

  afterEach(() => {
    for (const stop of Array.from(pollers)) stop();
    makeWritable(sandbox);
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  function swapFor(kind: Kind): () => void {
    switch (kind) {
      case 'root':
        return () => { fs.renameSync(work, held); fs.symlinkSync(outside, work, 'dir'); };
      case 'dest-parent':
        return () => { fs.renameSync(path.join(work, 'dp'), path.join(work, 'dp-held')); fs.symlinkSync(path.join(outside, 'dp'), path.join(work, 'dp'), 'dir'); };
      case 'src-parent':
        return () => { fs.renameSync(path.join(work, 'sp'), path.join(work, 'sp-held')); fs.symlinkSync(path.join(outside, 'sp'), path.join(work, 'sp'), 'dir'); };
      case 'recovery':
        fs.mkdirSync(path.join(outside, 'rec-store'));
        return () => {
          fs.renameSync(path.join(work, '.agent_recovery'), path.join(work, '.agent_recovery-held'));
          fs.symlinkSync(path.join(outside, 'rec-store'), path.join(work, '.agent_recovery'), 'dir');
        };
    }
  }

  function readyFor(method: Method, phase: Phase): () => boolean {
    if (phase === 'snapshot') return () => true;
    // Iteration: the destination has started changing (copy / delete).
    if (method === 'copy') {
      return () => fs.readFileSync(path.join(work, 'dp/dest/f3.txt'), 'utf8').startsWith('workspace sp/source');
    }
    if (method === 'delete') return () => !fs.existsSync(path.join(work, 'dp/dest/f3.txt'));
    throw new Error('move has no iteration phase');
  }

  function run(method: Method): Promise<unknown> {
    const turnId = 'identity';
    if (method === 'copy') return service.copy('sp/source', 'dp/dest', { overwrite: true, turnId });
    if (method === 'move') return service.move('sp/source', 'dp/moved', { turnId });
    return service.delete('dp/dest', { recursive: true, turnId });
  }

  const matrix: Array<[Method, Kind, Phase]> = [];
  for (const method of ['copy', 'move', 'delete'] as Method[]) {
    for (const kind of ['root', 'dest-parent', 'src-parent', 'recovery'] as Kind[]) {
      if (method === 'delete' && kind === 'src-parent') continue;
      for (const phase of ['snapshot', 'iteration'] as Phase[]) {
        // A move is one atomic rename issued in the same turn as its final identity check:
        // its only await window is the snapshot phase.
        if (method === 'move' && phase === 'iteration') continue;
        matrix.push([method, kind, phase]);
      }
    }
  }

  it.each(matrix)('%s with %s replaced during %s leaves the external tree untouched and never reports success', async (method, kind, phase) => {
    const before = fingerprint(outside);
    const arm = armSwap(readyFor(method, phase), swapFor(kind));
    const before2 = fingerprint(outside);
    let result: unknown;
    let error: any;
    try { result = await run(method); } catch (e) { error = e; }
    arm.stop();
    expect(arm.swapped()).toBe(true);
    expect(result).toBeUndefined();
    expect(REJECT_CODES).toContain(error?.code);
    // The external directory is byte-identical: no write, no delete, no recovery data.
    const afterTree = fingerprint(outside);
    expect(afterTree).toEqual(kind === 'recovery' ? { ...before2 } : before);
    expect(Object.keys(afterTree).some((name) => name.startsWith('.agent_recovery'))).toBe(false);
    if (kind === 'recovery') expect(fs.readdirSync(path.join(outside, 'rec-store'))).toEqual([]);
    expect(String(error.message)).not.toMatch(/ENOENT|EACCES/);
  });

  it('a snapshot-phase replacement stops before any side effect: both real trees keep their bytes', async () => {
    const workBefore = fingerprint(path.join(work, 'dp'));
    const arm = armSwap(() => true, swapFor('root'));
    await expect(service.delete('dp/dest', { recursive: true, turnId: 'identity' })).rejects.toMatchObject({ code: 'DIRECTORY_IDENTITY_CHANGED' });
    arm.stop();
    expect(fingerprint(path.join(held, 'dp'))).toEqual(workBefore);
  });

  it('after a mid-iteration replacement the report says which facts are NOT recorded', async () => {
    const arm = armSwap(readyFor('delete', 'iteration'), swapFor('root'));
    let error: any;
    try { await service.delete('dp/dest', { recursive: true, turnId: 'identity' }); } catch (e) { error = e; }
    arm.stop();
    expect(arm.swapped()).toBe(true);
    expect(error.code).toBe('OPERATION_INCOMPLETE');
    expect(error.message).toContain('未能');
    expect(error.message).not.toMatch(/变化事实已记入/);
    // The pre-mutation fact (original snapshot) is on the real recovery store; the post fact is absent.
    const manifest = JSON.parse(fs.readFileSync(path.join(held, '.agent_recovery/checkpoints/identity.json'), 'utf8'));
    expect(manifest.changes['dp/dest'].originalSnapshotPath).toBeTruthy();
    expect(manifest.changes['dp/dest'].newKind).toBe('directory');
    expect(manifest.changes['dp/dest'].newTreeHash).toBeUndefined();
    expect(fingerprint(outside)['dp/dest/f0.txt']).toBe(crypto.createHash('sha256').update('outside dp/dest 0').digest('hex'));
  });

  it('a move target whose parent did not exist is rejected when its ancestor turns into a link during the snapshot', async () => {
    fs.mkdirSync(path.join(outside, 'np'));
    const afterSeed = fingerprint(outside);
    const arm = armSwap(() => true, () => { fs.symlinkSync(path.join(outside, 'np'), path.join(work, 'newparent'), 'dir'); });
    await expect(service.move('sp/source', 'newparent/deep/moved', { turnId: 'identity' })).rejects.toMatchObject({ code: 'DIRECTORY_IDENTITY_CHANGED' });
    arm.stop();
    expect(arm.swapped()).toBe(true);
    expect(fingerprint(outside)).toEqual(afterSeed);
    expect(fs.existsSync(path.join(work, 'sp/source/f0.txt'))).toBe(true);
  });

  it('a copy target chain created by the operation is rejected when its first segment is replaced mid-copy', async () => {
    fs.mkdirSync(path.join(outside, 'np'));
    const afterSeed = fingerprint(outside);
    const arm = armSwap(
      () => fs.existsSync(path.join(work, 'newparent/deep/dest/f3.txt')),
      () => { fs.renameSync(path.join(work, 'newparent'), path.join(work, 'newparent-held')); fs.symlinkSync(path.join(outside, 'np'), path.join(work, 'newparent'), 'dir'); },
    );
    let error: any;
    try { await service.copy('sp/source', 'newparent/deep/dest', { turnId: 'identity' }); } catch (e) { error = e; }
    arm.stop();
    expect(arm.swapped()).toBe(true);
    expect(REJECT_CODES).toContain(error?.code);
    expect(fingerprint(outside)).toEqual(afterSeed);
  });

  it('concurrent operations are all rejected by one replacement and the outside stays unchanged', async () => {
    const before = fingerprint(outside);
    const arm = armSwap(() => true, swapFor('root'));
    const settled = await Promise.allSettled([
      service.copy('sp/source', 'dp/dest', { overwrite: true, turnId: 'identity-a' }),
      service.delete('dp/dest', { recursive: true, turnId: 'identity-b' }),
      service.copy('sp/source', 'dp/copy2', { turnId: 'identity-c' }),
    ]);
    arm.stop();
    expect(arm.swapped()).toBe(true);
    for (const item of settled) {
      expect(item.status).toBe('rejected');
      expect(REJECT_CODES).toContain((item as PromiseRejectedResult).reason?.code);
    }
    expect(fingerprint(outside)).toEqual(before);
  });

  it('concurrent legitimate operations without any replacement both complete and stay undoable', async () => {
    const [a, b] = await Promise.all([
      service.copy('sp/source', 'dp/copy-a', { turnId: 'legit' }),
      service.copy('sp/source', 'dp/copy-b', { turnId: 'legit' }),
    ]);
    expect(a.copied && b.copied).toBe(true);
    expect(fs.readFileSync(path.join(work, 'dp/copy-a/f7.txt'), 'utf8')).toBe('workspace sp/source 7');
    expect(fs.readFileSync(path.join(work, 'dp/copy-b/f7.txt'), 'utf8')).toBe('workspace sp/source 7');
    const undo = service.getCheckpointManager().undoTurn('legit');
    expect(fs.existsSync(path.join(work, 'dp/copy-a'))).toBe(false);
    expect(fs.existsSync(path.join(work, 'dp/copy-b'))).toBe(false);
    expect(undo).toBeDefined();
  });

  describe('fact persistence failure after the side effect started is reported as NOT recorded', () => {
    const lockManifests = () => fs.chmodSync(path.join(work, '.agent_recovery', 'checkpoints'), 0o555);
    afterEach(() => {
      try { fs.chmodSync(path.join(work, '.agent_recovery', 'checkpoints'), 0o755); } catch (_error) { /* removed */ }
      try { fs.chmodSync(path.join(work, 'dp', 'dest', 'locked'), 0o755); } catch (_error) { /* removed */ }
    });

    it('a completed copy whose post-state facts cannot be written does not claim they were recorded', async () => {
      const arm = armSwap(readyFor('copy', 'iteration'), lockManifests);
      let error: any;
      try { await service.copy('sp/source', 'dp/dest', { overwrite: true, turnId: 'persist-fail' }); } catch (e) { error = e; }
      arm.stop();
      expect(arm.swapped()).toBe(true);
      expect(error.code).toBe('OPERATION_INCOMPLETE');
      expect(error.message).toContain('已执行');
      expect(error.message).toContain('未能记入');
      expect(error.message).not.toMatch(/已记入本轮 checkpoint/);
      // The copy itself did complete: this is exactly the fact the report must not hide.
      expect(fs.readFileSync(path.join(work, 'dp/dest/f199.txt'), 'utf8')).toBe('workspace sp/source 199');
    });

    it('a delete that fails midway and cannot record its post-state says which facts are missing', async () => {
      fs.mkdirSync(path.join(work, 'dp/dest/locked'));
      fs.writeFileSync(path.join(work, 'dp/dest/locked/x.txt'), 'x');
      fs.chmodSync(path.join(work, 'dp/dest/locked'), 0o555);
      const arm = armSwap(readyFor('delete', 'iteration'), lockManifests);
      let error: any;
      try { await service.delete('dp/dest', { recursive: true, turnId: 'persist-fail' }); } catch (e) { error = e; }
      arm.stop();
      expect(arm.swapped()).toBe(true);
      expect(error.code).toBe('OPERATION_INCOMPLETE');
      expect(error.message).toMatch(/变化事实(未能|仅部分)记入/);
      expect(error.message).not.toMatch(/变化事实已记入/);
      expect(error.message).toContain('dp/dest');
    });

    it('when the facts CAN be written, an interrupted delete says they were recorded', async () => {
      fs.mkdirSync(path.join(work, 'dp/dest/locked'));
      fs.writeFileSync(path.join(work, 'dp/dest/locked/x.txt'), 'x');
      fs.chmodSync(path.join(work, 'dp/dest/locked'), 0o555);
      let error: any;
      try { await service.delete('dp/dest', { recursive: true, turnId: 'persist-ok' }); } catch (e) { error = e; }
      expect(error.code).toBe('OPERATION_INCOMPLETE');
      expect(error.message).toContain('变化事实已记入本轮 checkpoint');
      const manifestFile = path.join(work, '.agent_recovery/checkpoints/persist-ok.json');
      expect(JSON.parse(fs.readFileSync(manifestFile, 'utf8')).changes['dp/dest'].newKind).toBeDefined();
    });
  });

  describe('legitimate stable external targets (Full Access trusted workspace) keep working', () => {
    it('copies to an existing external directory, records only an external fact, writes no recovery data there', async () => {
      const target = path.join(outside, 'dp', 'dest');
      const result = await service.copy('sp/source', target, { overwrite: true, turnId: 'external' });
      expect(result.outsideWorkspace).toBe(true);
      expect(fs.readFileSync(path.join(target, 'f5.txt'), 'utf8')).toBe('workspace sp/source 5');
      expect(fs.existsSync(path.join(outside, '.agent_recovery'))).toBe(false);
      const manifest = JSON.parse(fs.readFileSync(path.join(work, '.agent_recovery/checkpoints/external.json'), 'utf8'));
      expect(Object.values(manifest.unrecoverable).length).toBeGreaterThan(0);
    });

    it('creates missing external parents below a stable existing ancestor', async () => {
      const target = path.join(outside, 'fresh', 'chain', 'dest');
      await service.copy('sp/source', target, { turnId: 'external' });
      expect(fs.readFileSync(path.join(target, 'f9.txt'), 'utf8')).toBe('workspace sp/source 9');
    });

    it('deletes and moves an external target while the workspace is stable', async () => {
      await service.delete(path.join(outside, 'dp', 'dest'), { recursive: true, permanent: true, turnId: 'external' });
      expect(fs.existsSync(path.join(outside, 'dp', 'dest'))).toBe(false);
      await service.move('sp/source', path.join(outside, 'moved-source'), { turnId: 'external' });
      expect(fs.existsSync(path.join(work, 'sp/source'))).toBe(false);
      expect(fs.existsSync(path.join(outside, 'moved-source/f1.txt'))).toBe(true);
    });

    it('rejects when the external target parent itself is replaced during the operation', async () => {
      const external = path.join(sandbox, 'external-parent');
      const impostor = path.join(sandbox, 'impostor');
      fs.mkdirSync(path.join(external, 'dest'), { recursive: true });
      fs.mkdirSync(path.join(impostor, 'dest'), { recursive: true });
      for (let i = 0; i < FILES; i += 1) {
        fs.writeFileSync(path.join(external, 'dest', `f${i}.txt`), `external ${i}`);
        fs.writeFileSync(path.join(impostor, 'dest', `f${i}.txt`), `impostor ${i}`);
      }
      const before = fingerprint(impostor);
      const arm = armSwap(() => true, () => {
        fs.renameSync(external, path.join(sandbox, 'external-held'));
        fs.symlinkSync(impostor, external, 'dir');
      });
      let error: any;
      try { await service.copy('sp/source', path.join(external, 'dest'), { overwrite: true, turnId: 'external' }); } catch (e) { error = e; }
      arm.stop();
      expect(REJECT_CODES).toContain(error?.code);
      expect(arm.swapped()).toBe(true);
      expect(fingerprint(impostor)).toEqual(before);
    });
  });

  describe('large single file moves through verified descriptors', () => {
    it('copies 5 MiB byte-exactly while the event loop keeps ticking', async () => {
      const content = crypto.randomBytes(5 * 1024 * 1024);
      fs.writeFileSync(path.join(work, 'big.bin'), content);
      let ticks = 0;
      let running = true;
      const tick = () => { if (running) { ticks += 1; setImmediate(tick); } };
      setImmediate(tick);
      try { await service.copy('big.bin', 'big-copy.bin', { turnId: 'big' }); } finally { running = false; }
      expect(fs.readFileSync(path.join(work, 'big-copy.bin')).equals(content)).toBe(true);
      expect(ticks).toBeGreaterThan(0);
    });

    it('a cancelled large copy removes the half-written file and reports the incomplete operation', async () => {
      fs.writeFileSync(path.join(work, 'big.bin'), crypto.randomBytes(20 * 1024 * 1024));
      const controller = new AbortController();
      const arm = armSwap(() => fs.existsSync(path.join(work, 'big-copy.bin')), () => controller.abort());
      let error: any;
      try { await service.copy('big.bin', 'big-copy.bin', { turnId: 'big', signal: controller.signal }); } catch (e) { error = e; }
      arm.stop();
      expect(error?.code).toBe('OPERATION_INCOMPLETE');
      expect(fs.existsSync(path.join(work, 'big-copy.bin'))).toBe(false);
    });
  });
});

describe('A9-67 F-022 repair: workspace root identity branch', () => {
  let sandbox: string;
  beforeEach(() => { sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'a9-67-root-')); });
  afterEach(() => { fs.rmSync(sandbox, { recursive: true, force: true }); });

  it('an existing root that cannot be resolved (ELOOP) is not verified by lexical fallback', async () => {
    fs.symlinkSync(path.join(sandbox, 'b'), path.join(sandbox, 'a'));
    fs.symlinkSync(path.join(sandbox, 'a'), path.join(sandbox, 'b'));
    const service = new A9WorkspaceService(path.join(sandbox, 'a'));
    await expect(service.copy('x', 'y', { turnId: 't' })).rejects.toMatchObject({ code: 'PATH_IDENTITY_UNKNOWN' });
    await expect(service.write('new.txt', 'data', { turnId: 't' } as any)).rejects.toMatchObject({ code: 'PATH_IDENTITY_UNKNOWN' });
    expect(fs.readdirSync(sandbox).sort()).toEqual(['a', 'b']);
  });

  it('an over-long root name reports PATH_TOO_LONG instead of a verified lexical root', async () => {
    const service = new A9WorkspaceService(path.join(sandbox, 'x'.repeat(300)));
    // Both the root probe and every operation fail closed without exposing the path.
    await expect(service.delete('anything', { turnId: 't' })).rejects.toMatchObject({ code: 'PATH_TOO_LONG' });
  });

  it('a default workspace that does not exist yet is created lazily by the first write', async () => {
    const root = path.join(sandbox, 'lazy', 'workspace');
    const service = new A9WorkspaceService(root);
    expect(fs.existsSync(root)).toBe(false);
    const result = await service.write('new.txt', 'hello', { turnId: 't' } as any);
    expect(result.path).toBe('new.txt');
    expect(fs.readFileSync(path.join(root, 'new.txt'), 'utf8')).toBe('hello');
    expect(result.outsideWorkspace).toBe(false);
  });

  it('a lazily created root below a symlinked ancestor is canonical, so new files stay workspace-relative', async () => {
    const real = path.join(sandbox, 'real');
    fs.mkdirSync(real);
    fs.symlinkSync(real, path.join(sandbox, 'link'), 'dir');
    const service = new A9WorkspaceService(path.join(sandbox, 'link', 'ws'));
    expect(service.workspaceRoot).toBe(path.join(fs.realpathSync(real), 'ws'));
    const result = await service.write('child/new.txt', 'hello', { turnId: 't' } as any);
    expect(result.path).toBe('child/new.txt');
    expect(result.outsideWorkspace).toBe(false);
  });
});
