/** Exercise streaming sub-agent cards and terminal shutdown without a real model. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { TerminalHarness } from "./test/terminal-harness.ts";
import { fixture, eventually } from "./test/fixture.ts";
const f = await fixture({ providerId: "test", modelId: "test", contextCapacity: 32768,
  async listModels() { return []; },
  async *stream(messages, tools) {
    if (tools.some(tool => tool.name === "propose_next")) {
      yield { type: "tool_call_delta", index: 0, idDelta: "next", nameDelta: "propose_next", argumentsDelta: '{"proposals":[]}' };
      yield { type: "finish", reason: "tool_calls" }; return;
    }
    const results = messages.filter(message => message.role === "tool");
    if (messages[0]?.content?.startsWith("You are a Demesne sub-agent")) {
      for (let i = 0; i < 15; i++) { await Bun.sleep(20); yield { type: "reasoning_delta", delta: `- Inspecting architecture point ${i}\n` }; }
      if (results.length < 3) { yield { type: "tool_call_delta", index: 0, idDelta: `read-${results.length}`, nameDelta: "read_file", argumentsDelta: '{"path":"README.md"}' }; yield { type: "finish", reason: "tool_calls" }; return; }
      yield { type: "text_delta", delta: "Investigation complete." }; yield { type: "finish", reason: "stop" }; return;
    }
    if (!results.length) {
      for (const [index, name] of ["Inspect architecture", "Inspect interactions", "Inspect tests"].entries())
        yield { type: "tool_call_delta", index, idDelta: `sub-${index}`, nameDelta: "subagent", argumentsDelta: JSON.stringify({ description: name, prompt: name }) };
      yield { type: "finish", reason: "tool_calls" }; return;
    }
    yield { type: "text_delta", delta: "All three investigations completed." }; yield { type: "finish", reason: "stop" };
  },
});
const directory=mkdtempSync(join(tmpdir(),"demesne-stream-shutdown-")),layout=join(directory,"layout.json");
const app=new TerminalHarness({entry:resolve(import.meta.dir,"terminal.ts"),env:f.env,args:["--live",`--server=${f.server.url}`,`--workspace=${f.workspace}`,`--layout=${layout}`]});
try {
  await app.after(0); await eventually(()=>Bun.file(layout).exists());
  await eventually(async()=>Boolean((await f.client.listSessions())[0]));
  const session=(await f.client.listSessions())[0]!;
  const box=JSON.parse(readFileSync(layout,"utf8"));app.click(Math.round(box.x+8),Math.round(box.y+10));
  app.paste("Run three independent sub-agent investigations.");app.write("\r");
  await eventually(async()=> (await f.client.getSessionState(session.id)).session.turns.at(-1)?.status==="completed",20000);
  assert.equal(app.child.exitCode,null,"Host remains alive while all sub-agent cards stream");
  app.write("\x11");
  const code=await Promise.race([app.child.exited,Bun.sleep(4000).then(()=>"timeout")]);
  assert.equal(code,0,app.error);assert(app.restored,"Terminal mode is restored");
  assert(!/EPIPE|Uncaught Exception|UnhandledPromiseRejection/.test(app.error),app.error);
  console.log("✓ three streaming sub-agent cards completed; host quit cleanly and restored the terminal");
}finally{app.kill();await f.close();rmSync(directory,{recursive:true,force:true});}
