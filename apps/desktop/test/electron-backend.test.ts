import { expect, test } from "bun:test";
import { Backend } from "../electron/backend.ts";
function backend(script: string, native = async (_method: string, _args: Record<string, unknown>) => {}) {
  return new Backend({ executable: process.execPath, args: ["-e", script], env: process.env, emit() {}, native, log() {} });
}
test("Electron host bridge correlates responses and native actions over private pipes", async () => {
  let copied = "";
  const bridge = backend(`let input='';process.stdin.on('data', chunk=>{input+=chunk;let i;while((i=input.indexOf('\\n'))>=0){const m=JSON.parse(input.slice(0,i));input=input.slice(i+1);if(m.kind==='request'){process.stdout.write(JSON.stringify({kind:'native',id:m.id,method:'copy',args:{text:m.args.text}})+'\\n');}else{process.stdout.write(JSON.stringify({kind:'response',id:m.id,ok:true,value:m.ok})+'\\n');}}});process.stdin.on('end',()=>process.exit(0));`, async (_method, args) => { copied = String(args.text); });
  try { expect(await bridge.request("copy", { text: "hello" })).toBe(true); expect(copied).toBe("hello"); }
  finally { await bridge.close(); }
});
test("host failure rejects pending requests and EOF closes only the UI host", async () => {
  const bridge = backend("process.stdin.on('data',()=>process.exit(7));");
  try { await expect(bridge.request("desktop-bootstrap")).rejects.toThrow("exited"); }
  finally { await bridge.close(); }
  const graceful = backend("process.stdin.on('data',()=>{});process.stdin.on('end',()=>process.exit(0));");
  const pending = graceful.request("desktop-bootstrap").catch(error => String(error));
  await graceful.close();
  expect(await pending).toContain("exited");
});
