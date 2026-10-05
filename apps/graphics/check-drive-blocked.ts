/** A blocked Drive mission explains itself through the same pixel transport
 * used by Ghostty: why it stopped, what led there, the evidence, and what to
 * do next. */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fixture, eventually } from "./test/fixture.ts";
import { TerminalHarness } from "./test/terminal-harness.ts";
const output = resolve(process.argv[2] ?? "/tmp/demesne-drive-blocked-check");
mkdirSync(output, { recursive: true });
const REASON = "I was adding the retry flag, but the spec doesn't say whether retries should apply to timeouts. Tell me which: retry timeouts too, or only connection errors?";
let decisions = 0;
const f = await fixture({ providerId: "test", modelId: "blocked-fixture", contextCapacity: 32768,
  async listModels() { return []; },
  async *stream(messages, tools) {
    if (tools.some(t => t.name === "propose_next")) { yield { type: "tool_call_delta", index: 0, idDelta: "p", nameDelta: "propose_next", argumentsDelta: JSON.stringify({ proposals: [] }) }; yield { type: "finish", reason: "tool_calls" }; return; }
    if (tools.some(t => t.name === "drive_ui")) {
      // First ask the coder, then block once its answer is in.
      const first = decisions++ === 0;
      const observation = JSON.parse(String(messages.at(-1)?.content ?? "{}"))?.observation?.id ?? "start";
      const action = first ? { kind: "compose", text: "Read retry.ts and say where a retry flag would go." } : { kind: "blocked" };
      yield { type: "tool_call_delta", index: 0, idDelta: "d", nameDelta: "drive_ui", argumentsDelta: JSON.stringify({ action, note: first ? "Asking the coder where the flag belongs" : REASON, notes: "", completed: [], remaining: ["Add the retry flag"], evidence: first ? [] : [{ observationId: observation, quote: "retry.ts handles connection errors; timeouts are thrown separately." }] }) };
      yield { type: "finish", reason: "tool_calls" }; return;
    }
    yield { type: "text_delta", delta: "retry.ts handles connection errors; timeouts are thrown separately." };
    yield { type: "finish", reason: "stop" };
  },
});
Bun.spawnSync(["git", "init", "-q"], { cwd: f.workspace });
writeFileSync(join(f.workspace, "retry.ts"), "export const retry = true;\n");
const app = new TerminalHarness({ env: f.env, entry: resolve(import.meta.dir, "terminal.ts"), args: ["--live", `--server=${f.server.url}`, `--workspace=${f.workspace}`, `--capture-dir=${output}`] });
let state: any;
async function wait(check: (s: any) => boolean, label: string) { try { await eventually(() => { try { state = JSON.parse(readFileSync(join(output, "state.json"), "utf8")); return check(state); } catch { return false; } }, 30000); } catch { throw new Error(`${label} did not settle: ${JSON.stringify(state?.live?.drive)} ${String(state?.live?.text).slice(-1500)}`); } }
try {
  await app.after(0);
  await wait(s => s.live?.connection === "online" && s.live?.sessionId, "online");
  await Bun.sleep(300);
  app.paste("/drive --bounded Add a retry flag to retry.ts"); await Bun.sleep(80); app.write("\r");
  await wait(s => s.live.drive === "blocked" && s.live.pane === "drive", "blocked");
  const text = state.live.text as string;
  for (const part of ["Blocked · needs you", "WHY", REASON, "WHAT LED HERE", "EVIDENCE", "timeouts are thrown separately", "WHAT YOU CAN DO", "Answer the question or give direction"]) assert(text.includes(part), `the blocked card shows ${part}`);
  assert(state.live.controls.some((c: any) => c.action === "drive-control" && JSON.parse(c.args).control === "resume"), "Resume is offered");
  await Bun.sleep(500);
  await app.png(join(output, "drive-blocked.png")); console.log("✓ drive-blocked");
  app.write("\x11"); assert.equal(await app.child.exited, 0);
  console.log(JSON.stringify({ result: "passed", screenshots: output, checked: ["why", "what led here", "evidence", "what you can do", "resume offered"] }));
} finally { app.kill(); await f.close(); }
