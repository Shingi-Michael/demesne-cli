/** Copy on select through the same pixel transport used by Ghostty: dragging
 * across text or double-clicking a word puts it on the clipboard. */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fixture, eventually } from "./test/fixture.ts";
import { TerminalHarness } from "./test/terminal-harness.ts";
const output = resolve(process.argv[2] ?? "/tmp/demesne-copy-check");
mkdirSync(output, { recursive: true });
const clipboard = () => Bun.spawnSync(["pbpaste"]).stdout.toString();
const saved = clipboard();
const f = await fixture({ providerId: "test", modelId: "copy-fixture", contextCapacity: 32768,
  async listModels() { return []; },
  async *stream() { yield { type: "text_delta", delta: "The answer is ready." }; yield { type: "finish", reason: "stop" }; },
});
const app = new TerminalHarness({ env: f.env, entry: resolve(import.meta.dir, "terminal.ts"), args: ["--live", `--server=${f.server.url}`, `--workspace=${f.workspace}`, `--capture-dir=${output}`] });
let state: any;
async function wait(check: (s: any) => boolean) { await eventually(() => { try { state = JSON.parse(readFileSync(join(output, "state.json"), "utf8")); return check(state); } catch { return false; } }, 15000); }
try {
  await app.after(0);
  await wait(s => s.live?.connection === "online" && s.live?.sessionId);
  await Bun.sleep(300);
  app.paste("copy these words please"); await Bun.sleep(80); app.write("\r");
  await wait(s => s.live.runs.at(-1)?.status === "completed" && s.live.requests?.length === 1);
  const request = state.live.requests[0];
  Bun.spawnSync(["pbcopy"], { stdin: new Response("") });
  // Drag from just left of the request text to just past its end.
  const y = request.y + request.height / 2;
  app.drag({ x: request.x + 1, y }, { x: request.x + request.width + 6, y });
  await eventually(() => clipboard() === "copy these words please", 5000);
  await wait(s => s.live.text.includes("Copied"));
  console.log("✓ drag copies the highlighted text");
  // A double click selects and copies one word.
  Bun.spawnSync(["pbcopy"], { stdin: new Response("") });
  const word = { x: request.x + 100, y };
  app.click(word.x, word.y); app.click(word.x, word.y);
  await eventually(() => clipboard() !== "", 5000);
  assert.equal(clipboard(), "words");
  console.log("✓ double click copies a word");
  // A plain click copies nothing.
  Bun.spawnSync(["pbcopy"], { stdin: new Response("") });
  app.click(request.x + 10, y);
  await Bun.sleep(600);
  assert.equal(clipboard(), "");
  console.log("✓ a plain click leaves the clipboard alone");
  app.write("\x11"); assert.equal(await app.child.exited, 0);
  console.log(JSON.stringify({ result: "passed" }));
} finally { app.kill(); await f.close(); Bun.spawnSync(["pbcopy"], { stdin: new Response(saved) }); }
