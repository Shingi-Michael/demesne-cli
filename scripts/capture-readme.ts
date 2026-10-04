/** Public README captures: real daemon/tools/UI, deterministic model, private temporary home. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { fixture, eventually } from "../apps/graphics/test/fixture.ts";
import { TerminalHarness } from "../apps/graphics/test/terminal-harness.ts";

const output = resolve(process.argv[2] ?? "docs/assets");
mkdirSync(output, { recursive: true });
const implementation = `export async function retry<T>(
  operation: () => Promise<T>,
  attempts = 3,
): Promise<T> {
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new RangeError("Invalid attempt count");
  }
  for (let attempt = 1; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= attempts) throw error;
    }
  }
}
`;
let round = 0;
const f = await fixture({
  providerId: "demo", modelId: "demo-model", contextCapacity: 32768,
  async listModels() { return [{ id: "demo-model", provider: "demo", contextWindow: 32768 }]; },
  async *stream(_messages, tools) {
    if (tools.some(t => t.name === "propose_next")) {
      yield { type: "tool_call_delta", index: 0, idDelta: "next", nameDelta: "propose_next", argumentsDelta: JSON.stringify({ proposals: [
        { title: "Review the retry boundary", why: "Inspect the pending retry helper and its failure behavior.", minutes: 10 },
        { title: "Plan cancellation support", why: "Check the new helper before extending it with AbortSignal.", minutes: 15 },
        { title: "Document safe retry usage", why: "Review the pending API change and explain when retrying is safe.", minutes: 10 },
      ].map(p => ({ ...p, kind: "investigate", evidence: ["git:uncommitted"], coders: 1, confidence: "high", value: 3 })) }) };
      yield { type: "finish", reason: "tool_calls" }; return;
    }
    const step = ++round;
    if (step <= 3) {
      const name = step === 1 ? "read_file" : step === 2 ? "write_file" : "run_command";
      const args = step === 1 ? { path: "retry.test.ts" } : step === 2 ? { path: "src/retry.ts", content: implementation } : { argv: [process.execPath, "test", "retry.test.ts"] };
      if (step === 1) yield { type: "reasoning_delta", delta: "I’ll inspect the contract, implement a bounded retry loop, and run the checks. The final failure must preserve the original error." };
      yield { type: "tool_call_delta", index: 0, idDelta: `demo-${step}`, nameDelta: name, argumentsDelta: JSON.stringify(args) };
      yield { type: "finish", reason: "tool_calls" };
    } else {
      yield { type: "text_delta", delta: "Added **bounded retries** with a small, typed API.\n\n```typescript\nconst data = await retry(() => fetchData(), 3);\n```\n\n- Returns immediately when the operation succeeds.\n- Preserves the original error after the last attempt.\n- Rejects invalid attempt counts before running.\n\n**All four tests pass.** Review the implementation in Changes.\n\nUse retries only for operations that are safe to repeat." };
      yield { type: "finish", reason: "stop" };
    }
  },
});
// Use a short temporary path so the workspace header stays legible in public captures.
const workspace = realpathSync(mkdtempSync(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "signal-kit-"))), capture = join(f.root, "capture");
mkdirSync(join(workspace, "src"), { recursive: true });
writeFileSync(join(workspace, "README.md"), "# Signal kit\nA small TypeScript client library.\n");
writeFileSync(join(workspace, "retry.test.ts"), `import { test, expect } from "bun:test";
import { retry } from "./src/retry";
test("returns the successful value", async () => expect(await retry(async () => 42)).toBe(42));
test("retries a transient failure", async () => { let n = 0; expect(await retry(async () => { if (++n < 3) throw Error("temporary"); return n; })).toBe(3); });
test("preserves the final error", async () => { const error = Error("offline"); try { await retry(async () => { throw error; }, 2); throw Error("expected rejection"); } catch (caught) { expect(caught).toBe(error); } });
test("rejects an invalid allowance", async () => { await expect(retry(async () => 1, 0)).rejects.toThrow(RangeError); });
`);
Bun.spawnSync(["git", "init", "-q"], { cwd: workspace });
// The fixture trusts only its own workspace; this capture uses its own folder.
writeFileSync(join(f.root, "data", "trusted-workspaces.json"), JSON.stringify({ trusted: [f.workspace, workspace] }));
const app = new TerminalHarness({ columns: 160, rows: 44, env: f.env, args: ["--live", `--server=${f.server.url}`, `--workspace=${workspace}`, `--capture-dir=${capture}`] });
let state: any;
async function wait(check: (s: any) => boolean) {
  try {
    await eventually(() => { try { state = JSON.parse(readFileSync(join(capture, "state.json"), "utf8")); return check(state); } catch { return false; } }, 20000);
  } catch (error) { throw new Error(`Demo did not settle: ${app.error}\n${JSON.stringify(state?.live).slice(0, 5000)}`, { cause: error }); }
}
async function click(action: string, args: Record<string, unknown> = {}) {
  const matches = (c: any) => c.action === action && Object.entries(args).every(([k,v]) => JSON.parse(c.args ?? "{}")[k] === v);
  await wait(s => s.live?.controls.some(matches));
  const c = state.live.controls.find(matches); app.click(Math.round(c.x), Math.round(c.y));
}
async function save(name: string) {
  // Decode the actual Kitty transport and require it to match the browser capture.
  await eventually(async () => { try {
    const a = await app.raw(), b = await sharp(join(capture, "latest.png")).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return a.width === b.info.width && a.height === b.info.height && a.data.every((v,i) => Math.abs(v - b.data[i]!) <= 2);
  } catch { return false; } }, 6000);
  await app.png(join(output, name)); console.log(`Captured ${name}`);
}
try {
  await wait(s => s.live?.driveNext?.proposals.length === 3);
  await save("demesne-start.png");
  app.paste("Build a typed retry helper and verify its failure behavior."); app.write("\r");
  await wait(s => s.live.approvals === 1); await click("permission", { decision: "allow_once" });
  await wait(s => s.live.approvals === 1 && s.live.text.includes("Allow this command?")); await click("permission", { decision: "allow_once" });
  await wait(s => s.live.runs.at(-1)?.status === "completed");
  assert.equal(readFileSync(join(workspace,"src/retry.ts"),"utf8"), implementation);
  await click("panel", { name: "changes" });
  await wait(s => s.live.pane === "changes" && s.live.text.includes("attempts"));
  assert(state.live.text.includes("checks passed"), "The real demo checks passed");
  await save("demesne-review.png");
  await click("panel", { name: "drive" });
  await wait(s => s.live.pane === "drive" && s.live.controls.some((c: any) => c.action === "drive-tab"));
  await save("demesne-drive.png");
  app.write("\x11"); assert.equal(await app.child.exited, 0); assert(app.restored);
} finally { app.kill(); await f.close(); rmSync(workspace, { recursive: true, force: true }); }
