/** Runs the Next queue through the same pixel transport used by Ghostty. */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { fixture, eventually } from "./test/fixture.ts";
import { TerminalHarness } from "./test/terminal-harness.ts";
const output = resolve(process.argv[2] ?? "/tmp/demesne-drive-next-check");
mkdirSync(output, { recursive: true });
const f = await fixture({ providerId: "test", modelId: "next-fixture", contextCapacity: 32768,
  async listModels() { return []; },
  async *stream(_messages, tools) {
    if (tools.some(t => t.name === "propose_next")) {
      yield { type: "tool_call_delta", index: 0, idDelta: "proposals", nameDelta: "propose_next", argumentsDelta: JSON.stringify({ proposals:
        ["Inspect pending change", "Review error messages", "Plan focused verification", "Investigate unused export"].map(title => ({ kind: "investigate", title, why: "Inspect the recorded uncommitted work before deciding what to change.", evidence: ["git:uncommitted"], minutes: 10, coders: 1, confidence: "high", value: 3 })) }) };
      yield { type: "finish", reason: "tool_calls" }; return;
    }
    if (tools.some(t => t.name === "drive_ui")) {
      yield { type: "tool_call_delta", index: 0, idDelta: "drive", nameDelta: "drive_ui", argumentsDelta: JSON.stringify({ action: { kind: "wait" }, note: "Waiting for inspection", notes: "Inspect before changes", completed: [], remaining: ["Inspect the change"], evidence: [] }) };
      yield { type: "finish", reason: "tool_calls" }; return;
    }
    yield { type: "text_delta", delta: "Read-only plan: inspect the change, identify the relevant check, and report the evidence." };
    yield { type: "finish", reason: "stop" };
  },
});
Bun.spawnSync(["git", "init", "-q"], { cwd: f.workspace });
writeFileSync(join(f.workspace, "pending.ts"), "export const pending = true;\n");
const app = new TerminalHarness({ env: f.env, entry: resolve(import.meta.dir, "terminal.ts"), args: ["--live", `--server=${f.server.url}`, `--workspace=${f.workspace}`, `--capture-dir=${output}`] });
let state: any;
async function wait(check: (s: any) => boolean) { await eventually(() => { try { state = JSON.parse(readFileSync(join(output, "state.json"), "utf8")); return check(state); } catch { return false; } }, 15000); }
async function click(action: string, args: Record<string, unknown> = {}) {
  await wait(s => s.live?.controls.some((c: any) => c.action === action && Object.entries(args).every(([k,v]) => JSON.parse(c.args ?? "{}")[k] === v)));
  const c = state.live.controls.find((c: any) => c.action === action && Object.entries(args).every(([k,v]) => JSON.parse(c.args ?? "{}")[k] === v));
  assert.notEqual(c.hit, false, `Control ${action} is reachable`); app.click(Math.round(c.x), Math.round(c.y));
}
async function capture(name: string) {
  await eventually(async () => { try { const a = await app.raw(), b = await sharp(join(output,"latest.png")).ensureAlpha().raw().toBuffer({ resolveWithObject:true });
    return a.width === b.info.width && a.height === b.info.height && a.data.every((value,i) => Math.abs(value-b.data[i]!) <= 2);
  } catch { return false; } }, 5000);
  await app.png(join(output,`${name}.png`)); console.log(`✓ ${name}`);
}
try {
  await wait(s => s.live?.driveNext?.proposals.length === 4);
  assert(state.live.text.includes("DRIVE PROPOSES")); await capture("next-start");
  const [snooze, veto, plan, run] = state.live.driveNext.proposals;
  await click("panel", { name: "drive" }); await wait(s => s.live.pane === "drive"); await capture("next-panel");
  await click("next-snooze", { id:snooze.id }); await wait(s => s.live.driveNext.proposals.length === 3);
  await click("next-never", { id:veto.id }); await wait(s => s.live.driveNext.proposals.length === 2 && s.live.driveMemory.some((m:any) => m.kind === "veto")); await capture("next-dismissed");
  await click("next-plan", { id:plan.id }); await wait(s => s.live.runs.at(-1)?.status === "completed");
  const session = await f.client.getSessionState(state.live.sessionId);
  assert(session.session.turns.at(-1)?.planOnly, "Plan first creates a read-only turn");
  assert.equal(session.session.turns.at(-1)?.status,"completed"); await capture("next-plan");
  await click("next-run", { id:run.id }); await wait(s => s.live.driveMode === "bounded" && ["running","waiting"].includes(s.live.drive)); await capture("next-running");
  await click("drive-control", { control:"stop" });
  app.write("\x11"); assert.equal(await app.child.exited,0); assert(app.restored);
  console.log(JSON.stringify({result:"passed",screenshots:output,checked:["start screen proposals","Next panel","Not now","Never persists veto","Plan first is read-only","Run starts bounded Drive"]}));
} finally { app.kill(); await f.close(); }
