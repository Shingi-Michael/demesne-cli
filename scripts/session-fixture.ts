import type { Workbench } from "../apps/cli/src/workbench/controller.ts";

export type PreviewState = "start" | "working" | "tools" | "thinking" | "thinking-answer" | "waiting" | "approval" | "complete" | "question" | "verify-only" | "failed-change" | "round-limit" | "unverified" | "long";

/// Explicit demonstration records; no model or filesystem operation is performed.
export function seedSession(ui: Workbench, state: PreviewState): void {
  if (state === "start") return;
  if (state === "round-limit") {
    ui.beginTurn({ userText: "Trace the call flow and map out the architecture.", at: "14:32" });
    for (const [index, path] of ["README.md", "package.json", "apps/cli/src/main.ts", "apps/daemon/src/main.ts", "apps/daemon/src/app.ts", "apps/daemon/src/engine.ts"].entries()) {
      ui.beginRound();
      ui.reasoningDelta(`Inspect ${path} to understand this part of the request flow.`);
      ui.toolRequested({ toolCallId: `read-${index}`, name: "read_file", arguments: { path } });
      ui.toolFinished({ toolCallId: `read-${index}`, name: "read_file", state: index === 5 ? "failed" : "done", durationMs: 18,
        message: index === 5 ? "Turn exceeded the model round limit." : "Demonstration file output; no file was read." });
    }
    ui.contextEvent({ schemaVersion: 1, eventId: 1, sessionId: "preview", turnId: "preview-turn", workspaceId: null, agentRunId: null,
      occurredAt: new Date().toISOString(), type: "model.usage", payload: { totalTokens: 63900 } });
    ui.finishTurn("failed", "Turn exceeded the model round limit.", { durationMs: 94200, tokensPerSecond: 19.4 });
    return;
  }
  if (state === "tools") {
    ui.beginTurn({ userText: "Accept Unicode identifiers, then run the parser checks.", at: "14:32" });
    ui.reasoningDelta("I need to inspect the letter guard before changing it.\nThe parser’s token contract should stay the same.");
    ui.toolRequested({ toolCallId: "read", name: "read_file", arguments: { path: "src/lexer.ts" } });
    ui.toolFinished({ toolCallId: "read", name: "read_file", state: "done", durationMs: 14,
      message: "The current guard accepts ASCII letters and underscores." });
    ui.beginRound();
    ui.assistantDelta("The guard is ASCII-only. I’ll use a Unicode letter property escape.");
    ui.toolRequested({ toolCallId: "edit", name: "edit_file", arguments: { path: "src/lexer.ts",
      oldText: "return /[a-zA-Z_]/.test(char);", newText: "return /[\\p{L}_]/u.test(char);" } });
    ui.toolFinished({ toolCallId: "edit", name: "edit_file", state: "done", durationMs: 8 });
    ui.beginRound();
    ui.assistantDelta("The guard is updated. I’m checking Unicode and existing ASCII cases.");
    ui.toolRequested({ toolCallId: "check", name: "run_command", arguments: { argv: ["bun", "test", "tests/parser.test.ts"] } });
    return;
  }
  // Single-run scenarios, each showing one shape of recorded evidence.
  if (state === "question") {
    ui.beginTurn({ userText: "What is the identifier boundary in the parser?", at: "14:28" });
    ui.assistantDelta("The identifier boundary is the letter guard in `src/lexer.ts`. It accepts ASCII letters and underscores, so Unicode letters are rejected by the lexer.");
    ui.finishTurn("completed", "Complete · demonstration data");
    return;
  }
  if (state === "verify-only") {
    ui.beginTurn({ userText: "Run the parser regression suite.", at: "14:28" });
    ui.toolRequested({ toolCallId: "check", name: "run_command", arguments: { argv: ["bun", "test", "tests/parser.test.ts"] } });
    ui.toolFinished({ toolCallId: "check", name: "run_command", state: "done", exitCode: 0, durationMs: 1200,
      message: "Parser regression suite (preview fixture)\n  ✓ ASCII identifiers\n  ✓ Unicode letters\n  ✓ Leading digits rejected\n\n42 pass · 0 fail" });
    ui.beginRound();
    ui.assistantDelta("The regression suite passed: **42 pass · 0 fail**. No files were changed.");
    ui.finishTurn("completed", "Complete · demonstration data");
    return;
  }
  if (state === "failed-change") {
    ui.beginTurn({ userText: "Accept Unicode identifiers. Preserve ASCII behavior.", at: "14:28" });
    ui.assistantDelta("I’ll update the letter guard in `src/lexer.ts`.");
    ui.toolRequested({ toolCallId: "edit", name: "edit_file", arguments: { path: "src/lexer.ts",
      oldText: "export function isIdentifierStart(char: string): boolean {\n  return /[a-zA-Z_]/.test(char);\n}",
      newText: "export function isIdentifierStart(char: string): boolean {\n  return /[\\p{L}_]/u.test(char);\n}" } });
    ui.toolFinished({ toolCallId: "edit", name: "edit_file", state: "failed",
      message: "The edit could not be applied: the file changed on disk after it was read." });
    ui.finishTurn("failed", "Failed · demonstration data");
    return;
  }
  if (state === "unverified") {
    ui.beginTurn({ userText: "Accept Unicode identifiers. Preserve ASCII behavior.", at: "14:28" });
    ui.assistantDelta("I’ll update the letter guard in `src/lexer.ts`.");
    ui.toolRequested({ toolCallId: "edit", name: "edit_file", arguments: { path: "src/lexer.ts",
      oldText: "export function isIdentifierStart(char: string): boolean {\n  return /[a-zA-Z_]/.test(char);\n}",
      newText: "export function isIdentifierStart(char: string): boolean {\n  return /[\\p{L}_]/u.test(char);\n}" } });
    ui.toolFinished({ toolCallId: "edit", name: "edit_file", state: "done", durationMs: 8 });
    ui.beginRound();
    ui.assistantDelta("The letter guard now accepts Unicode letters. **No verification was run** for this change.");
    ui.finishTurn("completed", "Complete · demonstration data");
    return;
  }
  // Waiting for the first output: the request and an inline Thinking spinner,
  // without a fabricated reasoning record or placeholder response.
  if (state === "waiting") {
    ui.beginTurn({ userText: "Accept Unicode identifiers. Preserve ASCII behavior.", at: "14:32" });
    return;
  }
  // A long instruction, reasoning, and response exercise inline disclosures
  // and the shared conversation scroll position.
  if (state === "long") {
    ui.beginTurn({ userText: "Accept Unicode identifiers in the parser.\n\nPreserve the existing ASCII behavior exactly: identifiers start with a letter or underscore and continue with letters, digits, or underscores. Leading digits remain rejected.\n\nHandle mixed-script identifiers — for example café, 日本語, and ελληνικά — without changing the token contract. Update the regression suite with cases for Latin accents, CJK, Greek, and leading-digit rejection. Keep the lexer’s public API unchanged.", at: "14:28" });
    ui.reasoningDelta("The instruction has four constraints: Unicode letters, preserved ASCII behavior, the token contract, and a regression suite.\nFirst I need to read the current guard to see exactly which characters it accepts.\nThe guard is a single regex, so the replacement is a Unicode property escape: /\\p{L}/u.\nI must confirm the parser does not re-validate identifiers after lexing; if it does, the second check needs the same change.\nThe regression suite already covers ASCII identifiers and leading digits; I will add accent, CJK, and Greek cases.\nI should also check that the /u flag is already used somewhere in the codebase, since it changes how the engine interprets escape sequences.\nFinally, the public API must stay unchanged: isIdentifierStart keeps its name, parameter type, and return type.");
    ui.toolRequested({ toolCallId: "read", name: "read_file", arguments: { path: "src/lexer.ts" } });
    ui.toolFinished({ toolCallId: "read", name: "read_file", state: "done", durationMs: 11, message: "The guard is a single ASCII regex with no /u flag." });
    ui.toolRequested({ toolCallId: "edit", name: "edit_file", arguments: { path: "src/lexer.ts",
      oldText: "return /[a-zA-Z_]/.test(char);", newText: "return /[\\p{L}_]/u.test(char);" } });
    ui.toolFinished({ toolCallId: "edit", name: "edit_file", state: "done", durationMs: 9 });
    ui.toolRequested({ toolCallId: "check", name: "run_command", arguments: { argv: ["bun", "test", "tests/parser.test.ts"] } });
    ui.toolFinished({ toolCallId: "check", name: "run_command", state: "done", exitCode: 0, durationMs: 1400,
      message: "Parser regression suite (preview fixture)\n  ✓ ASCII identifiers\n  ✓ Leading digits rejected\n  ✓ Latin accents: café\n  ✓ CJK: 日本語\n  ✓ Greek: ελληνικά\n\n42 pass · 0 fail" });
    ui.beginRound();
    ui.assistantDelta("## Unicode identifiers, with ASCII preserved\n\nThe letter guard now accepts any Unicode letter through the `\\p{L}` property escape, while the ASCII cases keep their exact behavior.\n\n- `café`, `日本語`, and `ελληνικά` identifiers are accepted at the start and in the middle.\n- Leading digits are still rejected: `1abc` remains a number, not an identifier.\n- The token contract and the public API of `src/lexer.ts` are unchanged.\n\n```ts\nreturn /[\\p{L}_]/u.test(char);\n```\n\nThe regression suite adds accent, CJK, Greek, and leading-digit cases alongside the existing ASCII coverage. The suite reports 42 pass · 0 fail.");
    ui.finishTurn("completed", "Complete · 2.1s · demonstration data");
    return;
  }
  ui.beginTurn({ userText: "Find the identifier boundary in the parser.", at: "14:28" });
  ui.toolRequested({ toolCallId: "survey", name: "read_file", arguments: { path: "src/lexer.ts" } });
  ui.toolFinished({ toolCallId: "survey", name: "read_file", state: "done", durationMs: 14, message: "The identifier guard accepts ASCII letters and underscores." });
  ui.beginRound();
  ui.assistantDelta("The boundary is in `src/lexer.ts`. Its ASCII-only guard rejects Unicode letters. The parser can keep its current token contract.");
  ui.finishTurn("completed", "Survey complete · demonstration data");
  ui.beginTurn({ userText: "Accept Unicode identifiers. Preserve ASCII behavior.", at: "14:32" });
  if (state === "thinking") {
    ui.reasoningDelta("The identifier guard currently accepts only ASCII letters.\nI need to check whether the parser already normalizes multi-byte input.\nThen I can adjust the guard without changing the token contract.");
    return;
  }
  // Two reasoning rounds around an agent update, in their original order on
  // the same reading surface at every width.
  if (state === "thinking-answer") {
    ui.reasoningDelta("First: the guard needs the Unicode property escape, not a longer ASCII range.");
    ui.assistantDelta("I’ll update the letter guard in `src/lexer.ts`.");
    ui.beginRound();
    ui.reasoningDelta("Second: check whether the parser already normalizes multi-byte input before the guard runs.\nMixed-script identifiers — café, 日本語, ελληνικά — must keep working.\nThen I can adjust the guard without changing the token contract.");
    return;
  }
  ui.assistantDelta("I’ll update the letter guard and check mixed-script identifiers against the existing ASCII cases.");
  for (const [index, path] of ["src/lexer.ts", "src/parser.ts", "tests/parser.test.ts"].entries()) {
    ui.toolRequested({ toolCallId: `read-${index}`, name: "read_file", arguments: { path } });
    ui.toolFinished({ toolCallId: `read-${index}`, name: "read_file", state: "done", durationMs: 12 });
  }
  ui.toolRequested({ toolCallId: "edit", name: "edit_file", arguments: { path: "src/lexer.ts",
    oldText: "export function isIdentifierStart(char: string): boolean {\n  return /[a-zA-Z_]/.test(char);\n}",
    newText: "export function isIdentifierStart(char: string): boolean {\n  return /[\\p{L}_]/u.test(char);\n}" } });
  ui.toolFinished({ toolCallId: "edit", name: "edit_file", state: "done", durationMs: 8 });
  ui.toolRequested({ toolCallId: "check", name: "run_command", arguments: { argv: ["bun", "test", "tests/parser.test.ts"] } });
  if (state === "approval") ui.toolWaiting("check", true);
  if (state !== "complete") return;
  ui.toolFinished({ toolCallId: "check", name: "run_command", state: "done", exitCode: 0, durationMs: 1200,
    message: "Parser regression suite (preview fixture)\n  ✓ ASCII identifiers\n  ✓ Unicode letters\n  ✓ Mixed-script identifiers\n  ✓ Leading digits rejected\n\n42 pass · 0 fail" });
  ui.beginRound();
  ui.assistantDelta("## Unicode identifiers are accepted\nThe lexer now recognizes Unicode letters while preserving ASCII behavior.\n\n- Updated `src/lexer.ts`; the parser contract is unchanged.\n- The regression command completed: **42 passed, 0 failed**.\n\n```ts\nreturn /[\\p{L}_]/u.test(char);\n```");
  ui.finishTurn("completed", "Complete · 1.2s · demonstration data");
}
