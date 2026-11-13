import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { A9WorkspaceService } from '../../src';

// Real bytes and native event-loop scheduling. Every marker is virtual.
it('rejects actual staging bytes when a marker becomes known after the source scan', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a9-66-secret-window-'));
  const marker = 'VIRTUAL_LATE_KNOWN_SNAPSHOT_MARKER';
  let known = false, observedStaging = false, running = true;
  let handle: NodeJS.Immediate;
  try {
    const work = path.join(root, 'work');
    const source = path.join(work, 'source');
    fs.mkdirSync(source, { recursive: true });
    for (let i = 0; i < 100; i += 1) fs.writeFileSync(path.join(source, `f${i}.txt`), `${marker} ${i}`, 'utf8');
    const service = new A9WorkspaceService(work, { containsSensitiveData: value => known && value.includes(marker) });
    const snapshots = path.join(work, '.agent_recovery', 'snapshots');
    const findPartial = (dir: string): boolean => {
      if (!fs.existsSync(dir)) return false;
      return fs.readdirSync(dir, { withFileTypes: true }).some(entry => entry.isDirectory()
        && (entry.name.includes('.partial-') || findPartial(path.join(dir, entry.name))));
    };
    const poll = () => {
      if (!running) return;
      if (findPartial(snapshots)) { observedStaging = true; known = true; return; }
      handle = setImmediate(poll);
    };
    handle = setImmediate(poll);
    await expect(service.delete('source', { recursive: true, turnId: 'late-secret' }))
      .rejects.toThrow('A9_CHECKPOINT_SECRET_BLOCKED');
    expect(observedStaging).toBe(true);
    expect(fs.readdirSync(source)).toHaveLength(100);
    for (let i = 0; i < 100; i += 1) expect(fs.readFileSync(path.join(source, `f${i}.txt`), 'utf8')).toBe(`${marker} ${i}`);
    expect(findPartial(snapshots)).toBe(false);
    // No original/current snapshot can be promoted or used for recovery.
    const files = (dir: string): string[] => !fs.existsSync(dir) ? [] : fs.readdirSync(dir, { withFileTypes: true })
      .flatMap(entry => entry.isDirectory() ? files(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);
    expect(files(snapshots)).toEqual([]);
  } finally {
    running = false;
    clearImmediate(handle!);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it('restarts staging validation when trust changes after an earlier file was checked', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a9-66-secret-generation-'));
  const marker = 'VIRTUAL_STAGING_GENERATION_MARKER';
  let known = false, markerScans = 0, expanded = false;
  let expansion: NodeJS.Immediate | undefined;
  try {
    const source = path.join(root, 'source'); fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, 'f0.txt'), marker, 'utf8');
    for (let i = 1; i < 100; i += 1) fs.writeFileSync(path.join(source, `f${i}.txt`), `ordinary ${i}`, 'utf8');
    let manager: ReturnType<A9WorkspaceService['getCheckpointManager']>;
    const service = new A9WorkspaceService(root, { containsSensitiveData: value => {
      if (Buffer.isBuffer(value) && value.toString('utf8') === marker && ++markerScans === 2) {
        // The first scan was source validation. The second has already checked
        // this staging file; expand trust on the real next native event turn.
        expansion = setImmediate(() => { known = true; expanded = true; manager.revalidatePersistedTurns(); });
      }
      return known && value.includes(marker);
    } });
    manager = service.getCheckpointManager();
    await expect(service.delete('source', { recursive: true, turnId: 'generation-secret' }))
      .rejects.toThrow('A9_CHECKPOINT_SECRET_BLOCKED');
    expect(expanded).toBe(true);
    expect(markerScans).toBeGreaterThanOrEqual(3);
    expect(fs.readFileSync(path.join(source, 'f0.txt'), 'utf8')).toBe(marker);
    const snapshotRoot = path.join(root, '.agent_recovery', 'snapshots');
    const count = (dir: string): number => !fs.existsSync(dir) ? 0 : fs.readdirSync(dir, { withFileTypes: true })
      .reduce((n, entry) => n + (entry.isDirectory() ? count(path.join(dir, entry.name)) : 1), 0);
    expect(count(snapshotRoot)).toBe(0);
  } finally {
    if (expansion) clearImmediate(expansion);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
