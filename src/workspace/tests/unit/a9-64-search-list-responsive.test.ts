import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { A9WorkspaceService } from '../../src';

const fsModule = require('fs') as typeof fs;

function legacyList(root: string, recursive: boolean): Array<{ name: string; path: string; type: string; sizeBytes?: number }> {
  const entries: Array<{ name: string; path: string; type: string; sizeBytes?: number }> = [];
  const scan = (dir: string, rel: string, depth: number): void => {
    const dirents = fs.readdirSync(dir, { withFileTypes: true });
    dirents.sort((a, b) => a.name.localeCompare(b.name));
    for (const dirent of dirents) {
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
      if (recursive && dirent.isDirectory() && depth < 10) scan(itemAbs, itemRel, depth + 1);
    }
  };
  scan(root, '', 0);
  return entries;
}

describe('A9-64 responsive list/search', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a9-64-'));
  });

  afterEach(() => {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_e) { /* cleanup is best effort */ }
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
    expect(nonRecursive.entries).toEqual(legacyList(tempDir, false));
    const recursive = await service.list('', { recursive: true, maxEntries: 500 });
    expect(recursive.entries).toEqual(legacyList(tempDir, true));
    const truncated = await service.list('', { recursive: true, maxEntries: 3 });
    expect(truncated.entries).toEqual(legacyList(tempDir, true).slice(0, 3));
    expect(truncated.truncated).toBe(true);
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
