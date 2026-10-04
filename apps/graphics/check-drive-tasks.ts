import assert from "node:assert/strict";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  mkdirSync as mkdir,
  unlinkSync,
} from "node:fs";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { fixture, eventually } from "./test/fixture.ts";
import { TerminalHarness } from "./test/terminal-harness.ts";
const output = resolve(process.argv[2] ?? "/tmp/demesne-drive-tasks-check");
mkdirSync(output, { recursive: true });
const density = process.argv.includes("--retina") ? 2 : 1;
let workerCalls = 0;
const f = await fixture({
  providerId: "test",
  modelId: "drive-test",
  async listModels() {
    return [];
  },
  async *stream(messages, tools) {
    // The Next queue refreshes after turns settle; this fixture proposes nothing.
    if (tools.some((tool) => tool.name === "propose_next")) {
      yield { type: "tool_call_delta", index: 0, idDelta: "next", nameDelta: "propose_next", argumentsDelta: JSON.stringify({ proposals: [] }) };
      yield { type: "finish", reason: "tool_calls" };
      return;
    }
    if (tools.some((tool) => tool.name === "drive_ui")) {
      const input = JSON.parse(messages[1]!.content!),
        task = input.ledger.tasks.find(
          (task: any) => task.id === input.ledger.currentTaskId,
        );
      let action: any,
        evidence: any[] = [],
        remaining: string[] = [];
      if (task.criteria[0] === "Verify the fixture check")
        action = {
          kind: "set_criteria",
          criteria: ["The fixture check prints CHECK_OK and passes"],
        };
      else if (!task.workerTurns.length) {
        action = {
          kind: "compose",
          text: "Run the fixture check and report its result",
        };
        remaining = ["Run the check"];
      } else if (input.inspection?.target !== "checks") {
        action = { kind: "inspect", target: "checks", position: "start" };
        remaining = ["Inspect the check"];
      } else {
        action = { kind: "complete", basis: "verified-work" };
        const page = input.inspection.pages.find((page: any) =>
          page.rows.some((row: string) => row.includes("CHECK_OK")),
        );
        if (!page) {
          console.log(JSON.stringify(input.inspection));
          throw new Error("Check output missing from inspection");
        }
        evidence = [{ observationId: page.observationId, quote: "CHECK_OK" }];
      }
      yield {
        type: "tool_call_delta",
        index: 0,
        idDelta: "drive",
        nameDelta: "drive_ui",
        argumentsDelta: JSON.stringify({
          action,
          evidence,
          remaining,
          completed: [],
          notes: "Verify once; then stop",
          note: "Fixture check reviewed",
        }),
      };
      yield { type: "finish", reason: "tool_calls" };
      return;
    }
    if (++workerCalls % 2 === 1) {
      yield {
        type: "tool_call_delta",
        index: 0,
        idDelta: `check-${workerCalls}`,
        nameDelta: "run_command",
        argumentsDelta: JSON.stringify({
          argv: [process.execPath, "run", "check"],
        }),
      };
      yield { type: "finish", reason: "tool_calls" };
    } else {
      yield { type: "text_delta", delta: "The fixture check passed." };
      yield { type: "finish", reason: "stop" };
    }
  },
});
writeFileSync(
  join(f.workspace, "package.json"),
  JSON.stringify({ scripts: { check: "bun -e \"console.log('CHECK_OK')\"" } }),
);
const packaged=process.argv.includes("--packaged");
const entry=packaged ? join(f.root,"packaged-host.ts") : resolve(import.meta.dir,"terminal.ts");
if (packaged) writeFileSync(entry, `const child=Bun.spawn([${JSON.stringify(resolve("dist/graphics/host"))},...process.argv.slice(2)],{stdin:"inherit",stdout:"inherit",stderr:"inherit",env:{...process.env,DEMESNE_GRAPHICS_ROOT:${JSON.stringify(resolve("dist/graphics"))}}});process.exit(await child.exited);`);
const app = new TerminalHarness({
  cell: { width: 8 * density, height: 18 * density },
  entry,
  env: f.env,
  args: [
    "--live",
    `--server=${f.server.url}`,
    `--workspace=${f.workspace}`,
    `--capture-dir=${output}`,
  ],
});
function journal() {
  try { const dir=join(f.home,".demesne/drive"), file=readdirSync(dir).find(file=>file.endsWith(".json")); return file ? JSON.parse(readFileSync(join(dir,file),"utf8")) : undefined; } catch { return undefined; }
}
let current: any;
async function state(check: (state: any) => boolean, label = "state") {
  try {
    await eventually(() => {
      try {
        current = JSON.parse(readFileSync(join(output, "state.json"), "utf8"));
        return check(current);
      } catch {
        return false;
      }
    }, 20000);
  } catch {
    throw new Error(
      `${label} did not settle: ${app.error}\n${JSON.stringify({ ...current?.live, assets: undefined }).slice(-8000)}`,
    );
  }
  return current;
}
const byAction =
  (action: string, args: Record<string, unknown> = {}) =>
  (c: any) =>
    c.action === action &&
    Object.entries(args).every(([k, v]) => JSON.parse(c.args ?? "{}")[k] === v);
async function clickControl(find: (c: any) => boolean) {
  await state((s) => s.live?.controls.some(find), "control");
  let c = current.live.controls.find(find);
  for (let i = 0; i < 12 && c.hit === false; i++) {
    app.write(
      `\x1b[<${c.y > current.height / 2 ? 65 : 64};${1100 * density};${600 * density}M`,
    );
    await Bun.sleep(80);
    await state(() => true);
    c = current.live.controls.find(find);
  }
  app.click(Math.round(c.x * density), Math.round(c.y * density));
  await Bun.sleep(80);
}
const click = (action: string, args: Record<string, unknown> = {}) =>
  clickControl(byAction(action, args));
async function key(value: string) {
  app.write(value);
  await Bun.sleep(80);
}
async function closePanel() {
  if (current.live.pane) {
    await click("close-panel");
    await state((s) => !s.live.pane);
  }
}
// Offscreen full capture and paint can round the outer radius alpha differently
// on Retina. Content stays within 2/255; only the 12px corners allow 6/255.
async function capture(name: string) {
  await Bun.sleep(160);
  try {
    await eventually(async () => {
      try {
        const a = await app.raw(),
          b = await sharp(join(output, "latest.png"))
            .ensureAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true });
        return (
          a.width === b.info.width &&
          a.height === b.info.height &&
          a.data.every((value, i) => {
            const x = Math.floor(i / 4) % a.width,
              y = Math.floor(i / 4 / a.width),
              corner =
                (x < 12 * density || x >= a.width - 12 * density) &&
                (y < 12 * density || y >= a.height - 12 * density);
            return Math.abs(value - b.data[i]!) <= (corner ? 6 : 2);
          })
        );
      } catch {
        return false;
      }
    }, 5000);
  } catch (error) {
    await app.png(join(output, `${name}-mismatch.png`));
    throw new Error(`Pixels did not settle: ${name}`);
  }
  await app.png(join(output, `${name}.png`));
  console.log(`✓ ${name}`);
}
try {
  await app.after(0);
  await state((s) => s.live?.connection === "online");
  // A standing note for Drive's project memory, shown in Session.
  app.paste("/drive remember Keep the CLI clean");
  await key("\r");
  await state((s) => s.live.driveMemory?.some((item: any) => item.text === "Keep the CLI clean" && item.source === "you"), "remembered note");
  app.paste("/drive --bounded Verify the fixture check");
  await key("\r");
  await state((s) => s.live.approvals === 1, "Drive worker approval");
  // Approving the tool is not a takeover: Drive keeps running on its own.
  await click("permission", { decision: "allow_once" });
  await eventually(()=>journal()?.status === "completed",20000);
  // The verified task is recorded in project memory for later missions.
  await state((s) => s.live.driveMemory?.some((item: any) => item.kind === "outcome" && item.source === "drive"), "recorded outcome");
  await key("\x1bj");
  await click("panel", { name: "history" });
  await state((s) => s.live.pane === "history");
  await capture("session-memory");
  await closePanel();
  await key("\x1bj");
  await state(
    (s) =>
      s.live.pane === "drive" && s.live.driveTasks?.[0]?.status === "completed",
  );
  assert.equal(current.live.driveMode, "bounded");
  assert.equal(current.live.driveTasks[0].completions, 1);
  assert(
    !current.live.controls.some(
      byAction("drive-control", { control: "resume" }),
    ),
  );
  await capture("bounded-completion");
  // Done lists the finished mission first, then what Drive recorded.
  await clickControl(byAction("drive-tab", { tab: "done" }));
  await state((s) => /Mission complete|Review changes/.test(s.live.text) && s.live.controls.some(byAction("panel", { name: "changes" })), "Done tab");
  assert(current.live.driveMemory.some((item: any) => item.kind === "outcome"), "the outcome is recorded");
  await capture("drive-done");
  await clickControl(byAction("drive-tab", { tab: "next" }));
  const id = current.live.driveTasks[0].id,
    session = current.live.sessionId;
  await Bun.sleep(2500);
  assert.equal(
    (await f.client.getSessionState(session)).session.turns.length,
    1,
  );
  await click("close-panel");
  app.paste("/drive resume");
  await key("\r");
  await state((s) => s.live.text.includes("This Drive mission is complete"));
  assert.equal(
    (await f.client.getSessionState(session)).session.turns.length,
    1,
  );
  await click("close-panel");
  await key("\x7f".repeat(100));
  app.paste(
    `/drive reopen ${id.slice(0, 8)} Check again as explicitly requested`,
  );
  await key("\r");
  await state((s) => s.live.approvals === 1, "Reopened worker approval");
  await click("permission", { decision: "allow_once" });
  await key("\x1bj");
  await eventually(()=>journal()?.status === "completed" && journal()?.ledger.tasks[0].completions.length === 2,20000);
  await key("\x1bj");
  await capture("explicit-reopen-history");
  assert.equal(
    (await f.client.getSessionState(session)).session.turns.length,
    2,
  );
  app.write("\x11");
  assert.equal(await app.child.exited, 0);
  assert(app.restored);
  console.log(
    JSON.stringify({
      result: "passed",
      screenshots: output,
      checked: [
        "bounded mission completion", "Done tab lists the mission and outcomes",
        "acceptance criteria",
        "recorded check facts",
        "no automatic repeat",
        "no resume after completion",
        "explicit reopen retains history",
      ],
    }),
  );
} finally {
  app.kill();
  await f.close();
}
