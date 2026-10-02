/** Browser regression and before/after profiling. Only temporary bundles gain
 * test hooks; the shipped preload and frontend expose no profiling API. */
import assert from "node:assert/strict";
import {
  cpSync,
  mkdtempSync,
  symlinkSync,
  readFileSync,
  rmSync,
  mkdirSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { fixture } from "./test/fixture.ts";
import { GraphicsHost } from "./host.ts";
import { StateEncoder } from "./state-wire.ts";
const output = resolve(process.argv[2] ?? "/tmp/demesne-streaming-check");
mkdirSync(output, { recursive: true });
const f = await fixture(),
  host = new GraphicsHost({
    workspace: f.workspace,
    settings: f.settings,
    client: f.client,
    changed: () => {},
  });
await host.connect();
const base = host.snapshot();
base.session!.createdAt = "2026-10-01T12:00:00Z";
const roots = [{ name: "optimized", path: import.meta.dir }];
const baseline = process.argv
  .find((arg) => arg.startsWith("--baseline="))
  ?.slice(11);
if (baseline) roots.unshift({ name: "baseline", path: resolve(baseline) });
if (!baseline && process.argv.includes("--compare"))
  roots.unshift({
    name: "baseline",
    path: join(
      readFileSync("/tmp/demesne-optimization-baseline-path", "utf8").trim(),
      "apps/graphics",
    ),
  });
const results: any[] = [];
try {
  for (const source of roots) {
    const directory = mkdtempSync(join(tmpdir(), "demesne-stream-profile-"));
    for (const name of [
      "live.html",
      "live.css",
      "ui.css",
      "assets",
      "bridge.cjs",
    ])
      cpSync(join(source.path, name), join(directory, name), {
        recursive: true,
      });
    symlinkSync(
      join(source.path, "node_modules"),
      join(directory, "node_modules"),
    );
    const injected = `\nlet observationCalls=0;const originalObserve=observeUI;observeUI=()=>{observationCalls++;return originalObserve();};globalThis.__check={render:renderState,markdown,report:reportObservation,observe:observeUI,observations:()=>observationCalls${source.name === "optimized" ? ",MarkdownView" : ""}};`;
    const built = await Bun.build({
      entrypoints: [join(source.path, "live.ts")],
      outdir: join(directory, "dist"),
      target: "browser",
      plugins: [
        {
          name: "test-hooks",
          setup(builder) {
            builder.onLoad(
              { filter: /\/graphics\/live\.ts$/ },
              async (args) => ({
                contents:
                  "Date.now=()=>1790856030000;\n" +
                  (await Bun.file(args.path).text()) +
                  injected,
                loader: "ts",
              }),
            );
          },
        },
      ],
    });
    if (!built.success) throw new Error(built.logs.map(String).join("\n"));
    await Bun.write(join(directory, "state.json"), JSON.stringify(base));
    await Bun.write(
      join(directory, "runner.cjs"),
      String.raw`
const {app,BrowserWindow,ipcMain}=require('electron');const{join}=require('node:path');const{readFileSync,writeFileSync}=require('node:fs');
app.disableHardwareAcceleration();app.commandLine.appendSwitch('force-device-scale-factor','1');app.setPath('userData',join(__dirname,'cache'));
const state=JSON.parse(readFileSync(join(__dirname,'state.json'),'utf8'));let onReady;const ready=new Promise(r=>onReady=r);
ipcMain.handle('demesne:request',(_event,request)=>request.method==='bootstrap'?state:null);ipcMain.on('demesne:ready',()=>onReady());
(async()=>{await app.whenReady();app.dock?.hide();const win=new BrowserWindow({width:1200,height:720,show:false,webPreferences:{preload:join(__dirname,'bridge.cjs'),offscreen:true,contextIsolation:true,sandbox:true,nodeIntegration:false,backgroundThrottling:false}});

win.webContents.on('console-message',(_e,level,message)=>{if(level>=2)console.error(message)});win.webContents.on('render-process-gone',(_e,details)=>{console.error(JSON.stringify(details));app.exit(1)});
await win.loadFile(join(__dirname,'live.html'));let readyTimeout;try{await Promise.race([ready,new Promise((_,reject)=>readyTimeout=setTimeout(()=>reject(new Error('UI bootstrap timeout')),10000))]);}finally{clearTimeout(readyTimeout);}await win.webContents.executeJavaScript('document.fonts.ready.then(()=>true)');
const result=await win.webContents.executeJavaScript('('+${browserChecks.toString()}+')('+JSON.stringify(state)+')');
await new Promise(r=>setTimeout(r,220));writeFileSync(process.argv[2],(await win.webContents.capturePage()).toPNG());
console.log(JSON.stringify(result));win.destroy();app.quit();})().catch(error=>{console.error(error);app.exit(1)});
`,
    );
    const electron = join(
      dirname(Bun.resolveSync("electron", import.meta.dir)),
      "dist",
      process.platform === "darwin"
        ? "Electron.app/Contents/MacOS/Electron"
        : "electron",
    );
    const child = Bun.spawn(
      [
        electron,
        join(directory, "runner.cjs"),
        join(output, `${source.name}.png`),
      ],
      {
        env: { HOME: f.home, PATH: process.env.PATH! },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      if (code !== 0) throw new Error(stderr || `Renderer exited (${code})`);
      const result = JSON.parse(stdout.trim());
      results.push({ name: source.name, ...result });
      console.log(JSON.stringify(results.at(-1)));
    } finally {
      child.kill();
      rmSync(directory, { recursive: true, force: true });
    }
  }
  if (roots.length === 2) {
    const a = await sharp(join(output, "baseline.png"))
        .ensureAlpha()
        .raw()
        .toBuffer(),
      b = await sharp(join(output, "optimized.png"))
        .ensureAlpha()
        .raw()
        .toBuffer();
    assert.equal(a.length, b.length);
    let different = 0,
      maximum = 0;
    for (let i = 0; i < a.length; i++) {
      const d = Math.abs(a[i]! - b[i]!);
      maximum = Math.max(maximum, d);
      if (d > 2) different++;
    }
    assert.equal(
      different,
      0,
      `Visual difference: ${different} channels, max ${maximum}`,
    );
    console.log("PASS: unchanged rendered pixels (2/255 antialias tolerance)");
  }
  const encoder = new StateEncoder();
  const initial = {
    ...base,
    revision: 100,
    runs: Array.from({ length: 100 }, (_, i) =>
      sampleRun(i, "x".repeat(10000)),
    ),
  };
  encoder.encode(initial);
  const last = initial.runs.at(-1)!,
    entry = last.entries[0]!;
  const next = {
    ...initial,
    revision: 101,
    runs: [
      ...initial.runs.slice(0, -1),
      {
        ...last,
        entries: [
          { ...entry, raw: "x".repeat(10000) + " new text", revision: 2 },
        ],
      },
    ],
  };
  const transfer = {
    snapshotBytes: Buffer.byteLength(JSON.stringify(next)),
    updateBytes: Buffer.byteLength(JSON.stringify(encoder.encode(next))),
  };
  console.log(JSON.stringify({ transfer }));
  await Bun.write(
    join(output, "results.json"),
    JSON.stringify({ results, transfer }, null, 2) + "\n",
  );
} finally {
  host.dispose();
  await f.close();
}

function sampleRun(index: number, raw: string): any {
  return {
    id: `profile-turn-${index}`,
    number: index + 1,
    content: "Inspect and verify the parser",
    status: "running",
    createdAt: "2026-10-01T12:00:00.000Z",
    completedAt: null,
    planOnly: false,
    entries: [
      {
        id: 1,
        type: "assistant",
        raw,
        streaming: false,
        revision: 1,
        at: "2026-10-01T12:00:00.000Z",
      },
    ],
  };
}
// Stringified into the actual application browser; no imports or outer closure.
async function browserChecks(base: any) {
  const check = (globalThis as any).__check;
  const assert = (value: unknown, label: string) => {
    if (!value) throw new Error(label);
  };
  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const canonical = (element: HTMLElement) => {
    const clone = element.cloneNode(true) as HTMLElement;
    const walker = document.createTreeWalker(clone, NodeFilter.SHOW_COMMENT),
      remove: Node[] = [];
    let n: Node | null;
    while ((n = walker.nextNode())) remove.push(n);
    for (const node of remove) node.parentNode!.removeChild(node);
    return clone.innerHTML;
  };
  let markdownCases = 0;
  if (check.MarkdownView) {
    const documents = [
      "# Heading\n\nHello **bold** and _italic_.\n\nEnd.",
      '[Reference][ref] and ![image][ref].\n\n[ref]: https://example.com "Title"\n',
      "Title\n=====\n\nSecond\n---\n\nAfter\n",
      "| Item | Result |\n| --- | --- |\n| a | **passed** |\n\nLast",
      "```ts\nconst x = '<script>';\n// comment\n```\n\nFinished.",
      "1. first\n2. second\n\n   more in second\n\n3. third\n\nAfter",
      "> quote\n>\n> - list\n> - **bold**\n\nAfter\n",
      "<script>alert('bad')</script>\n\n[bad](javascript:alert(1))\n\n<div>raw</div>",
      "~~~js\nconst x = `a${1}`;\n~~~\n\n    indented\n    code\n",
      "a  \nline break\n\n---\n\ntext &amp; &#x1f642; \\*literal*\n",
    ];
    const view = new check.MarkdownView();
    for (const raw of documents) {
      for (let i = 0; i <= raw.length; i++) {
        const text = raw.slice(0, i);
        view.update(text);
        const expected = check.markdown(text);
        assert(
          canonical(view.element) === expected,
          `Markdown mismatch at ${i}: ${JSON.stringify(text)}\n${canonical(view.element)}\n${expected}`,
        );
        markdownCases++;
      }
      view.update("Replaced");
      assert(
        canonical(view.element) === check.markdown("Replaced"),
        "non-append replacement",
      );
    }
    view.update("Fixed paragraph.\n\n```ts\nconst x=1;\n```\n\nGrowing");
    const paragraph = view.element.querySelector("p"),
      code = view.element.querySelector("pre");
    view.update("Fixed paragraph.\n\n```ts\nconst x=1;\n```\n\nGrowing answer");
    assert(
      paragraph === view.element.querySelector("p") &&
        code === view.element.querySelector("pre"),
      "stable Markdown nodes were replaced",
    );
  }
  let revision = base.revision + 100;
  const raw =
    "The parser checks a complete code point before advancing the cursor. This preserves Unicode letters and keeps ASCII digits separate.\n\n";
  const run = (index: number, chars: number, running = false): any => ({
    id: `profile-turn-${index}`,
    number: index + 1,
    content: "Inspect and verify the parser",
    status: running ? "running" : "completed",
    createdAt: "2026-10-01T12:00:00.000Z",
    completedAt: running ? null : "2026-10-01T12:00:01.000Z",
    planOnly: false,
    entries: [
      {
        id: 1,
        type: "assistant",
        raw: raw.repeat(Math.ceil(chars / raw.length)).slice(0, chars),
        streaming: false,
        revision: 1,
        at: "2026-10-01T12:00:00.000Z",
      },
    ],
  });
  const measure = (fn: (i: number) => void, n = 16) => {
    const times = [];
    for (let i = 0; i < n + 3; i++) {
      const start = performance.now();
      fn(i);
      const elapsed = performance.now() - start;
      if (i >= 3) times.push(elapsed);
    }
    times.sort((a, b) => a - b);
    return {
      medianMs: +times[Math.floor(times.length / 2)]!.toFixed(2),
      p95Ms: +times[Math.floor(times.length * 0.95)]!.toFixed(2),
    };
  };
  const profiles = [];
  for (const [count, oldChars, currentChars] of [
    [1, 0, 10000],
    [100, 10000, 10000],
    [100, 10000, 100000],
  ]) {
    let state = {
      ...base,
      runs: Array.from({ length: count! }, (_, i) =>
        run(i, i === count! - 1 ? currentChars! : oldChars!, i === count! - 1),
      ),
      activeTurnId: `profile-turn-${count! - 1}`,
      revision: revision++,
    };
    check.render(state);
    const unchanged = measure(() =>
      check.render({ ...state, revision: revision++ }),
    );
    const streaming = measure((i) => {
      const last = state.runs.at(-1),
        entry = last.entries[0];
      const next = {
        ...last,
        entries: [
          {
            ...entry,
            raw: entry.raw + " update" + i,
            revision: entry.revision + 1,
          },
        ],
      };
      state = {
        ...state,
        runs: [...state.runs.slice(0, -1), next],
        revision: revision++,
      };
      check.render(state);
    });
    profiles.push({
      turns: count,
      currentResponseChars: currentChars,
      unchangedRender: unchanged,
      streamingRender: streaming,
    });
  }
  const before = check.observations();
  for (let i = 0; i < 40; i++) check.report();
  await delay(240);
  const dormantScans = check.observations() - before;
  if (check.MarkdownView)
    assert(dormantScans === 0, "inactive Drive scanned the DOM");
  if (check.MarkdownView) {
    const first = run(0, 40, true);
    first.entries[0].raw = "A stable paragraph.\n\nGrowing";
    check.render({
      ...base,
      revision: revision++,
      activeTurnId: first.id,
      runs: [first],
    });
    const p = document.querySelector("[data-answer] p"),
      container = document.querySelector("[data-answer]");
    const second = {
      ...first,
      entries: [
        {
          ...first.entries[0],
          raw: first.entries[0].raw + " response",
          revision: 2,
        },
      ],
    };
    check.render({
      ...base,
      revision: revision++,
      activeTurnId: first.id,
      runs: [second],
    });
    assert(
      document.querySelector("[data-answer] p") === p &&
        document.querySelector("[data-answer]") === container,
      "conversation replaced a stable streamed node",
    );
    const third = {
      ...second,
      entries: [
        ...second.entries,
        { id: 2, type: "notice", tone: "info", text: "Tools are next" },
      ],
    };
    check.render({
      ...base,
      revision: revision++,
      activeTurnId: first.id,
      runs: [third],
    });
    assert(
      document.querySelector("[data-answer]") === container,
      "structural update discarded Markdown DOM",
    );
    const active = {
      ...base,
      revision: revision++,
      activeTurnId: first.id,
      runs: [third],
      drive: { status: "running", updatedAt: "2026-10-01T12:00:00Z" },
    };
    check.render(active);
    const scans = check.observations();
    for (let i = 0; i < 10; i++) {
      check.report();
      await delay(25);
    }
    await delay(200);
    assert(
      check.observations() > scans,
      "active Drive observations starved during continuous updates",
    );
    check.render({
      ...active,
      revision: revision++,
      drive: { ...active.drive, status: "paused" },
    });
    const paused = check.observations();
    check.report();
    await delay(220);
    assert(check.observations() === paused, "paused Drive scanned the DOM");
  }
  const state = {
    ...base,
    revision: revision++,
    activeTurnId: null,
    runs: [{ ...run(0, 10000), status: "completed" }],
  };
  check.render(state);
  const fixture =
    "# Result\n\nThe parser now handles **Unicode** correctly.\n\n```ts\nexport const isLetter = (char: string) => /\\p{L}/u.test(char);\n```\n\n| Suite | Result |\n| --- | --- |\n| Parser | passed |\n\n> Recorded output is preserved.\n\n<script>unsafe()</script>";
  state.runs = [
    {
      ...state.runs[0],
      entries: [{ ...state.runs[0].entries[0], raw: fixture }],
    },
  ];
  state.revision = revision++;
  check.render(state);
  document.querySelector<HTMLElement>("#stage")!.scrollTop = 0;
  document.querySelector<HTMLTextAreaElement>("textarea")!.blur();
  return {
    markdownCases,
    dormantScans,
    profiles,
    scope:
      "Synthetic conversations in the actual Chromium frontend; synchronous render/layout only, excluding terminal transmission and Ghostty presentation.",
  };
}
