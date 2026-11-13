import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { A9WorkspaceService } from '../../src/a9-workspace-service';
import { prepareGbkEncodeTableAsync, resetGbkEncodeTableForTests } from '../../src/encoding';

const roots: string[] = [];
const original = Buffer.from('d6d0cec40d0a', 'hex'); // 中文 CRLF, without warming the encoder.
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'win7-a9-66-gbk-identity-'));
  roots.push(root);
  const workspace = path.join(root, 'workspace'), outside = path.join(root, 'outside');
  fs.mkdirSync(workspace); fs.mkdirSync(outside);
  fs.mkdirSync(path.join(workspace, 'sub'));
  for (const dir of [workspace, path.join(workspace, 'sub'), outside]) fs.writeFileSync(path.join(dir, 'file.txt'), original);
  const service = new A9WorkspaceService(workspace);
  return { root, workspace, outside, service };
}
type Mutation = 'create' | 'overwrite' | 'edit';
async function call(f: ReturnType<typeof fixture>, operation: Mutation, target: string) {
  if (operation === 'edit') return f.service.edit(target, '中文', '虚构', { turnId: 'gbk-identity' });
  return f.service.write(target, '虚构\r\n', { encoding: 'gbk', turnId: 'gbk-identity' });
}

describe.each(['root', 'parent', 'leaf'] as const)('GBK cold initialization %s replacement', location => {
  it.each((location === 'leaf' ? ['overwrite', 'edit'] : ['create', 'overwrite', 'edit']) as Mutation[])('%s rejects before outside writes or recovery', async operation => {
    const f = fixture();
    const target = operation === 'create' ? 'new.txt' : 'file.txt';
    const relative = location === 'parent' ? `sub/${target}` : target;
    if (operation !== 'create') await f.service.read(relative, { encoding: 'gbk' });
    resetGbkEncodeTableForTests();
    let swapped = false;
    const tick = setImmediate(() => {
      const current = location === 'root' ? f.workspace : location === 'parent' ? path.join(f.workspace, 'sub') : path.join(f.workspace, 'file.txt');
      fs.renameSync(current, path.join(f.root, 'held'));
      fs.symlinkSync(location === 'leaf' ? path.join(f.outside, 'file.txt') : f.outside, current, location === 'leaf' ? 'file' : 'dir');
      swapped = true;
    });
    try {
      await expect(call(f, operation, relative)).rejects.toMatchObject({ code: 'DIRECTORY_IDENTITY_CHANGED' });
      expect(swapped).toBe(true);
      expect(fs.readFileSync(path.join(f.outside, 'file.txt'))).toEqual(original);
      expect(fs.existsSync(path.join(f.outside, 'new.txt'))).toBe(false);
      expect(fs.existsSync(path.join(f.outside, '.agent_recovery'))).toBe(false);
    } finally { clearImmediate(tick); }
  });
});

it('cached preparation still validates after an already queued microtask', async () => {
  const f = fixture();
  await prepareGbkEncodeTableAsync();
  let swapped = false;
  queueMicrotask(() => {
    fs.renameSync(f.workspace, path.join(f.root, 'held'));
    fs.symlinkSync(f.outside, f.workspace, 'dir');
    swapped = true;
  });
  await expect(call(f, 'create', 'new.txt')).rejects.toMatchObject({ code: 'DIRECTORY_IDENTITY_CHANGED' });
  expect(swapped).toBe(true);
  expect(fs.existsSync(path.join(f.outside, 'new.txt'))).toBe(false);
  expect(fs.existsSync(path.join(f.outside, '.agent_recovery'))).toBe(false);
});

it('stable GBK overwrite and edit preserve bytes and allow an explicit outside target', async () => {
  const f = fixture();
  resetGbkEncodeTableForTests();
  await f.service.read('file.txt', { encoding: 'gbk' });
  const overwritten = await call(f, 'overwrite', 'file.txt');
  expect(overwritten.outsideWorkspace).toBe(false);
  expect(fs.readFileSync(path.join(f.workspace, 'file.txt'))).toEqual(Buffer.from('d0e9b9b90d0a', 'hex'));
  await f.service.read('file.txt', { encoding: 'gbk' });
  const edited = await f.service.edit('file.txt', '虚构', '中文', { turnId: 'stable-edit' });
  expect(edited.outsideWorkspace).toBe(false);
  expect(fs.readFileSync(path.join(f.workspace, 'file.txt'))).toEqual(original);
  const target = path.join(f.outside, 'explicit.txt');
  const external = await f.service.write(target, '中文', { encoding: 'gbk', turnId: 'stable-external' });
  expect(external.outsideWorkspace).toBe(true);
  expect(fs.readFileSync(target)).toEqual(Buffer.from('d6d0cec4', 'hex'));
});

it('a missing default workspace can still be created by a GBK write', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'win7-a9-66-gbk-identity-'));
  roots.push(root);
  const workspace = path.join(root, 'missing', 'workspace');
  const service = new A9WorkspaceService(workspace);
  resetGbkEncodeTableForTests();
  expect((await service.write('new.txt', '中文', { encoding: 'gbk' })).outsideWorkspace).toBe(false);
  expect(fs.readFileSync(path.join(workspace, 'new.txt'))).toEqual(Buffer.from('d6d0cec4', 'hex'));
});
