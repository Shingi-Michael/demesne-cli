import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { TerminalHarness } from "./test/terminal-harness.ts";
import { fixture, eventually } from "./test/fixture.ts";

const directory = resolve(
  process.argv[2] ?? "/tmp/demesne-graphics-live-check",
);
mkdirSync(directory, { recursive: true });
let round = 0,
  driveDecisions = 0;
const f = await fixture(
  {
    providerId: "test",
    modelId: "qwen3.8-27b",
    contextCapacity: 262144,
    async listModels() {
      return [
        { id: "qwen3.8-27b", provider: "test", contextWindow: 262144 },
        { id: "qwen3.8-9b", provider: "test", contextWindow: 131072 },
      ];
    },
    async *stream(_messages, _tools, signal) {
      if (_tools.some((tool) => tool.name === "drive_ui")) {
        const action =
          ++driveDecisions === 1
            ? { kind: "compose", text: "Review the result" }
            : { kind: "wait" };
        yield {
          type: "tool_call_delta",
          index: 0,
          idDelta: "drive",
          nameDelta: "drive_ui",
          argumentsDelta: JSON.stringify({
            action,
            note: "Review the recorded work",
            notes: "Review the result",
            completed: [],
            remaining: ["Review"],
            evidence: [],
          }),
        };
        yield { type: "finish", reason: "tool_calls" };
        return;
      }
      round++;
      if (round === 1) {
        yield {
          type: "reasoning_delta",
          delta: "I will add the module, then check the exported value.",
        };
        await Bun.sleep(150);
        yield {
          type: "tool_call_delta",
          index: 0,
          idDelta: "write",
          nameDelta: "write_file",
          argumentsDelta: JSON.stringify({
            path: "hello.ts",
            content: "export const hello = 1;\n",
          }),
        };
        yield { type: "finish", reason: "tool_calls" };
      } else if (round === 2) {
        yield {
          type: "tool_call_delta",
          index: 0,
          idDelta: "check",
          nameDelta: "run_command",
          argumentsDelta: JSON.stringify({
            argv: [process.execPath, "test", "hello.test.ts"],
          }),
        };
        yield { type: "finish", reason: "tool_calls" };
      } else if (round === 3) {
        yield {
          type: "tool_call_delta",
          index: 0,
          idDelta: "ask",
          nameDelta: "ask_user",
          argumentsDelta: JSON.stringify({
            questions: [
              {
                question: "Which name should the example use?",
                reason: "Both names match the module.",
                suggestions: ["hello", "greeting"],
              },
            ],
          }),
        };
        yield { type: "finish", reason: "tool_calls" };
      } else if (round === 4) {
        yield {
          type: "tool_call_delta",
          index: 0,
          idDelta: "image",
          nameDelta: "view_image",
          argumentsDelta: JSON.stringify({ path: "sample.png" }),
        };
        yield { type: "finish", reason: "tool_calls" };
      } else if (round === 6) {
        await new Promise<void>((r) =>
          signal.addEventListener("abort", () => r(), { once: true }),
        );
        signal.throwIfAborted();
      } else {
        for (const delta of [
          "Added the module and verified the exported value.\n\n",
          "```ts\nexport const hello = 1;\n```\n\n",
          "| File | Result |\n| --- | --- |\n| hello.ts | Created |\n\n",
          "The verification command passed.\n\n<script>document.body.innerHTML='unsafe'</script>",
        ]) {
          yield { type: "text_delta", delta };
          await Bun.sleep(40);
        }
        yield {
          type: "usage",
          usage: { inputTokens: 2048, outputTokens: 96, totalTokens: 2144 },
        };
        yield { type: "finish", reason: "stop" };
      }
    },
  },
  { vision: true },
);
writeFileSync(
  join(f.workspace, "hello.test.ts"),
  'import {test,expect} from "bun:test"; import {hello} from "./hello.ts"; test("export",()=>expect(hello).toBe(1));\n',
);
await sharp({
  create: {
    width: 420,
    height: 240,
    channels: 4,
    background: { r: 90, g: 169, b: 230, alpha: 1 },
  },
})
  .png()
  .toFile(join(f.workspace, "sample.png"));
const launcher = process.argv.includes("--launcher");
const app = new TerminalHarness({
  entry: resolve(
    import.meta.dir,
    launcher ? "../cli/src/main.ts" : "terminal.ts",
  ),
  env: f.env,
  args: [
    ...(launcher
      ? ["graphics", "--server", f.server.url.href, "--workspace", f.workspace]
      : ["--live", `--server=${f.server.url}`, `--workspace=${f.workspace}`]),
    `--capture-dir=${directory}`,
  ],
});
let current: any;
async function state(check: (s: any) => boolean, label = "state") {
  try {
    await eventually(() => {
      try {
        current = JSON.parse(
          readFileSync(join(directory, "state.json"), "utf8"),
        );
        return check(current);
      } catch {
        return false;
      }
    }, 10000);
  } catch {
    throw new Error(
      `${label} did not settle: ${app.error}\n${JSON.stringify(current?.live).slice(0, 4000)}`,
    );
  }
  return current;
}
async function click(action: string, args?: Record<string, unknown>) {
  await state(
    (s) =>
      s.live?.controls.some(
        (c: any) =>
          c.action === action &&
          (!args ||
            Object.entries(args).every(
              ([k, v]) => JSON.parse(c.args ?? "{}")[k] === v,
            )),
      ),
    `control ${action}`,
  );
  const c = current.live.controls.find(
    (c: any) =>
      c.action === action &&
      (!args ||
        Object.entries(args).every(
          ([k, v]) => JSON.parse(c.args ?? "{}")[k] === v,
        )),
  );
  app.click(Math.round(c.x), Math.round(c.y));
}
// Chromium can round antialiased border channels differently on a fresh full capture.
// Every channel must match within 2/255; structural or stale-pixel differences fail.
async function capture(name: string) {
  await Bun.sleep(180);
  try {
    await eventually(async () => {
      try {
        const actual = await app.raw(),
          expected = await sharp(join(directory, "latest.png"))
            .ensureAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true });
        return (
          actual.width === expected.info.width &&
          actual.height === expected.info.height &&
          actual.data.every(
            (value, index) => Math.abs(value - expected.data[index]!) <= 2,
          )
        );
      } catch {
        return false;
      }
    }, 6000);
  } catch (error) {
    await app.png(join(directory, `${name}-mismatch.png`));
    throw new Error(`Pixel mismatch: ${name}`);
  }
  await app.png(join(directory, `${name}.png`));
  console.log(`✓ ${name}`);
}
async function key(sequence: string) {
  app.write(sequence);
  await Bun.sleep(80);
}
try {
  await app.after(0);
  await state((s) => s.live?.connection === "online" && s.live?.sessionId);
  await capture("start");
  await key("\t");
  await state((s) => s.live.overlay === "settings");
  await capture("settings");
  await click("choose-row", { index: 1 });
  await state(
    (s) => s.live.overlay === "models" && s.live.text.includes("qwen3.8-9b"),
  );
  await capture("models");
  await key("\x1b");
  await state((s) => !s.live.overlay);
  app.paste("/");
  await state((s) => s.live.text.includes("commands") && s.value === "/");
  await capture("slash");
  await key("\x1b\x7f");
  app.paste("@READ");
  await state((s) =>
    s.live.controls.some((c: any) => c.action === "completion"),
  );
  await capture("mentions");
  await key("\t");
  await state((s) => s.value === "@README.md ");

  await key("\x7f".repeat(100));
  app.paste("Create hello.ts and verify it");
  await key("\r");
  await state((s) => s.live.approvals === 1, "write approval");
  await capture("approval-write");
  await click("permission", { decision: "allow_once" });
  await state(
    (s) =>
      s.live.approvals === 1 && s.live.text.includes("Allow this command?"),
  );
  await capture("approval-command");
  await click("permission", { decision: "allow_once" });
  await state((s) => s.live.questions === 1, "question");
  await capture("question");
  await click("suggest-answer", { index: 0, value: "hello" });
  await state((s) =>
    s.live.controls.some((c: any) => c.label?.includes("Answer")),
  );
  const answer = current.live.controls.find(
    (c: any) => c.tag === "BUTTON" && c.label?.includes("Answer"),
  );
  app.click(Math.round(answer.x), Math.round(answer.y));
  await state((s) => s.live.runs.at(-1)?.status === "completed", "completion");
  await capture("answer");
  assert(current.live.text.includes("<script>"));
  assert(!current.live.text.startsWith("unsafe"));
  for (const pane of [
    "changes",
    "log",
    "verification",
    "files",
    "history",
    "context",
    "preview",
    "drive",
  ]) {
    if (current.live.pane) {
      if (!current.live.controls.some((c: any) => c.action === "close-panel")) {
        await key("\x1b");
        await state((s) =>
          s.live.controls.some((c: any) => c.action === "close-panel"),
        );
      }
      await click("close-panel");
      await state((s) => !s.live.pane);
    }
    if (pane === "log") await key("\x02");
    else if (pane === "verification") {
      await click("panel", { name: "verification" });
    } else await click("panel", { name: pane });
    await state((s) => s.live.pane === pane);
    if (pane === "changes")
      await state(
        (s) =>
          s.live.text.includes("hello.ts") &&
          s.live.text.includes("export const"),
      );
    if (pane === "preview")
      await state(
        (s) =>
          s.live.text.includes("sample.png") &&
          !s.live.text.includes("Loading image"),
      );
    await capture(pane);
    if (pane === "preview") {
      await click("pin-image");
      await state((s) => s.live.text.includes("pinned"));
      await capture("preview-pinned");
    }
    if (pane === "log") {
      await click("log-entry", { index: 2 });
      await state((s) => s.live.text.includes("OUTPUT"));
      await capture("log-detail");
    }
  }
  await click("close-panel");
  await state((s) => !s.live.pane);
  const editor = current.live.controls.find((c: any) => c.tag === "TEXTAREA");
  app.click(Math.round(editor.x), Math.round(editor.y));
  app.paste("Hold for cancellation");
  await key("\r");
  await state((s) => s.live.activeTurnId && s.live.runs.length === 2);
  app.paste("Retain this follow-up");
  await state((s) => s.live.queue === "Retain this follow-up");
  await capture("queue");
  await key("\r");
  assert.equal(round, 6);
  await key("\x1b");
  await key("\x1b");
  await state(
    (s) =>
      s.live.runs.at(-1)?.status === "cancelled" &&
      s.value === "Retain this follow-up",
  );
  await capture("restored");
  await click("clear-queue");
  await state((s) => s.value === "");
  await click("panel", { name: "drive" });
  await state((s) => s.live.pane === "drive");
  const mission = current.live.controls.find((c: any) => c.name === "mission");
  app.click(Math.round(mission.x), Math.round(mission.y));
  app.paste("Review this result");
  await key("\r");
  await state((s) => s.live.runs.length === 3, "Drive composer submission");
  await state(
    (s) => s.live.runs.at(-1)?.status === "completed",
    "Drive worker completion",
  );
  await capture("drive-live");
  if (current.live.pane !== "drive") {
    await click("panel", { name: "drive" });
    await state((s) => s.live.pane === "drive");
  }
  if (current.live.drive !== "paused")
    await click("drive-control", { control: "pause" });
  await state((s) => s.live.drive === "paused");
  await capture("drive-paused");
  await click("close-panel");
  await state((s) => !s.live.pane);
  await key("\x0b");
  await state((s) => s.live.overlay === "settings");
  await click("choose-row", { index: 5 });
  await state(
    (s) => s.live.setup?.step === "provider" && s.live.setup.probes !== null,
  );
  await capture("setup-provider");
  await click("setup-action", { index: 4 });
  await key("\r");
  await state((s) => s.live.setup?.step === "custom");
  await capture("setup-custom");
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () =>
      Response.json({ data: [{ id: "fixture-model", context_length: 32768 }] }),
  });
  try {
    app.paste(`${provider.url}v1`);
    await state((s) => s.live.setup?.customResult?.reachable);
    await key("\r");
    await state((s) => s.live.setup?.step === "model");
    await capture("setup-model");
    await key("\r");
    await state((s) => s.live.setup?.step === "review");
    await capture("setup-review");
    await key("\r");
    await state((s) => s.live.setup?.step === "done");
    await capture("setup-done");
    assert(
      readFileSync(join(f.home, ".demesne/config.toml"), "utf8").includes(
        "fixture-model",
      ),
    );
  } finally {
    await provider.stop(true);
  }
  await key("q");
  await state((s) => !s.live.setup);
  app.resize(100, 34);
  await state((s) => s.width === 800 && s.height === 612);
  await capture("resized");
  app.write("\x11");
  assert.equal(await app.child.exited, 0);
  assert(app.restored);
  assert.equal(app.images.size, 0);
  console.log(
    JSON.stringify({
      result: "passed",
      screenshots: directory,
      rounds: round,
      frames: app.batches,
    }),
  );
} finally {
  app.kill();
  await f.close();
}
