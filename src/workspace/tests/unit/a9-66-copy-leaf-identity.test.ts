import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { copyTreeAsync } from '../../src/async-tree';
import { IoGuard, captureAnchor } from '../../src/directory-identity';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'win7-a9-66-copy-leaf-')); roots.push(root);
  const inside=path.join(root,'inside'), outside=path.join(root,'outside');fs.mkdirSync(inside);fs.mkdirSync(outside);
  const source=path.join(inside,'source'), target=path.join(inside,'target'), external=path.join(outside,'virtual-private');
  fs.writeFileSync(source,'original');fs.writeFileSync(external,'VIRTUAL_PRIVATE_BYTES');
  return {root,inside,outside,source,target,external,guard:new IoGuard([captureAnchor(inside)])};
}
it.each(['link','replacement-file','directory'] as const)('rejects a source changed to %s after classification without copying outside data',async kind=>{
  const f=fixture();let swapped=false;
  queueMicrotask(()=>{
    fs.renameSync(f.source,path.join(f.inside,'held'));
    if(kind==='link')fs.symlinkSync(f.external,f.source);
    else if(kind==='directory')fs.mkdirSync(f.source);
    else fs.writeFileSync(f.source,'replacement');
    swapped=true;
  });
  await expect(copyTreeAsync(f.source,f.target,{force:true,guard:f.guard})).rejects.toMatchObject({code:'DIRECTORY_IDENTITY_CHANGED'});
  expect(swapped).toBe(true);expect(fs.existsSync(f.target)).toBe(false);
  expect(fs.readFileSync(f.external,'utf8')).toBe('VIRTUAL_PRIVATE_BYTES');
});
it('does not remove an existing destination before rejecting a replaced source',async()=>{
  const f=fixture();fs.writeFileSync(f.target,'preserve target');
  queueMicrotask(()=>{fs.renameSync(f.source,path.join(f.inside,'held'));fs.symlinkSync(f.external,f.source);});
  await expect(copyTreeAsync(f.source,f.target,{force:true,guard:f.guard})).rejects.toMatchObject({code:'DIRECTORY_IDENTITY_CHANGED'});
  expect(fs.readFileSync(f.target,'utf8')).toBe('preserve target');
});
it('keeps ordinary files and stable symlinks at their original copy semantics',async()=>{
  const f=fixture();await copyTreeAsync(f.source,f.target,{force:true,guard:f.guard});
  expect(fs.readFileSync(f.target,'utf8')).toBe('original');
  const link=path.join(f.inside,'stable-link'),dest=path.join(f.inside,'copied-link');fs.symlinkSync(f.external,link);
  await copyTreeAsync(link,dest,{force:true,guard:f.guard});
  expect(fs.lstatSync(dest).isSymbolicLink()).toBe(true);expect(fs.readlinkSync(dest)).toBe(f.external);
});

it('rejects a descendant named ..shadow before creating or copying anything',async()=>{
  const f=fixture(), source=path.join(f.inside,'tree');fs.mkdirSync(source);
  fs.mkdirSync(path.join(source,'..shadow'));
  const target=path.join(source,'..shadow','clone');
  const controller=new AbortController();let effects=0;
  const timer=setTimeout(()=>controller.abort(),30);
  try {
    await expect(copyTreeAsync(source,target,{force:true,guard:f.guard,signal:controller.signal,onSideEffect:()=>{effects++;}}))
      .rejects.toMatchObject({code:'ERR_FS_CP_EINVAL'});
    expect(effects).toBe(0);expect(fs.existsSync(target)).toBe(false);
  } finally {clearTimeout(timer);}
});

it.each([true,false])('keeps a replacement destination after a large-file copy yields (cancel=%s)',async cancel=>{
  const f=fixture();fs.writeFileSync(f.source,Buffer.alloc(4*1024*1024,0x41));
  const controller=new AbortController();let swapped=false;
  const operation=copyTreeAsync(f.source,f.target,{force:true,guard:f.guard,signal:controller.signal,onSideEffect:()=>{
    if(swapped)return;
    queueMicrotask(()=>{
      fs.renameSync(f.target,path.join(f.inside,'our-partial-file'));
      fs.writeFileSync(f.target,'replacement owned by another action');swapped=true;
      if(cancel)controller.abort();
    });
  }});
  await expect(operation).rejects.toMatchObject({code:cancel?'A9_TREE_OPERATION_CANCELLED':'DIRECTORY_IDENTITY_CHANGED'});
  expect(swapped).toBe(true);expect(fs.readFileSync(f.target,'utf8')).toBe('replacement owned by another action');
});
