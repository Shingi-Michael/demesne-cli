/** Does the model reach for Foundry on its own? Runs a set of real-sounding
 * requests through the daemon's own engine (its system prompt, its tool list)
 * against the person's configured model, and scores whether each answer made
 * a Foundry page when it should, and didn't when it shouldn't.
 *
 * Nothing the model asks for is carried out except reading the scratch
 * project: a Foundry save, a file write or a command is recorded and the turn
 * ends there. Everything lives in a temporary data directory; the person's
 * chats, Foundry gallery and daemon are untouched (the running daemon can stay
 * up). It reads ~/.demesne/config.toml and the sign-ins in the data directory.
 *
 *   bun scripts/eval-foundry-inference.ts [--runs 2] [--only id,id] [--out file.json]
 *
 * --fake runs a stand-in model instead (reads a file, then makes a page when
 * the request says show/look/page), to check the harness itself.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DemesneClient } from "../packages/client/src/index.ts";
import { loadConfig } from "../packages/config/src/index.ts";
import type { ProviderStreamEvent } from "../packages/providers/src/index.ts";
import { createDaemonApp } from "../apps/daemon/src/app.ts";
import { serveDaemon } from "../apps/daemon/src/http-server.ts";
import type { TurnInference, TurnProcessor } from "../apps/daemon/src/processor.ts";
import { createProcessor, signedInAccounts } from "../apps/daemon/src/providers-from-config.ts";

type Where = "project" | "chat" | "plan" | "drive" | "mail";
interface Case { id: string; where: Where; expect: "page" | "none"; prompt: string; before?: { user: string; answer: string } }

/// Mike's own wording where we have it (marked "real"); the rest in his voice.
export const CASES: Case[] = [
  // Something to look at, click or compare: the answer is a page.
  { id: "show-me-real", where: "project", expect: "page", prompt: "well show me what it would look like in here",
    before: { user: "id like to make some changes in the UI. theres black highlighting on the left side bar when interacting with chats", answer: "The sidebar's hover and selected rows use an opaque fill on the translucent glass, which reads as black. A hairline outline with a faint tint would keep the glass visible. Want me to change it?" } },
  { id: "small-page-real", where: "chat", expect: "page", prompt: "make me a small age i can interact with" },
  { id: "visual-change-real", where: "chat", expect: "page", prompt: "i would like a chat visual change" },
  { id: "two-layouts", where: "project", expect: "page", prompt: "should the settings page be one long list or tabs? show me both" },
  { id: "flow", where: "project", expect: "page", prompt: "how would onboarding flow for a new user, from first launch to the first chat?" },
  { id: "empty-state", where: "project", expect: "page", prompt: "what could the empty state look like when someone has no chats yet" },
  { id: "dashboard", where: "chat", expect: "page", prompt: "i want a little dashboard for my running: weekly km, a chart, and my next race" },
  { id: "landing", where: "chat", expect: "page", prompt: "can you put together a landing page for a coffee subscription called Slow Pour" },
  { id: "game", where: "chat", expect: "page", prompt: "make a tiny snake game i can play" },
  { id: "logo", where: "chat", expect: "page", prompt: "give me a few logo ideas for a tea shop" },
  { id: "chart", where: "chat", expect: "page", prompt: "visualize how my savings grow at 5% a year over 20 years starting with 1000" },
  { id: "diagram", where: "project", expect: "page", prompt: "draw how the app, the host and the daemon talk to each other" },
  { id: "redesign-idea", where: "project", expect: "page", prompt: "the top bar feels busy. what would a calmer version look like?" },
  { id: "pick-colors", where: "chat", expect: "page", prompt: "help me pick colors for a calm reading app, i want to see them" },
  { id: "plan-mock", where: "plan", expect: "page", prompt: "before we change anything, show me how the new tab bar would look with three chats open" },
  { id: "plan-compare", where: "plan", expect: "page", prompt: "compare a sidebar on the left vs a bottom bar for the mobile layout, visually" },
  { id: "doc", where: "chat", expect: "page", prompt: "write me a one-page brief for the Q1 launch i can share" },
  // Code work, questions and chat: no page.
  { id: "hover-fix-real", where: "project", expect: "none", prompt: "okay can you make a change on the side chats highlighting to not be so dark when i hover ?" },
  { id: "still-dark-real", where: "project", expect: "none", prompt: "the chats inside the project when hovering are still dark" },
  { id: "merge-real", where: "project", expect: "none", prompt: "is there something that needs to mergeed to main ?" },
  { id: "access-real", where: "project", expect: "none", prompt: "how do you not have access when youre in the folder ?" },
  { id: "hey-real", where: "chat", expect: "none", prompt: "hey" },
  { id: "function-look", where: "project", expect: "none", prompt: "what should the signature of the save function look like?" },
  { id: "layout-bug", where: "project", expect: "none", prompt: "the layout breaks on narrow windows, the sidebar overlaps the chat. fix it" },
  { id: "css-question", where: "chat", expect: "none", prompt: "what's the difference between flex and grid in css?" },
  { id: "explain-code", where: "project", expect: "none", prompt: "explain what src/Sidebar.tsx does" },
  { id: "add-test", where: "project", expect: "none", prompt: "add a test for the sidebar's selected state" },
  { id: "plan-refactor", where: "plan", expect: "none", prompt: "plan how to split src/Sidebar.tsx into smaller components" },
  // Nobody is watching: no page unless the task asks for one.
  { id: "drive-task", where: "drive", expect: "none", prompt: "You're doing one task Drive proposed for this repository: tidy the sidebar styles so hover and selected rows share one rule. Make the change, run the checks, and report what you did." },
  { id: "mail", where: "mail", expect: "none", prompt: "Heartbeat mail for mike@demesne.local from sam@example.com: \"Hey, could you check whether the sidebar fix landed? Thanks\"" },
];

const READS = new Set(["list_files", "read_file", "read_files", "search_files", "git_status", "git_diff", "git_history", "foundry_read", "session_tools"]);
const PAGE = new Set(["foundry_save", "foundry_edit"]);
const MAX_ROUNDS = 4;

interface Outcome { calls: string[]; text: string; rounds: number; wroteFile: string | null; error: string | null }
const fresh = (): Outcome => ({ calls: [], text: "", rounds: 0, wroteFile: null, error: null });
let current = fresh();
let canned: { user: string; answer: string } | null = null;

const lastUser = (messages: { role: string; content?: unknown }[]) => {
  const message = messages.findLast((item) => item.role === "user");
  return typeof message?.content === "string" ? message.content : JSON.stringify(message?.content ?? "");
};

/// One model round: text passes through; reads are carried out (up to
/// MAX_ROUNDS); anything else is recorded and the round ends without it.
async function* round(stream: AsyncIterable<ProviderStreamEvent>, messages: { role: string; content?: unknown }[]): AsyncIterable<ProviderStreamEvent> {
  if (canned && lastUser(messages).includes(canned.user)) {
    yield { type: "text_delta", delta: canned.answer };
    yield { type: "finish", reason: "stop" };
    return;
  }
  current.rounds++;
  const held: ProviderStreamEvent[] = [], calls = new Map<number, { name: string; args: string }>();
  let finish: ProviderStreamEvent | null = null;
  try {
  for await (const event of stream) {
    if (event.type === "text_delta") { current.text += event.delta; yield event; }
    else if (event.type === "tool_call_delta") {
      const call = calls.get(event.index) ?? { name: "", args: "" };
      call.name += event.nameDelta; call.args += event.argumentsDelta; calls.set(event.index, call);
      held.push(event);
    } else if (event.type === "response_state") held.push(event);
    else if (event.type === "finish") finish = event;
    else yield event;
  }
  } catch (error) { current.error = error instanceof Error ? error.message : String(error); throw error; }
  const names = [...calls.values()].map((call) => call.name);
  current.calls.push(...names);
  for (const call of calls.values()) if (/write|edit_file|create_file|apply_patch/.test(call.name) && /\.html?\b/.test(call.args)) current.wroteFile = call.name;
  if (names.length && names.every((name) => READS.has(name)) && current.rounds < MAX_ROUNDS) {
    yield* held;
    if (finish) yield finish;
    return;
  }
  // The answer ends where the model asked for something the eval doesn't carry out.
  if (names.length) yield { type: "text_delta", delta: `\n(eval: stopped at ${names.join(", ")})` };
  yield { type: "finish", reason: "stop" };
}

function watched(processor: TurnProcessor): TurnProcessor {
  // A plain copy: the real inference can be frozen, which a Proxy may not misreport.
  const inference = (real: TurnInference): TurnInference => ({
    providerId: real.providerId, modelId: real.modelId, profile: real.profile, thinkingEnabled: real.thinkingEnabled,
    preservesPromptCache: real.preservesPromptCache, vision: real.vision, contextCapacity: real.contextCapacity,
    maxOutputTokens: real.maxOutputTokens, temperature: real.temperature, seed: real.seed,
    ...(real.release ? { release: (cacheKey?: string) => real.release!(cacheKey) } : {}),
    stream: (messages, tools, signal, options) => round(real.stream(messages, tools, signal, options), messages),
  });
  return new Proxy(processor, {
    get: (target, key, receiver) => {
      if (key === "createTurnInference" && target.createTurnInference) return (...args: Parameters<NonNullable<TurnProcessor["createTurnInference"]>>) => inference(target.createTurnInference!(...args));
      if (key === "stream") return (messages: Parameters<TurnProcessor["stream"]>[0], ...rest: unknown[]) => round((target.stream as (...args: unknown[]) => AsyncIterable<ProviderStreamEvent>).call(target, messages, ...rest), messages);
      const value = Reflect.get(target, key, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/// A small, real-looking project for the model to read.
function scratchProject(root: string) {
  const project = join(root, "demesne-web");
  mkdirSync(join(project, "src"), { recursive: true });
  writeFileSync(join(project, "README.md"), "# demesne-web\n\nThe chat app's window: a sidebar of chats, the conversation, and a composer.\n");
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "demesne-web", private: true, scripts: { dev: "vite", test: "vitest" }, dependencies: { react: "^19.0.0" } }, null, 2));
  writeFileSync(join(project, "src/Sidebar.tsx"), `export function Sidebar({ chats, selected, onSelect }: { chats: { id: string; title: string }[]; selected: string; onSelect(id: string): void }) {
  return <nav className="sidebar">{chats.map((chat) => <button key={chat.id} className={chat.id === selected ? "row selected" : "row"} onClick={() => onSelect(chat.id)}>{chat.title}</button>)}</nav>;
}
`);
  writeFileSync(join(project, "src/styles.css"), `.sidebar { width: 260px; background: color-mix(in srgb, var(--paper) 60%, transparent); backdrop-filter: blur(20px); }
.row { display: block; width: 100%; padding: 6px 10px; border-radius: 8px; }
.row:hover, .row.selected { background: var(--surface2); }
`);
  return project;
}

const flag = (name: string) => { const at = process.argv.indexOf(`--${name}`); return at > 0 ? process.argv[at + 1] : undefined; };
const runs = Number(flag("runs") ?? 1), only = flag("only")?.split(","), out = flag("out");
const { config } = loadConfig({ includeProject: false });
const dataDirectory = config.dataDir ?? join(homedir(), ".demesne");
const fake: TurnProcessor = {
  providerId: "fake", modelId: "stand-in", contextCapacity: 262144,
  async listModels() { return [{ id: "stand-in", provider: "fake", contextWindow: 262144 }]; },
  async *stream(messages) {
    const asked = lastUser(messages), read = messages.some((message) => message.role === "tool");
    const call = (name: string, input: unknown) => ({ type: "tool_call_delta" as const, index: 0, idDelta: `${name}-${messages.length}`, nameDelta: name, argumentsDelta: JSON.stringify(input) });
    if (!read && !/^hey$/.test(asked)) { yield call("list_files", { path: "." }); yield { type: "finish", reason: "tool_calls" }; return; }
    if (/show|look|page|age/i.test(asked)) { yield call("foundry_save", { title: "Try", kind: "html", source: "<p>hi</p>" }); yield { type: "finish", reason: "tool_calls" }; return; }
    yield { type: "text_delta", delta: "Done in words." }; yield { type: "finish", reason: "stop" };
  },
  // Frozen, like a real provider's: the path the real run takes.
  createTurnInference(thinkingEnabled) {
    return Object.freeze({ providerId: "fake", modelId: "stand-in", profile: null, thinkingEnabled, preservesPromptCache: false, contextCapacity: 262144,
      stream: (messages: Parameters<TurnInference["stream"]>[0], tools: Parameters<TurnInference["stream"]>[1], signal: AbortSignal) => fake.stream(messages, tools, signal, thinkingEnabled) });
  },
};
const processor = process.argv.includes("--fake") ? fake : createProcessor(config, dataDirectory, await signedInAccounts(dataDirectory));
if (!processor) throw new Error("No provider is configured in ~/.demesne/config.toml");

const root = realpathSync(mkdtempSync(join(tmpdir(), "demesne-foundry-eval-")));
mkdirSync(join(root, "data"));
const project = scratchProject(root);
writeFileSync(join(root, "data", "trusted-workspaces.json"), JSON.stringify({ trusted: [project] }));
const token = "foundry-eval";
const app = createDaemonApp({ databasePath: join(root, "data/state.sqlite"), authToken: token, processor: watched(processor), heartbeat: { enabled: false } });
const server = serveDaemon(app, { hostname: "127.0.0.1", port: 0 });
const client = new DemesneClient({ server: server.url.href, token });

async function settle(sessionId: string, timeout = 240_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const turn = (await client.getSessionState(sessionId)).session.turns.at(-1);
    if (turn && !["queued", "running"].includes(turn.status)) return turn.status;
    if (Date.now() > deadline) { if (turn) await client.cancelTurn(turn.id).catch(() => {}); return "timed out"; }
    await Bun.sleep(250);
  }
}

const results: (Case & { run: number; made: boolean; pass: boolean; status: string } & Outcome)[] = [];
console.log(`Model: ${processor.providerId} ${processor.modelId}\n`);
try {
  for (let run = 1; run <= runs; run++) {
    for (const item of CASES.filter((entry) => !only || only.includes(entry.id))) {
      const { session } = await client.createSession(item.where === "chat" || item.where === "mail" ? {} : { workspacePath: project, trustWorkspace: true });
      if (item.before) {
        canned = item.before;
        await client.submitTurn(session.id, { content: item.before.user, permissionMode: "ask" });
        await settle(session.id);
      }
      canned = null;
      current = fresh();
      await client.submitTurn(session.id, {
        content: item.prompt,
        permissionMode: item.where === "drive" || item.where === "mail" ? "allow" : "ask",
        planOnly: item.where === "plan",
        fromDrive: item.where === "drive",
      });
      const status = await settle(session.id);
      const made = current.calls.some((name) => PAGE.has(name));
      // A turn that didn't finish says nothing about the model's choice.
      const pass = status === "completed" && made === (item.expect === "page");
      results.push({ ...item, run, made, pass, status, ...current });
      const said = current.text.replace(/\s+/g, " ").trim().slice(0, 90);
      console.log(`${status !== "completed" ? "ERROR" : pass ? "PASS" : "FAIL"}  ${item.expect === "page" ? "page" : "none"}  ${item.where.padEnd(7)} ${item.id.padEnd(20)} calls: ${current.calls.join(", ") || "-"}${current.wroteFile ? "  (wrote an HTML file)" : ""}${status !== "completed" ? `  [${status}]` : ""}${!made && /foundry|mock/i.test(current.text) ? "  (offered)" : ""}\n      ${current.error ? `error: ${current.error}` : said}`);
    }
  }
} finally {
  await server.stop(true);
  await app.close();
  rmSync(root, { recursive: true, force: true });
}
const score = (list: typeof results) => `${list.filter((item) => item.pass).length}/${list.length}`;
console.log(`\nShould make a page: ${score(results.filter((item) => item.expect === "page"))}`);
console.log(`Should not: ${score(results.filter((item) => item.expect === "none"))}`);
console.log(`All: ${score(results)}`);
const errors = results.filter((item) => item.status !== "completed").length;
if (errors) console.log(`${errors} turn(s) didn't finish; their scores mean nothing.`);
if (out) writeFileSync(out, JSON.stringify({ model: `${processor.providerId} ${processor.modelId}`, results }, null, 2));
if (errors) process.exit(1);
