/** The model's suggested next prompt through the same pixel transport used by
 * Ghostty: hidden from the answer (even while streaming), shown in the empty
 * composer, and Tab fills it in. */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fixture, eventually } from "./test/fixture.ts";
import { TerminalHarness } from "./test/terminal-harness.ts";
const output = resolve(process.argv[2] ?? "/tmp/demesne-next-prompt-check");
mkdirSync(output, { recursive: true });
const SUGGESTION = "Add a retry test for timeouts";
let streaming = true;
const f = await fixture({ providerId: "test", modelId: "next-fixture", contextCapacity: 32768, async listModels() { return []; },
  async *stream() {
    for (const part of ["Added bounded retries.", " All four tests pass.\n\n<ne", "xt>Add a retry", " test for timeouts</ne", "xt>"]) {
      yield { type: "text_delta", delta: part };
      await Bun.sleep(part.includes("<ne") ? 1500 : 50);
      while (streaming && part === "xt>Add a retry") await Bun.sleep(50);
    }
    yield { type: "finish", reason: "stop" };
  } });
const app = new TerminalHarness({ env: f.env, entry: resolve(import.meta.dir, "terminal.ts"), args: ["--live", `--server=${f.server.url}`, `--workspace=${f.workspace}`, `--capture-dir=${output}`] });
let state: any;
async function wait(check: (s: any) => boolean, label: string) { try { await eventually(() => { try { state = JSON.parse(readFileSync(join(output, "state.json"), "utf8")); return check(state); } catch { return false; } }, 15000); } catch { throw new Error(`${label} did not settle: ${String(state?.live?.text).slice(-800)}`); } }
const composer = (s: any) => s.live.controls.find((c: any) => c.tag === "TEXTAREA");
try {
  await app.after(0);
  await wait(s => s.live?.connection === "online" && s.live?.sessionId, "online");
  await Bun.sleep(300);
  app.paste("Add retries"); await Bun.sleep(80); app.write("\r");
  // Mid-stream, inside the tag: none of it shows.
  await wait(s => /All four tests pass/.test(s.live.text), "streaming answer");
  await Bun.sleep(400);
  assert(!/<ne|next>|Add a retry/.test(state.live.text), "an unfinished tag never shows");
  streaming = false;
  await wait(s => s.live.runs.at(-1)?.status === "completed" && composer(s)?.placeholder?.includes(SUGGESTION), "suggestion in the composer");
  assert(!state.live.text.includes("<next>"), "the finished answer has no tag");
  await Bun.sleep(400);
  await app.png(join(output, "suggestion.png")); console.log("✓ suggestion shows in the composer");
  const box = composer(state);
  app.click(Math.round(box.x), Math.round(box.y)); await Bun.sleep(100);
  app.write("\t");
  await wait(s => composer(s)?.value === SUGGESTION, "Tab fills it in");
  console.log("✓ Tab fills in the suggestion");
  app.write("\x11"); assert.equal(await app.child.exited, 0);
  console.log(JSON.stringify({ result: "passed", screenshots: output, checked: ["tag hidden while streaming", "tag hidden when done", "suggestion in the composer", "Tab fills it in"] }));
} finally { app.kill(); await f.close(); }
