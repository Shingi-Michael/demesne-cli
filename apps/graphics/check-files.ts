import assert from "node:assert/strict";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  mkdirSync as mkdir,
  unlinkSync,
} from "node:fs";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { fixture, eventually } from "./test/fixture.ts";
import { TerminalHarness } from "../../experiments/ghostty-ui/test/terminal-harness.ts";
const output = resolve(process.argv[2] ?? "/tmp/demesne-files-check");
mkdirSync(output, { recursive: true });
const density = process.argv.includes("--retina") ? 2 : 1;
let calls = 0;
let received = "";
const f = await fixture({
  providerId: "test",
  modelId: "files-test",
  async listModels() {
    return [];
  },
  async *stream(messages) {
    if (++calls === 1) {
      yield {
        type: "tool_call_delta",
        index: 0,
        idDelta: "check",
        nameDelta: "run_command",
        argumentsDelta: JSON.stringify({
          argv: [process.execPath, "run", "check"],
        }),
      };
      yield { type: "finish", reason: "tool_calls" };
    } else {
      if (calls > 2) {
        received = JSON.stringify(
          messages.filter((message) => message.role === "user").at(-1),
        );
        for (let i = 0; i < 60; i++) {
          yield { type: "text_delta", delta: "stream " };
          await Bun.sleep(25);
        }
      }
      yield { type: "text_delta", delta: "Check failed at src/math.ts:140:7." };
      yield { type: "finish", reason: "stop" };
    }
  },
});
mkdir(join(f.workspace, "src"));
const source = Array.from({ length: 20000 }, (_, i) =>
  i === 139
    ? "const answer = BAD_VALUE; // needle"
    : i === 140
      ? "// @other.ts"
      : i === 899
        ? "// another needle"
        : `// source line ${i + 1}`,
).join("\n");
writeFileSync(join(f.workspace, "src/math.ts"), source);
writeFileSync(join(f.workspace, "src/other.ts"), "unrelated\n");
writeFileSync(
  join(f.workspace, "package.json"),
  JSON.stringify({ scripts: { check: "bun check.ts" } }),
);
writeFileSync(
  join(f.workspace, "check.ts"),
  "console.error('src/math.ts:140:7: error: BAD_VALUE is not defined');process.exit(1);\n",
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
  app.paste("Run the check");
  await key("\r");
  await state((s) => s.live.approvals === 1);
  await click("permission", { decision: "allow_once" });
  await state((s) => s.live.runs.at(-1)?.status === "completed");
  await key("\x1bt");
  await state((s) => s.live.pane === "verification");
  await state((s) =>
    s.live.controls.some(
      byAction("source-location", { path: "src/math.ts", line: 140 }),
    ),
  );
  await capture("clickable-error");
  await click("source-location", { path: "src/math.ts", line: 140 });
  await state(
    (s) =>
      s.live.fileView?.line === 140 && s.live.fileView?.path === "src/math.ts",
  );
  assert(current.live.fileView.renderedLines < 100);
  await capture("source-location");
  await key("\x06");
  app.paste("needle");
  await state((s) => s.live.fileView.matches === 2);
  await key("\r");
  await state(
    (s) =>
      s.live.fileView.match === 1 && s.live.text.includes("another needle"),
  );
  await capture("source-search");
  await key("\x0c");
  app.paste("140");
  await key("\r");
  await state(
    (s) => s.live.fileView.line === 140 && s.live.text.includes("BAD_VALUE"),
  );
  await key("\x1b[1;2B");
  await key("\x1b[1;2B");
  await state(
    (s) => s.live.fileView.anchor === 140 && s.live.fileView.line === 142,
  );
  await click("file-attach");
  await state((s) => s.live.controls.some((c: any) => c.tag === "TEXTAREA"));
  await Bun.sleep(100);
  const draft = current.live.controls.find(
    (c: any) => c.tag === "TEXTAREA",
  ).value;
  assert(draft.includes("Source: src/math.ts:140-142"));
  assert(draft.includes("BAD_VALUE"));
  assert(!draft.includes("source line 143"));
  await capture("selected-code-attachment");
  await key("\r");
  await state((s) => Boolean(s.live.activeTurnId));
  await clickControl((c) => c.id === "source-search");
  await key("\x06");
  app.paste("BAD_VALUE");
  await state(
    (s) =>
      s.live.fileView.search === "BAD_VALUE" && s.live.fileView.matches === 1,
  );
  await state(
    (s) =>
      s.live.runs.length === 2 && s.live.runs.at(-1)?.status === "completed",
  );
  assert(received.includes("// @other.ts"));
  assert(!received.includes("// @src/other.ts"));
  assert.equal(current.live.fileView.search, "BAD_VALUE");
  assert.equal(current.live.fileView.line, 142);
  await capture("streaming-with-file-open");
  writeFileSync(
    join(f.workspace, "src/math.ts"),
    source.replace("BAD_VALUE", "NEW_VALUE"),
  );
  await state((s) => s.live.fileView.stale.includes("Changed on disk"));
  assert(current.live.text.includes("BAD_VALUE"));
  await capture("changed-on-disk");
  await click("file-reload");
  await state(
    (s) =>
      !s.live.fileView.stale &&
      s.live.text.includes("NEW_VALUE") &&
      s.live.fileView.matches === 0,
  );
  await capture("reloaded-source");
  await click("close-panel");
  await click("panel", { name: "files" });
  await state(
    (s) =>
      s.live.fileView.path === "src/math.ts" && s.live.fileView.line === 142,
  );
  await click("file-back");
  await clickControl((c) => c.id === "file-search");
  app.paste("src math");
  await state((s) => s.live.fileView.listCount === 1);
  await capture("filename-search");
  await key("\r");
  await state((s) => s.live.fileView.path === "src/math.ts");
  await clickControl((c) => c.id === "source-line");
  app.paste("19000");
  await key("\r");
  await state(
    (s) =>
      s.live.fileView.line === 19000 &&
      s.live.text.includes("source line 19000"),
  );
  assert(current.live.fileView.renderedLines < 100);
  await capture("large-file-navigation");
  unlinkSync(join(f.workspace, "src/math.ts"));
  await state((s) => s.live.fileView.stale.includes("Unavailable on disk"));
  assert(current.live.text.includes("source line 19000"));
  await capture("deleted-file-loaded-copy");
  app.write("\x11");
  assert.equal(await app.child.exited, 0);
  assert(app.restored);
  console.log(
    JSON.stringify({
      result: "passed",
      screenshots: output,
      checked: [
        "error location navigation",
        "literal search",
        "go to line",
        "exact range attachment",
        "external edit and deletion detection",
        "explicit reload",
        "remembered file",
        "filename filtering",
        "20,000-line virtualization",
        "stable source during streaming",
        "literal source at model submission",
      ],
    }),
  );
} finally {
  app.kill();
  await f.close();
}
