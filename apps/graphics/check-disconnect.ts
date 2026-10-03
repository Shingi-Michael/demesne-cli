/** Native Electron regression: closing either pipe must never open a crash dialog. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";
import { fixture } from "./test/fixture.ts";
import { GraphicsHost } from "./host.ts";

const renderer = resolve(process.argv[2] ?? join(import.meta.dir, "renderer.cjs"));
const root = dirname(renderer);
const electron = process.argv[3] ?? join(dirname(Bun.resolveSync("electron", import.meta.dir)), "dist", process.platform === "darwin" ? "Electron.app/Contents/MacOS/Electron" : "electron");
if (existsSync(join(root,"live.ts"))) {
  const bundle=await Bun.build({entrypoints:[join(root,"live.ts")],outdir:join(root,"dist"),target:"browser"});
  assert(bundle.success,"UI bundle builds");
}
const f=await fixture(), host=new GraphicsHost({workspace:f.workspace,settings:f.settings,client:f.client,changed:()=>{}});
await host.connect(); const snapshot=host.snapshot();
try {
  for (const scenario of ["stdout-before-init", "stdin-before-init", "stdout-during-frame", "stdin-during-frame", "quit", "sigterm", "snapshot"] as const) {
    const cache=mkdtempSync(join(tmpdir(),"demesne-disconnect-")), crash=join(cache,"uncaught.txt"), wrapper=join(cache,"entry.cjs");
    // Turn any uncaught error into a test failure instead of showing a modal.
    writeFileSync(wrapper, `const { app }=require("electron");process.on('uncaughtException',error=>{require('node:fs').writeFileSync(${JSON.stringify(crash)},String(error.stack));app.exit(91);});require(${JSON.stringify(renderer)});process.stderr.write("PIPE_FIXTURE_READY\\n");`);
    const child=spawn(electron,[wrapper],{stdio:["pipe","pipe","pipe"],env:{...f.env,ELECTRON_RUN_AS_NODE:undefined,DEMESNE_PIXEL_CACHE:cache}});
    child.stdin.on("error",()=>{}); let stderr="", interrupted=false, frames=0, snapshotReceived=false, exitSignal: string | null=null;
    const boot=Promise.withResolvers<void>();
    child.stderr.on("data",data=>{stderr+=data;if(stderr.includes("PIPE_FIXTURE_READY"))boot.resolve();});
    const exited=new Promise<number|null>((resolve,reject)=>{child.once("exit",(code,signal)=>{exitSignal=signal;resolve(code);});child.once("error",reject);});
    const timer=setTimeout(()=>child.kill("SIGKILL"),10000);
    const send=(value:unknown)=>{if(!child.stdin.destroyed)child.stdin.write(JSON.stringify(value)+"\n");};
    const lines=createInterface({input:child.stdout});
    lines.on("line",line=>{
      const message=JSON.parse(line);
      if(message.kind==="snapshot") snapshotReceived=true;
      if(message.kind==="request")send({kind:"response",id:message.id,ok:true,value:message.method==="bootstrap"?snapshot:null});
      if(message.kind==="tiles"){
        frames++;
        if(!interrupted){
          interrupted=true;
          if(scenario==="stdout-during-frame"){
            // Keep stdin open: force the next asynchronous frame write to see EPIPE.
            child.stdout.destroy();
            send({kind:"ack",serial:message.serial});
            send({kind:"resize",width:816,height:612,cell:{width:8,height:18},epoch:1,scale:1});
          }else if(scenario==="stdin-during-frame")child.stdin.end();
          else if(scenario==="quit")send({kind:"quit"});
          else if(scenario==="sigterm")child.kill("SIGTERM");
        }
      }
    });
    try {
      await Promise.race([boot.promise,exited.then(code=>{throw new Error(`Electron exited before the fixture loaded (${code}): ${stderr}`);})]);
      if(scenario==="stdout-before-init"){child.stdout.destroy();child.stdin.write("invalid-json\n");}
      else if(scenario==="stdin-before-init")child.stdin.end();
      else send({kind:"init",live:true,width:800,height:612,cell:{width:8,height:18},theme:snapshot.palette,epoch:0,scale:1,...(scenario==="snapshot"?{snapshot:join(cache,"snapshot.png")}:{})});
      const code=await exited;
      assert(!existsSync(crash),`${scenario}: ${existsSync(crash)?readFileSync(crash,"utf8"):""}`);
      assert.equal(code,0,`${scenario}: renderer did not exit cleanly (${exitSignal}): ${stderr.slice(-1500)}`);
      assert(!/UnhandledPromiseRejection|Uncaught Exception|Error: write EPIPE/.test(stderr),`${scenario}: ${stderr}`);
      if(scenario==="snapshot") assert(snapshotReceived,"Snapshot notification is flushed before exit");
      else if(!scenario.endsWith("before-init"))assert(frames>0,"A real encoded frame was transmitted before disconnect");
      console.log(`✓ ${scenario}`);
    }finally{clearTimeout(timer);lines.close();if(child.exitCode===null&&child.signalCode===null)child.kill("SIGKILL");await exited;rmSync(cache,{recursive:true,force:true});}
  }
}finally{host.dispose();await f.close();}
