/** Live thinking and command drafting through the same pixel transport used by
 * Ghostty: thinking is one line with its latest heading, and the gold activity
 * line never types out a command while the model is still writing it. */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fixture, eventually } from "./test/fixture.ts";
import { TerminalHarness } from "./test/terminal-harness.ts";
const output = resolve(process.argv[2] ?? "/tmp/demesne-thinking-check");
mkdirSync(output, { recursive: true });
let phase: "thinking" | "drafting" | "done" = "thinking";
let round = 0;
const f = await fixture({ providerId: "test", modelId: "thinking-fixture", contextCapacity: 32768, async listModels() { return []; },
  async *stream() {
    if (round++ > 0) { yield { type: "text_delta", delta: "Done." }; yield { type: "finish", reason: "stop" }; return; }
    for (const heading of ["Reading repository objects", "Preparing exact test run"]) {
      yield { type: "reasoning_delta", delta: `**${heading}**\n\nI'll run \`bun test apps/daemon/test/tools.test.ts\` next.\n\n` };
      await Bun.sleep(300);
    }
    while (phase === "thinking") await Bun.sleep(50);
    // The command arrives in pieces, slowly, as a real model writes it.
    const argv = JSON.stringify({ argv: ["bun", "test", "apps/daemon/test/tools.test.ts"] });
    for (let i = 0; i < argv.length; i += 6) {
      yield { type: "tool_call_delta", index: 0, idDelta: i ? "" : "c", nameDelta: i ? "" : "run_command", argumentsDelta: argv.slice(i, i + 6) };
      await Bun.sleep(i > 10 && phase === "drafting" ? 2000 : 30);
    }
    yield { type: "finish", reason: "tool_calls" };
  } });
const app = new TerminalHarness({ env: f.env, entry: resolve(import.meta.dir, "terminal.ts"), args: ["--live", `--server=${f.server.url}`, `--workspace=${f.workspace}`, `--capture-dir=${output}`] });
let state: any;
async function wait(check: (s: any) => boolean, label: string) { try { await eventually(() => { try { state = JSON.parse(readFileSync(join(output, "state.json"), "utf8")); return check(state); } catch { return false; } }, 15000); } catch { throw new Error(`${label} did not settle: ${String(state?.live?.text).slice(-800)}`); } }
const conversation = (s: any) => { const text = String(s.live.text); const start = text.indexOf("Run the tests"); return start < 0 ? "" : text.slice(start, text.indexOf("Review", start) > 0 ? text.indexOf("Review", start) : undefined); };
try {
  await app.after(0);
  await wait(s => s.live?.connection === "online" && s.live?.sessionId, "online");
  await Bun.sleep(300);
  app.paste("Run the tests"); await Bun.sleep(80); app.write("\r");
  await wait(s => /Preparing exact test run/.test(conversation(s)), "thinking headline");
  const thinking = conversation(state);
  assert(!thinking.includes("bun test"), "live thinking doesn't show the command text");
  assert.equal(thinking.match(/Thinking/g)?.length, 1, "one Thinking line, not two");
  await app.png(join(output, "thinking.png")); console.log("✓ thinking is one line");
  phase = "drafting";
  await wait(s => /Writing a command…/.test(conversation(s)), "drafting");
  assert(!/Drafting /.test(conversation(state)), "the gold line doesn't type out the command");
  await app.png(join(output, "drafting.png")); console.log("✓ drafting says Writing a command…");
  phase = "done";
  app.write("\x11"); assert.equal(await app.child.exited, 0);
  console.log(JSON.stringify({ result: "passed", screenshots: output, checked: ["thinking is one line with its latest heading", "no command text while thinking", "drafting doesn't type out commands"] }));
} finally { app.kill(); await f.close(); }
