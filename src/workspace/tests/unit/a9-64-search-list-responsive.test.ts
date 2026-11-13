import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { A9WorkspaceService } from '../../src';

const fsModule = require('fs') as typeof fs;

function legacyList(root: string, recursive: boolean, maxEntries = Number.MAX_SAFE_INTEGER) {
  const entries: Array<{ name: string; path: string; type: string; sizeBytes?: number }> = [];
  let truncated = false;
  const visitedDirs = new Set([fs.realpathSync(root)]);
  const scan = (dir: string, rel: string, depth: number): void => {
    if (entries.length >= maxEntries) { truncated = true; return; }
    const dirents = fs.readdirSync(dir, { withFileTypes: true });
    dirents.sort((a, b) => a.name.localeCompare(b.name));
    for (const dirent of dirents) {
      if (entries.length >= maxEntries) { truncated = true; break; }
      const itemRel = rel ? `${rel}/${dirent.name}` : dirent.name;
      const itemAbs = path.join(dir, dirent.name);
      let type = 'other';
      let sizeBytes: number | undefined;
      if (dirent.isDirectory()) type = 'directory';
      else if (dirent.isFile()) {
        type = 'file';
        try { sizeBytes = fs.statSync(itemAbs).size; } catch (_e) { /* legacy ignores stat failures */ }
      } else if (dirent.isSymbolicLink()) type = 'symlink';
      entries.push({ name: dirent.name, path: itemRel, type, sizeBytes });
      if (recursive && dirent.isDirectory() && depth < 10) {
        const realChild = fs.realpathSync(itemAbs);
        if (!visitedDirs.has(realChild)) {
          visitedDirs.add(realChild);
          scan(itemAbs, itemRel, depth + 1);
        }
      }
    }
  };
  scan(root, '', 0);
  return { entries, truncated, totalEntries: entries.length };
}

// Reproducible trees without case-folding collisions; no generated name is ignored.
function writeRandomTree(root: string, caseIndex: number): number {
  let state = (0xa9640000 + caseIndex) >>> 0;
  const random = () => {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
  const count = caseIndex === 0 ? 0 : caseIndex === 1 ? 300 : Math.floor(random() * 301);
  const parents = [{ dir: root, depth: 0 }];
  const names = ['File', 'a_b', 'UPPER', 'lower', '42', 'with-hyphen', '中文', 'has space', 'x'.repeat(80)];
  const used = new Set<string>();
  for (let i = 0; i < count; i += 1) {
    const parent = caseIndex % 4 === 0 || random() < 0.5 ? parents[0] : parents[Math.floor(random() * parents.length)];
    const directory = random() < 0.22;
    const name = `${names[i % names.length]}-${i}-${Math.floor(random() * 100000)}${directory ? '' : '.txt'}`;
    const target = path.join(parent.dir, name);
    const folded = target.normalize('NFC').toLowerCase();
    if (used.has(folded)) throw new Error('case-insensitive fixture collision');
    used.add(folded);
    if (directory) {
      fs.mkdirSync(target);
      if (parent.depth < 4) parents.push({ dir: target, depth: parent.depth + 1 });
    } else fs.writeFileSync(target, `sample ${i}`, 'utf8');
  }
  return count;
}

describe('A9-64 responsive list/search', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a9-64-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('keeps legacy ordering and truncation for non-recursive and recursive list', async () => {
    fs.mkdirSync(path.join(tempDir, '中文'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, '10'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'A.txt'), 'a');
    fs.writeFileSync(path.join(tempDir, 'a.txt'), 'aa');
    fs.writeFileSync(path.join(tempDir, '2.txt'), '22');
    fs.writeFileSync(path.join(tempDir, '中文', 'B.txt'), 'b');
    fs.writeFileSync(path.join(tempDir, '中文', '1.txt'), '1');

    const service = new A9WorkspaceService(tempDir);
    const nonRecursive = await service.list('', { maxEntries: 500 });
    expect(nonRecursive.entries).toEqual(legacyList(tempDir, false).entries);
    const recursive = await service.list('', { recursive: true, maxEntries: 500 });
    expect(recursive.entries).toEqual(legacyList(tempDir, true).entries);
    const truncated = await service.list('', { recursive: true, maxEntries: 3 });
    expect(truncated.entries).toEqual(legacyList(tempDir, true).entries.slice(0, 3));
    expect(truncated.truncated).toBe(true);
  });

  it('lists File.txt and a_b.txt exactly once in native locale order', async () => {
    fs.writeFileSync(path.join(tempDir, 'File.txt'), 'file');
    fs.writeFileSync(path.join(tempDir, 'a_b.txt'), 'underscore');
    const result = await new A9WorkspaceService(tempDir).list();
    expect(result.entries.map(entry => entry.name)).toEqual(['a_b.txt', 'File.txt']);
    expect(result.totalEntries).toBe(2);
    expect(result.truncated).toBe(false);
  });

  describe('P1-1 asynchronous directory identity', () => {
    const methods = ['list', 'search'] as const;
    const invoke = (service: A9WorkspaceService, method: typeof methods[number]) =>
      method === 'list' ? service.list('', { recursive: true }) : service.search('needle');

    it.each(methods)('%s rejects root replacement scheduled on the real event loop', async method => {
      const root = fs.realpathSync(tempDir);
      const workspace = path.join(root, 'workspace');
      const outside = path.join(root, 'outside');
      fs.mkdirSync(workspace); fs.mkdirSync(outside);
      fs.writeFileSync(path.join(workspace, 'inside.txt'), 'inside needle');
      fs.writeFileSync(path.join(outside, 'external.txt'), 'external needle');
      const service = new A9WorkspaceService(workspace);
      const swapped = new Promise<void>(resolve => setImmediate(() => {
        fs.renameSync(workspace, workspace + '-saved');
        fs.symlinkSync(outside, workspace, 'dir');
        resolve();
      }));
      try {
        await expect(invoke(service, method)).rejects.toMatchObject({ code: 'DIRECTORY_READ_FAILED' });
      } finally { await swapped; }
      // Full Access may still explicitly inspect an external target, accurately marked.
      const fresh = await invoke(service, method);
      expect(fresh.outsideWorkspace).toBe(true);
    });

    it.each(methods.flatMap(method => [false, true].flatMap(child =>
      [false, true].map(symlink => ({ method, child, symlink })))))(
      '$method rejects readdir replacement (child=$child, symlink=$symlink)', async ({ method, child, symlink }) => {
          const root = fs.realpathSync(tempDir);
          const workspace = path.join(root, `workspace-${child}-${symlink}`);
          const outside = path.join(root, `outside-${child}-${symlink}`);
          const target = child ? path.join(workspace, 'child') : workspace;
          fs.mkdirSync(target, { recursive: true }); fs.mkdirSync(outside);
          fs.writeFileSync(path.join(target, 'inside.txt'), 'inside needle');
          fs.writeFileSync(path.join(outside, 'external.txt'), 'external needle');
          const service = new A9WorkspaceService(workspace);
          const original = fs.promises.readdir;
          let swapped = false;
          const readdir = jest.spyOn(fs.promises, 'readdir').mockImplementation(async (directory: any, options?: any) => {
            if (String(directory) === target && !swapped) {
              await new Promise<void>(resolve => setImmediate(resolve));
              fs.renameSync(target, target + '-saved');
              if (symlink) fs.symlinkSync(outside, target, 'dir');
              else {
                fs.mkdirSync(target);
                fs.writeFileSync(path.join(target, 'external.txt'), 'external needle');
              }
              swapped = true;
            }
            return original.call(fs.promises, directory, options as any);
          });
          try {
            await expect(invoke(service, method)).rejects.toMatchObject({ code: 'DIRECTORY_READ_FAILED' });
            expect(swapped).toBe(true);
          } finally { readdir.mockRestore(); }
    });

    it('list revalidates the root after awaiting a child realpath', async () => {
      const root = fs.realpathSync(tempDir);
      const workspace = path.join(root, 'workspace');
      const outside = path.join(root, 'outside');
      fs.mkdirSync(path.join(workspace, 'child'), { recursive: true });
      fs.mkdirSync(path.join(outside, 'child'), { recursive: true });
      fs.writeFileSync(path.join(workspace, 'child/inside.txt'), 'inside needle');
      fs.writeFileSync(path.join(outside, 'child/external.txt'), 'external needle');
      const service = new A9WorkspaceService(workspace);
      const original = fs.promises.realpath;
      let swapped = false;
      const realpath = jest.spyOn(fs.promises, 'realpath').mockImplementation(async (target: any, options?: any) => {
        if (String(target) === path.join(workspace, 'child') && !swapped) {
          await new Promise<void>(resolve => setImmediate(resolve));
          fs.renameSync(workspace, workspace + '-saved');
          fs.symlinkSync(outside, workspace, 'dir');
          swapped = true;
        }
        return original.call(fs.promises, target, options);
      });
      try {
        await expect(invoke(service, 'list')).rejects.toMatchObject({ code: 'DIRECTORY_READ_FAILED' });
        expect(swapped).toBe(true);
      } finally { realpath.mockRestore(); }
    });

    it('search does not follow a file changed into an external symlink after readdir', async () => {
      const root = fs.realpathSync(tempDir);
      const workspace = path.join(root, 'workspace');
      const outside = path.join(root, 'external.txt');
      fs.mkdirSync(workspace);
      const file = path.join(workspace, 'inside.txt');
      fs.writeFileSync(file, 'inside needle'); fs.writeFileSync(outside, 'external needle');
      const service = new A9WorkspaceService(workspace);
      const original = fs.promises.readdir;
      let swapped = false;
      const readdir = jest.spyOn(fs.promises, 'readdir').mockImplementation(async (directory: any, options?: any) => {
        const entries = await original.call(fs.promises, directory, options as any);
        if (String(directory) === workspace && !swapped) {
          fs.renameSync(file, file + '-saved');
          fs.symlinkSync(outside, file, 'file');
          swapped = true;
        }
        return entries;
      });
      try {
        const result = await service.search('needle');
        expect(swapped).toBe(true);
        expect(result.matches).toEqual([]);
        expect(result.skipped).toContainEqual({ path: 'inside.txt', reason: 'stat_failed' });
      } finally { readdir.mockRestore(); }
    });

    it('search revalidates after a line-scan yield without swallowing identity failure', async () => {
      const root = fs.realpathSync(tempDir);
      const workspace = path.join(root, 'workspace');
      const outside = path.join(root, 'outside');
      fs.mkdirSync(workspace); fs.mkdirSync(outside);
      const file = path.join(workspace, 'inside.txt');
      fs.writeFileSync(file, 'inside needle');
      fs.writeFileSync(path.join(outside, 'external.txt'), 'external needle');
      const service = new A9WorkspaceService(workspace);
      const original = fsModule.readFileSync;
      let scheduled: NodeJS.Immediate | undefined;
      const read = jest.spyOn(fsModule, 'readFileSync').mockImplementation((target: any, ...args: any[]) => {
        const value = original(target, ...(args as [any]));
        if (String(target) === file && !scheduled) {
          scheduled = setImmediate(() => {
            fs.renameSync(workspace, workspace + '-saved');
            fs.symlinkSync(outside, workspace, 'dir');
          });
          const start = Date.now();
          while (Date.now() - start < 30) { /* Force the existing 25ms cooperative boundary. */ }
        }
        return value;
      });
      try {
        await expect(service.search('needle')).rejects.toMatchObject({ code: 'DIRECTORY_READ_FAILED' });
      } finally {
        read.mockRestore();
        if (scheduled) clearImmediate(scheduled);
      }
    });
  });

  it.each(Array.from({ length: 200 }, (_, index) => index))('matches independent legacy traversal for random tree %i', async (caseIndex) => {
    const count = writeRandomTree(tempDir, caseIndex);
    const service = new A9WorkspaceService(tempDir);
    for (const recursive of [false, true]) {
      for (const maxEntries of [1, 7, 500, count + 501]) {
        const expected = legacyList(tempDir, recursive, maxEntries);
        const result = await service.list('', { recursive, maxEntries });
        expect({ entries: result.entries, truncated: result.truncated, totalEntries: result.totalEntries }).toEqual(expected);
      }
    }
  });

  it('bounds unreadable list details at 50 while counting all 100 skipped directories', async () => {
    for (let i = 0; i < 100; i += 1) fs.mkdirSync(path.join(tempDir, `unreadable-${i}`));
    const service = new A9WorkspaceService(tempDir);
    const originalReaddir = fs.promises.readdir;
    const readdir = jest.spyOn(fs.promises, 'readdir').mockImplementation(async (target: any, options?: any) => {
      if (String(target) !== service.workspaceRoot) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      return originalReaddir.call(fs.promises, target, options as any);
    });
    try {
      const result: any = await service.list('', { recursive: true });
      expect(result.skipped).toHaveLength(50);
      expect(result.skippedTotal).toBe(100);
      expect(result.skipped.every((entry: any) => entry.reason === 'directory_unreadable')).toBe(true);
      expect(new Set(result.skipped.map((entry: any) => entry.path)).size).toBe(50);
    } finally {
      readdir.mockRestore();
    }
  });

  it('cancels list while a large directory is being scanned', async () => {
    for (let i = 0; i < 10000; i += 1) fs.writeFileSync(path.join(tempDir, `f-${i}.txt`), '');
    const service = new A9WorkspaceService(tempDir);
    const controller = new AbortController();
    const started = Date.now();
    const pending = (service as any).list('', { maxEntries: 10000, signal: controller.signal });
    setTimeout(() => controller.abort(), 0);
    await expect(pending).rejects.toThrow('目录读取已取消');
    expect(Date.now() - started).toBeLessThan(200);
  });

  it('uses operation-specific cancellation text for repeated list and search cancellations', async () => {
    for (let i = 0; i < 2400; i += 1) {
      const level1 = path.join(tempDir, `d-${String(Math.floor(i / 200)).padStart(2, '0')}`);
      const level2 = path.join(level1, `s-${String(Math.floor((i % 200) / 20)).padStart(2, '0')}`);
      fs.mkdirSync(level2, { recursive: true });
      fs.writeFileSync(path.join(level2, `f-${i}.txt`), `sample ${i}\n`);
    }
    const service = new A9WorkspaceService(tempDir);
    const expectOptionalCancellation = async (operation: Promise<unknown>, message: string): Promise<void> => {
      try {
        await operation;
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe(message);
      }
    };

    for (let delayMs = 0; delayMs < 12; delayMs += 1) {
      const controller = new AbortController();
      const pending = service.list('', { recursive: true, maxEntries: 10000, signal: controller.signal });
      setTimeout(() => controller.abort(), delayMs);
      await expectOptionalCancellation(pending, '目录读取已取消');
    }
    for (let delayMs = 0; delayMs < 12; delayMs += 1) {
      const controller = new AbortController();
      const pending = service.search('__a9_64_never__', { signal: controller.signal });
      setTimeout(() => controller.abort(), delayMs);
      await expectOptionalCancellation(pending, '搜索已被用户取消');
    }
  });

  it('reports root and child directory read failures', async () => {
    fs.mkdirSync(path.join(tempDir, 'child'));
    fs.writeFileSync(path.join(tempDir, 'child', 'x.txt'), 'x');
    const service = new A9WorkspaceService(tempDir);
    const originalReaddir = fs.promises.readdir;
    const readdir = jest.spyOn(fs.promises, 'readdir').mockImplementation(async (target: any, options?: any) => {
      if (String(target).endsWith(`${path.sep}child`)) {
        const error: NodeJS.ErrnoException = new Error('permission denied');
        error.code = 'EACCES';
        throw error;
      }
      return originalReaddir.call(fs.promises, target, options as any);
    });
    // The root call is allowed through the original implementation; the child is reported.
    const listed: any = await service.list('', { recursive: true });
    expect(listed.skipped).toEqual([{ path: 'child', reason: 'directory_unreadable' }]);
    readdir.mockRejectedValueOnce(Object.assign(new Error('root denied'), { code: 'EACCES' }));
    await expect(service.list('')).rejects.toMatchObject({ code: 'DIRECTORY_READ_FAILED' });
    readdir.mockRestore();
  });

  it('does not count binary or ambiguous files in skippedFiles', async () => {
    fs.writeFileSync(path.join(tempDir, 'large.bin'), Buffer.alloc(1024 * 1024 + 1));
    fs.writeFileSync(path.join(tempDir, 'binary.bin'), Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
    fs.writeFileSync(path.join(tempDir, 'plain.txt'), 'needle');
    const result: any = await new A9WorkspaceService(tempDir).search('needle');
    expect(result.skipped).toEqual(expect.arrayContaining([
      { path: 'large.bin', reason: 'too_large' },
      { path: 'binary.bin', reason: 'binary_or_ambiguous' },
    ]));
    expect(result.skippedTotal).toBe(2);
    expect(result.skippedFiles).toBe(1);
  });

  it('reports read-failed search files with bounded details', async () => {
    fs.writeFileSync(path.join(tempDir, 'broken.txt'), 'needle');
    const originalRead = fsModule.readFileSync;
    const readFile = jest.spyOn(fsModule, 'readFileSync').mockImplementation((target: any, ...args: any[]) => {
      if (String(target).endsWith(`${path.sep}broken.txt`)) throw new Error('read failed');
      return originalRead(target, ...(args as [any]));
    });
    const result: any = await new A9WorkspaceService(tempDir).search('needle');
    expect(result.skipped).toEqual([{ path: 'broken.txt', reason: 'read_failed' }]);
    expect(result.skippedTotal).toBe(1);
    expect(result.skippedFiles).toBe(1);
    readFile.mockRestore();
  });

  it('keeps an exact file limit untruncated when no directory entries remain', async () => {
    for (let i = 0; i < 20000; i += 1) fs.writeFileSync(path.join(tempDir, `exact-${i}.txt`), '');
    const service = new A9WorkspaceService(tempDir);
    const exact: any = await service.search('__a9_64_no_match__');
    expect(exact.filesScanned).toBe(20000);
    expect(exact.truncated).toBe(false);
    expect(exact.truncationReasons).toEqual([]);

    fs.writeFileSync(path.join(tempDir, 'over-limit.txt'), '');
    const over: any = await service.search('__a9_64_no_match__');
    expect(over.filesScanned).toBe(20000);
    expect(over.truncated).toBe(true);
    expect(over.truncationReasons).toEqual(['files']);
  });

  it('stops reading queued directories after reaching the file or match limit', async () => {
    const firstDir = path.join(tempDir, 'a');
    fs.mkdirSync(firstDir);
    for (let i = 0; i < 20001; i += 1) fs.writeFileSync(path.join(firstDir, `f-${i}.txt`), 'needle');
    for (let i = 0; i < 300; i += 1) {
      const dir = path.join(tempDir, `z-${i}`);
      fs.mkdirSync(dir);
      for (let j = 0; j < 3; j += 1) fs.writeFileSync(path.join(dir, `f-${j}.txt`), 'needle');
    }
    const service = new A9WorkspaceService(tempDir);
    const readdir = jest.spyOn(fs.promises, 'readdir');
    try {
      const files = await service.search('__a9_64_no_match__');
      console.log(`A9-64 file limit: readdir=${readdir.mock.calls.length} filesScanned=${files.filesScanned} truncated=${files.truncated} reasons=${files.truncationReasons.join(',')}`);
      expect(readdir).toHaveBeenCalledTimes(2);
      expect(readdir.mock.calls.map(([target]) => String(target))).toEqual([service.workspaceRoot, path.join(service.workspaceRoot, 'a')]);
      expect(files.filesScanned).toBe(20000);
      expect(files.truncated).toBe(true);
      expect(files.truncationReasons).toEqual(['files']);

      readdir.mockClear();
      const matches = await service.search('needle', { maxMatches: 1 });
      console.log(`A9-64 match limit: readdir=${readdir.mock.calls.length} filesScanned=${matches.filesScanned} matches=${matches.totalMatches} reasons=${matches.truncationReasons.join(',')}`);
      expect(readdir).toHaveBeenCalledTimes(2);
      expect(readdir.mock.calls.map(([target]) => String(target))).toEqual([service.workspaceRoot, path.join(service.workspaceRoot, 'a')]);
      expect(matches.filesScanned).toBe(1);
      expect(matches.totalMatches).toBe(1);
      expect(matches.truncated).toBe(true);
      expect(matches.truncationReasons).toEqual(['matches']);
    } finally {
      readdir.mockRestore();
    }
  });

  it('reports search truncation reason and cancels during traversal', async () => {
    fs.writeFileSync(path.join(tempDir, 'hit.txt'), 'needle\n');
    const service = new A9WorkspaceService(tempDir);
    const limited: any = await service.search('needle', { maxMatches: 1 });
    expect(limited.truncated).toBe(true);
    expect(limited.truncationReasons).toEqual(['matches']);
    for (let i = 0; i < 10000; i += 1) fs.writeFileSync(path.join(tempDir, `scan-${i}.txt`), '');
    const controller = new AbortController();
    const started = Date.now();
    const pending = (service as any).search('never', { signal: controller.signal, maxMatches: 200 });
    setTimeout(() => controller.abort(), 10);
    await expect(pending).rejects.toThrow('搜索已被用户取消');
    expect(Date.now() - started).toBeLessThan(200);
  });

  it('throws a stable error when the search root cannot be read', async () => {
    const readdir = jest.spyOn(fs.promises, 'readdir').mockRejectedValue(Object.assign(new Error('root denied'), { code: 'EACCES' }));
    await expect(new A9WorkspaceService(tempDir).search('needle')).rejects.toMatchObject({ code: 'DIRECTORY_READ_FAILED' });
    readdir.mockRestore();
  });

  it('keeps the cancellation error text unchanged', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(new A9WorkspaceService(tempDir).search('needle', { signal: controller.signal })).rejects.toThrow('搜索已被用户取消');
  });
});
