import { createPainter, SLASH_COMMANDS, themeNames } from "../packages/brand/src/index.ts";
import { CliContextRail } from "../apps/cli/src/context-rail.ts";
import { Workbench } from "../apps/cli/src/workbench/controller.ts";
import { seedSession, type PreviewState } from "./session-fixture.ts";
import type { SessionView } from "../apps/cli/src/workbench/session.ts";
import type { ArtifactKind } from "../apps/cli/src/workbench/session-flow.ts";
import type { DriveState } from "../packages/protocol/src/index.ts";

const args = process.argv.slice(2);
const state = (args.find((arg) => arg.startsWith("--state="))?.split("=")[1] ?? "complete") as PreviewState;
if (!["start", "working", "tools", "thinking", "thinking-answer", "waiting", "approval", "complete", "question", "verify-only", "failed-change", "round-limit", "unverified", "long"].includes(state)) throw new Error("Use --state=start, working, tools, thinking, thinking-answer, waiting, approval, complete, question, verify-only, failed-change, round-limit, unverified or long.");
const snapshot = args.find((arg) => arg.startsWith("--snapshot="))?.split("=")[1];
const paint = createPainter(!args.includes("--plain"), process.env.DEMESNE_THEME);
const rail = new CliContextRail({ id: "demonstration-model", provider: "demo", contextWindow: 100_000 }, process.cwd());
rail.setBranch("unicode-identifiers");
let queue = "";
let interrupted = false;
let drivePreview: DriveState | null = null;
const ui = new Workbench({ paint, contextRail: rail, sessionTitle: "Unicode identifiers", workspaceRoot: "~/demesne", version: "preview",
  drive: args.includes("--drive") ? { control(control) {
    if (!drivePreview) return;
    drivePreview = { ...drivePreview, status: control === "resume" ? "running" : control === "stop" ? "stopped" : "paused",
      activity: control === "resume" ? "Reviewing the saved implementation." : `Drive ${control === "stop" ? "stopped" : "paused"}.` };
    ui.setDrive(drivePreview);
  }, intervene() {} } : undefined,
  onExit: () => { ui.stop(); process.exit(0); }, onInterrupt: () => {
    if (interrupted) { ui.stop(); process.exit(0); }
    interrupted = true;
    ui.toolFinished({ toolCallId: "check", name: "run_command", state: "stopped", message: "Stopped in preview." });
    ui.finishTurn("stopped", "Stopped · demonstration data");
    void promptLoop();
  }, queue: { get: () => queue, set: (value) => { queue = value; } },
});
seedSession(ui, state);
if (state === "start") ui.setRecentSessions([
  { id: "preview-completed", title: "Unicode identifiers", updatedAt: new Date(Date.now() - 2 * 3600_000).toISOString(), turns: 12, lastStatus: "completed" },
  { id: "preview-stopped", title: "Durable compaction", updatedAt: new Date(Date.now() - 24 * 3600_000).toISOString(), turns: 31, lastStatus: "interrupted" },
  { id: "preview-failed", title: "Image preview panel", updatedAt: "2026-09-26T12:00:00Z", turns: 8, lastStatus: "failed" },
]);
ui.setFooter(" DEMO / no model connected", "");
// Preview navigation uses production input routing, including its focus rules.
const input = ui as unknown as { onKeypress(text: string, key: { name?: string; meta?: boolean; ctrl?: boolean }): void };
const view = (args.find((arg) => arg.startsWith("--view="))?.split("=")[1] ?? "response").toLowerCase();
const viewRights: Record<string, number> = { response: 0, review: 1, log: 0 };
if (!(view in viewRights)) throw new Error("Use --view=response, review or log.");
const viewIndex = viewRights[view]!;
const viewIsLog = view === "log";
for (let index = 0; index < viewIndex; index++) input.onKeypress("", { name: "right", meta: true });
if (viewIsLog) input.onKeypress("", { name: "b", ctrl: true });

async function promptLoop(): Promise<void> {
  while (true) {
    const value = (await ui.readPrompt({ history: [], mentions: ["src/lexer.ts", "tests/parser.test.ts"], commands: SLASH_COMMANDS })).trim();
    if (value === "/exit") { ui.stop(); process.exit(0); }
    if (value.startsWith("/theme")) {
      const names = themeNames();
      const query = value.slice(6).trim();
      if (names.includes(query)) paint.setTheme(query);
      else { const selected = await ui.choose("Theme", names); if (selected !== null) paint.setTheme(names[selected]!); }
    } else if (value === "/model") await ui.choose("Preview model", ["demonstration-model (fixture)"]);
    else if (value === "/sessions") await ui.choose("Preview session", ["Unicode identifiers"]);
    else {
      ui.beginTurn({ userText: value, at: "now" });
      ui.assistantDelta("This is demonstration data. Run `bun run demesne` to direct your configured model.\n\nTry selecting an earlier run, opening Changes, or inspecting the recorded check.");
      ui.finishTurn("completed", "Preview complete");
    }
  }
}

if (state === "approval") {
  void ui.askApproval({ summary: "Run the parser regression suite", toolName: "run_command", allowPersist: false,
    previewRows: ["bun test tests/parser.test.ts", "Working directory: ~/demesne"] }).then((decision) => {
    ui.toolFinished({ toolCallId: "check", name: "run_command", state: decision === "deny" ? "denied" : "done", ...(decision === "deny" ? {} : { exitCode: 0 }), message: "Preview decision recorded; no command executed." });
    ui.finishTurn(decision === "deny" ? "stopped" : "completed", "Decision recorded · demonstration data");
    void promptLoop();
  });
} else if (state === "working" || state === "tools" || state === "thinking" || state === "thinking-answer" || state === "waiting") {
  // Enter streaming mode through the same prompt path as the real CLI.
  void ui.readPrompt({ history: [], mentions: [], commands: [] });
  // Submit through the prompt before restoring the selected view.
  if (viewIndex > 0) input.onKeypress("", { name: "escape" });
  if (viewIndex > 0) input.onKeypress("", { name: "escape" });
  input.onKeypress("Preview run", {});
  input.onKeypress("", { name: "return" });
  for (let index = 0; index < viewIndex; index++) input.onKeypress("", { name: "right", meta: true });
  if (viewIsLog) input.onKeypress("", { name: "b", ctrl: true });
} else void promptLoop();

if (args.includes("--long-draft")) {
  // Seed a long follow-up through production routing so the prompt shows the
  // bounded editor, its scroll, and the always-visible controls.
  const draft = Array.from({ length: 12 }, (_, index) => `Follow-up line ${index + 1}: keep the token contract stable while ${index % 2 ? "extending the guard" : "checking the suite"}.`).join("\n");
  input.onKeypress(draft, {});
}
const commandQuery = args.find((arg) => arg.startsWith("--commands="))?.slice("--commands=".length);
if (commandQuery !== undefined) input.onKeypress(commandQuery || "/", {});
const mentionQuery = args.find((arg) => arg.startsWith("--mentions="))?.slice("--mentions=".length);
if (mentionQuery !== undefined) {
  ui.setMentionFiles(["src/lexer.ts", "src/parser.ts", "src/identifier.ts", "tests/parser.test.ts"]);
  input.onKeypress(`@${mentionQuery}`, {});
}
if (args.includes("--trace")) {
  // Inspect the most recent reasoning in the conversation, through production
  // input routing. Live thinking is already expanded, so toggle twice there.
  ui.frame(80, 24);
  const view = (ui as unknown as { sessionView: { current?: { entries: { type: string; id: number }[] }; memory: { expansion: Map<string, boolean> } } }).sessionView;
  const thinking = view.current?.entries.findLast((entry) => entry.type === "reasoning");
  if (!thinking) throw new Error("--trace needs a state with reasoning (use --state=thinking).");
  input.onKeypress("", { name: "x", ctrl: true });
  if (!view.memory.expansion.get(`entry:${thinking.id}`)) input.onKeypress("", { name: "x", ctrl: true });
}
const inspect = args.find((arg) => arg.startsWith("--inspect="))?.split("=")[1];
if (inspect) {
  if (!["changes", "verification", "failure"].includes(inspect)) throw new Error("Use --inspect=changes, verification or failure.");
  ui.frame(80, 24);
  const view = (ui as unknown as { sessionView: SessionView }).sessionView;
  if (view.current) view.act({ kind: "artifact", runId: view.current.id, target: inspect as ArtifactKind });
}
if (args.includes("--live-diff")) {
  ui.beginTurn({ userText: "Add a lexer helper and regression coverage.", at: "now" });
  for (const [index, path] of ["src/lexer.ts", "tests/lexer.test.ts"].entries()) {
    const before = index ? "" : "export const isLetter = (c: string) => /[a-z]/i.test(c);\n";
    const after = index ? 'test("Unicode letters", () => expect(isLetter("界")).toBe(true));\n'
      : "export const isLetter = (c: string) => /\\p{L}/u.test(c);\n";
    ui.toolRequested({ toolCallId: `preview-${index}`, name: "write_file", arguments: { path, content: after } });
    ui.toolFinished({ toolCallId: `preview-${index}`, name: "write_file", state: "done", changes: [{ path, before: before || null, after, beforeExists: !!before, afterExists: true }] });
  }
  const content = [
    "export interface Identifier {", '  kind: "identifier";', "  value: string;", "  end: number;", "}", "",
    "export function scanIdentifier(", "  source: string,", "  start = 0,", "): Identifier | null {",
    "  const first = source.codePointAt(start);", "  if (first === undefined) return null;",
    "  const initial = String.fromCodePoint(first);", "  if (!/[\\p{L}_]/u.test(initial)) return null;", "",
    "  // Advance by complete Unicode code points.", "  let end = start + initial.length;", "  while (end < source.length) {",
    "    const char = String.fromCodePoint(source.codePointAt(end)!);", "    if (!/[\\p{L}\\p{N}_]/u.test(char)) break;",
    "    end += char.length;", "  }", "", '  return { kind: "identifier", value: source.slice(start, end), end };', "}", "",
  ].join("\n");
  const input = { path: "src/identifier.ts", content };
  const raw = JSON.stringify(input); let sent = 0, eventId = 0;
  const advance = () => {
    const end = Math.min(raw.length, sent + 90);
    ui.toolDraft({ schemaVersion: 1, eventId: ++eventId, type: "tool.call_draft", occurredAt: new Date().toISOString(), sessionId: "demo", turnId: "demo", workspaceId: null, agentRunId: null,
      payload: { draftId: "preview:0", name: "write_file", delta: raw.slice(sent, end) } });
    sent = end;
  };
  for (let i = 0; i < 6; i++) advance();
  ui.frame(120, 36);
  const session = (ui as unknown as { sessionView: SessionView }).sessionView;
  session.act({ kind: "diff-open", runId: session.current!.id });
  if (!snapshot) {
    const timer = setInterval(() => {
      if (interrupted) { clearInterval(timer); return; }
      advance();
      if (sent < raw.length) return;
      clearInterval(timer);
      ui.toolRequested({ toolCallId: "preview-written", draftId: "preview:0", name: "write_file", arguments: input });
      ui.toolFinished({ toolCallId: "preview-written", name: "write_file", state: "done", changes: [{ path: input.path, before: null, after: content, beforeExists: false, afterExists: true }] });
      ui.finishTurn("completed", "Preview complete · demonstration data");
    }, 350);
  }
}
if (args.includes("--expand-diff")) (ui as unknown as { sessionView: SessionView }).sessionView.act({ kind: "diff-expand" });
if (args.includes("--drive")) {
  drivePreview = { id: "demo", mission: "Finish the Unicode identifier changes from the earlier conversation and review the result.", homeSessionId: "demo", workspace: "~/demesne", status: "running",
    activity: "Inspecting the applied Diff and parser regression results.", step: 8, model: "demo / configured-model", updatedAt: new Date().toISOString(),
    notes: "Recovered the ASCII compatibility requirement from History. The coding agent updated the letter guard; now review the recorded checks.",
    completed: ["Recovered the original goal", "Submitted a targeted implementation request"], remaining: ["Review mixed-script and leading-digit coverage"],
    evidence: [{ observationId: "demo-screen", quote: "42 pass · 0 fail" }], steps: [{ step: 8, action: '{"kind":"key","key":"alt+d"}', note: "Open the applied changes", result: "Pressed alt+d.", at: new Date().toISOString() }] };
  ui.setDrive(drivePreview); ui.showDrive();
}
if (args.includes("--context")) {
  rail.apply({ schemaVersion: 1, eventId: 1, type: "model.request_started", occurredAt: new Date().toISOString(), workspaceId: null, sessionId: "demo", turnId: "demo", agentRunId: null,
    payload: { contextPlan: { schemaVersion: 3, capacityTokens: 100000, estimatedInputTokens: 42000, estimatedMessageTokens: 36000, estimatedToolDefinitionTokens: 6000,
      reserves: { outputTokens: 16000, toolResultTokens: 1500, safetyTokens: 500, totalTokens: 18000 }, maximumPlannedInputTokens: 82000, budgetStatus: "within_soft_limit", actions: [] } } });
  ui.frame(110, 30); input.onKeypress("", { name: "c", meta: true });
}
if (snapshot) {
  const match = /^(\d+)x(\d+)$/.exec(snapshot);
  if (!match) throw new Error("Snapshot size must be WIDTHxHEIGHT, e.g. --snapshot=80x24.");
  process.stdout.write(ui.frame(Number(match[1]), Number(match[2])).rows.join("\n") + "\n");
} else {
  if (!process.stdout.isTTY) throw new Error("Use an interactive terminal, or --snapshot=80x24 --plain.");
  process.on("SIGTERM", () => { ui.stop(); process.exit(0); });
  ui.start();
}
