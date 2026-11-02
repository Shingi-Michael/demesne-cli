// Native desktop navigation with model discovery deliberately held open.
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fixture, eventually } from '../apps/desktop/workspace/test/fixture.ts';
import { ProviderTurnProcessor } from '../apps/daemon/src/provider-processor.ts';
const catalog=Promise.withResolvers<void>();
const f=await fixture(new ProviderTurnProcessor({id:'test',async listModels(){await catalog.promise;return [{id:'check',provider:'test',contextWindow:262144}];},
  async *stream({messages}){
    const at=messages.findLastIndex(m=>m.role==='user');
    const done=messages.slice(at+1).filter(m=>m.role==='tool').length;
    if(JSON.stringify(messages[at]?.content).includes('Edit') && done<2){
      const name=done?'edit_file':'read_file',args=done?{path:'large.txt',oldText:'header\n',newText:'header\n\n'}:{path:'large.txt',offset:1,limit:200};
      yield {type:'tool_call_delta',index:0,idDelta:'step-'+messages.length,nameDelta:name,argumentsDelta:JSON.stringify(args)};
      yield {type:'finish',reason:'tool_calls'};return;
    }
    yield {type:'text_delta',delta:'Ready'};yield {type:'finish',reason:'stop'};
  }
},'check',{},undefined,262144));
let app:Awaited<ReturnType<typeof electron.launch>>|undefined;
try {
  writeFileSync(join(f.workspace,'large.txt'),'header\n'+'unchanged line\n'.repeat(65000));
  const other=join(f.root,'other-project');mkdirSync(other);
  const a=(await f.client.createSession({workspacePath:f.workspace})).session.id;
  const b=(await f.client.createSession({workspacePath:other,trustWorkspace:true})).session.id;
  for(let i=0;i<10;i++){
    await f.client.submitTurn(a,{content:'Edit the header',permissionMode:'allow'});
    await eventually(async()=> (await f.client.getSessionState(a)).session.turns.at(-1)?.status==='completed',10000).catch(async error=>{console.error('Fixture turn did not complete',JSON.stringify(await f.client.getSessionState(a)));throw error;});
  }
  await f.client.submitTurn(b,{content:'Small chat'});
  await eventually(async()=> (await f.client.getSessionState(b)).session.turns.at(-1)?.status==='completed');
  const executable=process.argv[2];
  app=await electron.launch({...(executable?{executablePath:resolve(executable)}:{}),args:[...(executable?[]:[resolve('apps/desktop/build/app')]),`--user-data-dir=${join(f.root,'electron')}`,`--workspace=${f.workspace}`,`--server=${f.server.url}`],env:{...f.env,DEMESNE_BUN:process.execPath,XDG_CONFIG_HOME:join(f.home,'.config'),XDG_CACHE_HOME:join(f.home,'.cache')},timeout:30000});
  const page=await app.firstWindow();
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await page.locator('.bar-tab.on').waitFor({timeout:30000});
  const open=async(id:string,path?:string)=>{
    const start=performance.now();
    if(path) await page.evaluate(({path,id})=>document.dispatchEvent(new CustomEvent('demesne:open-project',{detail:{path,sessionId:id}})),{path,id});
    else await page.evaluate(id=>(window as any).demesneDesktop.core.invoke('desktop_request',{method:'select-session',args:{id}}),id);
    await page.locator(`.bar-tab.on[data-tab="${id}"]`).waitFor({timeout:3000});
    await page.locator('#conversation').getByText('Ready',{exact:true}).first().waitFor();
    const ms=Math.round(performance.now()-start);assert(ms<2000,`Chat opening took ${ms}ms`);console.log(`${path?'Cross-project':'Same-project'} chat visible in ${ms} ms with catalog still blocked.`);
  };
  await open(a);
  assert.equal(await page.locator('.file-edit').count(),0,'historical file contents remain deferred');
  await open(b,other);await open(a,f.workspace);
  const snapshot=await page.evaluate(()=>(window as any).demesneDesktop.core.invoke('desktop_request',{method:'bootstrap',args:{}}));
  assert(Buffer.byteLength(JSON.stringify(snapshot.runs))<100000,'large historical file contents do not cross IPC');
  const edits = snapshot.runs.flatMap((run:any)=>run.entries.filter((entry:any)=>entry.type==='tool' && entry.name==='edit_file' && entry.state==='done' && entry.changes?.length).map((tool:any)=>({turnId:run.id,tool})));
  if(edits.length!==10) console.log('Fixture tools',snapshot.runs.map((run:any)=>run.entries.filter((entry:any)=>entry.type==='tool').map((entry:any)=>({name:entry.name,state:entry.state,message:entry.message}))));
  assert.equal(edits.length,10,'fixture really recorded ten successful file edits');
  assert(edits.every(({tool}:any)=>tool.deferredChanges && tool.changes.every((change:any)=>change.before===null && change.after===null)));
  const recorded = await page.evaluate(({sessionId,turnId,toolCallId})=>(window as any).demesneDesktop.core.invoke('desktop_request',{method:'file-edit-details',args:{sessionId,turnId,toolCallId}}),{sessionId:a,turnId:edits[0].turnId,toolCallId:edits[0].tool.toolCallId});
  assert(recorded[0].before.length>900000 && recorded[0].after.length>900000,'exact large file versions are available on demand');
  assert.equal(recorded[0].after,'header\n\n'+'unchanged line\n'.repeat(65000));
  catalog.resolve();
  assert.deepEqual(errors,[]);
  console.log('Native navigation passed: ten large recorded edits, stalled catalog, project round trip and bounded snapshots.');
} finally {catalog.resolve();await app?.close();await f.close();}
