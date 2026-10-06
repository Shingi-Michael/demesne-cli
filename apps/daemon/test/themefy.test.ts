import {afterEach,expect,test} from "bun:test";
import {mkdtempSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {DemesneClient} from "../../../packages/client/src/index.ts";
import {createDaemonApp,type DaemonApp} from "../src/app.ts";
import type {TurnProcessor} from "../src/processor.ts";
import type {QuestionState,SessionStateResponse} from "@demesne/protocol";
import {warmOlive} from "../../../packages/brand/test/theme-fixture.ts";
const roots:string[]=[],apps:DaemonApp[]=[];
afterEach(async()=>{for(const app of apps.splice(0))await app.close();for(const r of roots.splice(0))rmSync(r,{recursive:true,force:true});});
function fixture(processor:TurnProcessor){
  const root=mkdtempSync(join(tmpdir(),"demesne-themefy-test-"));roots.push(root);
  const start=()=>{const app=createDaemonApp({databasePath:join(root,"db.sqlite"),processor,agent:{maxModelRounds:8,maxToolCalls:8}});apps.push(app);
    const client=new DemesneClient({server:"http://fixture",fetch:((url,init)=>Promise.resolve(app.fetch(new Request(url,init)))) as typeof fetch});return{app,client};};
  return{...start(),start};
}
async function wait(client:DemesneClient,id:string,ready:(s:SessionStateResponse)=>boolean){for(let i=0;i<300;i++){const s=await client.getSessionState(id);if(ready(s))return s;await Bun.sleep(5);}throw new Error("Themefy did not settle");}
const answer=(q:QuestionState,text:string)=>({action:"answer" as const,index:q.answers.length,revision:q.revision,answer:{answer:text,source:"typed" as const}});
test("early application and invalid colors are corrected without changing the current palette",async()=>{
  let calls=0;const errors:string[]=[];
  const f=fixture({providerId:"fixture",modelId:"fixture",async listModels(){return[];},async *stream(messages){
    calls++;errors.push(...messages.filter(m=>m.role === "tool" && m.content?.startsWith("Error:")).map(m=>m.content!));
    const name=[1,4,5].includes(calls)?"apply_theme":"ask_user";
    const input=calls===4?{...warmOlive,colors:{...warmOlive.colors,background:"#EEEEEE"}}:name === "apply_theme"?warmOlive:{mode:"interview",questions:[{question:calls===2?"Mood?":"Accent?"}]};
    yield{type:"tool_call_delta",index:0,idDelta:"call-"+calls,nameDelta:name,argumentsDelta:JSON.stringify(input)};yield{type:"finish",reason:"tool_calls"};
  }});
  const {session}=await f.client.createSession({title:"Colors without a project"});await f.client.themefy(session.id);
  for(const text of ["warm dark","olive with gold"]){const s=await wait(f.client,session.id,s=>Boolean(s.pendingQuestions?.length));expect((await f.client.themes()).selected.name).toBe("demesne");await f.client.questionAction(s.pendingQuestions![0]!.id,answer(s.pendingQuestions![0]!,text));}
  const done=await wait(f.client,session.id,s=>s.session.turns.at(-1)?.status === "completed");
  expect(done.session.turns[0]!.kind).toBe("themefy");expect(errors.some(e=>e.includes("at least two"))).toBe(true);expect(errors.some(e=>e.includes("darker"))).toBe(true);
  expect(calls).toBe(5);expect((await f.client.themes()).selected.label).toBe(warmOlive.label);
});
test("daemon restart keeps the exact Themefy continuation and previous answers",async()=>{
  let calls=0;const offered:string[][]=[];
  const f=fixture({providerId:"fixture",modelId:"fixture",async listModels(){return[];},async *stream(messages,tools){
    offered.push(tools.map(t=>t.name));calls++;
    const resumed=messages.some(m=>m.role === "user" && m.content?.startsWith("Continue this interrupted request"));
    const name=resumed?"apply_theme":"ask_user",input=resumed?warmOlive:{mode:"interview",questions:[{question:calls===1?"Mood and appearance?":"Accent?"}]};
    if(resumed)expect(messages.some(m=>m.content?.includes("warm dark") && m.content?.includes("olive gold"))).toBe(true);
    yield{type:"tool_call_delta",index:0,idDelta:"call-"+calls,nameDelta:name,argumentsDelta:JSON.stringify(input)};yield{type:"finish",reason:"tool_calls"};
  }});
  const {session}=await f.client.createSession({title:"Recover theme interview"});await f.client.themefy(session.id);
  const first=(await wait(f.client,session.id,s=>Boolean(s.pendingQuestions?.length))).pendingQuestions![0]!;
  await f.client.questionAction(first.id,answer(first,"warm dark"));
  const second=(await wait(f.client,session.id,s=>Boolean(s.pendingQuestions?.length && s.pendingQuestions[0]!.id!==first.id))).pendingQuestions![0]!;
  await f.app.close();const reopened=f.start(),restored=(await reopened.client.getSessionState(session.id)).pendingQuestions![0]!;
  expect(restored.id).toBe(second.id);expect(restored.status).toBe("paused");expect(calls).toBe(2);
  await reopened.client.questionAction(restored.id,answer(restored,"olive gold"));
  const done=await wait(reopened.client,session.id,s=>s.session.turns.at(-1)?.status === "completed");
  expect(done.session.turns.at(-1)!.kind).toBe("themefy");expect((await reopened.client.themes()).selected.label).toBe(warmOlive.label);
  expect(offered).toEqual(Array.from({length:3},()=>["ask_user","apply_theme"]));
});
