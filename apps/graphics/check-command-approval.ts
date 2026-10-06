/** Compact command approvals remain inspectable and require the same decision. */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fixture, eventually } from "./test/fixture.ts";
import { TerminalHarness } from "./test/terminal-harness.ts";
const output = resolve(process.argv[2] ?? "/tmp/demesne-command-approval-check");
mkdirSync(output, { recursive: true });
const prompt = "Check the compact approval prompt";
const code = "/* " + "Long command details. ".repeat(100) + " */ console.log('COMPACT_APPROVAL_EXECUTED');";
let round = 0;
const f = await fixture({ providerId: "test", modelId: "approval-test", contextCapacity: 32768,
  async listModels() { return [{ id: "approval-test", provider: "test" }]; },
  async *stream(messages) {
    if (messages.findLast(message => message.role === "user")?.content !== prompt) {
      yield { type: "text_delta", delta: '{"proposals":[]}' }; yield { type: "finish", reason: "stop" }; return;
    }
    if (++round === 1) {
      yield { type: "tool_call_delta", index: 0, idDelta: "command", nameDelta: "run_command", argumentsDelta: JSON.stringify({ argv: [process.execPath, "-e", code] }) };
      yield { type: "finish", reason: "tool_calls" };
    } else { yield { type: "text_delta", delta: "Verified command approval." }; yield { type: "finish", reason: "stop" }; }
  },
});
const app = new TerminalHarness({ env: f.env, entry: resolve(import.meta.dir, "terminal.ts"), args: ["--live", `--server=${f.server.url}`, `--workspace=${f.workspace}`, `--capture-dir=${output}`] });
let state: any;
const wait = (check: (value: any) => boolean, label: string) => eventually(() => {
  try { state = JSON.parse(readFileSync(join(output, "state.json"), "utf8")); return check(state); } catch { return false; }
}, 15000).catch(() => { throw new Error(`${label}: ${state?.live?.text?.slice(-1200)}`); });
async function capture(name: string) { await Bun.sleep(200); await app.png(join(output, `${name}.png`)); }
try {
  await app.after(0);
  await wait(s => s.live?.connection === "online" && s.live?.sessionId, "online");
  app.paste(prompt); app.write("\r");
  await wait(s => s.live.approvals === 1, "approval");
  assert(state.live.approvalText.includes("Allow this command?"));
  assert(state.live.approvalText.includes("Command details"));
  assert(!state.live.approvalDetailsOpen);
  assert(!state.live.approvalText.includes("COMPACT_APPROVAL_EXECUTED"));
  assert(!state.live.approvalText.includes("host command:"));
  assert(!state.live.text.includes("COMPACT_APPROVAL_EXECUTED"));
  await capture("collapsed");
  const details = state.live.controls.find((c: any) => c.tag === "SUMMARY" && c.label === "Command details");
  assert(details, "the details toggle is accessible");
  app.click(Math.round(details.x), Math.round(details.y));
  await wait(s => s.live.approvalDetailsOpen, "expanded");
  assert(state.live.approvalText.includes("COMPACT_APPROVAL_EXECUTED"));
  await capture("expanded");
  // Closing and opening details leaves the pending decision intact.
  app.write("\x02");
  await wait(s => s.live.pane === "log", "side panel");
  const movedDetails = state.live.controls.find((c: any) => c.tag === "SUMMARY" && c.label === "Command details");
  app.click(Math.round(movedDetails.x), Math.round(movedDetails.y));
  await wait(s => !s.live.approvalDetailsOpen, "collapse after panel navigation");
  app.write("\r");
  await wait(s => s.live.approvalDetailsOpen, "keyboard expansion with side panel");
  app.write("\r");
  await wait(s => !s.live.approvalDetailsOpen, "keyboard collapse");
  assert.equal(state.live.approvals, 1);
  const allow = state.live.controls.find((c: any) => c.action === "permission" && JSON.parse(c.args ?? "{}").decision === "allow_once");
  app.click(Math.round(allow.x), Math.round(allow.y));
  await wait(s => s.live.approvals === 0 && /Verified command approval/.test(s.live.text), "approved and complete");
  const status = await f.client.getSessionState(state.live.sessionId);
  const replay = await f.client.replayPage(state.live.sessionId, 0, status.lastEventId);
  assert(replay.events.some(event => event.type === "tool.call_completed" && event.payload.name === "run_command"));
  await capture("completed");
  app.write("\x11"); assert.equal(await app.child.exited, 0);
  console.log(JSON.stringify({ result: "passed", screenshots: output, checks: ["compact default", "inspectable details", "keyboard collapse", "approval execution unchanged"] }));
} finally { app.kill(); await f.close(); }
