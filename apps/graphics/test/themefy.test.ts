import {expect,test} from "bun:test";
import {GraphicsHost} from "../host.ts";
import {fixture,eventually} from "./fixture.ts";
import {warmOlive} from "../../../packages/brand/test/theme-fixture.ts";
import type {ProviderMessage} from "../../../packages/providers/src/index.ts";

test("Themefy interviews in the composer, applies live, saves, and undoes without entering coding history",async()=>{
  const seen:ProviderMessage[][]=[],offered:string[][]=[];
  const f=await fixture({providerId:"fixture",modelId:"fixture",async listModels(){return[];},async *stream(messages,tools){
    seen.push(structuredClone(messages));offered.push(tools.map(t=>t.name));
    if(!tools.some(t=>t.name === "apply_theme")){yield{type:"text_delta",delta:"Normal coding turn"};yield{type:"finish",reason:"stop"};return;}
    const results=messages.filter(m=>m.role === "tool");
    const name=results.length<2?"ask_user":"apply_theme",input=results.length<2?{mode:"interview",questions:[{question:results.length?"For that warm mood, which accent?":"What mood and appearance do you want?"}]}:warmOlive;
    yield{type:"tool_call_delta",index:0,idDelta:"call-"+seen.length,nameDelta:name,argumentsDelta:JSON.stringify(input)};yield{type:"finish",reason:"tool_calls"};
  }});
  const options={workspace:f.workspace,settings:f.settings,client:f.client,changed:()=>{}};
  let host=new GraphicsHost(options);
  try {
    await host.connect();await host.submit("A prior coding request");await eventually(()=>host.current!.runs().at(-1)?.status === "completed");
    const before=host.snapshot().palette;
    await host.handle("themefy",{sessionId:host.current!.session.id});
    for(const response of ["warm dark colours","muted olive and soft gold"]){
      await eventually(()=>host.current!.questions.size===1);const q=host.snapshot().questions[0]!;
      expect(q.mode).toBe("interview");expect(host.snapshot().palette).toEqual(before);
      await host.handle("question-action",{sessionId:host.current!.session.id,id:q.id,action:{action:"answer",index:0,revision:q.revision,answer:{answer:response,source:"typed"}}});
      await eventually(()=>!host.current!.questions.has(q.id));
    }
    await eventually(()=>host.current!.runs().at(-1)?.status === "completed" && host.snapshot().theme.startsWith("custom-"));
    const selected=host.snapshot().theme;expect(host.snapshot().palette.ink).toBe(warmOlive.colors.background);expect(host.snapshot().themeCanUndo).toBe(true);
    expect(seen[1]!.some(m=>m.content?.includes("A prior coding request"))).toBe(false);
    expect(offered.slice(1)).toEqual(Array.from({length:3},()=>["ask_user","apply_theme"]));
    expect(seen[3]!.some(m=>m.role === "tool" && m.content?.includes("muted olive"))).toBe(true);
    await host.handle("theme-undo",{sessionId:host.current!.session.id});expect(host.snapshot().theme).toBe("demesne");expect(host.snapshot().themes).toContain(selected);
    await host.handle("theme",{sessionId:host.current!.session.id,name:selected});host.dispose();host=new GraphicsHost(options);await host.connect();expect(host.snapshot().theme).toBe(selected);
    await host.submit("Next coding request");await eventually(()=>host.current!.runs().at(-1)?.status === "completed");
    expect(seen.at(-1)!.some(m=>m.content?.includes("muted olive"))).toBe(false);
  }finally{host.dispose();await f.close();}
});

test("cancelled Themefy leaves palette untouched; unoffered execution tools are denied",async()=>{
  let round=0;
  const f=await fixture({providerId:"fixture",modelId:"fixture",async listModels(){return[];},async *stream(){
    const name=++round===1?"write_file":"ask_user",input=name === "write_file"?{path:"README.md",content:"Wrong"}:{mode:"interview",questions:[{question:"Which mood?"}]};
    yield{type:"tool_call_delta",index:0,idDelta:"call-"+round,nameDelta:name,argumentsDelta:JSON.stringify(input)};yield{type:"finish",reason:"tool_calls"};
  }});
  const host=new GraphicsHost({workspace:f.workspace,settings:f.settings,client:f.client,changed:()=>{}});
  try{
    await host.connect();await host.handle("themefy",{sessionId:host.current!.session.id});await eventually(()=>host.current!.questions.size===1);
    const q=host.snapshot().questions[0]!;await host.handle("question-action",{sessionId:host.current!.session.id,id:q.id,action:{action:"cancel",revision:q.revision}});
    expect(host.snapshot().theme).toBe("demesne");expect(await Bun.file(f.workspace+"/README.md").text()).toBe("# Isolated UI fixture\n");expect(round).toBe(2);
  }finally{host.dispose();await f.close();}
});
