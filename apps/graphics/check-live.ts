import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { TerminalHarness } from "./test/terminal-harness.ts";
import { fixture, eventually } from "./test/fixture.ts";
import { warmOlive } from "../../packages/brand/test/theme-fixture.ts";

const directory = resolve(
  process.argv[2] ?? "/tmp/demesne-graphics-live-check",
);
mkdirSync(directory, { recursive: true });
let round = 0,
  driveDecisions = 0;
const traceUpdate=Promise.withResolvers<void>(), traceFinish=Promise.withResolvers<void>(), checkTraceFinish=Promise.withResolvers<void>();
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
      if (_tools.some(tool=>tool.name === "apply_theme")) {
        const answers=_messages.filter(m=>m.role === "tool");
        const name=answers.length<2?"ask_user":"apply_theme";
        yield {type:"tool_call_delta",index:0,idDelta:"themefy-"+answers.length,nameDelta:name,argumentsDelta:JSON.stringify(answers.length<2?
          {mode:"interview",questions:[{question:answers.length?"For that warm mood, which accent colors?":"What mood and appearance should your theme have?"}]}:warmOlive)};
        yield {type:"finish",reason:"tool_calls"};return;
      }
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
        await traceUpdate.promise;
        yield {type:"reasoning_delta",delta:"\n\nThe trace continues beneath the thinking header, including a longer explanation that wraps across multiple lines instead of being truncated beside the spinner."};
        await traceFinish.promise;
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
        yield {type:"reasoning_delta",delta:"**Checking the export**\n\nI will run the fixture check now."};
        await checkTraceFinish.promise;
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
async function click(action: string, args?: Record<string, unknown>, label?: string) {
  await state(
    (s) =>
      s.live?.controls.some(
        (c: any) =>
          c.action === action &&
          (!label || c.label.startsWith(label)) &&
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
      (!label || c.label.startsWith(label)) &&
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
  await click("choose-row", undefined, "Model");
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
  await state(s=>s.live.thinking?.[0]?.live && s.live.thinking[0].open,"expanded live thinking");
  let trace=current.live.thinking[0];
  assert(!trace.summary.includes("I will"),"reasoning stays out of the thinking header");
  assert(trace.bodyTop>trace.headerBottom,"the trace renders below its header");
  await capture("thinking-live");
  app.click(Math.round(trace.x),Math.round(trace.y));
  await state(s=>!s.live.thinking[0].open,"manually collapsed thinking");
  traceUpdate.resolve();
  await state(s=>s.live.thinking[0].body.includes("trace continues"),"reasoning update");
  assert(!current.live.thinking[0].open,"new chunks respect manual collapse");
  trace=current.live.thinking[0];app.click(Math.round(trace.x),Math.round(trace.y));
  await state(s=>s.live.thinking[0].open,"reopened thinking");
  await capture("thinking-expanded");
  traceFinish.resolve();
  await state((s) => s.live.approvals === 1, "write approval");
  assert(current.live.thinking[0].open,"explicitly expanded traces stay open after thinking finishes");
  await capture("approval-write");
  trace=current.live.thinking[0];app.click(Math.round(trace.x),Math.round(trace.y));
  await state(s=>!s.live.thinking[0].open,"fold completed trace before checking panels");
  await click("permission", { decision: "allow_once" });
  await state(s=>s.live.thinking?.[1]?.live && s.live.thinking[1].open,"second live trace");
  assert(!current.live.thinking[1].summary.includes("Checking the export"),"summary headings also stay below the header");
  checkTraceFinish.resolve();
  await state(
    (s) =>
      s.live.approvals === 1 && s.live.text.includes("Allow this command?"),
  );
  await capture("approval-command");
  assert(!current.live.thinking[1].open,"untouched traces fold when thinking finishes");
  await click("permission", { decision: "allow_once" });
  await state((s) => s.live.questions === 1, "question");
  await capture("question");
  assert(!current.live.controls.some((input: any)=>input.name === "0"),"questions use the main composer");
  const composer=current.live.controls.find((input: any)=>input.tag === "TEXTAREA");
  assert(composer && !composer.disabled,"the composer accepts typed answers");
  app.click(Math.round(composer.x),Math.round(composer.y));
  app.paste("hello");app.write("\r");
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
    // Drill-downs open from their place: Checks from Review, Image from
    // Files; the step log also opens with Ctrl+B.
    if (pane === "log") await key("\x02");
    else if (pane === "verification") {
      // Wait for Review before the next click: opening it reflows the page.
      await click("panel", { name: "changes" });
      await state((s) => s.live.pane === "changes");
      await click("panel", { name: "verification" });
    } else if (pane === "preview") {
      await click("panel", { name: "files" });
      await state((s) => s.live.pane === "files");
      await click("panel", { name: "preview" });
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
  // Missions start from the composer (the panel has no mission form). The
  // composer moves as the panel opens, so click it from fresh coordinates
  // until the text lands there.
  const missionText = "/drive --continuous Review this result";
  for (let attempt = 0; attempt < 5; attempt++) {
    await Bun.sleep(150);
    await state(() => true);
    const composer = current.live.controls.find((c: any) => c.tag === "TEXTAREA");
    app.click(Math.round(composer.x), Math.round(composer.y));
    app.paste(missionText);
    try { await state((s) => s.live.controls.some((c: any) => c.tag === "TEXTAREA" && c.value === missionText), "mission typed"); break; }
    catch { if (attempt === 4) throw new Error("The mission never reached the composer"); }
  }
  await key("\r");
  await state((s) => s.live.runs.length === 3, "Drive composer submission");
  if (current.live.pane !== "drive") {
    await click("panel", { name: "drive" });
    await state((s) => s.live.pane === "drive");
  }
  // Pause while the mission is certainly live: once the worker finishes,
  // Drive may review it and block (which offers Resume, not Pause).
  await state((s) => ["running", "waiting"].includes(s.live.drive), "Drive live");
  await capture("drive-live");
  await click("drive-control", { control: "pause" });
  await state((s) => s.live.drive === "paused", "Drive paused");
  await state(
    (s) => s.live.runs.at(-1)?.status === "completed",
    "Drive worker completion",
  );
  await capture("drive-paused");
  await click("close-panel");
  await state((s) => !s.live.pane);
  await key("\x0b");
  await state((s) => s.live.overlay === "settings");
  await click("choose-row", undefined, "Provider setup");
  await state(
    (s) => s.live.setup?.step === "provider" && s.live.setup.probes !== null,
  );
  await capture("setup-provider");
  const custom = current.live.controls.find((control: any) => control.action === "setup-action" && control.label.includes("Custom URL"));
  assert(custom, "Custom URL option is visible");
  await click("setup-action", { index: JSON.parse(custom.args).index });
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
  // The same renderer used by Ghostty and the desktop consumes Themefy's
  // ordinary composer answers, then swaps tokens in the running page.
  const newComposer=current.live.controls.find((c:any)=>c.tag === "TEXTAREA");
  app.click(Math.round(newComposer.x),Math.round(newComposer.y));app.paste("/new");await key("\r");
  await state(s=>!s.live.runs.length && !s.value,"fresh theme session");
  app.paste("/themefy");await key("\r");
  await state(s=>s.live.questions === 1,"theme interview");
  await capture("themefy-question");
  for(const text of ["warm dark colours","muted olive with soft gold"]) {
    await state(s=>s.live.questions === 1);
    const composer=current.live.controls.find((c:any)=>c.tag === "TEXTAREA");
    app.click(Math.round(composer.x),Math.round(composer.y));app.paste(text);await key("\r");
    await state(s=>!s.live.questions || s.live.text.includes("which accent"));
  }
  await state(s=>s.live.runs.at(-1)?.status === "completed" && s.live.theme?.startsWith("custom-"),"theme applied");
  await capture("themefy-applied");
  const themeComposer=current.live.controls.find((c:any)=>c.tag === "TEXTAREA");
  app.click(Math.round(themeComposer.x),Math.round(themeComposer.y));app.paste("/theme");await key("\r");
  await state(s=>s.live.overlay === "themes" && s.live.text.includes("Olive & Gold"),"saved theme picker");
  await capture("themefy-saved");
  await click("choose-row",undefined,"Undo last theme change");
  await state(s=>!s.live.overlay && s.live.theme === "demesne","theme undo");
  await capture("themefy-undo");
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
  traceUpdate.resolve();traceFinish.resolve();checkTraceFinish.resolve();
  app.kill();
  await f.close();
}
