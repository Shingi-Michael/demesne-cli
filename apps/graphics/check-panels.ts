import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { fixture, eventually } from "./test/fixture.ts";
import { TerminalHarness } from "./test/terminal-harness.ts";
const output = resolve(process.argv[2] ?? "/tmp/demesne-panel-review-check");
mkdirSync(output, { recursive: true });
const density = process.argv.includes("--retina") ? 2 : 1;
let round = 0;
const f = await fixture(
  {
    providerId: "test",
    modelId: "panel-test",
    async listModels() {
      return [];
    },
    async *stream() {
      const operations = [
        {
          name: "edit_file",
          input: {
            path: "multi.ts",
            edits: [
              { oldText: "// line 5\n", newText: "// updated five\n" },
              { oldText: "// line 25\n", newText: "// updated twenty-five\n" },
            ],
          },
        },
        {
          name: "run_command",
          input: { argv: [process.execPath, "run", "check"] },
        },
        {
          name: "run_command",
          input: {
            argv: [
              process.execPath,
              "-e",
              "console.log('SERVER_READY');setInterval(()=>{},1000)",
            ],
            background: true,
          },
        },
        { name: "view_image", input: { path: "actual.png" } },
      ];
      const operation = operations[round++];
      if (operation) {
        yield {
          type: "tool_call_delta",
          index: 0,
          idDelta: `operation-${round}`,
          nameDelta: operation.name,
          argumentsDelta: JSON.stringify(operation.input),
        };
        yield { type: "finish", reason: "tool_calls" };
      } else {
        yield {
          type: "text_delta",
          delta:
            "The edits are ready to review. The check completed; the background server is running.",
        };
        yield { type: "finish", reason: "stop" };
      }
    },
  },
  { vision: true },
);
const original =
  Array.from({ length: 50 }, (_, i) => `// line ${i + 1}`).join("\n") + "\n";
writeFileSync(join(f.workspace, "multi.ts"), original);
writeFileSync(join(f.workspace, ".gitignore"), ".release\n");
writeFileSync(
  join(f.workspace, "package.json"),
  JSON.stringify({ scripts: { check: "bun check.ts" } }),
);
writeFileSync(
  join(f.workspace, "check.ts"),
  "import {existsSync} from 'node:fs';console.log('CHECK_STARTED');while(!existsSync('.release'))await Bun.sleep(25);console.log('CHECK_PASSED');\n",
);
await sharp({
  create: { width: 1800, height: 1000, channels: 3, background: "#5aa9e6" },
})
  .png()
  .toFile(join(f.workspace, "actual.png"));
await sharp({
  create: { width: 1800, height: 1000, channels: 3, background: "#4cc38a" },
})
  .png()
  .toFile(join(f.workspace, "reference.png"));
const git = (...args: string[]) =>
  execFileSync("git", ["-C", f.workspace, ...args], { stdio: "pipe" });
git("init", "-q");
git("add", ".");
git(
  "-c",
  "user.name=Panel Test",
  "-c",
  "user.email=test@example.com",
  "commit",
  "-qm",
  "Initial",
);
const app = new TerminalHarness({
  cell: { width: 8 * density, height: 18 * density },
  entry: resolve(import.meta.dir, "terminal.ts"),
  env: f.env,
  args: [
    "--live",
    `--server=${f.server.url}`,
    `--workspace=${f.workspace}`,
    `--capture-dir=${output}`,
  ],
});
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
    }, 10000);
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
  app.paste(
    "Edit multi.ts, run the check, start the server and show actual.png",
  );
  await key("\r");
  await state((s) => s.live.approvals === 1);
  await click("permission", { decision: "allow_once" });
  await state(
    (s) => s.live.approvals === 1 && s.live.text.includes("run_command"),
  );
  await click("permission", { decision: "allow_once" });
  await key("\x02");
  await state((s) => s.live.pane === "log");
  await click("command-tab", { tab: "running" });
  await state(
    (s) =>
      s.live.processes.some(
        (c: any) =>
          c.status === "running" && c.stdout.includes("CHECK_STARTED"),
      ),
    "live output",
  );
  await capture("live-command-output");
  writeFileSync(join(f.workspace, ".release"), "go");
  await state((s) => s.live.approvals === 1);
  await click("permission", { decision: "allow_once" });
  await state((s) => s.live.runs.at(-1)?.status === "completed");
  const server = current.live.processes.find(
    (c: any) => c.background && c.status === "running",
  );
  assert(server);
  await click("command-select", { id: server.id });
  await state((s) => s.live.text.includes("SERVER_READY"));
  await click("stop-command", { id: server.id });
  await state(
    (s) =>
      s.live.processes.find((c: any) => c.id === server.id)?.status ===
      "stopped",
  );
  await capture("stopped-background-command");
  await closePanel();
  await click("panel", { name: "verification" });
  await state(
    (s) =>
      s.live.pane === "verification" &&
      s.live.processes.some((c: any) => c.check && c.freshness === "current"),
  );
  await capture("verification-current");
  writeFileSync(
    join(f.workspace, "README.md"),
    "External edit after testing\n",
  );
  await state(
    (s) =>
      s.live.processes.some((c: any) => c.check && c.freshness === "outdated"),
    "outdated verification",
  );
  await capture("verification-outdated");
  const check = current.live.processes.find((c: any) => c.check);
  await click("rerun-check", { id: check.id });
  await state((s) =>
    s.live.processes.some(
      (c: any) =>
        c.check &&
        c.id !== check.id &&
        c.status === "completed" &&
        c.freshness === "current",
    ),
  );
  await capture("verification-rerun");
  await closePanel();
  await click("panel", { name: "changes" });
  await state((s) => s.live.reviewPaths.includes("multi.ts"));
  await capture("turn-diff");
  await click("source-location", { path: "multi.ts", line: 5 });
  await state(
    (s) =>
      s.live.pane === "files" &&
      s.live.fileView.path === "multi.ts" &&
      s.live.fileView.line === 5,
  );
  await capture("diff-to-source");
  await click("panel", { name: "changes" });
  await state(
    (s) => s.live.pane === "changes" && s.live.reviewPaths.includes("multi.ts"),
  );
  await click("review-mode", { mode: "before" });
  await state((s) => s.live.reviewMode === "before");
  await capture("full-before");
  await click("review-mode", { mode: "diff" });
  // Hunk navigation is keyboard-only now (the key footer is gone).
  await key("]");
  await click("review-scope", { scope: "workspace" });
  await state(
    (s) =>
      s.live.reviewScope === "workspace" &&
      s.live.reviewPaths.includes("README.md"),
  );
  await capture("workspace-scope");
  await click("review-scope", { scope: "session" });
  await state(
    (s) => s.live.reviewScope === "session" && s.live.reviewPaths.length === 1,
  );
  await capture("session-scope");
  await click("review-undo");
  await state((s) => s.live.overlay === "confirm-undo");
  await click("review-undo-confirm");
  await state((s) => !s.live.overlay && s.live.text.includes("reverted"));
  assert.equal(readFileSync(join(f.workspace, "multi.ts"), "utf8"), original);
  await capture("file-undone");
  await closePanel();
  // Images live under Files.
  await click("panel", { name: "files" });
  await click("panel", { name: "preview" });
  await state(
    (s) => s.live.pane === "preview" && s.live.previewGeometry?.imageWidth > 0,
  );
  await click("preview-zoom", { zoom: 1 });
  await state((s) => s.live.previewZoom === 1 && !s.live.previewFit);
  assert.equal(current.live.previewGeometry.imageWidth, 1800 / density);
  await capture("preview-100-percent");
  const canvas = current.live.controls.find(
    (c: any) => c.tag === "DIV" && c.width > 400 && c.label == null,
  );
  const x = 1000 * density,
    y = 300 * density;
  app.write(
    `\x1b[<0;${x};${y}M\x1b[<32;${x - 150 * density};${y}M\x1b[<0;${x - 150 * density};${y}m`,
  );
  await state((s) => s.live.previewGeometry.left > 100);
  await capture("preview-panned");
  await clickControl((c) => c.id === "reference-path");
  app.paste("reference.png");
  await clickControl((c) => c.id === "reference-width");
  app.paste("900");
  await clickControl((c) => c.id === "reference-height");
  app.paste("500");
  await key("\r");
  await state((s) => s.live.referenceImage && s.live.previewCompare);
  await capture("reference-overlay");
  await click("preview-fit");
  await state((s) => s.live.previewFit);
  await capture("reference-fit");
  const width = current.live.panelWidth;
  await clickControl((c) => c.label === "Resize panel");
  const grip = current.live.controls.find(
    (c: any) => c.label === "Resize panel",
  );
  app.write(
    `\x1b[<0;${Math.round(grip.x * density)};${250 * density}M\x1b[<32;${Math.round((grip.x - 80) * density)};${250 * density}M\x1b[<0;${Math.round((grip.x - 80) * density)};${250 * density}m`,
  );
  await state((s) => s.live.panelWidth > width + 50);
  await capture("resized-panel");
  const savedWidth = JSON.parse(
    readFileSync(join(f.home, ".demesne/graphics-ui.json"), "utf8"),
  ).panelWidth;
  assert(savedWidth > width + 50);
  app.write("\x11");
  assert.equal(await app.child.exited, 0);
  assert(app.restored);
  console.log(
    JSON.stringify({
      result: "passed",
      screenshots: output,
      checked: [
        "live stdout before exit",
        "individual command stop",
        "outdated verification",
        "exact rerun",
        "three review scopes",
        "full-file context",
        "per-file undo",
        "100% image zoom",
        "reference import and overlay",
        "persisted panel width",
      ],
    }),
  );
} finally {
  app.kill();
  await f.close();
}
