/** Breakage alerts through the same pixel transport used by Ghostty: a check
 * that newly fails pops a card, Fix runs the agent in its own git worktree
 * (the user's files untouched), and Apply brings the fix onto their branch. */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fixture, eventually } from "./test/fixture.ts";
import { TerminalHarness } from "./test/terminal-harness.ts";
const output = resolve(process.argv[2] ?? "/tmp/demesne-breakage-check");
mkdirSync(output, { recursive: true });
// The daemon (in this process) commits the fix with the user's git identity.
Object.assign(process.env, { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "a@b", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "a@b" });
let release = false;
const f = await fixture({ providerId: "test", modelId: "breakage-fixture", contextCapacity: 32768, async listModels() { return []; },
  async *stream(messages) {
    const asked = messages.findLastIndex((message) => message.role === "user");
    const fixing = String(messages[asked]?.content ?? "").includes("Something in this repository just broke");
    const step = messages.length - 1 - asked;
    const call = (id: string, name: string, args: unknown) => [{ type: "tool_call_delta" as const, index: 0, idDelta: id, nameDelta: name, argumentsDelta: JSON.stringify(args) }, { type: "finish" as const, reason: "tool_calls" as const }];
    if (!fixing) {
      if (step === 0) { yield* call("c", "run_command", { argv: ["sh", "check"] }); return; }
      yield { type: "text_delta", delta: "The check fails: count is 1." }; yield { type: "finish", reason: "stop" }; return;
    }
    if (step === 0) { yield* call("w", "write_file", { path: "src/count.ts", content: "export const count = 2;\n" }); return; }
    if (step <= 2) {
      // Hold the fix open long enough to see it running.
      while (!release) await Bun.sleep(50);
      yield* call("r", "run_command", { argv: ["sh", "check"] }); return;
    }
    yield { type: "text_delta", delta: "count had regressed to 1; I set it back to 2 and the check passes." }; yield { type: "finish", reason: "stop" };
  } });
const git = (...args: string[]) => Bun.spawnSync(["git", ...args], { cwd: f.workspace, env: process.env }).stdout.toString().trim();
mkdirSync(join(f.workspace, "src"));
writeFileSync(join(f.workspace, "check"), "grep -q 'count = 2' src/count.ts || { echo 'expected count 2' >&2; exit 1; }\n");
writeFileSync(join(f.workspace, "src", "count.ts"), "export const count = 2;\n");
git("init", "-q", "-b", "main"); git("add", "-A"); git("commit", "-qm", "init");
const app = new TerminalHarness({ env: f.env, entry: resolve(import.meta.dir, "terminal.ts"), args: ["--live", `--server=${f.server.url}`, `--workspace=${f.workspace}`, `--capture-dir=${output}`] });
let state: any;
async function wait(check: (s: any) => boolean, label: string, timeout = 20000) {
  try { await eventually(() => { try { state = JSON.parse(readFileSync(join(output, "state.json"), "utf8")); return check(state); } catch { return false; } }, timeout); }
  catch { throw new Error(`${label} did not settle: ${JSON.stringify(state?.live?.breakage)}`); }
}
async function click(action: string, args: Record<string, unknown> = {}) {
  const find = (s: any) => s.live?.controls.find((c: any) => c.action === action && Object.entries(args).every(([k, v]) => JSON.parse(c.args ?? "{}")[k] === v));
  await wait((s) => Boolean(find(s)), `control ${action}`);
  const c = find(state);
  assert.notEqual(c.hit, false, `Control ${action} is reachable`);
  app.click(Math.round(c.x), Math.round(c.y));
}
async function shot(name: string) { await Bun.sleep(500); await app.png(join(output, `${name}.png`)); console.log(`✓ ${name}`); }
try {
  await app.after(0);
  await wait((s) => s.live?.connection === "online" && s.live?.sessionId, "online");
  await Bun.sleep(1500);
  // Someone breaks it; the next turn runs the check and it fails.
  writeFileSync(join(f.workspace, "src", "count.ts"), "export const count = 1;\n");
  git("commit", "-qam", "oops");
  app.paste("Run the check"); await Bun.sleep(80); app.write("\r");
  await click("permission", { decision: "allow_once" });
  await wait((s) => s.live.breakage?.signals.length === 1, "alert");
  assert.match(state.live.breakage.signals[0].title, /Check failing: sh check/);
  await shot("alert");

  await click("breakage-fix");
  await wait((s) => s.live.breakage?.fix?.status === "running" && s.live.breakage.signals.length === 0, "fix running");
  await wait((s) => (s.live.breakage.fix.activity?.steps ?? 0) >= 1, "fix activity");
  const { path, branch } = state.live.breakage.fix;
  assert(existsSync(path), "the worktree exists");
  assert.equal(readFileSync(join(f.workspace, "src", "count.ts"), "utf8"), "export const count = 1;\n", "the user's file is untouched while fixing");
  await shot("running");
  release = true;

  await wait((s) => s.live.breakage?.fix?.status === "ready", "fix ready");
  assert.deepEqual(state.live.breakage.fix.checks, [{ command: "sh check", passed: true }]);
  assert.equal(readFileSync(join(f.workspace, "src", "count.ts"), "utf8"), "export const count = 1;\n", "still untouched until Apply");
  await shot("ready");

  await click("breakage-apply");
  await wait((s) => s.live.breakage?.fix === null && s.live.breakage.message?.tone === "ok", "applied");
  assert.equal(readFileSync(join(f.workspace, "src", "count.ts"), "utf8"), "export const count = 2;\n");
  assert.equal(git("log", "-1", "--format=%s"), "Fix: Check failing: sh check");
  assert(!existsSync(path), "the worktree is removed");
  assert.equal(git("branch", "--list", branch), "", "the branch is removed");
  await shot("applied");
  await click("breakage-close");
  await wait((s) => s.live.breakage?.message === null, "toast closed");

  app.write("\x11"); assert.equal(await app.child.exited, 0);
  console.log(JSON.stringify({ result: "passed", screenshots: output, checked: ["new failure pops a card", "fix runs in a worktree", "checkout untouched until Apply", "Apply cherry-picks and cleans up"] }));
} finally { app.kill(); await f.close(); }
