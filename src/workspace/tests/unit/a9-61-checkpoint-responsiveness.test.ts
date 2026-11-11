/**
 * A9-61: bulk external-change accounting and cold checkpoint validation must
 * stay responsive on the Electron main thread without weakening durability.
 *
 * Part A uses only APIs that already existed at d5b99b62 (red-run capable).
 * Part B covers the cooperative entry points added by A9-61.
 * Assertions are behavioral (write counts, event ordering, disk facts), never ms thresholds.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { A9WorkspaceService } from '../../src';
import { CheckpointManager } from '../../src/checkpoint-manager';

// Spies go on the real module object that compiled sources read through their import bindings.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const nodeFs: typeof fs = require('fs');

const MOVED_FILES = 512;
const FILE_BYTES = 2 * 1024;
const BIG_BYTES = 3 * 1024 * 1024; // > 2 MiB single-file baseline bound: skipped, sparse
const sha = (value: Buffer | string) => crypto.createHash('sha256').update(value).digest('hex');

const roots: string[] = [];
/** Cooperative callbacks a test scheduled; settled before its sandbox is removed, also on failure. */
const scheduled: Array<Promise<unknown>> = [];
const stoppers: Array<() => void> = [];
function later(work: () => void): Promise<void> {
  const done = new Promise<void>((resolve, reject) => setImmediate(() => {
    try { work(); resolve(); } catch (error) { reject(error); }
  }));
  scheduled.push(done.catch(() => undefined));
  return done;
}
afterEach(async () => {
  for (const stop of stoppers.splice(0)) stop();
  await Promise.all(scheduled.splice(0));
  jest.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function makeWorkspace(files = MOVED_FILES): { root: string; contents: Map<string, string> } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a9-61-ws-'));
  roots.push(root);
  const contents = new Map<string, string>();
  fs.mkdirSync(path.join(root, 'src'));
  for (let index = 0; index < files; index += 1) {
    const rel = `src/f-${String(index).padStart(4, '0')}.txt`;
    const body = `file ${index}\n`.padEnd(FILE_BYTES, String.fromCharCode(97 + (index % 26)));
    fs.writeFileSync(path.join(root, rel), body);
    contents.set(rel, sha(body));
  }
  const fd = fs.openSync(path.join(root, 'big.bin'), 'w');
  fs.ftruncateSync(fd, BIG_BYTES);
  fs.closeSync(fd);
  return { root, contents };
}

/** What a CMD `move src\* dst\` leaves behind: every file renamed into a new directory. */
function moveAll(root: string): void {
  fs.mkdirSync(path.join(root, 'dst'));
  for (const name of fs.readdirSync(path.join(root, 'src'))) {
    fs.renameSync(path.join(root, 'src', name), path.join(root, 'dst', name));
  }
}

const isManifest = (target: unknown, turnId: string) =>
  typeof target === 'string' && target.endsWith(`${path.sep}checkpoints${path.sep}${turnId}.json`);
const isArtifact = (target: unknown) =>
  typeof target === 'string' && target.includes(`${path.sep}.agent_recovery${path.sep}snapshots${path.sep}`);

/** Ordered log of manifest writes, artifact reads and event-loop heartbeats. */
function instrument(turnId: string) {
  const log: string[] = [];
  let manifestBytes = 0;
  const realRename = fs.renameSync;
  jest.spyOn(nodeFs, 'renameSync').mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
    realRename(from, to);
    if (isManifest(to, turnId)) {
      log.push('persist');
      manifestBytes += fs.statSync(to).size;
    }
  }) as typeof fs.renameSync);
  const realRead = fs.readFileSync;
  jest.spyOn(nodeFs, 'readFileSync').mockImplementation(((target: any, options?: any) => {
    if (isArtifact(target)) log.push('artifact');
    return realRead(target, options);
  }) as typeof fs.readFileSync);
  let beating = false;
  const tick = () => {
    if (!beating) return;
    log.push('beat');
    setImmediate(tick);
  };
  stoppers.push(() => { beating = false; });
  return {
    log,
    manifestBytes: () => manifestBytes,
    startHeartbeat: () => { beating = true; setImmediate(tick); },
    stopHeartbeat: () => { beating = false; },
    reset: () => { log.length = 0; manifestBytes = 0; },
    count: (kind: string) => log.filter((entry) => entry === kind).length,
    /** Heartbeats strictly between the first and last occurrence of `kind`. */
    beatsWithin: (kind: string) => {
      const first = log.indexOf(kind);
      const last = log.lastIndexOf(kind);
      return first < 0 ? 0 : log.slice(first, last).filter((entry) => entry === 'beat').length;
    },
  };
}

function diskFacts(root: string, turnId: string) {
  const checkpoint = new CheckpointManager(root).loadCheckpoint(turnId)!;
  return {
    changes: JSON.parse(JSON.stringify(checkpoint.changes)),
    unrecoverable: JSON.parse(JSON.stringify(checkpoint.unrecoverable)),
    status: checkpoint.externalBaseline?.collectionStatus,
  };
}

describe('A9-61 Part A: bounded bulk accounting through the existing Workspace API', () => {
  it('records 512 Shell renames with bounded manifest writes while the event loop keeps running', async () => {
    const { root, contents } = makeWorkspace();
    const service = new A9WorkspaceService(root);
    const turnId = 'turn-bulk-move';
    const baseline = await service.freezeTurnBaseline(turnId);
    expect(Object.keys(baseline.files)).toHaveLength(MOVED_FILES);
    expect(baseline.skipped.map((item) => [item.path, item.reason])).toEqual([['big.bin', 'too_large']]);
    moveAll(root);

    const probe = instrument(turnId);
    probe.startHeartbeat();
    const started = Date.now();
    const report = await service.collectExternalChanges(turnId, baseline);
    const elapsedMs = Date.now() - started;
    probe.stopHeartbeat();

    // 512 deleted + 512 created file facts + 1 created directory fact.
    const operations = MOVED_FILES * 2 + 1;
    const writes = probe.count('persist');
    console.log(`A9-61 bulk collection: operations=${operations} manifestWrites=${writes} ` +
      `manifestBytes=${probe.manifestBytes()} beatsBetweenWrites=${probe.beatsWithin('persist')} elapsedMs=${elapsedMs}`);
    expect(writes).toBeGreaterThan(0);
    expect(writes).toBeLessThanOrEqual(Math.ceil(operations / 256));
    expect(probe.beatsWithin('persist')).toBeGreaterThan(0);

    expect(report.changes.filter((change) => change.kind === 'renamed')).toHaveLength(MOVED_FILES * 2);
    const facts = diskFacts(root, turnId);
    expect(facts.status).toBe('complete');
    expect(Object.keys(facts.changes)).toHaveLength(operations);
    for (const [rel, hash] of contents) {
      expect(facts.changes[rel]).toMatchObject({ action: 'delete', originalKind: 'file', newKind: 'absent',
        originalHash: hash, originalArtifactRole: 'baseline' });
      const moved = rel.replace(/^src\//, 'dst/');
      expect(facts.changes[moved]).toMatchObject({ action: 'create', originalKind: 'absent', newKind: 'file', newHash: hash });
    }
    expect(facts.changes.dst).toMatchObject({ action: 'create', isDirectory: true, newKind: 'directory' });
    expect(facts.changes['big.bin']).toBeUndefined();

    // A fresh process restores every original byte and removes the created tree.
    const outcome = new CheckpointManager(root).undoTurn(turnId);
    expect(outcome.errors).toEqual([]);
    expect(outcome.drifted).toEqual([]);
    for (const [rel, hash] of contents) expect(sha(fs.readFileSync(path.join(root, rel)))).toBe(hash);
    expect(fs.existsSync(path.join(root, 'dst'))).toBe(false);
    expect(fs.statSync(path.join(root, 'big.bin')).size).toBe(BIG_BYTES);
  }, 120_000);

  it('keeps skipped/unrecoverable facts durable inside batches and preserves them on undo', async () => {
    const { root, contents } = makeWorkspace(300);
    const service = new A9WorkspaceService(root);
    const turnId = 'turn-skipped-batch';
    const baseline = await service.freezeTurnBaseline(turnId);
    for (const rel of contents.keys()) fs.unlinkSync(path.join(root, rel));
    fs.renameSync(path.join(root, 'big.bin'), path.join(root, 'big-renamed.bin'));

    const report = await service.collectExternalChanges(turnId, baseline);
    expect(report.unrecoverable).toEqual(expect.arrayContaining([
      { path: 'big.bin', kind: 'renamed', reason: 'too_large' },
      { path: 'big-renamed.bin', kind: 'renamed', reason: 'rename-from-skipped' },
    ]));
    const facts = diskFacts(root, turnId);
    expect(facts.status).toBe('complete');
    expect(facts.unrecoverable['big.bin']).toMatchObject({ kind: 'renamed' });
    expect(facts.unrecoverable['big-renamed.bin']).toMatchObject({ kind: 'renamed' });
    expect(facts.changes['big.bin']).toMatchObject({ action: 'delete', unrecoverable: true });
    expect(facts.changes['big-renamed.bin']).toMatchObject({ action: 'modify', unrecoverable: true });
    for (const rel of contents.keys()) expect(facts.changes[rel]).toMatchObject({ action: 'delete' });

    const outcome = new CheckpointManager(root).undoTurn(turnId);
    for (const [rel, hash] of contents) expect(sha(fs.readFileSync(path.join(root, rel)))).toBe(hash);
    expect(outcome.errors.some((error) => error.includes('big.bin'))).toBe(true);
    expect(fs.statSync(path.join(root, 'big-renamed.bin')).size).toBe(BIG_BYTES); // current content preserved
  }, 120_000);

  it('never acknowledges an undurable fact when a manifest write fails, and recovers fully after restart', async () => {
    const { root, contents } = makeWorkspace();
    const service = new A9WorkspaceService(root);
    const turnId = 'turn-write-failure';
    const baseline = await service.freezeTurnBaseline(turnId);
    moveAll(root);

    const realWrite = fs.writeFileSync;
    let manifestWrites = 0;
    jest.spyOn(nodeFs, 'writeFileSync').mockImplementation(((target: any, data: any, options?: any) => {
      if (typeof target === 'string' && target.includes(`${path.sep}checkpoints${path.sep}${turnId}.json.tmp-`)) {
        manifestWrites += 1;
        if (manifestWrites === 3) throw Object.assign(new Error('injected EIO'), { code: 'EIO' });
      }
      return realWrite(target, data, options);
    }) as typeof fs.writeFileSync);
    await expect(service.collectExternalChanges(turnId, baseline)).rejects.toThrow(/Checkpoint 清单写入失败/);
    jest.restoreAllMocks();

    // Memory equals disk: the failed write left no in-memory-only fact behind.
    const memory = service.getCheckpointManager().loadCheckpoint(turnId)!;
    const disk = diskFacts(root, turnId);
    expect(JSON.parse(JSON.stringify(memory.changes))).toEqual(disk.changes);
    expect(memory.externalBaseline?.collectionStatus).toBe('pending');
    expect(disk.status).toBe('pending');
    expect(service.getCheckpointManager().undoTurn(turnId).restored).toEqual([]);

    // Restart: explicit reconciliation rebuilds the complete facts from the durable baseline.
    const restarted = new A9WorkspaceService(root);
    const reconciliation = await restarted.reconcilePendingExternalBaseline(turnId);
    expect(reconciliation?.report?.changes.filter((change) => change.kind === 'renamed')).toHaveLength(MOVED_FILES * 2);
    expect(Object.keys(diskFacts(root, turnId).changes)).toHaveLength(MOVED_FILES * 2 + 1);
    expect(restarted.getCheckpointManager().confirmExternalUndo(turnId, reconciliation!.confirmationId)).toBe(true);
    const outcome = restarted.getCheckpointManager().undoTurn(turnId);
    expect(outcome.errors).toEqual([]);
    expect(outcome.drifted).toEqual([]);
    for (const [rel, hash] of contents) expect(sha(fs.readFileSync(path.join(root, rel)))).toBe(hash);
    expect(diskFacts(root, turnId).status).toBe('complete');
  }, 120_000);

  it('validates a cold crash-time manifest in yielded slices during reconciliation', async () => {
    const { root } = makeWorkspace();
    const turnId = 'turn-cold-reconcile';
    await new A9WorkspaceService(root).freezeTurnBaseline(turnId);
    moveAll(root); // crash before collection

    const restarted = new A9WorkspaceService(root);
    const probe = instrument(turnId);
    probe.startHeartbeat();
    const reconciliation = await restarted.reconcilePendingExternalBaseline(turnId);
    probe.stopHeartbeat();
    console.log(`A9-61 cold reconcile: artifactReads=${probe.count('artifact')} ` +
      `beatsBetweenArtifactReads=${probe.beatsWithin('artifact')} manifestWrites=${probe.count('persist')}`);
    expect(probe.count('artifact')).toBeGreaterThanOrEqual(MOVED_FILES);
    expect(probe.beatsWithin('artifact')).toBeGreaterThan(0);
    expect(reconciliation?.confirmationId).toMatch(/^undo-[a-f0-9]{32}$/);
    expect(diskFacts(root, turnId).status).toBe('awaiting_confirmation');
  }, 120_000);
});

describe('A9-61 Part B: cooperative cold loads, batches and Diff', () => {
  async function collectedTurn(turnId: string) {
    const fixture = makeWorkspace();
    const service = new A9WorkspaceService(fixture.root);
    const baseline = await service.freezeTurnBaseline(turnId);
    moveAll(fixture.root);
    await service.collectExternalChanges(turnId, baseline);
    return { ...fixture, service };
  }
  const cached = (manager: CheckpointManager, turnId: string) =>
    (manager as unknown as { checkpoints: Map<string, unknown> }).checkpoints.has(turnId);

  it('loads cooperatively with the synchronous result, one shared validation and no early cache entry', async () => {
    const turnId = 'turn-async-load';
    const { root } = await collectedTurn(turnId);
    const reference = new CheckpointManager(root);
    const probe = instrument(turnId);
    const expected = reference.loadCheckpoint(turnId);
    const syncReads = probe.count('artifact');
    probe.reset();

    const manager = new CheckpointManager(root);
    const cachedAtBeat: boolean[] = [];
    let pending = true;
    stoppers.push(() => { pending = false; });
    const watch = () => { if (!pending) return; cachedAtBeat.push(cached(manager, turnId)); setImmediate(watch); };
    setImmediate(watch);
    probe.startHeartbeat();
    let first: unknown;
    let second: unknown;
    try {
      [first, second] = await Promise.all([manager.loadCheckpointAsync(turnId), manager.loadCheckpointAsync(turnId)]);
    } finally {
      pending = false;
      probe.stopHeartbeat();
    }

    expect(first).toBe(second);
    expect(JSON.parse(JSON.stringify(first))).toEqual(JSON.parse(JSON.stringify(expected)));
    expect(probe.count('artifact')).toBe(syncReads); // concurrent callers shared one validation
    expect(probe.beatsWithin('artifact')).toBeGreaterThan(0);
    expect(cachedAtBeat.length).toBeGreaterThan(0);
    expect(cachedAtBeat.every((value) => value === false)).toBe(true);
    expect(cached(manager, turnId)).toBe(true);
    expect(await manager.loadCheckpointAsync(turnId)).toBe(first);
  }, 120_000);

  it('never promotes a manifest that was tampered with during cooperative validation', async () => {
    const turnId = 'turn-async-tamper';
    const { root } = await collectedTurn(turnId);
    const manifest = path.join(root, '.agent_recovery', 'checkpoints', `${turnId}.json`);
    const original = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    const victim = Object.keys(original.externalBaseline.files).sort().pop()!;
    const manager = new CheckpointManager(root);
    let tampered = false;
    const tamper = () => {
      if (tampered) return;
      tampered = true;
      const changed = JSON.parse(JSON.stringify(original));
      changed.externalBaseline.files[victim].sha256 = 'f'.repeat(64);
      fs.writeFileSync(manifest, `${JSON.stringify(changed, null, 2)}\n`, 'utf8');
    };
    const tamperDone = later(tamper);
    await expect(manager.loadCheckpointAsync(turnId)).rejects.toThrow(/content SHA-256 mismatch/);
    await tamperDone;
    expect(tampered).toBe(true);
    expect(cached(manager, turnId)).toBe(false);
    expect(() => manager.loadCheckpoint(turnId)).toThrow(/content SHA-256 mismatch/);
  }, 120_000);

  it('re-validates instead of returning stale facts when another writer persists during validation', async () => {
    const turnId = 'turn-async-rewrite';
    const { root } = await collectedTurn(turnId);
    const manager = new CheckpointManager(root);
    const writer = later(() => new CheckpointManager(root).recordUnrecoverableExternal(turnId, {
      path: 'C:/outside/marker.txt', kind: 'outside', reason: 'concurrent durable writer',
    }));
    const loaded = await manager.loadCheckpointAsync(turnId);
    await writer;
    expect(loaded?.unrecoverable['C:/outside/marker.txt']).toMatchObject({ reason: 'concurrent durable writer' });
  }, 120_000);

  it('does not report a legitimate artifact and manifest rewrite during validation as corruption', async () => {
    const { root } = makeWorkspace(0);
    const service = new A9WorkspaceService(root);
    const turnId = 'turn-async-artifact-rewrite';
    for (let index = 0; index < 100; index += 1) {
      await service.write(`direct/f-${String(index).padStart(3, '0')}.txt`, `first ${index}\n`, { turnId });
    }
    const manager = new CheckpointManager(root);
    // Entry 99 is validated after the first yield: its 'new' artifact and the manifest change underneath.
    const writer = later(() => {
      void service.write('direct/f-099.txt', 'second 99\n', { turnId }).catch(() => undefined);
    });
    const loaded = await manager.loadCheckpointAsync(turnId);
    await writer;
    expect(loaded?.changes['direct/f-099.txt'].newHash).toBe(sha('second 99\n'));
    expect(JSON.parse(JSON.stringify(loaded))).toEqual(JSON.parse(JSON.stringify(new CheckpointManager(root).loadCheckpoint(turnId))));
  }, 120_000);

  it('rejects secrets, wrong Turn binding and foreign artifacts with the synchronous errors', async () => {
    const turnId = 'turn-async-reject';
    const { root } = await collectedTurn(turnId);
    const manifestDir = path.join(root, '.agent_recovery', 'checkpoints');
    const secretAware = (value: string | Buffer) =>
      (Buffer.isBuffer(value) ? value.toString('utf8') : value).includes('file 511\n');
    const syncError = (manager: CheckpointManager, id: string) => {
      try { manager.loadCheckpoint(id); } catch (error) { return (error as Error).message; }
      return 'no error';
    };
    const asyncError = async (manager: CheckpointManager, id: string) => {
      try { await manager.loadCheckpointAsync(id); } catch (error) { return (error as Error).message; }
      return 'no error';
    };

    const secret = await asyncError(new CheckpointManager(root, undefined, secretAware), turnId);
    expect(secret).toMatch(/A9_CHECKPOINT_SECRET_BLOCKED/);
    expect(secret).toBe(syncError(new CheckpointManager(root, undefined, secretAware), turnId));

    const raw = JSON.parse(fs.readFileSync(path.join(manifestDir, `${turnId}.json`), 'utf8'));
    fs.writeFileSync(path.join(manifestDir, 'turn-copied.json'), JSON.stringify(raw), 'utf8');
    const copied = await asyncError(new CheckpointManager(root), 'turn-copied');
    expect(copied).toMatch(/turn mismatch/);
    expect(copied).toBe(syncError(new CheckpointManager(root), 'turn-copied'));

    const foreign = { ...raw, turnId: 'turn-foreign' };
    fs.writeFileSync(path.join(manifestDir, 'turn-foreign.json'), JSON.stringify(foreign), 'utf8');
    const bound = await asyncError(new CheckpointManager(root), 'turn-foreign');
    expect(bound).toMatch(/无法读取 Checkpoint 清单 .*turn-foreign/);
    expect(bound).toBe(syncError(new CheckpointManager(root), 'turn-foreign'));
  }, 120_000);

  it('restarts an in-flight load when the trusted secret set changes', async () => {
    const { root } = makeWorkspace();
    const turnId = 'turn-async-generation';
    await new A9WorkspaceService(root).freezeTurnBaseline(turnId); // pending: baseline artifacts validate first
    const manifest = JSON.parse(fs.readFileSync(path.join(root, '.agent_recovery', 'checkpoints', `${turnId}.json`), 'utf8'));
    const firstValidated = Object.keys(manifest.externalBaseline.files)[0];
    const marker = fs.readFileSync(path.join(root, firstValidated), 'utf8').split('\n')[0] + '\n';
    let secretKnown = false;
    const manager = new CheckpointManager(root, undefined,
      (value) => secretKnown && (Buffer.isBuffer(value) ? value.toString('utf8') : value).includes(marker));
    const rotation = later(() => {
      // The first artifact already passed under the old secret set; the result must not be promoted.
      secretKnown = true;
      expect(() => manager.revalidatePersistedTurns()).toThrow(/A9_CHECKPOINT_SECRET_BLOCKED/);
    });
    await expect(manager.loadCheckpointAsync(turnId)).rejects.toThrow(/A9_CHECKPOINT_SECRET_BLOCKED/);
    await rotation;
    expect(secretKnown).toBe(true);
    expect(cached(manager, turnId)).toBe(false);
    await expect(manager.revalidatePersistedTurnsAsync()).rejects.toThrow(/A9_CHECKPOINT_SECRET_BLOCKED/);
  }, 120_000);

  it('preserves a concurrent same-Turn fact written between batches', async () => {
    const { root } = makeWorkspace();
    const service = new A9WorkspaceService(root);
    const turnId = 'turn-concurrent-batch';
    const baseline = await service.freezeTurnBaseline(turnId);
    moveAll(root);
    const probe = instrument(turnId);
    let injected = false;
    let polling = true;
    stoppers.push(() => { polling = false; });
    const injection = new Promise<void>((resolve, reject) => {
      const inject = () => {
        if (!polling) { resolve(); return; }
        if (probe.count('persist') === 0) { setImmediate(inject); return; }
        try {
          injected = true;
          service.getCheckpointManager().recordUnrecoverableExternal(turnId, {
            path: 'C:/outside/concurrent.txt', kind: 'outside', reason: 'same-turn writer between batches',
          });
          resolve();
        } catch (error) { reject(error); }
      };
      setImmediate(inject);
    });
    scheduled.push(injection.catch(() => undefined));
    try {
      await service.collectExternalChanges(turnId, baseline);
    } finally {
      polling = false;
    }
    await injection;
    expect(injected).toBe(true);
    const facts = diskFacts(root, turnId);
    expect(facts.unrecoverable['C:/outside/concurrent.txt']).toMatchObject({ kind: 'outside' });
    expect(Object.keys(facts.changes)).toHaveLength(MOVED_FILES * 2 + 1);
    expect(facts.status).toBe('complete');
    expect(service.getCheckpointManager().loadCheckpoint(turnId)?.unrecoverable['C:/outside/concurrent.txt']).toBeDefined();
  }, 120_000);

  it('shares one crash reconciliation between concurrent Undo requests', async () => {
    const { root } = makeWorkspace();
    const turnId = 'turn-reconcile-dedup';
    await new A9WorkspaceService(root).freezeTurnBaseline(turnId);
    moveAll(root);
    const restarted = new A9WorkspaceService(root);
    const probe = instrument(turnId);
    const [first, second] = await Promise.all([
      restarted.reconcilePendingExternalBaseline(turnId),
      restarted.reconcilePendingExternalBaseline(turnId),
    ]);
    expect(first).toBe(second);
    expect(first?.confirmationId).toBe(restarted.getCheckpointManager().getExternalUndoConfirmation(turnId));
    expect(probe.count('persist')).toBeLessThanOrEqual(Math.ceil((MOVED_FILES * 2 + 1) / 256));
  }, 120_000);

  it('returns the synchronous Diff and review from one cooperative pass', async () => {
    const turnId = 'turn-async-diff';
    const { root } = makeWorkspace(80);
    const service = new A9WorkspaceService(root);
    const baseline = await service.freezeTurnBaseline(turnId);
    for (let index = 0; index < 80; index += 1) {
      fs.appendFileSync(path.join(root, `src/f-${String(index).padStart(4, '0')}.txt`), `\nchanged ${index}\n`);
    }
    await service.collectExternalChanges(turnId, baseline);
    await service.read('src/f-0000.txt');
    await service.edit('src/f-0000.txt', 'changed 0', 'edited 0', { turnId: 'turn-async-diff-direct' });

    for (const id of [turnId, 'turn-async-diff-direct', 'turn-missing']) {
      const reference = new CheckpointManager(root);
      const expected = { diff: reference.getTurnDiff(id), review: reference.getTurnReview(id) };
      const actual = await new CheckpointManager(root).getTurnDiffAndReviewAsync(id);
      expect(actual).toEqual(expected);
    }
  }, 120_000);
});
