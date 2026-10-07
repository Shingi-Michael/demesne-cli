/** Verify shipped native codecs and daemon boot without touching a user's service. */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
const daemon = resolve(process.argv[2] ?? "apps/desktop/src-tauri/target/debug/demesned");
// `--beside` checks a CLI install: no runtime override, so the daemon must find
// node_modules next to its real path, even when launched through a symlink.
const beside = process.argv[3] === "--beside";
const runtime = beside ? dirname(realpathSync(daemon)) : resolve(process.argv[3] ?? join(dirname(daemon), "runtime"));
assert(existsSync(daemon)); assert(existsSync(join(runtime, "node_modules/sharp/dist/index.cjs")));
const directory = mkdtempSync(join(tmpdir(), "demesne-desktop-backend-"));
const config = join(directory, "config.toml");
writeFileSync(config, '[daemon]\nauto_start="never"\n', { mode: 0o600 });
const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("reserved") });
const port = reservation.port; await reservation.stop(true);
const child = Bun.spawn([daemon], { env: {
  PATH: process.env.PATH, HOME: directory, DEMESNE_CONFIG_FILE: config, DEMESNE_DATA_DIR: join(directory,"data"),
  ...(beside ? {} : { DEMESNE_NATIVE_RUNTIME_DIR: runtime }), DEMESNE_HOST: "127.0.0.1", DEMESNE_PORT: String(port),
}, stdout:"pipe",stderr:"pipe" });
let output="";const readers=[child.stdout,child.stderr].map(async stream=>{for await(const bytes of stream)output=(output+new TextDecoder().decode(bytes)).slice(-8000)});
try {
  const deadline=Date.now()+10000;let healthy=false;
  while(Date.now()<deadline && child.exitCode===null){try{const r=await fetch(`http://127.0.0.1:${port}/healthz`);if(r.ok){healthy=true;break}}catch{}await Bun.sleep(50)}
  assert(healthy,`Packaged daemon did not start: ${output}`);
  const token=readFileSync(join(directory,"data/daemon.token"),"utf8").trim();
  const status=await fetch(`http://127.0.0.1:${port}/v1/status`,{headers:{authorization:`Bearer ${token}`}});assert.equal(status.status,200);
  console.log(`Packaged ${beside ? "CLI" : "desktop"} daemon and relocated native image runtime verified.`);
}finally{child.kill("SIGTERM");await child.exited;await Promise.allSettled(readers);rmSync(directory,{recursive:true,force:true})}
