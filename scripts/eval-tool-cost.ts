/** What tool calls cost: runs a fixed set of everyday coding tasks through
 * the daemon's own engine against the configured model, carrying every tool
 * call out for real in a scratch copy of this repository, and reports per
 * task the rounds, the input sent (tokens where the provider reports them,
 * characters always), the share of it that was tool output, the uncached
 * input, and whether the answer was right. Run it before and after a change
 * to how tools return or keep results; a change passes when input goes down,
 * rounds go up no more than 5%, and the same tasks come out right.
 *
 * Everything lives in a temporary data directory: the person's chats and
 * daemon are untouched. It reads ~/.demesne/config.toml and the sign-ins in
 * the data directory.
 *
 *   bun scripts/eval-tool-cost.ts [--only id,id] [--out file.json] [--cold]
 *
 * --cold waits as if the person stepped away between turns, so old reads may
 * be cut (forget-reads.ts). --fake runs a stand-in model to check the harness.
 */
import { Database } from "bun:sqlite";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DemesneClient } from "../packages/client/src/index.ts";
import { loadConfig } from "../packages/config/src/index.ts";
import type { ProviderStreamEvent } from "../packages/providers/src/index.ts";
import { createDaemonApp } from "../apps/daemon/src/app.ts";
import { serveDaemon } from "../apps/daemon/src/http-server.ts";
import type { TurnInference, TurnProcessor } from "../apps/daemon/src/processor.ts";
import { createProcessor, signedInAccounts } from "../apps/daemon/src/providers-from-config.ts";
import { CACHE_COLD_MS } from "../apps/daemon/src/forget-reads.ts";

interface Step { ask: string; right: (answer: string, project: string) => boolean }
interface Task { id: string; steps: Step[] }
const file = (project: string, path: string) => readFileSync(join(project, path), "utf8");
const says = (...words: (string | RegExp)[]) => (answer: string) => words.every((word) => typeof word === "string" ? answer.includes(word) : word.test(answer));

/// Questions with one right answer in the code, small edits that can be
/// checked on disk, and one chat of follow-ups that leans on earlier reads.
export const TASKS: Task[] = [
  { id: "find-rule", steps: [{ ask: "Which function in packages/protocol/src/index.ts works out the Always rule saved for a tool call? Answer with its name.", right: says("derivePersistedRule") }] },
  { id: "find-class", steps: [{ ask: "Which file in apps/daemon/src defines the PermissionBroker class?", right: says("permissions.ts") }] },
  { id: "default-limit", steps: [{ ask: "When read_file is called without a limit, how many lines does it return by default? Look in apps/daemon/src/tools.ts.", right: says(/\b400\b/) }] },
  { id: "git-tools", steps: [{ ask: "Name the git tools the daemon registers in apps/daemon/src/tools.ts.", right: says("git_status", "git_diff", "git_history") }] },
  { id: "core-tools", steps: [{ ask: "Is web_fetch one of the tools always sent whole, or does it wait behind tool search? Answer core or deferred.", right: says(/deferred|waits|behind/i) }] },
  { id: "explain-flow", steps: [{ ask: "How does a tool call's permission get decided before it runs? Name the main functions involved, briefly.", right: says(/preapproved|allowRulesCover|sessionRulesCover/) }] },
  { id: "rename", steps: [{ ask: "Rename the constant MAX_RESULTS in apps/daemon/src/tool-search.ts to MAX_SEARCH_RESULTS everywhere it is used. Don't run anything.", right: (_, project) => !/\bMAX_RESULTS\b/.test(file(project, "apps/daemon/src/tool-search.ts")) && /\bMAX_SEARCH_RESULTS\b/.test(file(project, "apps/daemon/src/tool-search.ts")) }] },
  { id: "constant", steps: [{ ask: "Change PAGE_MAX_CHARS in apps/daemon/src/web.ts to 50_000. Nothing else.", right: (_, project) => /PAGE_MAX_CHARS = 50_000/.test(file(project, "apps/daemon/src/web.ts")) }] },
  { id: "add-function", steps: [{ ask: "In apps/daemon/src/page-look.ts add an exported function isLocalHost(hostname: string): boolean that says whether a hostname is one of LOCAL_HOSTS or ends in .localhost. Don't run anything.", right: (_, project) => /export function isLocalHost\(/.test(file(project, "apps/daemon/src/page-look.ts")) }] },
  { id: "follow-ups", steps: [
    { ask: "Read apps/daemon/src/forget-reads.ts and tell me in two sentences what it does.", right: says(/note|forget|earlier turn/i) },
    { ask: "Which tools count as re-readable there?", right: says("read_file", "git_diff") },
    { ask: "And how long can a result be before it gets cut to a note? Give the number.", right: says(/1[,_ ]?500/) },
    { ask: "Which other file in apps/daemon/src calls into it?", right: says("engine.ts") },
  ] },
];

interface RoundCost { chars: number; toolChars: number }
let rounds: RoundCost[] = [];
const contentChars = (content: unknown) => typeof content === "string" ? content.length : JSON.stringify(content ?? "").length;

function watched(processor: TurnProcessor): TurnProcessor {
  const measure = (messages: { role: string; content?: unknown }[], tools: unknown) => {
    let chars = JSON.stringify(tools ?? []).length, toolChars = 0;
    for (const message of messages) { const size = contentChars(message.content); chars += size; if (message.role === "tool") toolChars += size; }
    rounds.push({ chars, toolChars });
  };
  const inference = (real: TurnInference): TurnInference => ({
    providerId: real.providerId, modelId: real.modelId, profile: real.profile, thinkingEnabled: real.thinkingEnabled,
    preservesPromptCache: real.preservesPromptCache, vision: real.vision, contextCapacity: real.contextCapacity,
    maxOutputTokens: real.maxOutputTokens, temperature: real.temperature, seed: real.seed,
    ...(real.release ? { release: (cacheKey?: string) => real.release!(cacheKey) } : {}),
    stream: (messages, tools, signal, options) => { measure(messages, tools); return real.stream(messages, tools, signal, options); },
  });
  return new Proxy(processor, {
    get: (target, key, receiver) => {
      if (key === "createTurnInference" && target.createTurnInference) return (...args: Parameters<NonNullable<TurnProcessor["createTurnInference"]>>) => inference(target.createTurnInference!(...args));
      if (key === "stream") return (messages: Parameters<TurnProcessor["stream"]>[0], tools: unknown, ...rest: unknown[]) => { measure(messages, tools); return (target.stream as (...args: unknown[]) => AsyncIterable<ProviderStreamEvent>).call(target, messages, tools, ...rest); };
      const value = Reflect.get(target, key, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/// The stand-in: reads the file a step names, then answers with what the
/// checks look for, so the harness itself can be tried without a model.
const lastUser = (messages: { role: string; content?: unknown }[]) => String(messages.findLast((message) => message.role === "user")?.content ?? "");
const fake: TurnProcessor = {
  providerId: "fake", modelId: "stand-in", contextCapacity: 262144,
  async listModels() { return [{ id: "stand-in", provider: "fake", contextWindow: 262144 }]; },
  async *stream(messages) {
    const asked = lastUser(messages), at = messages.findLastIndex((message) => message.role === "user");
    const done = messages.slice(at + 1).some((message) => message.role === "tool");
    const path = /(?:apps|packages)\/[\w/.-]+\.ts/.exec(asked)?.[0];
    if (!done && path) { yield { type: "tool_call_delta", index: 0, idDelta: `r-${messages.length}`, nameDelta: "read_file", argumentsDelta: JSON.stringify({ path }) }; yield { type: "finish", reason: "tool_calls" }; return; }
    yield { type: "text_delta", delta: "derivePersistedRule permissions.ts 400 git_status git_diff git_history deferred preapproved note read_file 1500 engine.ts" };
    yield { type: "finish", reason: "stop" };
  },
};

const flag = (name: string) => { const at = process.argv.indexOf(`--${name}`); return at > 0 ? process.argv[at + 1] : undefined; };
const only = flag("only")?.split(","), out = flag("out"), cold = process.argv.includes("--cold");
const { config } = loadConfig({ includeProject: false });
const dataDirectory = config.dataDir ?? join(homedir(), ".demesne");
const processor = process.argv.includes("--fake") ? fake : createProcessor(config, dataDirectory, await signedInAccounts(dataDirectory));
if (!processor) throw new Error("No provider is configured in ~/.demesne/config.toml");

const root = realpathSync(mkdtempSync(join(tmpdir(), "demesne-cost-eval-")));
const repo = resolve(import.meta.dir, "..");
/// The project: a copy of this repository's daemon and packages, a size
/// where reading costs something.
const fresh = (name: string) => {
  const project = join(root, "projects", name);
  for (const part of ["apps/daemon/src", "packages/protocol/src", "packages/storage/src", "packages/providers/src", "README.md"]) cpSync(join(repo, part), join(project, part), { recursive: true });
  return project;
};
const projects = TASKS.filter((task) => !only || only.includes(task.id)).map((task) => [task.id, fresh(task.id)] as const);
mkdirSync(join(root, "data"));
writeFileSync(join(root, "data", "trusted-workspaces.json"), JSON.stringify({ trusted: projects.map(([, path]) => path) }));
let clock = Date.now();
const token = "cost-eval";
const database = join(root, "data", "state.sqlite");
const app = createDaemonApp({ databasePath: database, authToken: token, processor: watched(processor), heartbeat: { enabled: false }, nameChats: false,
  // As the daemon runs: rarely used tools load on demand, the model's own settings.
  deferTools: process.env.DEMESNE_DEFER_TOOLS !== "0", agent: config.agent, providerVision: config.provider.vision,
  ...(cold ? { now: () => new Date(clock) } : {}) });
const server = serveDaemon(app, { hostname: "127.0.0.1", port: 0 });
const client = new DemesneClient({ server: server.url.href, token });

async function settle(sessionId: string, timeout = 300_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const state = await client.getSessionState(sessionId);
    const turn = state.session.turns.at(-1);
    if (turn && !["queued", "running"].includes(turn.status)) return { status: turn.status, turnId: turn.id };
    if (Date.now() > deadline) { if (turn) await client.cancelTurn(turn.id).catch(() => {}); return { status: "timed out", turnId: turn?.id ?? "" }; }
    await Bun.sleep(250);
  }
}

interface Result { id: string; step: number; status: string; right: boolean; rounds: number; inputChars: number; toolChars: number; inputTokens: number | null; cachedTokens: number | null; answer: string }
const results: Result[] = [];
console.log(`Model: ${processor.providerId} ${processor.modelId}${cold ? " (cold between turns)" : ""}\n`);
try {
  for (const [id, project] of projects) {
    const task = TASKS.find((entry) => entry.id === id)!;
    const { session } = await client.createSession({ workspacePath: project, trustWorkspace: true });
    for (const [index, step] of task.steps.entries()) {
      rounds = [];
      if (cold) clock += CACHE_COLD_MS;
      await client.submitTurn(session.id, { content: step.ask, permissionMode: "allow" });
      const { status, turnId } = await settle(session.id);
      const state = await client.getSessionState(session.id);
      const answer = state.session.turns.find((turn) => turn.id === turnId)?.responseText ?? "";
      const db = new Database(database, { readonly: true });
      const usage = db.query("SELECT SUM(input_tokens) AS input, SUM(cached_input_tokens) AS cached FROM provider_calls WHERE turn_id = ?").get(turnId) as { input: number | null; cached: number | null };
      db.close();
      let right = false;
      try { right = status === "completed" && step.right(answer, project); } catch { right = false; }
      const row: Result = { id, step: index + 1, status, right, rounds: rounds.length, inputChars: rounds.reduce((sum, item) => sum + item.chars, 0), toolChars: rounds.reduce((sum, item) => sum + item.toolChars, 0),
        inputTokens: usage.input, cachedTokens: usage.cached, answer: answer.slice(0, 400) };
      results.push(row);
      const tokens = row.inputTokens == null ? "" : `  ${Math.round(row.inputTokens / 1000)}k in, ${Math.round((row.inputTokens - (row.cachedTokens ?? 0)) / 1000)}k uncached`;
      console.log(`${status !== "completed" ? "ERROR" : right ? "RIGHT" : "WRONG"}  ${`${id}${task.steps.length > 1 ? ` #${index + 1}` : ""}`.padEnd(16)} ${String(row.rounds).padStart(2)} rounds  ${Math.round(row.inputChars / 1000)}k chars sent, ${Math.round(row.toolChars / Math.max(1, row.inputChars) * 100)}% tool output${tokens}`);
    }
  }
} finally {
  await server.stop(true);
  await app.close();
  rmSync(root, { recursive: true, force: true });
}
const sum = (pick: (row: Result) => number | null) => results.reduce((total, row) => total + (pick(row) ?? 0), 0);
const inputTokens = sum((row) => row.inputTokens), cached = sum((row) => row.cachedTokens);
console.log(`\nRight: ${results.filter((row) => row.right).length}/${results.length}`);
console.log(`Rounds: ${sum((row) => row.rounds)}`);
console.log(`Sent: ${Math.round(sum((row) => row.inputChars) / 1000)}k characters, ${Math.round(sum((row) => row.toolChars) / Math.max(1, sum((row) => row.inputChars)) * 100)}% of it tool output`);
if (inputTokens) console.log(`Input: ${Math.round(inputTokens / 1000)}k tokens, ${Math.round((inputTokens - cached) / 1000)}k uncached`);
if (out) writeFileSync(out, JSON.stringify({ model: `${processor.providerId} ${processor.modelId}`, cold, results }, null, 2));
if (results.some((row) => row.status !== "completed")) process.exit(1);
