import { afterEach, expect, test } from "bun:test";
import { mkdtempSync,mkdirSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DemesneClient } from "../../../packages/client/src/index.ts";
import type { ProviderMessage } from "@demesne/providers";
import type { QuestionState } from "@demesne/protocol";
import { DemesneStore } from "@demesne/storage";
import { createDaemonApp,type DaemonApp } from "../src/app.ts";
import type { TurnProcessor } from "../src/processor.ts";

const roots:string[]=[], apps:DaemonApp[]=[];
afterEach(async()=>{for(const app of apps.splice(0))await app.close();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
async function until<T>(read:()=>Promise<T>,ready:(value:T)=>boolean):Promise<T>{
  for(let i=0;i<300;i++){const value=await read();if(ready(value))return value;await Bun.sleep(5);}throw new Error("Interview fixture did not settle");
}
function processor(batched=false) {
  const seen:ProviderMessage[][]=[], offered:string[][]=[];
  const provider:TurnProcessor={providerId:"fixture",modelId:"fixture",async listModels(){return[];},async *stream(messages,tools){
    seen.push(structuredClone(messages));
    offered.push(tools.map(tool=>tool.name));
    const content=messages.findLast(m=>m.role==="user")?.content ?? "";
    const results=messages.filter(m=>m.role==="tool");
    if(content.startsWith("Continue this interrupted request")){yield{type:"text_delta",delta:"Resumed from the typed preference: "+content};yield{type:"finish",reason:"stop"};return;}
    if(results.length >= (batched?1:2)){yield{type:"text_delta",delta:"Preferences recorded: "+results.map(m=>m.content).join("\n")};yield{type:"finish",reason:"stop"};return;}
    const questions=batched?[{question:"Dark or light?"},{question:"Which accent?"}]:[{question:results.length?"You chose warm. Which accent fits that mood?":"What mood do you want?"}];
    yield{type:"tool_call_delta",index:0,idDelta:"ask-"+seen.length,nameDelta:"ask_user",argumentsDelta:JSON.stringify({mode:batched?"clarification":"interview",questions})};
    yield{type:"finish",reason:"tool_calls"};
  }};return{provider,seen,offered};
}
function fixture(options:{timeout?:number;batched?:boolean}={}) {
  const root=mkdtempSync(join(tmpdir(),"demesne-interview-"));roots.push(root);
  const workspace=join(root,"workspace"),data=join(root,"data");mkdirSync(workspace);mkdirSync(data);
  const p=processor(options.batched),databasePath=join(data,"db.sqlite");
  const start=()=>{const app=createDaemonApp({databasePath,processor:p.provider,questionTimeoutMs:options.timeout,allowlistPath:join(data,"config.toml"),agent:{maxModelRounds:5,maxToolCalls:5}});apps.push(app);
    const client=new DemesneClient({server:"http://fixture",fetch:((url,init)=>Promise.resolve(app.fetch(new Request(url,init)))) as typeof fetch});return{app,client};};
  return{...start(),start,workspace,databasePath,...p};
}
async function first(f:ReturnType<typeof fixture>) {
  const {session}=await f.client.createSession({workspacePath:f.workspace,trustWorkspace:true,title:"Interview"});
  const {turn}=await f.client.submitTurn(session.id,{content:"Interview me about colours one question at a time",permissionMode:"ask"});
  const state=await until(()=>f.client.getSessionState(session.id),s=>Boolean(s.pendingQuestions?.length));
  return{session,turn,q:state.pendingQuestions![0]!};
}
const answer=(q:QuestionState,text:string)=>({action:"answer" as const,index:q.answers.length,revision:q.revision,answer:{answer:text,source:"typed" as const}});

test("adaptive questions consume typed answers in the same turn and retain refinements",async()=>{
  const f=fixture(),{session,turn,q}=await first(f);
  expect(q.mode).toBe("interview");expect(f.seen).toHaveLength(1);
  await f.client.questionAction(q.id,answer(q,"warm and cosy"));
  const next=await until(()=>f.client.getSessionState(session.id),s=>Boolean(s.pendingQuestions?.[0]?.id!==q.id && s.pendingQuestions?.length));
  const followup=next.pendingQuestions![0]!;
  expect(followup.questions[0]!.question).toContain("warm");
  expect(f.seen[1]!.some(m=>m.role==="tool" && m.content?.includes("warm and cosy"))).toBe(true);
  await f.client.questionAction(followup.id,answer(followup,"Actually make it muted olive, with soft gold"));
  const done=await until(()=>f.client.getSessionState(session.id),s=>s.session.turns[0]?.status==="completed");
  expect(done.session.turns).toHaveLength(1);expect(done.session.turns[0]!.id).toBe(turn.id);
  expect(done.session.turns[0]!.responseText).toContain("muted olive");expect(done.pendingQuestions).toEqual([]);
  await expect(f.client.questionAction(q.id,answer(q,"late answer"))).rejects.toThrow("already closed");
});

test("timeout pauses without a model continuation; drafts persist and stale actions fail",async()=>{
  const f=fixture({timeout:1000}),{session,q}=await first(f);
  expect(q.status).toBe("waiting");
  await f.client.questionAction(q.id,{action:"draft",index:0,revision:q.revision,text:"warm charcoal",draftVersion:2});
  await f.client.questionAction(q.id,{action:"draft",index:0,revision:q.revision,text:"older draft",draftVersion:1});
  const paused=await until(()=>f.client.getSessionState(session.id),s=>s.pendingQuestions?.[0]?.status==="paused");
  const saved=paused.pendingQuestions![0]!;expect(saved.draft).toBe("warm charcoal");expect(f.seen).toHaveLength(1);
  expect((await f.client.status()).activeInferences).toBe(0);
  await expect(f.client.questionAction(q.id,answer(q,"outdated binding"))).rejects.toThrow("question changed");
  await f.client.questionAction(saved.id,answer(saved,"warm charcoal"));
  expect((await until(()=>f.client.getSessionState(session.id),s=>s.pendingQuestions?.[0]?.id!==saved.id && Boolean(s.pendingQuestions?.length))).pendingQuestions![0]!.mode).toBe("interview");
});

test("batch answers are collected sequentially without another model call or stale index reuse",async()=>{
  const f=fixture({batched:true}),{session,q}=await first(f);
  const partial=await f.client.questionAction(q.id,answer(q,"dark"));
  expect(partial.question.answers).toEqual([{answer:"dark",source:"typed"}]);expect(f.seen).toHaveLength(1);
  await expect(f.client.questionAction(q.id,{...answer(partial.question,"bad"),index:0})).rejects.toThrow("earlier question");
  await f.client.questionAction(q.id,answer(partial.question,"olive"));
  const done=await until(()=>f.client.getSessionState(session.id),s=>s.session.turns[0]?.status==="completed");
  expect(done.session.turns[0]!.responseText).toContain("olive");expect(f.seen).toHaveLength(2);
});

test("explicit cancellation closes the question and turn without guessing or continuing",async()=>{
  const f=fixture(),{session,turn,q}=await first(f);
  await f.client.questionAction(q.id,{action:"cancel",revision:q.revision});
  const state=await f.client.getSessionState(session.id);
  expect(state.pendingQuestions).toEqual([]);expect(state.session.turns.find(t=>t.id===turn.id)?.status).toBe("cancelled");
  expect(f.seen).toHaveLength(1);
  await expect(f.client.questionAction(q.id,answer(q,"late"))).rejects.toThrow("already closed");
});

test("daemon restart retains a paused draft and resumes only after explicit typed input",async()=>{
  const f=fixture(),{session,q}=await first(f);
  await f.client.questionAction(q.id,{action:"draft",index:0,revision:q.revision,text:"forest green",draftVersion:1});
  await f.app.close();const reopened=f.start();
  const restored=await reopened.client.getSessionState(session.id),pending=restored.pendingQuestions![0]!;
  expect(pending.id).toBe(q.id);expect(pending.status).toBe("paused");expect(pending.interrupted).toBe(true);expect(pending.draft).toBe("forest green");
  expect(f.seen).toHaveLength(1);
  const resumed=await reopened.client.questionAction(pending.id,answer(pending,"forest green with gold"));
  expect(resumed.turnId).toBeString();
  const done=await until(()=>reopened.client.getSessionState(session.id),s=>s.session.turns.at(-1)?.status==="completed");
  expect(done.session.turns.at(-1)!.responseText).toContain("forest green with gold");expect(done.pendingQuestions).toEqual([]);
});

test("saved complete answers remain resumable if shutdown interrupted their tool-result commit",async()=>{
  const f=fixture();await f.app.close();
  const store=new DemesneStore(f.databasePath);
  const {session}=store.createSession("Interrupted answer",f.workspace);
  const {turn}=store.createTurn(session.id,"Interview about colours","ask");store.startTurn(turn.id);
  const {providerCallId}=store.startProviderCall(turn.id,"fixture","fixture");
  const {toolCallId}=store.recordToolCall(turn.id,providerCallId,"orphaned-ask","ask_user",'{}');store.startToolCall(toolCallId);
  const {questionId}=store.requestQuestions(toolCallId,[{question:"Which accent?",suggestions:[]}],"interview");
  store.resolveQuestions(questionId,toolCallId,[{answer:"muted gold",source:"typed"}]);store.close();
  const reopened=f.start(),state=await reopened.client.getSessionState(session.id),q=state.pendingQuestions![0]!;
  expect(q.status).toBe("paused");expect(q.answers).toEqual([{answer:"muted gold",source:"typed"}]);expect(f.seen).toHaveLength(0);
  await expect(reopened.client.questionAction(q.id,answer(q,"duplicate"))).rejects.toThrow("already saved");
  const resumed=await reopened.client.questionAction(q.id,{action:"resume",revision:q.revision});expect(resumed.turnId).toBeString();
  const done=await until(()=>reopened.client.getSessionState(session.id),s=>s.session.turns.at(-1)?.status==="completed");
  expect(done.session.turns.at(-1)!.responseText).toContain("muted gold");expect(done.pendingQuestions).toEqual([]);
});

test("preference interviews need no project and expose no filesystem tools",async()=>{
  const f=fixture();const {session}=await f.client.createSession({title:"Global preferences"});
  await f.client.submitTurn(session.id,{content:"Interview about preferences",permissionMode:"ask"});
  const state=await until(()=>f.client.getSessionState(session.id),s=>Boolean(s.pendingQuestions?.length));
  expect(state.session.workspace).toBeNull();expect(state.pendingQuestions![0]!.mode).toBe("interview");
  expect(f.offered[0]).toEqual(["ask_user"]);
  await f.client.questionAction(state.pendingQuestions![0]!.id,{action:"cancel",revision:state.pendingQuestions![0]!.revision});
});

test("parallel interview requests cannot present a second question before the first answer",async()=>{
  const f=fixture();await f.app.close();const store=new DemesneStore(f.databasePath);
  try{
    const {session}=store.createSession("Single question",f.workspace),{turn}=store.createTurn(session.id,"Interview","ask");store.startTurn(turn.id);
    const {providerCallId}=store.startProviderCall(turn.id,"fixture","fixture");
    const first=store.recordToolCall(turn.id,providerCallId,"first","ask_user","{}"),second=store.recordToolCall(turn.id,providerCallId,"second","ask_user","{}");
    store.startToolCall(first.toolCallId);store.startToolCall(second.toolCallId);
    store.requestQuestions(first.toolCallId,[{question:"Mood?",suggestions:[]}],"interview");
    expect(()=>store.requestQuestions(second.toolCallId,[{question:"Accent?",suggestions:[]}],"interview")).toThrow("current interview question");
    expect(store.getSessionState(session.id)!.pendingQuestions).toHaveLength(1);
  }finally{store.close();}
});

test("all interrupted clarification answers are collected before one continuation starts",async()=>{
  const f=fixture();await f.app.close();const store=new DemesneStore(f.databasePath);
  const {session}=store.createSession("Pending choices",f.workspace),{turn}=store.createTurn(session.id,"Gather colour preferences","ask");store.startTurn(turn.id);
  const {providerCallId}=store.startProviderCall(turn.id,"fixture","fixture");
  for(const [index,question] of ["Mood?","Accent?"].entries()){
    const {toolCallId}=store.recordToolCall(turn.id,providerCallId,"q-"+index,"ask_user","{}");store.startToolCall(toolCallId);
    store.requestQuestions(toolCallId,[{question,suggestions:[]}]);
  }
  store.close();const reopened=f.start();
  const pending=(await reopened.client.getSessionState(session.id)).pendingQuestions!;
  expect(pending.map(q=>q.questions[0]!.question)).toEqual(["Mood?","Accent?"]);
  await reopened.client.questionAction(pending[0]!.id,answer(pending[0]!,"warm"));
  expect(f.seen).toHaveLength(0);
  await reopened.client.questionAction(pending[1]!.id,answer(pending[1]!,"olive"));
  const done=await until(()=>reopened.client.getSessionState(session.id),s=>s.session.turns.at(-1)?.status==="completed");
  expect(f.seen).toHaveLength(1);expect(done.session.turns.at(-1)!.responseText).toContain("warm");expect(done.session.turns.at(-1)!.responseText).toContain("olive");
});

test("an explicitly cancelled turn never restores an answered-but-uncommitted question",async()=>{
  const f=fixture();await f.app.close();const store=new DemesneStore(f.databasePath);
  const {session}=store.createSession("Cancelled",f.workspace),{turn}=store.createTurn(session.id,"Interview","ask");store.startTurn(turn.id);
  const {providerCallId}=store.startProviderCall(turn.id,"fixture","fixture"),{toolCallId}=store.recordToolCall(turn.id,providerCallId,"answer","ask_user","{}");
  store.startToolCall(toolCallId);const {questionId}=store.requestQuestions(toolCallId,[{question:"Mood?",suggestions:[]}],"interview");
  store.resolveQuestions(questionId,toolCallId,[{answer:"warm",source:"typed"}]);store.cancelTurn(turn.id);store.close();
  const reopened=f.start();expect((await reopened.client.getSessionState(session.id)).pendingQuestions).toEqual([]);expect(f.seen).toHaveLength(0);
});
