import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { A9WorkspaceService } from '../../src/a9-workspace-service';

const roots:string[]=[];
// chmod permission denial is a POSIX fixture; Windows needs a real ACL fixture.
const permissionCase=process.platform==='win32'?it.skip:it;
afterEach(()=>{for(const root of roots.splice(0))fs.rmSync(root,{recursive:true,force:true});});
function fixture(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'win7-a9-67-directory-gap-'));roots.push(root);
  const hidden=path.join(root,'hidden'),child=path.join(hidden,'preexisting-empty');
  fs.mkdirSync(child,{recursive:true});
  return{root,hidden,child,service:new A9WorkspaceService(root)};
}
async function baselineWithGap(f:ReturnType<typeof fixture>,turn:string){
  fs.chmodSync(f.hidden,0);
  try{
    expect(()=>fs.readdirSync(f.hidden)).toThrow();
    const baseline=await f.service.freezeTurnBaseline(turn);
    expect(baseline.skipped).toContainEqual(expect.objectContaining({path:'hidden',reason:'backup_failed'}));
    return baseline;
  }finally{fs.chmodSync(f.hidden,0o755);}
}
permissionCase('does not call a still-present skipped directory deleted',async()=>{
  const f=fixture(),baseline=await baselineWithGap(f,'gap-root');
  const report=await f.service.collectExternalChanges('gap-root',baseline);
  expect(report.changes.some(c=>c.path==='hidden'&&(c.kind==='deleted'||c.kind==='renamed'))).toBe(false);
  expect(fs.statSync(f.hidden).isDirectory()).toBe(true);
});
permissionCase('does not grant delete-new to preexisting directories below an unreadable baseline and preserves them after reopen/undo',async()=>{
  const f=fixture(),baseline=await baselineWithGap(f,'gap-child');
  const report=await f.service.collectExternalChanges('gap-child',baseline);
  expect(report.changes).toContainEqual(expect.objectContaining({path:'hidden/preexisting-empty',kind:'modified',recoverable:false}));
  expect(report.changes.some(c=>c.path==='hidden/preexisting-empty'&&c.recoverable)).toBe(false);
  const reopened=new A9WorkspaceService(f.root),checkpoint=reopened.getCheckpointManager().loadCheckpoint('gap-child')!;
  expect(checkpoint.unrecoverable['hidden/preexisting-empty']).toBeDefined();
  expect(checkpoint.changes['hidden/preexisting-empty']?.action).not.toBe('create');
  reopened.getCheckpointManager().undoTurn('gap-child');
  expect(fs.statSync(f.child).isDirectory()).toBe(true);
  new A9WorkspaceService(f.root).getCheckpointManager().undoTurn('gap-child');
  expect(fs.statSync(f.child).isDirectory()).toBe(true);
});
it('still records and undoes a genuinely new empty directory under a covered baseline',async()=>{
  const f=fixture(),baseline=await f.service.freezeTurnBaseline('covered-new');
  fs.mkdirSync(path.join(f.root,'new-empty'));
  const report=await f.service.collectExternalChanges('covered-new',baseline);
  expect(report.changes).toContainEqual(expect.objectContaining({path:'new-empty',kind:'created',recoverable:true}));
  const undone=f.service.getCheckpointManager().undoTurn('covered-new');expect(undone.errors).toEqual([]);
  expect(fs.existsSync(path.join(f.root,'new-empty'))).toBe(false);
  expect(fs.statSync(f.child).isDirectory()).toBe(true);
});
