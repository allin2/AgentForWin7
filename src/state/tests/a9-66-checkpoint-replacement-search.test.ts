const Database = require('better-sqlite3');
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { A9PersistenceManager } from '../src/a9-persistence';

const project=(raw:string)=>{const x=JSON.parse(raw);return x.requestPrompt||x.finalMessage||'';};
it('retains an existing checkpoint replaced after search starts, using its stable logical key',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'win7-a9-checkpoint-replace-'));let manager:A9PersistenceManager|undefined;
 try{
  const opened=A9PersistenceManager.open({databasePath:':memory:',dataRoot:root,openDatabase:(p,o)=>new Database(p,o)});if(opened.status!=='ready')throw new Error(opened.status);manager=opened.manager;
  const c=manager.ensureActiveConversation(root,'legacy','conv');
  for(let n=1;n<=3;n++){manager.upsertTask('task'+n,c.sessionId,'completed');manager.upsertTurn('turn'+n,'task'+n,c.sessionId,'completed');manager.recordModelEvent(c.sessionId,null,'conversation.request',{taskId:'task'+n,requestPrompt:'q'+n});manager.saveCheckpoint({turnId:'turn'+n,sessionId:c.sessionId,payload:{finalMessage:'needle answer '+n}});}
  const expected=manager.searchRetainedHistory(root,{query:'needle'},project).results.map((r:any)=>r.id).sort();
  const pending=manager.searchRetainedHistoryAsync(root,{query:'needle'},project,{batchRows:1});
  manager.saveCheckpoint({turnId:'turn2',sessionId:c.sessionId,payload:{finalMessage:'needle replacement 2'}});
  const actual=await pending;expect(actual.results.map((r:any)=>r.id).sort()).toEqual(expected);
  expect(actual.results.find((r:any)=>r.id==='turn2')?.snippet).toContain('replacement 2');
  expect(manager.searchRetainedHistory(root,{query:'needle'},project).results.map((r:any)=>r.id).sort()).toEqual(expected);
 }finally{if(manager)(manager as any).db.close();fs.rmSync(root,{recursive:true,force:true});}
});
it('keeps empty and Unicode legacy checkpoint keys and identical paged ordering',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'win7-a9-checkpoint-replace-'));let manager:A9PersistenceManager|undefined;
 try{
  const opened=A9PersistenceManager.open({databasePath:':memory:',dataRoot:root,openDatabase:(p,o)=>new Database(p,o)});if(opened.status!=='ready')throw new Error(opened.status);manager=opened.manager;
  const c=manager.ensureActiveConversation(root,'legacy','conv');
  for(const id of ['', 'z', '中文', '\uE000', '😀'])manager.saveCheckpoint({turnId:id,sessionId:c.sessionId,payload:{finalMessage:'needle '+id}});
  manager.db.prepare("UPDATE a9_checkpoints SET created_at='2026-11-01T00:00:00.000Z'").run();
  const writes=manager.db.prepare('SELECT total_changes() AS n').get();
  let before:any;const ids:string[]=[];
  for(let page=0;page<10;page++){
   const input={query:'needle',limit:2,...(before?{before}:{})};
   const expected=manager.searchRetainedHistory(root,input,project);
   const actual=await manager.searchRetainedHistoryAsync(root,input,project,{batchRows:1});
   expect(actual).toEqual(expected);ids.push(...actual.results.map((r:any)=>r.id));
   if(!actual.nextBefore)break;before=actual.nextBefore;
  }
  expect(ids).toEqual(['😀','\uE000','中文','z','']);
  expect(manager.db.prepare('SELECT total_changes() AS n').get()).toEqual(writes);
 }finally{if(manager)(manager as any).db.close();fs.rmSync(root,{recursive:true,force:true});}
});
