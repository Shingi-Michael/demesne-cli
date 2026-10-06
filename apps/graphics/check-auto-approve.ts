/** Test auto-approve through the real renderer in an isolated fixture only. */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { fixture, eventually } from "./test/fixture.ts";
import { TerminalHarness } from "./test/terminal-harness.ts";
const output = resolve(process.argv[2] ?? "/tmp/demesne-auto-approve-check");
mkdirSync(output, { recursive: true });
const prompt = "Verify the session auto-approve option";
const askAgainPrompt = "Verify commands ask again after disabling auto-approve";
const rounds = new Map<string, number>();
const f = await fixture({
  providerId: "test", modelId: "approval-test", contextCapacity: 32768,
  async listModels() { return [{ id: "approval-test", provider: "test" }]; },
  async *stream(messages) {
    const content = messages.findLast(message => message.role === "user")?.content;
    if (content !== prompt && content !== askAgainPrompt) {
      yield { type: "text_delta", delta: '{"proposals":[]}' }; yield { type: "finish", reason: "stop" }; return;
    }
    const round = (rounds.get(content) ?? 0) + 1;
    rounds.set(content, round);
    if (round === 1) {
      yield { type: "tool_call_delta", index: 0, idDelta: content === prompt ? "first-command" : "second-command", nameDelta: "run_command",
        argumentsDelta: JSON.stringify({ argv: [process.execPath, "-e", "console.log('AUTO_APPROVAL_EXECUTED');"] }) };
      yield { type: "finish", reason: "tool_calls" };
    } else {
      yield { type: "text_delta", delta: "Verified session auto-approval." };
      yield { type: "finish", reason: "stop" };
    }
  },
});
const app = new TerminalHarness({ env: f.env, entry: resolve(import.meta.dir, "terminal.ts"),
  args: ["--live", `--server=${f.server.url}`, `--workspace=${f.workspace}`, `--capture-dir=${output}`] });
let state: any;
const wait = (check: (value: any) => boolean, label: string) => eventually(() => {
  try { state = JSON.parse(readFileSync(join(output, "state.json"), "utf8")); return check(state); } catch { return false; }
}, 15000).catch(() => { throw new Error(`${label}: ${state?.live?.text?.slice(-1500)}`); });
async function click(find: (control: any) => boolean, label: string) {
  await wait(s => s.live?.controls.some(find), label);
  const control = state.live.controls.find(find);
  assert.notEqual(control.hit, false, `${label} is reachable`);
  app.click(Math.round(control.x), Math.round(control.y));
}
async function capture(name: string) {
  await Bun.sleep(200);
  await eventually(async () => {
    try {
      const actual = await app.raw(), expected = await sharp(join(output, "latest.png")).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      return actual.width === expected.info.width && actual.height === expected.info.height &&
        actual.data.every((value, index) => Math.abs(value - expected.data[index]!) <= 2);
    } catch { return false; }
  }, 6000).catch(async () => {
    await app.png(join(output, `${name}-mismatch.png`));
    throw new Error(`Pixel mismatch: ${name}`);
  });
  await app.png(join(output, `${name}.png`));
}
try {
  await app.after(0);
  await wait(s => s.live?.connection === "online" && s.live?.sessionId, "online");
  assert.equal(state.live.autoApprove, false);
  const first = state.live.sessionId;
  app.paste(prompt); app.write("\r");
  await wait(s => s.live.approvals === 1, "approval");
  assert(state.live.approvalText.includes("Allow this command?"));
  assert(state.live.approvalText.includes("Auto-approve all · this session"));
  assert(state.live.approvalText.includes("With Auto-approve all, edits, commands, deletions and publishing run without asking"));
  assert(!state.live.approvalDetailsOpen);
  assert(!state.live.approvalText.includes("AUTO_APPROVAL_EXECUTED"));
  await capture("ask-first");
  await click(c => c.action === "auto-approve", "auto-approve current session");
  await wait(s => s.live.autoApprove && s.live.approvals === 0 && /Verified session auto-approval/.test(s.live.text), "approved and completed");
  assert(state.live.text.includes("Auto-approve all · this session"));
  assert.equal((await f.client.getSessionState(first)).session.autoApprove, true);
  await capture("enabled");
  await click(c => c.action === "overlay" && c.label === "Auto-approve", "settings badge");
  await wait(s => s.live.overlay === "settings" && /Approvals/.test(s.live.text), "settings");
  await capture("settings-enabled");
  await click(c => c.action === "choose-row" && c.label.includes("Approvals"), "disable in settings");
  await wait(s => !s.live.autoApprove && s.live.overlay === "settings" && /Ask first/.test(s.live.text), "ask first restored");
  assert.equal((await f.client.getSessionState(first)).session.autoApprove, false);
  await capture("settings-disabled");
  await click(c => c.action === "close-overlay", "close settings");
  app.paste(askAgainPrompt); app.write("\r");
  await wait(s => !s.live.autoApprove && s.live.approvals === 1, "next command asks first");
  await capture("asks-again");
  app.write("\x0b");
  await wait(s => s.live.overlay === "settings", "settings for pending command");
  await click(c => c.action === "choose-row" && c.label.includes("Approvals"), "enable in settings");
  await wait(s => s.live.autoApprove && s.live.approvals === 0 && !s.live.activeTurnId, "enabled again and pending command completes");
  await click(c => c.action === "choose-row" && c.label.includes("Mode"), "plan mode");
  await wait(s => s.live.overlay === null && /Auto-approve all · Plan stays read only/.test(s.live.text), "plan remains read only");
  await capture("plan-mode");
  app.paste("/new"); app.write("\r");
  await wait(s => s.live.sessionId !== first && !s.live.autoApprove, "new session asks first");
  assert.equal((await f.client.getSessionState(first)).session.autoApprove, true);
  await capture("new-session");
  app.write("\x11"); assert.equal(await app.child.exited, 0);
  console.log(JSON.stringify({ result: "passed", screenshots: output, checks: ["compact command", "pending action released", "visible active badges", "settings toggle", "next command asks after disabling", "Plan read only", "new session asks first"] }));
} finally { app.kill(); await f.close(); }
