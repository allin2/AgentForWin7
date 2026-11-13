/**
 * A9-66 F-012: the cooperative tree hash and copy must produce exactly the
 * same digest / snapshot bytes as the synchronous reference
 * (CheckpointManager.hashDirectoryTree and fs.cpSync).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CheckpointManager } from '../../src/checkpoint-manager';
import { copyTreeAsync, hashDirectoryTreeAsync } from '../../src/async-tree';

describe('A9-66 async tree equivalence with the synchronous reference', () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'a9-66-tree-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  function fixture(root: string): void {
    fs.mkdirSync(path.join(root, '中文 目录', 'empty'), { recursive: true });
    fs.mkdirSync(path.join(root, 'b'), { recursive: true });
    fs.writeFileSync(path.join(root, '中文 目录', '文件 1.txt'), Buffer.from('多字节内容\r\n', 'utf8'));
    fs.writeFileSync(path.join(root, 'b', 'big.bin'), Buffer.alloc(3 * 1024 * 1024 + 7, 0xa5));
    fs.writeFileSync(path.join(root, 'B.txt'), '');
    fs.symlinkSync('/absolute/elsewhere', path.join(root, 'abs-link'));
  }

  it('hashDirectoryTreeAsync equals hashDirectoryTree byte-for-byte', async () => {
    const root = path.join(tmp, 'root');
    fixture(root);
    fs.symlinkSync('b', path.join(root, 'rel-link'));
    const manager = new CheckpointManager(tmp);
    expect(await hashDirectoryTreeAsync(root)).toBe((manager as any).hashDirectoryTree(root));
  });

  it('copyTreeAsync produces the same tree as fs.cpSync({ recursive: true })', async () => {
    const root = path.join(tmp, 'root');
    fixture(root);
    fs.symlinkSync('b', path.join(root, 'rel-link'));
    fs.cpSync(root, path.join(tmp, 'sync-copy'), { recursive: true });
    await copyTreeAsync(root, path.join(tmp, 'async-copy'), { force: false });
    const manager = new CheckpointManager(tmp);
    const syncHash = (manager as any).hashDirectoryTree(path.join(tmp, 'sync-copy'));
    expect((manager as any).hashDirectoryTree(path.join(tmp, 'async-copy'))).toBe(syncHash);
    // Both resolve a relative link to an absolute target, so neither equals the
    // source tree: the snapshot integrity check keeps failing closed as before.
    expect(syncHash).not.toBe((manager as any).hashDirectoryTree(root));
  });

  it('copyTreeAsync rejects copying a directory into itself like cpSync', async () => {
    const root = path.join(tmp, 'root');
    fixture(root);
    await expect(copyTreeAsync(root, path.join(root, 'b', 'inner'), { force: true }))
      .rejects.toMatchObject({ code: 'ERR_FS_CP_EINVAL' });
  });
});
