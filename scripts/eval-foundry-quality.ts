/** How good are Foundry's pages? Runs twelve fixed asks (foundry-quality.ts
 * QUALITY_CASES) through the daemon's own engine against the person's
 * configured model, renders each page it made in the desktop app off screen,
 * scores it on six measured checks and writes a contact sheet to look at.
 * Every change to Foundry (the kit, the brief, the tools) gets a before and
 * after: run it on main, then on the change, with --compare.
 *
 *   bun scripts/prepare-desktop.ts            (once, so the app can render)
 *   bun scripts/eval-foundry-quality.ts [--only id,id] [--label name] [--out dir] [--compare dir/report.json] [--no-look]
 *   bun scripts/eval-foundry-quality.ts --pages dir    (score .html files, no model)
 *   bun scripts/eval-foundry-quality.ts --fake         (a stand-in model, to check the harness)
 *
 * The model reads freely (Demesne asks run in this repository, read only)
 * and its Foundry tools run for real, with its own look after a save unless
 * --no-look. Anything else it asks for (a write, a command) ends that round
 * unrun. Everything lives in a temporary data directory: the person's chats,
 * gallery and daemon are untouched. Linux needs a display (xvfb-run -a).
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { DemesneClient } from "../packages/client/src/index.ts";
import { loadConfig } from "../packages/config/src/index.ts";
import type { ProviderStreamEvent } from "../packages/providers/src/index.ts";
import { createDaemonApp } from "../apps/daemon/src/app.ts";
import { electronLook, type LookResult } from "../apps/daemon/src/foundry-look.ts";
import { serveDaemon } from "../apps/daemon/src/http-server.ts";
import type { TurnInference, TurnProcessor } from "../apps/daemon/src/processor.ts";
import { createProcessor, signedInAccounts } from "../apps/daemon/src/providers-from-config.ts";
import { checks, compareLines, contactSheet, QUALITY_CASES, score, type DesignNumbers, type PageResult, type Report } from "./foundry-quality.ts";

const repo = resolve(import.meta.dir, "..");
const flag = (name: string) => { const at = process.argv.indexOf(`--${name}`); return at > 0 ? process.argv[at + 1] : undefined; };
const only = flag("only")?.split(","), pagesDir = flag("pages"), comparePath = flag("compare");
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const out = resolve(flag("out") ?? join(tmpdir(), `demesne-foundry-quality-${stamp}`));
mkdirSync(join(out, "shots"), { recursive: true });
mkdirSync(join(out, "pages"), { recursive: true });

const electron = process.env.DEMESNE_ELECTRON ?? join(repo, "node_modules/electron/dist", process.platform === "darwin" ? "Electron.app/Contents/MacOS/Electron" : process.platform === "win32" ? "electron.exe" : "electron");
const lookCommand = [electron, ...(process.env.DEMESNE_ELECTRON ? [] : [join(repo, "apps/desktop/build/app")]), ...(process.getuid?.() === 0 ? ["--no-sandbox"] : [])];
const render = electronLook(lookCommand);

/// Render one page and turn it into a result's numbers and pictures.
async function measure(id: string, kind: string, title: string, source: string): Promise<Pick<PageResult, "score" | "checks" | "design" | "issues" | "shots">> {
  writeFileSync(join(out, "pages", `${id}.${kind === "svg" ? "svg" : "html"}`), source);
  const look: LookResult | null = await render({ kind, source, title }, AbortSignal.timeout(60_000)).catch(() => null);
  if (!look?.pages.length) return { score: null, checks: null, design: null, issues: ["The app could not render the page"], shots: [] };
  const shots = look.pages.map((page) => {
    const file = `shots/${id}-${page.width}.png`;
    writeFileSync(join(out, file), Buffer.from(page.png, "base64"));
    return file;
  });
  const issues = [...look.pages.flatMap((page) => page.issues.map((issue) => `${page.width}px: ${issue}`)), ...look.errors.map((error) => `console: ${error}`)];
  const design = look.pages[0]?.design as DesignNumbers | undefined;
  if (!design) return { score: null, checks: null, design: null, issues: [...issues, "No design numbers (an older app build?)"], shots };
  const parts = checks(design, issues.length);
  return { score: score(parts), checks: parts, design, issues, shots };
}

const blank = (id: string, prompt: string): PageResult => ({ id, prompt, title: null, kind: null, bytes: 0, versions: 0, score: null, checks: null, design: null, issues: [], shots: [], seconds: 0, rounds: 0, outputTokens: 0, calls: [], error: null });

async function finish(report: Report) {
  const before = comparePath ? JSON.parse(readFileSync(comparePath, "utf8")) as Report : undefined;
  writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 2));
  writeFileSync(join(out, "sheet.html"), contactSheet(report, before));
  console.log(`\n${compareLines(report, before).join("\n")}\n\nContact sheet: ${join(out, "sheet.html")}\nReport: ${join(out, "report.json")}`);
}

// --pages: score files that already exist, no model.
if (pagesDir) {
  const results: PageResult[] = [];
  for (const file of readdirSync(pagesDir).filter((name) => /\.html?$/.test(name)).sort()) {
    const id = basename(file).replace(/\.html?$/, ""), source = readFileSync(join(pagesDir, file), "utf8");
    const title = source.match(/<title>([^<]*)<\/title>/i)?.[1] ?? id;
    const result = { ...blank(id, file), title, kind: "html", bytes: Buffer.byteLength(source), versions: 1, ...await measure(id, "html", title, source) };
    console.log(`${String(result.score ?? "-").padStart(3)}  ${id}`);
    results.push(result);
  }
  await finish({ model: "files", when: new Date().toISOString(), label: flag("label") ?? basename(resolve(pagesDir)), results });
  process.exit(0);
}

const READS = new Set(["list_files", "read_file", "read_files", "search_files", "git_status", "git_diff", "git_history", "session_tools", "foundry_read", "foundry_save", "foundry_edit"]);
const MAX_ROUNDS = 10;
interface Watch { rounds: number; calls: string[]; outputTokens: number; error: string | null }
let current: Watch = { rounds: 0, calls: [], outputTokens: 0, error: null };

/// One model round: reads and Foundry tools run; anything else ends the round unrun.
async function* round(stream: AsyncIterable<ProviderStreamEvent>): AsyncIterable<ProviderStreamEvent> {
  current.rounds++;
  const held: ProviderStreamEvent[] = [], names = new Map<number, string>();
  let finish: ProviderStreamEvent | null = null;
  try {
    for await (const event of stream) {
      if (event.type === "usage") { current.outputTokens += event.usage.outputTokens ?? 0; yield event; }
      else if (event.type === "tool_call_delta") { names.set(event.index, (names.get(event.index) ?? "") + event.nameDelta); held.push(event); }
      else if (event.type === "response_state") held.push(event);
      else if (event.type === "finish") finish = event;
      else yield event;
    }
  } catch (error) { current.error = error instanceof Error ? error.message : String(error); throw error; }
  const called = [...names.values()];
  current.calls.push(...called);
  if (called.length && called.every((name) => READS.has(name)) && current.rounds < MAX_ROUNDS) {
    yield* held;
    if (finish) yield finish;
    return;
  }
  if (called.length) yield { type: "text_delta", delta: `\n(eval: stopped at ${called.join(", ")})` };
  yield { type: "finish", reason: "stop" };
}

function watched(processor: TurnProcessor): TurnProcessor {
  const inference = (real: TurnInference): TurnInference => ({
    providerId: real.providerId, modelId: real.modelId, profile: real.profile, thinkingEnabled: real.thinkingEnabled,
    preservesPromptCache: real.preservesPromptCache, vision: real.vision, contextCapacity: real.contextCapacity,
    maxOutputTokens: real.maxOutputTokens, temperature: real.temperature, seed: real.seed,
    ...(real.release ? { release: (cacheKey?: string) => real.release!(cacheKey) } : {}),
    stream: (messages, tools, signal, options) => round(real.stream(messages, tools, signal, options)),
  });
  return new Proxy(processor, {
    get: (target, key, receiver) => {
      if (key === "createTurnInference" && target.createTurnInference) return (...args: Parameters<NonNullable<TurnProcessor["createTurnInference"]>>) => inference(target.createTurnInference!(...args));
      if (key === "stream") return (...args: unknown[]) => round((target.stream as (...args: unknown[]) => AsyncIterable<ProviderStreamEvent>).apply(target, args));
      const value = Reflect.get(target, key, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

const { config } = loadConfig({ includeProject: false });
const dataDirectory = config.dataDir ?? join(homedir(), ".demesne");
const FAKE_PAGE = `<link rel="stylesheet" href="foundry://kit/base.css"><main class="container"><p class="eyebrow">Stand-in</p><h1>A page from the stand-in model</h1><p class="secondary">It checks the harness, not taste.</p><div class="grid three"><div class="card"><h3>One</h3><p>First</p></div><div class="card"><h3>Two</h3><p>Second</p></div><div class="card"><h3>Three</h3><p>Third</p></div></div></main>`;
const fake: TurnProcessor = {
  providerId: "fake", modelId: "stand-in", contextCapacity: 262144,
  async listModels() { return [{ id: "stand-in", provider: "fake", contextWindow: 262144 }]; },
  async *stream(messages) {
    if (messages.some((message) => message.role === "tool")) { yield { type: "text_delta", delta: "Made it." }; yield { type: "finish", reason: "stop" }; return; }
    yield { type: "tool_call_delta", index: 0, idDelta: `save-${messages.length}`, nameDelta: "foundry_save", argumentsDelta: JSON.stringify({ title: "Stand-in page", kind: "html", source: FAKE_PAGE }) };
    yield { type: "usage", usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 } };
    yield { type: "finish", reason: "tool_calls" };
  },
  createTurnInference(thinkingEnabled) {
    return Object.freeze({ providerId: "fake", modelId: "stand-in", profile: null, thinkingEnabled, preservesPromptCache: false, contextCapacity: 262144,
      stream: (messages: Parameters<TurnInference["stream"]>[0], tools: Parameters<TurnInference["stream"]>[1], signal: AbortSignal) => fake.stream(messages, tools, signal, thinkingEnabled) });
  },
};
const processor = process.argv.includes("--fake") ? fake : createProcessor(config, dataDirectory, await signedInAccounts(dataDirectory));
if (!processor) throw new Error("No provider is configured in ~/.demesne/config.toml");

const root = realpathSync(mkdtempSync(join(tmpdir(), "demesne-foundry-quality-")));
mkdirSync(join(root, "data"));
writeFileSync(join(root, "data", "trusted-workspaces.json"), JSON.stringify({ trusted: [repo] }));
const token = "foundry-quality";
const app = createDaemonApp({ databasePath: join(root, "data/state.sqlite"), authToken: token, processor: watched(processor), heartbeat: { enabled: false },
  foundryLook: process.argv.includes("--no-look") ? undefined : render });
const server = serveDaemon(app, { hostname: "127.0.0.1", port: 0 });
const client = new DemesneClient({ server: server.url.href, token });

async function settle(sessionId: string, timeout = 600_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const turn = (await client.getSessionState(sessionId)).session.turns.at(-1);
    if (turn && !["queued", "running"].includes(turn.status)) return turn.status;
    if (Date.now() > deadline) { if (turn) await client.cancelTurn(turn.id).catch(() => {}); return "timed out"; }
    await Bun.sleep(500);
  }
}

const model = `${processor.providerId} ${processor.modelId}`;
console.log(`Model: ${model}\nWriting to ${out}\n`);
const results: PageResult[] = [];
try {
  for (const item of QUALITY_CASES.filter((entry) => !only || only.includes(entry.id))) {
    current = { rounds: 0, calls: [], outputTokens: 0, error: null };
    const started = Date.now();
    const { session } = await client.createSession(item.where === "project" ? { workspacePath: repo, trustWorkspace: true } : {});
    await client.submitTurn(session.id, { content: item.prompt, permissionMode: "ask" });
    const status = await settle(session.id);
    const result: PageResult = { ...blank(item.id, item.prompt), seconds: Math.round((Date.now() - started) / 1000), rounds: current.rounds, outputTokens: current.outputTokens, calls: current.calls,
      error: status === "completed" ? current.error : `turn ${status}${current.error ? `: ${current.error}` : ""}` };
    const made = (await client.foundryList()).artifacts.filter((artifact) => artifact.sessionId === session.id).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    if (made) {
      const detail = await client.foundryGet(made.id);
      Object.assign(result, { title: detail.title, kind: detail.kind, bytes: Buffer.byteLength(detail.source), versions: detail.version });
      if (detail.kind !== "markdown") Object.assign(result, await measure(item.id, detail.kind, detail.title, detail.source));
    }
    results.push(result);
    console.log(`${String(result.score ?? "-").padStart(3)}  ${item.id.padEnd(18)} ${result.title ?? "(no page)"}  ${result.seconds}s, ${result.rounds} rounds, ${result.outputTokens} out${result.error ? `  [${result.error}]` : ""}`);
  }
} finally {
  await server.stop(true);
  await app.close();
  rmSync(root, { recursive: true, force: true });
}
await finish({ model, when: new Date().toISOString(), label: flag("label") ?? model, results });
