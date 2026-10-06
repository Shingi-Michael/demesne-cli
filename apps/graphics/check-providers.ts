/** Settings › Providers through the same pixel transport used by Ghostty:
 * the overlay lists providers with their sign-in state and stays open. */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fixture, eventually } from "./test/fixture.ts";
import { TerminalHarness } from "./test/terminal-harness.ts";
const output = resolve(process.argv[2] ?? "/tmp/demesne-providers-check");
mkdirSync(output, { recursive: true });
const f = await fixture();
const app = new TerminalHarness({ env: f.env, entry: resolve(import.meta.dir, "terminal.ts"), args: ["--live", `--server=${f.server.url}`, `--workspace=${f.workspace}`, `--capture-dir=${output}`] });
let state: any;
async function wait(check: (s: any) => boolean, label: string) { try { await eventually(() => { try { state = JSON.parse(readFileSync(join(output, "state.json"), "utf8")); return check(state); } catch { return false; } }, 15000); } catch { throw new Error(`${label} did not settle: ${String(state?.live?.text).slice(-1200)}`); } }
try {
  await app.after(0);
  await wait(s => s.live?.connection === "online" && s.live?.sessionId, "online");
  await Bun.sleep(300);
  app.paste("/providers"); await Bun.sleep(80); app.write("\r");
  await wait(s => s.live.overlay === "providers" && s.live.text.includes("Not set up · ChatGPT plan sharing") && s.live.text.includes("Not set up · hosted models"), "providers overlay");
  for (const part of ["Providers", "ACCOUNTS", "Not set up · ChatGPT plan sharing", "Not set up · hosted models", "sign in ↗"]) assert(state.live.text.includes(part), `the overlay shows ${part}`);
  assert(!state.live.text.includes("Codex"), "the overlay has no removed runtime provider");
  await Bun.sleep(400);
  await app.png(join(output, "providers.png")); console.log("✓ providers");
  // The Settings row opens the same overlay.
  app.write("\x1b"); await wait(s => !s.live.overlay, "closed");
  app.write("\t"); await wait(s => s.live.overlay === "settings" && s.live.text.includes("Providers"), "settings row");
  app.write("\x11"); assert.equal(await app.child.exited, 0);
  console.log(JSON.stringify({ result: "passed", screenshots: output, checked: ["/providers lists providers and their state", "Settings has a Providers row"] }));
} finally { app.kill(); await f.close(); }
