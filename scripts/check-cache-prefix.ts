/** The prefix check: does Demesne keep the start of a chat the same?
 *
 * A provider's prompt cache reuses only the part of a request that repeats
 * the previous one from its first byte. This runs one scripted chat through
 * the daemon's own engine with a stand-in model, flipping every switch that
 * could change what is sent (a tool beyond the everyday ones, plan mode,
 * auto-approve, a Foundry page, pictures, the permission mode, stepping away
 * for less and for more than the cache's lifetime), then a
 * short second chat on a small window, where tools wait and are called
 * through use_tool (apps/daemon/src/tool-search.ts), and reads back what the
 * cache meter (apps/daemon/src/cache-prefix.ts) recorded for each request.
 *
 * KNOWN lists the breaks that exist today, each with the step of the caching
 * plan that removes it. The check fails when a request breaks the prefix and
 * is not listed (a change made caching worse), and when a listed break no
 * longer happens (take it off the list, so it can't come back unnoticed).
 *
 *   bun scripts/check-cache-prefix.ts [--json file]
 *
 * It also runs with the tests (apps/daemon/test/cache-prefix.test.ts).
 * Read more: https://code.claude.com/docs/en/prompt-caching
 */
import { Database } from "bun:sqlite";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DemesneClient } from "../packages/client/src/index.ts";
import type { PermissionMode, PrefixReport } from "../packages/protocol/src/index.ts";
import type { ProviderStreamEvent } from "../packages/providers/src/index.ts";
import { createDaemonApp } from "../apps/daemon/src/app.ts";
import { serveDaemon } from "../apps/daemon/src/http-server.ts";
import type { TurnProcessor } from "../apps/daemon/src/processor.ts";

type Round = { call: { name: string; args: unknown }[] } | { say: string };
interface ScriptedTurn { id: string; what: string; ask: string; rounds: Round[]; planOnly?: boolean; mode?: PermissionMode; idleMinutes?: number;
  /// A switch flipped on the chat just before this message.
  set?: { autoApprove?: boolean } }

const PAGE = `<!doctype html><html><head><link rel="stylesheet" href="foundry://kit/base.css"></head><body>${"<section><h2>Plans</h2><p>A long page, so its source is worth leaving out later.</p></section>".repeat(120)}</body></html>`;

/// One chat that does a bit of everything a real one does.
export const CHAT: ScriptedTurn[] = [
  { id: "read", what: "reads a file", ask: "Read apps/daemon/src/forget-reads.ts and say what it does.", rounds: [{ call: [{ name: "read_file", args: { path: "apps/daemon/src/forget-reads.ts" } }] }, { say: "It cuts old reads to notes." }] },
  { id: "read-more", what: "reads a big file and searches", ask: "Now look at apps/daemon/src/tools.ts.", rounds: [{ call: [{ name: "read_file", args: { path: "apps/daemon/src/tools.ts" } }] }, { call: [{ name: "search_files", args: { query: "givenBefore" } }] }, { say: "Seen." }] },
  { id: "follow-up", what: "a plain follow-up", ask: "Thanks. Which of those is larger?", rounds: [{ say: "tools.ts" }] },
  { id: "more-tool", what: "uses a tool beyond the everyday ones", ask: "Check the history please.", rounds: [{ call: [{ name: "git_history", args: { action: "log" } }] }, { call: [{ name: "git_status", args: {} }] }, { say: "Done." }] },
  { id: "after-tool", what: "a plain follow-up", ask: "Ok and then?", rounds: [{ say: "Nothing more." }] },
  { id: "plan-on", what: "plan mode on", ask: "Plan a small tidy up.", planOnly: true, rounds: [{ say: "1. Tidy." }] },
  { id: "plan-off", what: "plan mode off", ask: "Go on.", rounds: [{ say: "Tidied." }] },
  { id: "overview", what: "an ask that reads like an overview", ask: "Give me an overview of this project.", rounds: [{ say: "It is a harness." }] },
  { id: "after-overview", what: "a plain follow-up", ask: "Shorter please.", rounds: [{ say: "Harness." }] },
  { id: "approve-on", what: "auto-approve turned on", ask: "Do the next ones without asking.", set: { autoApprove: true }, rounds: [{ say: "Will do." }] },
  { id: "approve-off", what: "auto-approve turned off", ask: "Ask me again from here.", set: { autoApprove: false }, rounds: [{ say: "Asking again." }] },
  { id: "foundry", what: "makes a Foundry page", ask: "Sketch the plans page.", rounds: [{ call: [{ name: "foundry_save", args: { title: "Plans", kind: "page", source: PAGE } }] }, { say: "Saved." }] },
  { id: "after-foundry", what: "a plain follow-up", ask: "Nice.", rounds: [{ say: "Thanks." }] },
  { id: "pictures", what: "looks at four pictures, one after the other", ask: "Look at the screenshot after each change.", rounds: [
    ...Array.from({ length: 4 }, () => ({ call: [{ name: "view_image", args: { path: "shot.png" } }] })), { say: "They match." }] },
  { id: "attended", what: "a turn that asks before it acts", ask: "One more thing, what is 2+2?", mode: "ask", rounds: [{ say: "4" }] },
  { id: "unattended", what: "back to acting without asking", ask: "And 3+3?", rounds: [{ say: "6" }] },
  { id: "away", what: "the next ask after 20 minutes away, inside the cache's 30", ask: "Still there?", idleMinutes: 20, rounds: [{ say: "Yes." }] },
  { id: "back", what: "a plain follow-up", ask: "Good.", rounds: [{ say: "Yes." }] },
  { id: "long-away", what: "the next ask after 45 minutes away, past the cache's 30", ask: "And now?", idleMinutes: 45, rounds: [{ say: "Still here." }] },
  { id: "long-back", what: "a plain follow-up", ask: "Good.", rounds: [{ say: "Yes." }] },
];

/// A short chat on a window too small for every tool's description: the
/// tools beyond the everyday ones wait, and are called through use_tool.
export const SMALL_CHAT: ScriptedTurn[] = [
  { id: "small:first", what: "small window: a plain ask", ask: "Hello.", rounds: [{ say: "Hello." }] },
  { id: "small:waiting-tool", what: "small window: a waiting tool, first asked how it is called", ask: "Check the history please.", rounds: [
    { call: [{ name: "tool_search", args: { names: ["git_history"] } }] }, { call: [{ name: "use_tool", args: { name: "git_history", input: { action: "log" } } }] }, { say: "Done." }] },
  { id: "small:after-tool", what: "small window: a plain follow-up", ask: "Ok and then?", rounds: [{ say: "Nothing more." }] },
  { id: "small:tool-again", what: "small window: the waiting tool again", ask: "Once more.", rounds: [{ call: [{ name: "use_tool", args: { name: "git_history", input: { action: "log" } } }] }, { say: "Same." }] },
];
/// Small enough that Demesne's own tools wait (tool-search.ts WHOLE_SHARE).
const SMALL_WINDOW = 32_768;

/// The breaks that exist today: request (turn id # round) -> where it
/// breaks, and the step of the caching plan that removes it.
export const KNOWN: Record<string, { at: NonNullable<PrefixReport["brokeAt"]>; step: number; why: string }> = {
  // By design: the stand-in model says it keeps its cache 30 minutes
  // (cache-clock.ts). Past that the cache is gone, so old reads and page
  // sources are cut for free (forget-reads.ts). Inside it nothing is touched.
  "long-away#1": { at: "history", step: 5, why: "old reads and page sources are cut once the provider's cache is gone" },
};

export interface MeasuredRequest { id: string; what: string; report: PrefixReport;
  /// The newest message as the model got it: the ask, then any notes (chat-notes.ts).
  asked: string }
export interface PrefixCheck { requests: MeasuredRequest[]; problems: string[]; sentChars: number; keptChars: number; possibleChars: number }

export async function runPrefixCheck(): Promise<PrefixCheck> {
  const problems: string[] = [];
  const requests = [...await runChat(CHAT, 1_000_000, problems), ...await runChat(SMALL_CHAT, SMALL_WINDOW, problems)];
  for (const { id, report } of requests) {
    const known = KNOWN[id];
    if (report.brokeAt && !known) problems.push(`New break at ${id}: ${report.cause ?? report.brokeAt}. Keep the start of the request the same and add what changed at the end instead.`);
    else if (report.brokeAt && known && report.brokeAt !== known.at) problems.push(`${id} now breaks at the ${report.brokeAt}, not the ${known.at}: ${report.cause ?? ""}`);
    else if (!report.brokeAt && known && report.previousChars !== null) problems.push(`${id} no longer breaks the prefix. Remove it from KNOWN in scripts/check-cache-prefix.ts.`);
  }
  for (const id of Object.keys(KNOWN)) if (!requests.some((request) => request.id === id)) problems.push(`KNOWN lists ${id}, which the chat never sent.`);
  const sentChars = requests.reduce((total, { report }) => total + report.sentChars, 0);
  const keptChars = requests.reduce((total, { report }) => total + (report.keptChars ?? 0), 0);
  // With nothing rewritten, each request would keep all of the one before it.
  const possibleChars = requests.reduce((total, { report }) => total + Math.min(report.previousChars ?? 0, report.sentChars), 0);
  return { requests, problems, sentChars, keptChars, possibleChars };
}

/// One scripted chat through the engine, on a model with this window.
async function runChat(chat: ScriptedTurn[], contextCapacity: number, problems: string[]): Promise<MeasuredRequest[]> {
  let turnIndex = 0, round = 0, calls = 0;
  const asked: string[] = [];
  const model: TurnProcessor = {
    providerId: "stand-in", modelId: "scripted", contextCapacity, maxOutputTokens: Math.min(8000, Math.floor(contextCapacity / 8)), preservesPromptCache: true, cacheLifeMs: 30 * 60_000,
    async listModels() { return [{ id: "scripted", provider: "stand-in", contextWindow: contextCapacity }]; },
    async *stream(messages): AsyncGenerator<ProviderStreamEvent> {
      asked.push(String(messages.findLast((message) => message.role === "user")?.content ?? ""));
      const step = chat[turnIndex]!.rounds[round++] ?? { say: "(the script ran out)" };
      if ("call" in step) {
        for (const [index, call] of step.call.entries()) yield { type: "tool_call_delta", index, idDelta: `call-${calls++}`, nameDelta: call.name, argumentsDelta: JSON.stringify(call.args) };
        yield { type: "finish", reason: "tool_calls" };
      } else { yield { type: "text_delta", delta: step.say }; yield { type: "finish", reason: "stop" }; }
    },
  };
  const root = realpathSync(mkdtempSync(join(tmpdir(), "demesne-prefix-check-")));
  const repo = resolve(import.meta.dir, ".."), project = join(root, "project");
  for (const part of ["apps/daemon/src", "packages/protocol/src", "README.md"]) cpSync(join(repo, part), join(project, part), { recursive: true });
  // The smallest PNG there is: one grey pixel.
  writeFileSync(join(project, "shot.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNoAAAAggCBd81ytgAAAABJRU5ErkJggg==", "base64"));
  mkdirSync(join(root, "data"));
  writeFileSync(join(root, "data", "trusted-workspaces.json"), JSON.stringify({ trusted: [project] }));
  const database = join(root, "data", "state.sqlite");
  let clock = Date.now();
  const app = createDaemonApp({ databasePath: database, authToken: "prefix-check", processor: model, heartbeat: { enabled: false }, nameChats: false, deferTools: true, providerVision: true, now: () => new Date(clock) });
  const server = serveDaemon(app, { hostname: "127.0.0.1", port: 0 });
  const client = new DemesneClient({ server: server.url.href, token: "prefix-check" });
  const requests: MeasuredRequest[] = [];
  try {
    const { session } = await client.createSession({ workspacePath: project, trustWorkspace: true });
    for (const [index, turn] of chat.entries()) {
      turnIndex = index; round = 0; asked.length = 0;
      clock += (turn.idleMinutes ?? 0.5) * 60_000;
      if (turn.set) await client.updateSession(session.id, turn.set);
      const { turn: submitted } = await client.submitTurn(session.id, { content: turn.ask, permissionMode: turn.mode ?? "allow", ...(turn.planOnly ? { planOnly: true } : {}) });
      for (const deadline = Date.now() + 60_000; ;) {
        const state = (await client.getSessionState(session.id)).session.turns.find((entry) => entry.id === submitted.id);
        if (state && !["queued", "running"].includes(state.status)) { if (state.status !== "completed") problems.push(`Turn "${turn.id}" ended ${state.status}.`); break; }
        if (Date.now() > deadline) { problems.push(`Turn "${turn.id}" did not finish.`); break; }
        await Bun.sleep(20);
      }
      const db = new Database(database, { readonly: true });
      const rows = db.query("SELECT prefix_json FROM provider_calls WHERE turn_id = ? ORDER BY rowid").all(submitted.id) as { prefix_json: string | null }[];
      db.close();
      if (rows.length !== turn.rounds.length) problems.push(`Turn "${turn.id}" made ${rows.length} requests, the script has ${turn.rounds.length}.`);
      for (const [at, row] of rows.entries()) {
        if (!row.prefix_json) { problems.push(`Request ${turn.id}#${at + 1} has no cache meter record.`); continue; }
        requests.push({ id: `${turn.id}#${at + 1}`, what: `${turn.what}${rows.length > 1 ? `, round ${at + 1}` : ""}`, report: JSON.parse(row.prefix_json) as PrefixReport, asked: asked[at] ?? "" });
      }
    }
  } finally {
    await server.stop(true);
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
  return requests;
}

if (import.meta.main) {
  const check = await runPrefixCheck();
  const share = (part: number, whole: number | null) => whole ? `${Math.round(part / whole * 100)}%` : "";
  for (const { id, what, report } of check.requests) {
    const kept = report.previousChars === null ? "first request" : `kept ${share(report.keptChars ?? 0, report.previousChars).padStart(4)} of the request before`;
    console.log(`${id.padEnd(18)} ${String(report.sentChars).padStart(7)} chars  ${kept}${report.brokeAt ? `  (plan step ${KNOWN[id]?.step ?? "?"})` : ""}  ${what}`);
    if (report.cause) console.log(`${" ".repeat(19)}${report.cause}`);
  }
  const breaks = check.requests.filter(({ report }) => report.brokeAt).length;
  console.log(`\n${check.requests.length} requests, ${breaks} broke the prefix. A cache could reuse ${share(check.keptChars, check.sentChars)} of what was sent; ${share(check.possibleChars, check.sentChars)} with nothing rewritten.`);
  const out = process.argv.indexOf("--json");
  if (out > 0 && process.argv[out + 1]) writeFileSync(process.argv[out + 1]!, JSON.stringify(check, null, 2));
  if (check.problems.length) { console.error(`\n${check.problems.join("\n")}`); process.exit(1); }
  console.log("No new breaks.");
}
