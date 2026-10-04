/** Drive experiments through the same pixel transport used by Ghostty: an
 * experiment proposal is designed (Plan first), started, built in worktrees,
 * checked, measured, and its verdict lands in project memory. */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { fixture, eventually } from "./test/fixture.ts";
import { TerminalHarness } from "./test/terminal-harness.ts";
const output = resolve(process.argv[2] ?? "/tmp/demesne-experiments-check");
mkdirSync(output, { recursive: true });
Object.assign(process.env, { GIT_AUTHOR_NAME: "Check", GIT_AUTHOR_EMAIL: "check@example.com", GIT_COMMITTER_NAME: "Check", GIT_COMMITTER_EMAIL: "check@example.com" });
const f = await fixture({ providerId: "test", modelId: "experiment-fixture", contextCapacity: 32768,
  async listModels() { return []; },
  async *stream(messages, tools) {
    if (tools.some(t => t.name === "propose_next")) {
      yield { type: "tool_call_delta", index: 0, idDelta: "p", nameDelta: "propose_next", argumentsDelta: JSON.stringify({ proposals: [
        { kind: "experiment", title: "Find a value that scores fewer points", why: "Points look high; a smaller value may cut them in half.", evidence: ["git:uncommitted"], minutes: 30, coders: 2, confidence: "medium", value: 4 }] }) };
      yield { type: "finish", reason: "tool_calls" }; return;
    }
    if (tools.some(t => t.name === "design_experiment")) {
      yield { type: "tool_call_delta", index: 0, idDelta: "d", nameDelta: "design_experiment", argumentsDelta: JSON.stringify({
        question: "Does a smaller value score fewer points?", hypothesis: "Points equal the value, so halving it halves the points.", metric: "points", budgetMinutes: 30,
        variants: [{ idea: "set value to 5", instruction: "Change value.ts so value is 5. Keep the export name." }, { idea: "set value to -1", instruction: "Change value.ts so value is -1. Keep the export name." }] }) };
      yield { type: "finish", reason: "tool_calls" }; return;
    }
    if (tools.some(t => t.name === "drive_ui")) {
      yield { type: "tool_call_delta", index: 0, idDelta: "drive", nameDelta: "drive_ui", argumentsDelta: JSON.stringify({ action: { kind: "wait" }, note: "Waiting for inspection", notes: "Inspect before changes", completed: [], remaining: ["Inspect the change"], evidence: [] }) };
      yield { type: "finish", reason: "tool_calls" }; return;
    }
    if (messages.some(m => m.role === "tool")) { yield { type: "text_delta", delta: "Changed value.ts." }; yield { type: "finish", reason: "stop" }; return; }
    const prompt = String(messages.findLast(m => m.role === "user")?.content ?? "");
    const number = /Your idea: set value to (-?[\d.]+)/.exec(prompt)?.[1];
    if (!number) { yield { type: "text_delta", delta: "Nothing to do." }; yield { type: "finish", reason: "stop" }; return; }
    // Slow enough that the experiment is still running when a mission starts.
    await Bun.sleep(15000);
    yield { type: "tool_call_delta", index: 0, idDelta: "w", nameDelta: "write_file", argumentsDelta: JSON.stringify({ path: "value.ts", content: `export const value = ${number};\n` }) };
    yield { type: "finish", reason: "tool_calls" };
  },
});
const git = (...args: string[]) => Bun.spawnSync(["git", ...args], { cwd: f.workspace });
git("init", "-q", "-b", "main");
writeFileSync(join(f.workspace, "value.ts"), "export const value = 10;\n");
writeFileSync(join(f.workspace, "metric.ts"), 'import { value } from "./value.ts";\nconsole.log(JSON.stringify({ value }));\n');
writeFileSync(join(f.workspace, "check.ts"), 'import { value } from "./value.ts";\nif (value < 0) process.exit(1);\n');
mkdirSync(join(f.workspace, ".demesne"));
writeFileSync(join(f.workspace, ".demesne/experiments.json"), JSON.stringify({ checks: [[process.execPath, "check.ts"]], pullRequest: false,
  metrics: [{ name: "points", about: "The number in value.ts.", direction: "lower", argv: [process.execPath, "metric.ts"], minImprovement: 0.2 }] }));
git("add", "-A"); git("commit", "-qm", "init");
writeFileSync(join(f.workspace, "draft.ts"), "export const draft = true;\n");
const app = new TerminalHarness({ env: f.env, entry: resolve(import.meta.dir, "terminal.ts"), args: ["--live", `--server=${f.server.url}`, `--workspace=${f.workspace}`, `--capture-dir=${output}`] });
let state: any;
async function wait(check: (s: any) => boolean, timeout = 20000) { await eventually(() => { try { state = JSON.parse(readFileSync(join(output, "state.json"), "utf8")); return check(state); } catch { return false; } }, timeout); }
async function click(action: string, args: Record<string, unknown> = {}) {
  const match = (c: any) => c.action === action && Object.entries(args).every(([k, v]) => JSON.parse(c.args ?? "{}")[k] === v);
  await wait(s => s.live?.controls.some(match));
  const c = state.live.controls.find(match);
  assert.notEqual(c.hit, false, `Control ${action} is reachable`); app.click(Math.round(c.x), Math.round(c.y));
}
// A frame matches when no channel differs by more than 24/255: after the
// start screen's layout shifts, its tiles' text can settle with antialiasing
// a shade apart (seen up to 18); real content changes differ far more.
async function capture(name: string) {
  await eventually(async () => { try { const a = await app.raw(), b = await sharp(join(output, "latest.png")).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    if (a.width !== b.info.width || a.height !== b.info.height) return false;
    for (let i = 0; i < a.data.length; i++) if (i % 4 !== 3 && Math.abs(a.data[i]! - b.data[i]!) > 24) return false;
    return true;
  } catch { return false; } }, 5000);
  await app.png(join(output, `${name}.png`)); console.log(`✓ ${name}`);
}
try {
  await wait(s => s.live?.driveNext?.proposals.length === 1);
  const proposal = state.live.driveNext.proposals[0];
  await click("panel", { name: "drive" }); await wait(s => s.live.pane === "drive");
  await click("next-plan", { id: proposal.id });
  await wait(s => s.live.experiments?.draft?.spec.variants.length === 3);
  assert.deepEqual(state.live.experiments.draft.spec.metric.argv, [process.execPath, "metric.ts"], "the metric comes from the kit");
  assert(state.live.text.includes("DESIGNED"));
  await capture("experiment-draft");
  await click("experiment-start");
  await wait(s => s.live.experiments.items[0]?.status === "running");
  // A Drive mission takes over the panel; the running experiment stays under it.
  const composer = state.live.controls.find((c: any) => c.tag === "TEXTAREA");
  app.click(composer.x, composer.y); await Bun.sleep(100);
  app.paste("/drive --bounded Inspect the pending change"); await Bun.sleep(80); app.write("\r");
  await wait(s => s.live.driveMode === "bounded" && ["running", "waiting"].includes(s.live.drive) && s.live.experiments.items[0]?.status === "running");
  await wait(s => s.live.text.includes("Does a smaller value score fewer points?") && /RUNNING/.test(s.live.text));
  await capture("experiment-during-mission");
  await click("drive-control", { control: "stop" });
  await wait(s => s.live.experiments.items[0]?.status === "settled", 60000);
  const experiment = state.live.experiments.items[0];
  assert.equal(experiment.verdict.winner, "B");
  assert.equal(experiment.variants.find((v: any) => v.label === "C").status, "failed");
  await wait(s => s.live.driveMemory.some((m: any) => m.kind === "outcome" && m.text.includes(`Experiment ${experiment.id}`)));
  assert(state.live.text.includes("Does a smaller value score fewer points?"));
  const branch = git("show", `${experiment.variants[1].branch}:value.ts`).stdout.toString();
  assert.equal(branch, "export const value = 5;\n", "the winner is committed on its branch");
  await capture("experiment-settled");
  app.write("\x11"); assert.equal(await app.child.exited, 0); assert(app.restored);
  console.log(JSON.stringify({ result: "passed", screenshots: output, checked: ["experiment proposal designs from the kit", "draft shows variants before starting", "running experiment visible during a mission", "variants built, checked and measured", "failing variant stopped", "winner kept on its branch", "verdict recorded in project memory"] }));
} finally { app.kill(); await f.close(); }
