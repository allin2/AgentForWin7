/**
 * A9-66 F-011/F-012/F-025 and A9-67 F-022/F-029 regressions on the real
 * A9WorkspaceService, real temporary filesystem and real checkpoint manifest.
 * No filesystem mocks: interleaving is observed with a real setImmediate
 * ticker, cancellation with a real AbortController.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { A9WorkspaceService } from '../../src';

const DIRS = 40;
const FILES_PER_DIR = 60;
const FILE_BYTES = 1024;

function makeTree(root: string): void {
  for (let d = 0; d < DIRS; d += 1) {
    const dir = path.join(root, `d${String(d).padStart(2, '0')}`);
    fs.mkdirSync(dir, { recursive: true });
    for (let f = 0; f < FILES_PER_DIR; f += 1) {
      fs.writeFileSync(path.join(dir, `f${f}.txt`), crypto.createHash('sha256').update(`${d}/${f}`).digest('hex').repeat(FILE_BYTES / 64));
    }
  }
}

function countFiles(root: string): number {
  let count = 0;
  const visit = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) visit(path.join(dir, entry.name));
      else count += 1;
    }
  };
  visit(root);
  return count;
}

const activeTickers = new Set<() => number>();
function startTicker(onTick?: (ticks: number) => void): { stop: () => number } {
  let ticks = 0;
  let running = true;
  const stopFn = () => { running = false; activeTickers.delete(stopFn); return ticks; };
  activeTickers.add(stopFn);
  const tick = () => {
    if (!running) return;
    ticks += 1;
    onTick?.(ticks);
    setImmediate(tick);
  };
  setImmediate(tick);
  return { stop: stopFn };
}

function manifest(service: A9WorkspaceService, turnId: string): any {
  const file = path.join(service.getCheckpointManager().getRecoveryRoot(), 'checkpoints', `${turnId}.json`);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : undefined;
}

function partialSnapshots(service: A9WorkspaceService): string[] {
  const root = path.join(service.getCheckpointManager().getRecoveryRoot(), 'snapshots');
  const found: string[] = [];
  const visit = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.includes('.partial-')) found.push(entry.name);
      if (entry.isDirectory()) visit(path.join(dir, entry.name));
    }
  };
  visit(root);
  return found;
}

describe('A9-66/67 large directory side effects and baseline facts', () => {
  let tmp: string;
  let service: A9WorkspaceService;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'a9-66-67-ws-'));
    service = new A9WorkspaceService(tmp);
  });

  afterEach(() => {
    for (const stop of Array.from(activeTickers)) stop();
    const restore = (dir: string) => {
      try { fs.chmodSync(dir, 0o755); } catch { /* already removed */ }
      try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (entry.isDirectory()) restore(path.join(dir, entry.name));
        }
      } catch { /* unreadable or removed */ }
    };
    restore(tmp);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('F-012/F-011: recoverable delete of a large directory yields to the event loop and undo restores every byte', async () => {
    makeTree(path.join(tmp, 'big'));
    const before = countFiles(path.join(tmp, 'big'));
    const ticker = startTicker();
    const started = Date.now();
    const result = await service.delete('big', { recursive: true, turnId: 'turn-del' });
    const ticks = ticker.stop();
    expect(result.deleted).toBe(true);
    expect(fs.existsSync(path.join(tmp, 'big'))).toBe(false);
    // The legacy synchronous path finishes inside one macrotask (ticks <= 1).
    expect(ticks).toBeGreaterThan(20);
    const record = manifest(service, 'turn-del').changes.big;
    expect(record.originalTreeHash).toMatch(/^[a-f0-9]{64}$/);
    expect(record.newKind).toBe('absent');
    const undo = service.getCheckpointManager().undoTurn('turn-del');
    expect(undo.errors).toEqual([]);
    expect(countFiles(path.join(tmp, 'big'))).toBe(before);
    expect(partialSnapshots(service)).toEqual([]);
    process.stdout.write(`[a9-66-evidence] delete files=${before} ticks=${ticks} ms=${Date.now() - started}\n`);
  });

  it('F-012: cancellation during the pre-side-effect snapshot rejects with the directory and manifest untouched', async () => {
    makeTree(path.join(tmp, 'big'));
    const before = countFiles(path.join(tmp, 'big'));
    const controller = new AbortController();
    const ticker = startTicker((ticks) => { if (ticks === 5) controller.abort(); });
    await expect(service.delete('big', { recursive: true, turnId: 'turn-cancel', signal: controller.signal } as any))
      .rejects.toThrow();
    ticker.stop();
    expect(countFiles(path.join(tmp, 'big'))).toBe(before);
    const record = manifest(service, 'turn-cancel')?.changes?.big;
    expect(record).toBeUndefined();
    expect(partialSnapshots(service)).toEqual([]);
    // A later attempt builds a complete snapshot (never a reused partial one).
    await service.delete('big', { recursive: true, turnId: 'turn-cancel' });
    expect(service.getCheckpointManager().undoTurn('turn-cancel').errors).toEqual([]);
    expect(countFiles(path.join(tmp, 'big'))).toBe(before);
  });

  it('F-011: large directory copy yields and records the exact post-state tree hash', async () => {
    makeTree(path.join(tmp, 'src'));
    const ticker = startTicker();
    await service.copy('src', 'dst', { turnId: 'turn-copy' });
    const ticks = ticker.stop();
    expect(ticks).toBeGreaterThan(20);
    expect(countFiles(path.join(tmp, 'dst'))).toBe(DIRS * FILES_PER_DIR);
    const record = manifest(service, 'turn-copy').changes.dst;
    expect(record.action).toBe('create');
    expect(record.newTreeHash).toBe((service.getCheckpointManager() as any).hashDirectoryTree(path.join(tmp, 'dst')));
    expect(service.getCheckpointManager().undoTurn('turn-copy').errors).toEqual([]);
    expect(fs.existsSync(path.join(tmp, 'dst'))).toBe(false);
  });

  it('F-011: a failure after deletion started records the actual post-state instead of a raw error', async () => {
    makeTree(path.join(tmp, 'big'));
    const before = countFiles(path.join(tmp, 'big'));
    const locked = path.join(tmp, 'big', 'd39');
    fs.chmodSync(locked, 0o555);
    let error: any;
    try {
      await service.delete('big', { recursive: true, turnId: 'turn-partial' });
    } catch (caught) {
      error = caught;
    }
    fs.chmodSync(locked, 0o755);
    expect(error?.code).toBe('OPERATION_INCOMPLETE');
    const remaining = countFiles(path.join(tmp, 'big'));
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThan(before);
    const record = manifest(service, 'turn-partial').changes.big;
    expect(record.newKind).toBe('directory');
    expect(record.newTreeHash).toBe((service.getCheckpointManager() as any).hashDirectoryTree(path.join(tmp, 'big')));
    expect(service.getCheckpointManager().undoTurn('turn-partial').errors).toEqual([]);
    expect(countFiles(path.join(tmp, 'big'))).toBe(before);
  });

  it('F-011: move of a large directory snapshots cooperatively and stays undoable', async () => {
    makeTree(path.join(tmp, 'from'));
    const ticker = startTicker();
    await service.move('from', 'to', { turnId: 'turn-move' });
    const ticks = ticker.stop();
    expect(ticks).toBeGreaterThan(20);
    expect(service.getCheckpointManager().undoTurn('turn-move').errors).toEqual([]);
    expect(countFiles(path.join(tmp, 'from'))).toBe(DIRS * FILES_PER_DIR);
    expect(fs.existsSync(path.join(tmp, 'to'))).toBe(false);
  });

  it('F-025: the first GBK write builds the reverse table cooperatively and keeps exact bytes', async () => {
    const text = '中文 GBK 写入：汉字、标点，\r\n第二行';
    const ticker = startTicker();
    await service.write('gbk.txt', text, { encoding: 'gbk', turnId: 'turn-gbk' });
    const ticks = ticker.stop();
    expect(ticks).toBeGreaterThan(20);
    const bytes = fs.readFileSync(path.join(tmp, 'gbk.txt'));
    expect(new TextDecoder('gbk', { fatal: true }).decode(bytes)).toBe(text);
    // Byte equivalence with an independently built synchronous table.
    let syncBytes: Buffer | undefined;
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      syncBytes = require('../../src/encoding').encodeText(text, 'gbk');
    });
    expect(Buffer.compare(bytes, syncBytes!)).toBe(0);
  });

  it('F-022: an over-long path component reports PATH_TOO_LONG instead of a raw errno', async () => {
    const longName = 'n'.repeat(300);
    await expect(service.write(`${longName}/x.txt`, 'x', { turnId: 'turn-long' }))
      .rejects.toMatchObject({ code: 'PATH_TOO_LONG' });
    await expect(service.read(`${longName}.txt`)).rejects.toMatchObject({ code: 'PATH_TOO_LONG' });
  });

  it('F-022: an identity that cannot be resolved fails closed instead of using the lexical path', async () => {
    fs.mkdirSync(path.join(tmp, 'sealed', 'inner'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'sealed', 'inner', 'a.txt'), 'a');
    fs.chmodSync(path.join(tmp, 'sealed'), 0o000);
    try {
      await expect(service.read('sealed/inner/a.txt')).rejects.toMatchObject({ code: 'PATH_IDENTITY_UNKNOWN' });
    } finally {
      fs.chmodSync(path.join(tmp, 'sealed'), 0o755);
    }
  });

  it('F-029: files under a directory unreadable at baseline time are never classified as recoverable creations', async () => {
    fs.mkdirSync(path.join(tmp, 'hidden'));
    fs.writeFileSync(path.join(tmp, 'hidden', 'pre-existing.txt'), 'existed before the Turn');
    fs.writeFileSync(path.join(tmp, 'visible.txt'), 'v');
    fs.chmodSync(path.join(tmp, 'hidden'), 0o000);
    const baseline = await service.freezeTurnBaseline('turn-gap');
    fs.chmodSync(path.join(tmp, 'hidden'), 0o755);
    expect(baseline.skipped.some((item) => item.path === 'hidden')).toBe(true);
    const report = await service.collectExternalChanges('turn-gap', baseline);
    const fact = report.changes.find((change) => change.path === 'hidden/pre-existing.txt');
    expect(fact).toBeDefined();
    expect(fact!.recoverable).toBe(false);
    expect(fact!.restoredVia).toBeUndefined();
    expect(report.unrecoverable.some((item) => item.path === 'hidden/pre-existing.txt')).toBe(true);
  });

  it('F-029: a directory unreadable at collection time is UNKNOWN, not deleted-and-restorable', async () => {
    fs.mkdirSync(path.join(tmp, 'later'));
    fs.writeFileSync(path.join(tmp, 'later', 'kept.txt'), 'kept');
    const baseline = await service.freezeTurnBaseline('turn-unknown');
    fs.chmodSync(path.join(tmp, 'later'), 0o000);
    let report;
    try {
      report = await service.collectExternalChanges('turn-unknown', baseline);
    } finally {
      fs.chmodSync(path.join(tmp, 'later'), 0o755);
    }
    const fact = report.changes.find((change) => change.path === 'later/kept.txt');
    expect(fact?.kind).not.toBe('deleted');
    expect(fact?.recoverable).toBe(false);
    expect(report.unrecoverable.some((item) => item.path === 'later/kept.txt' && item.reason === 'collect_unreadable')).toBe(true);
  });
});
