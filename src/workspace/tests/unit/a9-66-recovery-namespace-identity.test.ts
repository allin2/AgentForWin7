import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { A9WorkspaceService } from '../../src/a9-workspace-service';
import { resetGbkEncodeTableForTests, prepareGbkEncodeTableAsync } from '../../src/encoding';
import { copyTreeAsync } from '../../src/async-tree';
import { IoGuard, captureAnchor } from '../../src/directory-identity';

const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))fs.rmSync(root,{recursive:true,force:true});});
const oldBytes=Buffer.from('d6d0cec4','hex');
function fixture(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'win7-a9-recovery-namespace-'));roots.push(root);
 const workspace=path.join(root,'workspace'),outside=path.join(root,'outside');fs.mkdirSync(workspace);fs.mkdirSync(outside);
 const store=path.join(workspace,'.agent_recovery');for(const name of ['checkpoints','snapshots','blobs'])fs.mkdirSync(path.join(store,name),{recursive:true});
 fs.writeFileSync(path.join(workspace,'file.txt'),oldBytes);
 return{root,workspace,outside,store,service:new A9WorkspaceService(workspace)};
}
describe.each(['root','checkpoints','snapshots','blobs'] as const)('recovery %s namespace',role=>{
 it.each(['create','overwrite','edit'] as const)('rejects %s before redirected recovery writes',async operation=>{
  const f=fixture();if(operation!=='create')await f.service.read('file.txt',{encoding:'gbk'});resetGbkEncodeTableForTests();
  let swapped=false;const tick=setImmediate(()=>{const p=role==='root'?f.store:path.join(f.store,role);fs.renameSync(p,path.join(f.root,'held'));fs.symlinkSync(f.outside,p,'dir');swapped=true;});
  try{
   const result=operation==='edit'?f.service.edit('file.txt','中文','虚构',{turnId:'recovery-test'}):f.service.write(operation==='create'?'new.txt':'file.txt','虚构',{encoding:'gbk',turnId:'recovery-test'});
   await expect(result).rejects.toMatchObject({code:'DIRECTORY_IDENTITY_CHANGED'});
   expect(swapped).toBe(true);expect(fs.readdirSync(f.outside)).toEqual([]);expect(fs.readFileSync(path.join(f.workspace,'file.txt'))).toEqual(oldBytes);expect(fs.existsSync(path.join(f.workspace,'new.txt'))).toBe(false);
  }finally{clearImmediate(tick);}
 });
});
it.each(['checkpoints','snapshots','blobs'] as const)('rejects recovery %s replacement during real directory snapshot',async role=>{
 const f=fixture();const source=path.join(f.workspace,'tree');fs.mkdirSync(source);for(let n=0;n<100;n++)fs.writeFileSync(path.join(source,`${n}.txt`),'virtual '+n);
 let swapped=false;const tick=setImmediate(()=>{const p=path.join(f.store,role);fs.renameSync(p,path.join(f.root,'held'));fs.symlinkSync(f.outside,p,'dir');swapped=true;});
 try{
  await expect(f.service.delete('tree',{recursive:true,turnId:'directory-recovery'})).rejects.toBeDefined();
  expect(swapped).toBe(true);expect(fs.readdirSync(f.outside)).toEqual([]);expect(fs.readdirSync(source)).toHaveLength(100);
 }finally{clearImmediate(tick);}
});
it('does not create an external snapshot directory before rejecting a nested link',async()=>{
 const f=fixture();const nested=path.join(f.store,'snapshots','nested');fs.symlinkSync(f.outside,nested,'dir');
 const manager:any=f.service.getCheckpointManager();
 expect(()=>manager.ensureRecoveryDir(path.join(nested,'must-not-be-created'))).toThrow();
 expect(fs.readdirSync(f.outside)).toEqual([]);
});
it('revalidates a cached checkpoint before GBK overwrite without waiting for persist',async()=>{
 const f=fixture();await f.service.read('file.txt',{encoding:'gbk'});await f.service.write('file.txt','中文',{encoding:'gbk',turnId:'cached'});
 await f.service.read('file.txt',{encoding:'gbk'});await prepareGbkEncodeTableAsync();
 queueMicrotask(()=>{fs.renameSync(f.store,path.join(f.root,'held'));fs.symlinkSync(f.outside,f.store,'dir');});
 await expect(f.service.write('file.txt','虚构',{encoding:'gbk',turnId:'cached'})).rejects.toMatchObject({code:'DIRECTORY_IDENTITY_CHANGED'});
 expect(fs.readFileSync(path.join(f.workspace,'file.txt'))).toEqual(oldBytes);expect(fs.readdirSync(f.outside)).toEqual([]);
});
it('does not create a lazy workspace until the stable write is ready',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'win7-a9-recovery-namespace-'));roots.push(root);const workspace=path.join(root,'missing','workspace');const service=new A9WorkspaceService(workspace);
 expect(fs.existsSync(workspace)).toBe(false);service.getCheckpointManager().loadCheckpoint('absent');expect(fs.existsSync(workspace)).toBe(false);
 await service.write('new.txt','中文',{encoding:'gbk'});expect(fs.readFileSync(path.join(workspace,'new.txt'))).toEqual(oldBytes);
});
it('preserves a directory symlink destination mode when it changes after the last child',async()=>{
 const f=fixture(),source=path.join(f.workspace,'source'),target=path.join(f.workspace,'target');fs.mkdirSync(source);fs.chmodSync(source,0o700);fs.chmodSync(f.outside,0o755);fs.writeFileSync(path.join(source,'one'),'virtual');let swapped=false;
 const operation=copyTreeAsync(source,target,{force:true,guard:new IoGuard([captureAnchor(f.workspace)]),onSideEffect:()=>{if(!swapped&&fs.existsSync(path.join(target,'one'))){swapped=true;queueMicrotask(()=>{fs.renameSync(target,path.join(f.workspace,'held'));fs.symlinkSync(f.outside,target,'dir');});}}});
 await expect(operation).rejects.toMatchObject({code:'DIRECTORY_IDENTITY_CHANGED'});expect(swapped).toBe(true);expect(fs.statSync(f.outside).mode&0o777).toBe(0o755);
});
