import { expect, test } from "bun:test";
import { createPainter, visibleLength } from "@demesne/brand";
import { partialToolArguments, applyToolDraft } from "../src/workbench/tool-preview.ts";
import { codeDiff } from "../src/workbench/change-diff.ts";
import { DiffPanel, changeFiles } from "../src/workbench/diff-panel.ts";
import { SessionView, planRuns } from "../src/workbench/session.ts";
import { Workbench } from "../src/workbench/controller.ts";
import { CliContextRail } from "../src/context-rail.ts";
import type { ToolEntry, WorkbenchEntry } from "../src/workbench/entries.ts";

const paint = createPainter(false);
const user = (id = 1): WorkbenchEntry => ({ id, type: "user", text: "Write code", at: "12:00" });
const tool = (id: number, path: string, before = "", after = "const answer = 42;\n"): ToolEntry => ({ id, type: "tool", toolCallId: String(id), name: "write_file", input: { path, content: after },
  phase: "change", state: "done", startedAt: 0, changes: [{ path, before: before || null, after, beforeExists: !!before, afterExists: true }] });

test("partial JSON renders streamed escaped code and multi-hunk edits without interpreting unfinished escapes", () => {
  const args = { path: "src/界.ts", edits: [{ oldText: "const a = 1;", newText: 'const a = "👩‍💻\\n";\n' }, { oldText: "b", newText: "c" }], all: true };
  const raw = JSON.stringify(args);
  for (let i = 0; i <= raw.length; i++) expect(() => partialToolArguments(raw.slice(0, i))).not.toThrow();
  expect(partialToolArguments(raw)).toEqual(args);
  expect(partialToolArguments('{"path":"a","content":"one\\n\\u754')).toMatchObject({ path: "a", content: "one\n" });
  expect(partialToolArguments('{"content":"\\uD83D')).toMatchObject({ content: "" });
  const entries: WorkbenchEntry[] = [user()]; let id = 2;
  for (const delta of raw) applyToolDraft(entries, { draftId: "round:0", name: "edit_file", delta }, () => id++, 0);
  expect(entries).toHaveLength(2);
  expect(entries[1]).toMatchObject({ drafting: true, state: "running", input: args, diff: { oldText: "const a = 1;\n…\nb" } });
});

test("line diffs retain true line numbers and separate distant changes, including newline-only changes", () => {
  const before = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`);
  const after = [...before]; after[2] = "replaced"; after.splice(30, 0, "inserted");
  const diff = codeDiff(before.join("\n"), after.join("\n"));
  expect(diff.added).toBe(2); expect(diff.removed).toBe(1);
  expect(diff.rows.find((row) => row.text === "replaced")).toMatchObject({ next: 3, kind: "added" });
  expect(diff.rows.find((row) => row.text === "inserted")).toMatchObject({ next: 31, kind: "added" });
  expect(diff.rows.some((row) => row.kind === "gap")).toBe(true);
  expect(codeDiff("a\n", "a").rows.at(-1)?.text).toBe("No newline at end of file");
  expect(codeDiff("", "a\n")).toMatchObject({ added: 1, removed: 0 });
  expect(codeDiff("a\n", "")).toMatchObject({ added: 0, removed: 1 });
  expect(codeDiff("x\n".repeat(2000), "y\n".repeat(2000))).toMatchObject({ added: 2000, removed: 2000 });
});

test("accumulated file evidence preserves creations, deletions and earlier writes after a failed edit", () => {
  const first = tool(2, "a.ts", "", "first\n"), second = tool(3, "a.ts", "first\n", "second\n");
  const failed: ToolEntry = { ...tool(4, "a.ts"), state: "failed", changes: undefined, diff: { oldText: "second\n", newText: "failed\n" } };
  const file = changeFiles([first, second, failed])[0]!;
  expect(file.applied).toMatchObject({ before: null, after: "second\n", beforeExists: false });
  expect(file.tool.state).toBe("failed"); expect(file.revisions).toBe(3);
  const panel = new DiffPanel(); panel.open(planRuns([user(), first, second, failed]), 1);
  const screen = panel.render(80, 32, paint).rows.join("\n");
  expect(screen).toContain("Failed"); expect(screen).toContain("Earlier applied changes"); expect(screen).toContain("not applied");
  const external = tool(5, "a.ts", "external\n", "last\n");
  expect(changeFiles([first, second, external])[0]?.previous).toBeDefined();
});

test("following tracks the active file and next turn; scrolling freezes code through settlement and resize", () => {
  const first = tool(2, "first.ts"), live: ToolEntry = { ...tool(3, "live.ts"), changes: undefined, state: "running", drafting: true,
    diff: { oldText: "", newText: Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n") } };
  const entries: WorkbenchEntry[] = [user(), first, live];
  const panel = new DiffPanel(); panel.open(planRuns(entries), 1);
  expect(panel.render(60, 26, paint).rows.join("\n")).toContain("line 59");
  panel.scroll(-6);
  const paused = panel.render(60, 26, paint).rows.slice(9, 25).join("\n");
  live.state = "done"; live.drafting = false; live.changes = [{ path: "live.ts", before: null, after: "COMPLETELY DIFFERENT", beforeExists: false, afterExists: true }];
  entries.push(tool(4, "later.ts")); panel.sync(planRuns(entries));
  expect(panel.render(60, 26, paint).rows.slice(9, 25).join("\n")).toBe(paused);
  expect(panel.following).toBe(false); expect(panel.selected?.path).toBe("live.ts");
  for (const width of [34, 40, 80, 140]) for (const height of [8, 12, 24, 40]) {
    const frame = panel.render(width, height, paint);
    expect(frame.rows).toHaveLength(height);
    expect(frame.rows.every((row) => visibleLength(row) <= width)).toBe(true);
    expect(frame.zones.every((zone) => zone.row < height && zone.column + zone.width <= width)).toBe(true);
  }
  panel.act({ kind: "diff-live" }); expect(panel.selected?.path).toBe("later.ts");
  entries.push(user(5), tool(6, "next-turn.ts")); panel.sync(planRuns(entries));
  expect(panel.runId).toBe(5); expect(panel.selected?.path).toBe("next-turn.ts");
  panel.act({ kind: "diff-select", path: "next-turn.ts" });
  entries.push(user(7), tool(8, "last-turn.ts")); panel.sync(planRuns(entries));
  expect(panel.runId).toBe(5);
});

test("native diff opens from an edit row and supports dock, expansion, live return and preserved composer drafts", () => {
  const ui = new Workbench({ paint, contextRail: new CliContextRail({ id: "test", provider: "test" }, "/project"), sessionTitle: "Test", version: "test", onExit() {}, onInterrupt() {}, queue: { get: () => "", set() {} } });
  const internals = ui as unknown as { entries: WorkbenchEntry[]; sessionView: SessionView; onKeypress(text: string, key: { name?: string; ctrl?: boolean; meta?: boolean }): void };
  ui.beginTurn({ userText: "Implement this", at: "12:00" });
  ui.toolDraft({ schemaVersion: 1, eventId: 1, type: "tool.call_draft", occurredAt: new Date().toISOString(), sessionId: "s", turnId: "t", workspaceId: null, agentRunId: null,
    payload: { draftId: "r:0", name: "write_file", delta: '{"path":"src/new.ts","content":"export const answer = 42;\\n"}' } });
  ui.frame(120, 36);
  internals.onKeypress("", { name: "d", meta: true });
  expect(ui.frame(120, 36).rows.join("\n")).toContain("Drafting");
  ui.toolRequested({ toolCallId: "actual", name: "write_file", draftId: "r:0", arguments: { path: "src/new.ts", content: "export const answer = 42;\n" } });
  expect(internals.entries.filter((entry) => entry.type === "tool")).toHaveLength(1);
  ui.toolFinished({ toolCallId: "actual", name: "write_file", state: "done", changes: [{ path: "src/new.ts", before: null, after: "export const answer = 42;\n", beforeExists: false, afterExists: true }] });
  ui.finishTurn("completed", "Done");
  void ui.readPrompt({ history: [], commands: [], mentions: [] });
  internals.onKeypress("keep my draft", {});
  internals.onKeypress("", { name: "return", meta: true });
  expect(internals.sessionView.panelExpanded).toBe(true);
  let frame = ui.frame(120, 36).rows.join("\n");
  expect(frame).toContain("New file · applied this turn"); expect(frame).toContain("keep my draft"); expect(frame).toContain("Alt+↵ restore");
  internals.onKeypress("", { name: "escape" });
  expect(internals.sessionView.panelOpen).toBe(false);
  const rendered = ui.frame(120, 36).rows.join("\n");
  expect(rendered).toContain("+1 −0"); expect(rendered).toContain("keep my draft");
  internals.sessionView.act({ kind: "diff-open", runId: 1, recordId: 2 });
  internals.sessionView.key({ name: "g", ctrl: true });
  expect(internals.sessionView.diffOpen).toBe(true);
});

test("the Changes panel follows Figma 20:124: totals, file rows with counts, a file header and folded context", () => {
  const before = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
  const after = before.replace("line 3\n", "line three\n").replace("line 50\n", "line fifty\nline fifty-one\n");
  const edited = tool(2, "apps/daemon/src/app.ts", before, after);
  const created = tool(3, "apps/daemon/src/journal.ts", "", "export const journal = [];\n");
  const drafting: ToolEntry = { ...tool(4, "apps/daemon/test/app.test.ts"), changes: undefined, state: "running", drafting: true,
    diff: { oldText: "", newText: "a\nb\n" } };
  const panel = new DiffPanel(); panel.open(planRuns([user(), edited, created, drafting]), 1);
  panel.act({ kind: "diff-select", path: "apps/daemon/src/app.ts" });
  const rows = panel.render(90, 36, paint).rows;
  const text = rows.join("\n");
  // Totals across files, with drafting called out, and the follow and expand controls.
  expect(rows[2]).toMatch(/^ {2}3 files \+6 −2 · 1 drafting +paused +Alt\+↵ expand/);
  // Each file shows its folder, state and own counts; the selected one is marked.
  expect(text).toMatch(/▎✓ apps\/daemon\/src\/app\.ts +Applied {2}\+3 −2/);
  expect(text).toMatch(/✓ apps\/daemon\/src\/journal\.ts +Applied {2}\+1 −0/);
  expect(text).toMatch(/◌ apps\/daemon\/test\/app\.test\.ts +Drafting {2}\+2 −0/);
  // The header names the file, its state, language and edits, with totals right.
  // Beside it, the Diff / Whole file switch (Figma 124:1038).
  expect(text).toMatch(/app\.ts {2}Applied · TypeScript · 1 edit {2}(?: Diff │ Whole file  v +)?\+3 −2/);
  // Old and new line numbers, folded context, and no hunk headers.
  expect(text).toMatch(/ 3 +− line 3/);
  expect(text).toMatch(/ +3 \+ line three/);
  expect(text).toContain("unchanged lines");
  expect(text).not.toContain("@@");
});

test("an edit row says open on hover without shifting, and keeps its card lit", () => {
  const ui = new Workbench({ paint, contextRail: new CliContextRail({ id: "test", provider: "test" }, "/project"), sessionTitle: "Test", version: "test", onExit() {}, onInterrupt() {}, queue: { get: () => "", set() {} } });
  const internals = ui as unknown as { sessionView: SessionView };
  ui.beginTurn({ userText: "Implement this", at: "12:00" });
  ui.toolRequested({ toolCallId: "edit", name: "write_file", arguments: { path: "src/new.ts", content: "export const answer = 42;\n" } });
  ui.toolFinished({ toolCallId: "edit", name: "write_file", state: "done", changes: [{ path: "src/new.ts", before: null, after: "export const answer = 42;\n", beforeExists: false, afterExists: true }] });
  ui.assistantDelta("Added the answer.");
  ui.finishTurn("completed", "Done");
  let rows = ui.frame(120, 36).rows;
  expect(rows.some((row) => /\bcopy\b/.test(row))).toBe(false);
  const at = rows.findIndex((row) => row.includes("src/new.ts") && row.includes("+1 −0"));
  expect(at).toBeGreaterThan(-1);
  const rest = rows[at]!;
  expect(rest).not.toContain("open ▸");
  expect(internals.sessionView.hover(at, 40, 0)).toBe(true);
  rows = ui.frame(120, 36).rows;
  expect(rows[at]).toContain("open ▸");
  expect(visibleLength(rows[at]!)).toBe(visibleLength(rest));
  expect(rows[at]!.indexOf("+1 −0")).toBe(rest.indexOf("+1 −0"));
  // The row sits inside the response card, whose copy link stays shown.
  expect(rows.some((row) => /\bcopy\b/.test(row))).toBe(true);
});

test("one viewer: v switches between the diff and the whole file, which marks this session's changes and steps through them", async () => {
  const before = "import { a } from \"./a.ts\";\n\nexport const one = 1;\nexport const two = 2;\nexport const three = 3;\n";
  const after = "import { a } from \"./a.ts\";\n\nexport const one = 1;\nexport const TWO = 2;\nexport const three = 3;\nexport const four = 4;\n";
  const loaded: string[] = [];
  const ui = new Workbench({ paint, contextRail: new CliContextRail({ id: "test", provider: "test" }, "/project"), sessionTitle: "Test", version: "test", onExit() {}, onInterrupt() {}, queue: { get: () => "", set() {} },
    readFile: async (path) => { loaded.push(path); return { path, content: after, byteLength: after.length }; } });
  const internals = ui as unknown as { onKeypress(text: string, key: { name?: string }): void; sessionView: SessionView };
  const key = (text: string, name = text) => internals.onKeypress(text, { name });
  ui.beginTurn({ userText: "Rename two", at: "12:00" });
  ui.toolRequested({ toolCallId: "edit", name: "edit_file", arguments: { path: "src/n.ts" } });
  ui.toolFinished({ toolCallId: "edit", name: "edit_file", state: "done", changes: [{ path: "src/n.ts", before, after, beforeExists: true, afterExists: true }] });
  ui.finishTurn("completed", "Done");
  void ui.readPrompt({ history: [], commands: [], mentions: [] });
  internals.sessionView.act({ kind: "diff-open", runId: 1 });
  let text = ui.frame(200, 40).rows.join("\n");
  expect(text).toMatch(/ Diff │ Whole file {2}v/);
  expect(text).toContain("v whole file");
  key("v");
  await Bun.sleep(0);
  text = ui.frame(200, 40).rows.join("\n");
  expect(loaded).toEqual(["src/n.ts"]);
  expect(text).toMatch(/n\.ts {2}TypeScript · 6 lines {2} Diff │ Whole file/);
  // Every line of the file, the changed ones marked.
  expect(text).toMatch(/ 1 {3}import \{ a \}/);
  expect(text).toMatch(/ 4 ▌ export const TWO = 2;/);
  expect(text).toMatch(/ 6 ▌ export const four = 4;/);
  expect(text).toContain("change – of 2");
  key("n");
  expect(ui.frame(200, 40).rows.join("\n")).toContain("change 1 of 2");
  key("n");
  expect(ui.frame(200, 40).rows.join("\n")).toContain("change 2 of 2");
  // Search: type, Enter finds, Escape ends the search but keeps the viewer open.
  key("/");
  for (const character of "three") key(character);
  expect(ui.frame(200, 40).rows.join("\n")).toMatch(/\/three▏ · 1 of 1/);
  internals.onKeypress("", { name: "escape" });
  text = ui.frame(200, 40).rows.join("\n");
  expect(text).not.toContain("/three");
  expect(text).toContain("change 2 of 2");
  key("v");
  expect(ui.frame(200, 40).rows.join("\n")).toMatch(/ Diff │ Whole file/);
});

test("a file opened on its own shows the whole file, explains files it cannot show, and Esc goes back", async () => {
  const ui = new Workbench({ paint, contextRail: new CliContextRail({ id: "test", provider: "test" }, "/project"), sessionTitle: "Test", version: "test", onExit() {}, onInterrupt() {}, queue: { get: () => "", set() {} },
    readFile: async (path) => path === ".env" ? { path, content: null, byteLength: null, reason: "protected: secrets and key material are never shown" } : { path, content: "line one\nline two\n", byteLength: 18 } });
  const internals = ui as unknown as { onKeypress(text: string, key: { name?: string }): void; sessionView: SessionView };
  void ui.readPrompt({ history: [], commands: [], mentions: [] });
  ui.beginTurn({ userText: "Look", at: "12:00" }); ui.finishTurn("completed", "Done");
  let back = 0;
  internals.sessionView.onFilesBack = () => { back++; };
  internals.sessionView.openFile("docs/notes.md");
  await Bun.sleep(0);
  let text = ui.frame(200, 40).rows.join("\n");
  expect(text).toMatch(/notes\.md {2}docs\//);
  expect(text).toContain("‹ Files");
  expect(text).toContain("no changes this session");
  expect(text).toMatch(/ 2 {3}line two/);
  internals.onKeypress("", { name: "escape" });
  expect(back).toBe(1);
  expect(ui.frame(200, 40).rows.join("\n")).not.toContain("‹ Files");
  internals.sessionView.openFile(".env");
  await Bun.sleep(0);
  expect(ui.frame(200, 40).rows.join("\n")).toContain("Can't show this file: protected: secrets and key material are never shown.");
});

test("the Files list filters as you type, opens a file in the viewer, returns with the filter kept, and @ mentions a file", async () => {
  let draft = "";
  const ui = new Workbench({ paint, contextRail: new CliContextRail({ id: "test", provider: "test" }, "/project"), sessionTitle: "Test", version: "test", onExit() {}, onInterrupt() {}, queue: { get: () => "", set() {} },
    fileInfo: async () => [{ path: "src/lexer.ts", byteLength: 20, status: "M" }, { path: "docs/notes.md", byteLength: 18, status: null }, { path: "src/parser.ts", byteLength: 30, status: null }],
    readFile: async (path) => ({ path, content: `contents of ${path}\n`, byteLength: 20 }) });
  const internals = ui as unknown as { onKeypress(text: string, key: { name?: string }): void; sessionView: SessionView; openRailAction(action: string): void; editor: { value: string } };
  void ui.readPrompt({ history: [], commands: [], mentions: ["src/lexer.ts", "docs/notes.md", "src/parser.ts"] });
  ui.beginTurn({ userText: "Look", at: "12:00" }); ui.finishTurn("completed", "Done");
  internals.openRailAction("files");
  await Bun.sleep(0);
  let text = ui.frame(200, 40).rows.join("\n");
  expect(text).toMatch(/Files {2}/);
  expect(text).toContain("⌕ Type to filter");
  expect(text).toMatch(/GIT CHANGES +1/);
  for (const character of "note") internals.onKeypress(character, { name: character });
  text = ui.frame(200, 40).rows.join("\n");
  expect(text).toContain("⌕ note");
  expect(text).toContain("docs/notes.md");
  expect(text).not.toContain("src/parser.ts");
  internals.onKeypress("", { name: "return" });
  await Bun.sleep(0);
  text = ui.frame(200, 40).rows.join("\n");
  expect(text).toContain("‹ Files");
  expect(text).toMatch(/ 1 {3}contents of docs\/notes\.md/);
  internals.onKeypress("", { name: "escape" });
  await Bun.sleep(0);
  text = ui.frame(200, 40).rows.join("\n");
  expect(text).toContain("⌕ note");
  // @ puts the selected file in the draft as a mention.
  internals.onKeypress("@", { name: undefined });
  draft = internals.editor.value;
  expect(draft).toBe("@notes.md ");
});
