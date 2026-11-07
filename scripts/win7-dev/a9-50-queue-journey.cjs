'use strict';
const fs=require('fs'),path=require('path'),os=require('os'),http=require('http'),assert=require('assert'),cp=require('child_process'),crypto=require('crypto');
const arg=n=>process.argv.find(v=>v.startsWith(`--${n}=`))?.slice(n.length+3);
const config=JSON.parse(fs.readFileSync(arg('config'),'utf8'));
const out=arg('out'); const delay=ms=>new Promise(r=>setTimeout(r,ms));
const physicalFs=process.versions.electron?require('original-fs'):fs;
const hash=f=>crypto.createHash('sha256').update(physicalFs.readFileSync(f)).digest('hex');
const write=(p,v)=>fs.writeFileSync(p,JSON.stringify(v,null,2)+'\n',{encoding:'utf8',flag:'wx'});
function verifyInputs(){
 if(config.manifestSha256){
  const releaseRoot=path.resolve(config.productRoot,'../../..');
  const file=path.join(releaseRoot,'release-manifest.json');assert.strictEqual(hash(file),config.manifestSha256);
  const manifest=JSON.parse(physicalFs.readFileSync(file,'utf8'));
  assert.strictEqual(manifest.source_commit,config.sourceCommit);assert.strictEqual(manifest.external_acceptance_eligible,true);
  for(const entry of manifest.files){
   const absolute=path.resolve(releaseRoot,entry.path);assert(absolute.startsWith(releaseRoot+path.sep));
   assert.strictEqual(physicalFs.statSync(absolute).size,entry.size,entry.path);assert.strictEqual(hash(absolute),entry.sha256,entry.path);
  }
 }
 for(const file of config.sourceFiles||[])assert.strictEqual(hash(path.join(config.productRoot,file.path)),file.sha256,file.path);
}
verifyInputs();
async function parent(){
 fs.mkdirSync(out);const temporary=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'win7-a9-50-product-')));
 const workspace=path.join(temporary,'中文 workspace');fs.mkdirSync(workspace);fs.writeFileSync(path.join(workspace,'note.txt'),'fixture\n','utf8');
 const requests=[],sockets=new Set();let held=null,child=null;
 const report={status:'RUNNING',sourceCommit:config.sourceCommit,sourceDirty:config.sourceDirty!==false,evidenceLevel:process.platform==='win32'?'Win7 DEV_CHANNEL':'Mac development Electron22',externalModelRequests:0,zipSha256:config.zipSha256,manifestSha256:config.manifestSha256,driverSha256:hash(__filename),sourceFiles:(config.sourceFiles||[]).map(file=>({path:file.path,sha256:hash(path.join(config.productRoot,file.path))})),phases:[]};
 const send=(res,delta,reason='stop')=>{res.writeHead(200,{'Content-Type':'text/event-stream'});res.end(`data: ${JSON.stringify({choices:[{delta,finish_reason:reason}]})}\n\ndata: [DONE]\n\n`);};
 const server=http.createServer((req,res)=>{
  if(req.url==='/facts'){res.end(JSON.stringify({count:requests.length,prompts:requests.map(r=>r.prompt),held:!!held}));return;}
  if(req.url==='/release'||req.url==='/fail'){const old=held;held=null;if(!old){res.writeHead(409);res.end('NOT_HELD');return;}if(req.url==='/fail'){old.writeHead(400);old.end('fixture failure');}else send(old,{content:'first complete'});res.end('released');return;}
  if(req.url!=='/v1/chat/completions'){res.writeHead(404);res.end();return;}
  let body='';req.on('data',b=>body+=b);req.on('end',()=>{
   try{const data=JSON.parse(body);const probe=data.tools?.[0]?.function?.name==='probe_test_echo';
    const prompt=probe?'probe':data.messages.filter(m=>m.role==='user').pop().content;
    requests.push({prompt,body});assert(!body.includes('A950_PRIVATE'),'DRAFT_LEAK');
    if(probe)return send(res,{tool_calls:[{index:0,id:'probe',function:{name:'probe_test_echo',arguments:'{"message":"probe_ok"}'}}]},'tool_calls');
    if(prompt.startsWith('A950_HOLD')){held=res;res.once('close',()=>{if(held===res)held=null;});}
    else send(res,{content:'queued complete'});
   }catch(e){report.providerError=String(e.stack);res.writeHead(500);res.end('fixture invalid');}
  });
 });server.on('connection',s=>{sockets.add(s);s.once('close',()=>sockets.delete(s));});
 try{
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const fixture=`http://127.0.0.1:${server.address().port}`;
  for(const phase of ['first','restored']){
   const env={...process.env,WIN7AGENT_A9_DATAROOT:path.join(temporary,'data'),WIN7AGENT_A9_ELECTRON_SQLITE:config.nativeRoot,LOCALAPPDATA:path.join(temporary,'local')};
   delete env.ELECTRON_RUN_AS_NODE;delete env.NODE_OPTIONS;delete env.WIN7AGENT_A9_WORKSPACE;delete env.WIN7AGENT_PORTABLE;
   const log=fs.openSync(path.join(out,phase+'.log'),'wx');
   const args=[__filename,`--config=${arg('config')}`,`--out=${path.join(out,phase+'.json')}`,`--phase=${phase}`,`--temporary=${temporary}`,`--fixture=${fixture}`,`--evidence=${out}`];
   if(phase==='first')args.push(`--a9-smoke-workspace=${workspace}`);
   const result=await new Promise((resolve,reject)=>{child=cp.spawn(config.electron,args,{env,stdio:['ignore',log,log]});let timedOut=false;const timer=setTimeout(()=>{timedOut=true;child.kill('SIGKILL');},90000);child.once('error',e=>{clearTimeout(timer);reject(e);});child.once('close',(code,signal)=>{clearTimeout(timer);child=null;resolve({code,signal,timedOut});});}).finally(()=>fs.closeSync(log));
   const detail=JSON.parse(fs.readFileSync(path.join(out,phase+'.json'),'utf8'));report.phases.push({phase,...result,detail});assert.strictEqual(result.code,0,detail.error);assert.strictEqual(detail.status,'PASS');
  }
  const db=new(require(config.hostDatabase))(path.join(temporary,'data/a9-state.db'),{readonly:true});
  try{report.sqlite={integrity:db.pragma('integrity_check',{simple:true}),activeTasks:db.prepare("SELECT count(*) n FROM a9_tasks WHERE status='active'").get().n,activeTurns:db.prepare("SELECT count(*) n FROM a9_turns WHERE status='active'").get().n,activeRuns:db.prepare("SELECT count(*) n FROM a9_runs WHERE status='active'").get().n};assert.strictEqual(report.sqlite.integrity,'ok');assert.strictEqual(report.sqlite.activeTasks+report.sqlite.activeTurns+report.sqlite.activeRuns,0);assert(!JSON.stringify(db.prepare('SELECT payload_json FROM a9_events').all()).includes('A950_PRIVATE'));}finally{db.close();}
  assert.strictEqual(requests.length,process.platform==='win32'?9:8);assert(!report.providerError);report.status='PASS';
 }catch(e){report.status='FAIL';report.error=String(e.stack||e);}
 finally{for(const s of sockets)s.destroy();if(server.listening)await new Promise(r=>server.close(r));assert(!child);fs.rmSync(temporary,{recursive:true,force:true});report.temporaryRemoved=!fs.existsSync(temporary);report.requestPrompts=requests.map(r=>r.prompt);write(path.join(out,'RESULT.json'),report);}
 console.log(JSON.stringify({status:report.status,error:report.error,requests:requests.length}));process.exitCode=report.status==='PASS'?0:1;
}
async function child(){
 const {app,BrowserWindow}=require('electron');const temporary=arg('temporary'),fixture=arg('fixture'),phase=arg('phase');
 app.disableHardwareAcceleration();app.setPath('userData',path.join(temporary,'profile'));app.setPath('crashDumps',path.join(temporary,'crashes'));
 const report={status:'RUNNING',phase,runtime:process.versions,checks:[],errors:[]};let win;
 const evaluate=(fn,...args)=>win.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`);
 const until=async(fn,label)=>{const end=Date.now()+12000;while(Date.now()<end){const v=await fn();if(v)return v;await delay(25);}throw new Error('TIMEOUT '+label);};
 const snapshot=async()=>{const r=await evaluate(()=>window.win7Agent.a9.snapshot());assert(r.ok);return r.snapshot;};
 const control=route=>new Promise((resolve,reject)=>http.get(fixture+route,res=>{let b='';res.on('data',c=>b+=c);res.on('end',()=>res.statusCode===200?resolve(route==='/facts'?JSON.parse(b):b):reject(new Error(b)));}).on('error',reject));
 const input=text=>evaluate(t=>{const n=document.getElementById('task-prompt');n.value=t;n.dispatchEvent(new Event('input',{bubbles:true}));},text);
 const click=id=>evaluate(i=>document.getElementById(i).click(),id);
 const submit=async text=>{await input(text);await until(()=>evaluate(()=>!document.getElementById('run-task').hidden&&!document.getElementById('run-task').disabled),'send enabled');await click('run-task');await until(async()=>Boolean((await control('/facts')).held),'held request');};
 const queue=async text=>{await input(text);await until(()=>evaluate(()=>!document.getElementById('queue-task').disabled),'queue enabled');await click('queue-task');await until(async()=>(await snapshot()).queue.items.some(i=>i.text===text),'queued');await until(()=>evaluate(()=>document.getElementById('task-prompt').value===''),'composer cleared');};
 const check=async(name,fn)=>{const detail=await fn();report.checks.push({name,status:'PASS',detail});};
 app.on('web-contents-created',(_e,contents)=>{contents.on('preload-error',(_e,_f,e)=>report.errors.push(e.message));contents.on('render-process-gone',(_e,d)=>report.errors.push(JSON.stringify(d)));});
 require(path.join(config.productRoot,'main.js'));
 try{
  await app.whenReady();await until(()=>{win=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('/renderer/workbench.html'));return win&&!win.webContents.isLoading();},'product window');
  await until(async()=>(await snapshot()).status==='ready','runtime');
  if(phase==='first'){
   await evaluate(()=>{document.querySelector('input[name="a9-mode-choice"][value="read_only"]').checked=true;document.getElementById('a9-mode-apply').click();});await until(async()=>(await snapshot()).mode==='read_only','mode');
   await evaluate(url=>{document.getElementById('a9-provider-url').value=url+'/v1';document.getElementById('a9-provider-model').value='local-a950';document.getElementById('a9-provider-apply').click();},fixture);
   await until(()=>evaluate(()=>document.getElementById('a9-provider-probe-state').textContent==='tool_calling'),'probe');
   await submit('A950_HOLD_FIFO');
   await check('double_click_enqueues_once_and_draft_is_separate',async()=>{
    await input('A950_SECOND');await until(()=>evaluate(()=>!document.getElementById('queue-task').disabled),'enabled');
    await evaluate(()=>{document.getElementById('queue-task').click();document.getElementById('queue-task').click();});
    await until(async()=>(await snapshot()).queue.items.length===1,'one item');await until(()=>evaluate(()=>document.getElementById('task-prompt').value===''),'cleared');
    await queue('A950_THIRD');await input('A950_PRIVATE_unsent');await until(async()=>(await snapshot()).draft.text==='A950_PRIVATE_unsent','draft saved');
    assert.strictEqual((await control('/facts')).count,2);return {queued:2,requestsBeforeRelease:2};
   });
   await check('queue_input_stop_and_scroll_are_reachable',async()=>{
    const facts=[];win.setMinimumSize(500,400);
    for(const [w,h] of [[1366,768],[900,540],[780,540]]){
     win.setPosition(0,0);win.setContentSize(w,h);await until(()=>evaluate((w,h)=>innerWidth===w&&innerHeight===h,w,h),'viewport');
     await evaluate(()=>{if(document.getElementById('inspector').classList.contains('open'))document.getElementById('close-inspector').click();if(innerWidth<800&&document.getElementById('navigation-rail').classList.contains('open'))document.getElementById('close-navigation').click();});
     await evaluate(async()=>Promise.all(document.getAnimations().filter(a=>a.effect.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{}))));
     const detail=await evaluate(()=>{const ids=['task-prompt','queue-task','cancel-task','queue-toggle'];return {w:innerWidth,h:innerHeight,scrollWidth:document.documentElement.scrollWidth,items:ids.map(id=>{const n=document.getElementById(id),r=n.getBoundingClientRect();return {id,visible:!!n.getClientRects().length,hit:n.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)),bottom:r.bottom};})};});
     assert(detail.items.every(i=>i.visible&&i.hit&&i.bottom<=h),JSON.stringify(detail));assert(detail.scrollWidth<=w);facts.push(detail);
     if(w===780)fs.writeFileSync(path.join(arg('evidence'),'queue-780.png'),(await win.webContents.capturePage()).toPNG());
    }return facts;
   });
   await control('/release');await until(async()=>{const s=await snapshot();return (await control('/facts')).count===4&&s.agentStatus==='completed'&&!s.queue.items.length;},'FIFO complete');
   await check('fifo_runs_once_and_unsent_draft_survives',async()=>{const facts=await control('/facts');assert.deepStrictEqual(facts.prompts,['probe','A950_HOLD_FIFO','A950_SECOND','A950_THIRD']);assert.strictEqual((await snapshot()).draft.text,'A950_PRIVATE_unsent');assert.strictEqual(await evaluate(()=>document.getElementById('task-prompt').value),'A950_PRIVATE_unsent');return facts;});
   await submit('A950_HOLD_CANCEL');await queue('A950_CANCELLED_QUEUE');await input('A950_PRIVATE_after_stop');await until(async()=>(await snapshot()).draft.text==='A950_PRIVATE_after_stop','draft saved');await click('cancel-task');
   await until(async()=>(await snapshot()).agentStatus==='cancelled','cancelled');
   await check('stop_pauses_queue_without_losing_draft',async()=>{const s=await snapshot();assert(s.queue.paused);assert.strictEqual(s.queue.items.length,1);assert.strictEqual(s.draft.text,'A950_PRIVATE_after_stop');assert.strictEqual((await control('/facts')).count,5);await evaluate(()=>window.win7AgentA9Workbench.refreshSnapshot());return {paused:true,queued:1,requests:5};});
   await evaluate(()=>document.querySelector('#queue-items button').click());await until(async()=>(await snapshot()).queue.items.length===0,'remove');
   await submit('A950_HOLD_FAIL');await queue('A950_AFTER_FAIL');await control('/fail');await until(async()=>(await snapshot()).agentStatus==='failed','failure');
   await check('failure_requires_explicit_resume',async()=>{let s=await snapshot();assert(s.queue.paused&&s.queue.items.length===1);assert.strictEqual((await control('/facts')).count,6);await evaluate(()=>window.win7AgentA9Workbench.refreshSnapshot());await click('queue-toggle');await until(async()=>(await control('/facts')).count===7&&(await snapshot()).agentStatus==='completed','resumed');return {before:6,after:7};});
   await submit('A950_HOLD_RESTART');await queue('A950_AFTER_RESTART');await input('A950_PRIVATE_restart');
   await until(async()=>(await snapshot()).draft.text==='A950_PRIVATE_restart','restart draft saved');await click('cancel-task');
   await until(async()=>(await snapshot()).agentStatus==='cancelled','restart current cancelled');
   const pending=await snapshot();assert(pending.queue.paused&&pending.queue.items.length===1);
   assert.strictEqual((await control('/facts')).count,8);
  }else{
   await check('restart_never_replays_and_windows_dpapi_restores_paused_content',async()=>{
    const s=await snapshot();assert.strictEqual((await control('/facts')).count,8);
    if(process.platform==='win32'){
     assert.strictEqual(s.queue.persistence,'dpapi');assert(s.queue.paused);assert.strictEqual(s.queue.items.length,1);
     assert.strictEqual(s.queue.items[0].text,'A950_AFTER_RESTART');assert.strictEqual(s.draft.text,'A950_PRIVATE_restart');
     await evaluate(()=>window.win7AgentA9Workbench.refreshSnapshot());await click('queue-toggle');
     await until(async()=>(await control('/facts')).count===9&&(await snapshot()).agentStatus==='completed','explicit restored queue resume');
     assert.strictEqual((await snapshot()).draft.text,'A950_PRIVATE_restart');
    }else{assert.strictEqual(s.queue.items.length,0);assert.strictEqual(s.queue.persistence,'memory');assert.strictEqual(s.draft.text,'');}
    return {beforeExplicitResume:8,afterExplicitResume:(await control('/facts')).count,persistence:s.queue.persistence,dpapi:process.platform==='win32'?'PASS':'NOT_PERFORMED'};
   });
  }
  await evaluate(()=>window.win7AgentA9Workbench.refreshSnapshot());assert((await snapshot()).conversationControls.canSwitch);assert.strictEqual(report.errors.length,0);report.status='PASS';
  report.loadedModules=Object.keys(require.cache).filter(f=>f.startsWith(path.resolve(config.productRoot,'..')+path.sep)||f.startsWith(config.nativeRoot+path.sep)).map(f=>({path:f,sha256:hash(f)}));
 }catch(e){report.status='FAIL';report.error=String(e.stack||e);}
 finally{write(out,report);app.quit();process.exitCode=report.status==='PASS'?0:1;}
}
(arg('phase')?child():parent()).catch(e=>{console.error(e);process.exitCode=1;});
