import { expect,test } from "bun:test";
import { GraphicsHost } from "../host.ts";
import { fixture,eventually } from "./fixture.ts";

test("question replies keep the coding draft out of the queue and survive a new UI host",async()=>{
  let calls=0;
  const f=await fixture({providerId:"test",modelId:"test",async listModels(){return[];},async *stream(){
    if(++calls===1){yield{type:"tool_call_delta",index:0,idDelta:"ask",nameDelta:"ask_user",argumentsDelta:JSON.stringify({mode:"interview",questions:[{question:"What mood do you want?"}]})};yield{type:"finish",reason:"tool_calls"};}
    else {yield{type:"text_delta",delta:"Recorded the typed preference."};yield{type:"finish",reason:"stop"};}
  }});
  const options={workspace:f.workspace,settings:f.settings,client:f.client,changed:()=>{}};
  let host=new GraphicsHost(options);
  try {
    await host.connect();await host.submit("Interview me");
    await eventually(()=>host.current!.questions.size===1);
    const sessionId=host.current!.session.id,q=host.snapshot().questions[0]!;
    host.draft="A separate coding request";
    const action={action:"draft" as const,index:0,revision:q.revision!,text:"warm olive",draftVersion:1};
    await host.handle("question-action",{sessionId,id:q.id,action});
    expect(host.draft).toBe("A separate coding request");expect(host.queue).toBe("");expect(calls).toBe(1);
    await expect(host.handle("question-action",{sessionId,id:q.id,action,driveCommand:"fake-drive"})).rejects.toThrow("Only the user");
    host.dispose();host=new GraphicsHost({...options,sessionId});await host.connect();
    expect(host.snapshot().questions[0]!.draft).toBe("warm olive");
    const restored=host.snapshot().questions[0]!;
    await host.handle("question-action",{sessionId,id:restored.id,action:{action:"answer",index:0,revision:restored.revision,answer:{answer:"warm olive",source:"typed"}}});
    await eventually(()=>host.current!.runs().at(-1)?.status==="completed");
    expect(host.snapshot().questions).toEqual([]);expect(calls).toBe(2);expect(host.queue).toBe("");
    await expect(host.handle("question-action",{sessionId:"wrong-session",id:restored.id,action})).rejects.toThrow("session changed");
  } finally {host.dispose();await f.close();}
});

test.each([1,2])("late draft replies cannot revive a closed question or roll back %i-question progress",async(count)=>{
  let calls=0;
  const f=await fixture({providerId:"test",modelId:"test",async listModels(){return[];},async *stream(){
    if(++calls===1){yield{type:"tool_call_delta",index:0,idDelta:"ask",nameDelta:"ask_user",argumentsDelta:JSON.stringify({questions:Array.from({length:count},(_,i)=>({question:`Preference ${i+1}?`}))})};yield{type:"finish",reason:"tool_calls"};}
    else {yield{type:"text_delta",delta:"Done."};yield{type:"finish",reason:"stop"};}
  }});
  const gate=Promise.withResolvers<void>(),saved=Promise.withResolvers<void>();
  const original=f.client.questionAction.bind(f.client);
  f.client.questionAction=async(id,action)=>{const result=await original(id,action);if(action.action==="draft"){saved.resolve();await gate.promise;}return result;};
  const host=new GraphicsHost({workspace:f.workspace,settings:f.settings,client:f.client,changed:()=>{}});
  try{
    await host.connect();await host.submit("Ask for preferences");await eventually(()=>host.current!.questions.size===1);
    const sessionId=host.current!.session.id,q=host.snapshot().questions[0]!;
    const delayed=host.handle("question-action",{sessionId,id:q.id,action:{action:"draft",index:0,revision:q.revision,text:"old draft",draftVersion:1}});
    await saved.promise;
    await host.handle("question-action",{sessionId,id:q.id,action:{action:"answer",index:0,revision:q.revision,answer:{answer:"warm",source:"typed"}}});
    await eventually(()=>count===1?host.current!.questions.size===0:host.snapshot().questions[0]?.answers?.length===1);
    gate.resolve();await delayed;
    if(count===1)expect(host.snapshot().questions).toEqual([]);
    else{
      const next=host.snapshot().questions[0]!;expect(next.answers).toEqual([{answer:"warm",source:"typed"}]);expect(next.draft).toBe("");
      await host.handle("question-action",{sessionId,id:q.id,action:{action:"cancel",revision:next.revision}});
    }
  }finally{gate.resolve();host.dispose();await f.close();}
});
