import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeedSentence } from "@demesne/protocol";
import { anchorHolds, DeedBook, numberText, pinAnchor, pinValue, sectionFor, type DeedHost, type DeedVerdict } from "../src/deed.ts";

const CODE = ["export const QUIET_MS = 20 * 60_000;", "export const PER_DAY = 3;", "", "export function tick() {", "  return QUIET_MS;", "}", ""].join("\n");

function project() {
  const root = mkdtempSync(join(tmpdir(), "deed-root-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "auto.ts"), CODE);
  writeFileSync(join(root, "README.md"), "# Demo\n");
  return root;
}

function book(overrides: Partial<DeedHost> = {}) {
  const root = project();
  const turns: { sessionId: string; prompt: string; mode: string; end: () => void }[] = [];
  const archived: string[] = [];
  let next = 0;
  const host: DeedHost = {
    startSession: () => `s${++next}`,
    startTurn: (sessionId, prompt, mode) => new Promise<void>((resolve) => { turns.push({ sessionId, prompt, mode, end: resolve }); }),
    archive: (sessionId) => { archived.push(sessionId); },
    judge: async () => ({ holds: true, why: "", words: "" }),
    test: async () => ({ ok: true, passed: 3, failed: 0, ms: 10 }),
    ...overrides,
  };
  const deeds = new DeedBook(mkdtempSync(join(tmpdir(), "deed-data-")), host);
  const tool = (name: string) => deeds.tools().find((item) => item.definition.name === name)!;
  return { root, deeds, turns, archived, tool };
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test("an anchor quotes the lines it rests on, and notices when they change", () => {
  const root = project();
  const anchor = pinAnchor(root, { path: "src/auto.ts", line: 1 })!;
  expect(anchor).toMatchObject({ path: "src/auto.ts", line: 1 });
  expect(anchor.quote).toContain("QUIET_MS = 20");
  expect(anchorHolds(root, anchor)).toBe(true);
  // Moving the lines down keeps it true; changing them doesn't.
  writeFileSync(join(root, "src", "auto.ts"), `// moved\n${CODE}`);
  expect(anchorHolds(root, anchor)).toBe(true);
  writeFileSync(join(root, "src", "auto.ts"), CODE.replace("20 *", "10 *"));
  expect(anchorHolds(root, anchor)).toBe(false);
});

test("anchors stay inside the project", () => {
  const root = project();
  expect(pinAnchor(root, { path: "../outside.ts" })).toBeNull();
  expect(pinAnchor(root, { path: "/etc/passwd" })).toBeNull();
  expect(pinAnchor(root, { path: ".git/config" })).toBeNull();
  expect(pinAnchor(root, { path: "missing.ts", line: 2 })).toBeNull();
  // No line: the whole file is held.
  expect(pinAnchor(root, { path: "README.md" })).toMatchObject({ path: "README.md", hash: expect.any(String) });
});

test("a new sentence joins the section it shares the most words with", () => {
  const sentence = (section: string, text: string): DeedSentence => ({ id: text, section, text, anchors: [], state: "true", updatedAt: "" });
  const deed = { workspace: "/w", writtenAt: "", writing: null, sections: ["Drive", "Chats"], sentences: [sentence("Drive", "Drive starts ideas after quiet minutes."), sentence("Chats", "Enter steers a running turn.")] };
  expect(sectionFor(deed, "Drive waits fewer quiet minutes at night.")).toBe("Drive");
  expect(sectionFor(deed, "A running turn shows its steps.")).toBe("Chats");
});

test("writing the deed: a read-only chat records sentences tied to code, then is archived", async () => {
  const { root, deeds, turns, archived, tool } = book();
  const started = deeds.act(root, { action: "write" });
  expect(started.writing).toMatchObject({ sessionId: "s1", status: "running" });
  await flush();
  expect(turns[0]).toMatchObject({ sessionId: "s1", mode: "deny" });
  // Only that chat sees the tool.
  expect(tool("deed_write").available!("s1")).toBe(true);
  expect(tool("deed_write").available!("other")).toBe(false);
  await expect(tool("deed_write").execute({ sections: [] }, { workspaceRoot: root, signal: new AbortController().signal, sessionId: "other" })).rejects.toThrow("only for the chat");
  const said = await tool("deed_write").execute({ sections: [
    { name: "Drive", sentences: [
      { text: "Drive starts the first idea after 20 quiet minutes.", anchors: [{ path: "src/auto.ts", line: 1 }] },
      { text: "It makes things up.", anchors: [{ path: "nowhere.ts", line: 1 }] },
    ] },
  ] }, { workspaceRoot: root, signal: new AbortController().signal, sessionId: "s1" });
  expect(said).toContain("Recorded 1 sentences in 1 sections (1 left out");
  turns[0]!.end();
  await flush();
  const deed = deeds.state(root);
  expect(deed.writing).toBeNull();
  expect(deed.sections).toEqual(["Drive"]);
  expect(deed.sentences).toMatchObject([{ section: "Drive", state: "true", text: "Drive starts the first idea after 20 quiet minutes." }]);
  expect(archived).toEqual(["s1"]);
});

test("a chat that ends without writing leaves the deed unwritten, with why", async () => {
  const { root, deeds, turns } = book();
  deeds.act(root, { action: "write" });
  await flush();
  turns[0]!.end();
  await flush();
  expect(deeds.state(root)).toMatchObject({ writtenAt: null, writing: { status: "failed", error: "The chat ended without writing it." } });
});

test("a chat that can't start ends the job instead of leaving it running", async () => {
  const { root, deeds } = book({ startTurn: () => { throw new Error("no model"); } });
  deeds.act(root, { action: "write" });
  await flush();
  expect(deeds.state(root).writing).toMatchObject({ status: "failed" });
});

async function written() {
  const setup = book();
  const { root, deeds, turns, tool } = setup;
  deeds.act(root, { action: "write" });
  await flush();
  await tool("deed_write").execute({ sections: [{ name: "Drive", sentences: [{ text: "Drive starts the first idea after 20 quiet minutes.", anchors: [{ path: "src/auto.ts", line: 1 }] }] }] }, { workspaceRoot: root, signal: new AbortController().signal, sessionId: "s1" });
  turns[0]!.end();
  await flush();
  return { ...setup, id: deeds.state(root).sentences[0]!.id };
}

test("a change to the code marks its sentence to check, and changing it back clears it", async () => {
  const { root, deeds, id } = await written();
  writeFileSync(join(root, "src", "auto.ts"), CODE.replace("20 *", "15 *"));
  expect(deeds.state(root).sentences.find((sentence) => sentence.id === id)!.state).toBe("check");
  writeFileSync(join(root, "src", "auto.ts"), CODE);
  expect(deeds.state(root).sentences.find((sentence) => sentence.id === id)!.state).toBe("true");
});

test("checking a sentence that no longer holds says why and offers true words", async () => {
  let verdict: DeedVerdict = { holds: false, why: "It waits 15 minutes now.", words: "Drive starts the first idea after 15 quiet minutes.", lines: [{ path: "src/auto.ts", line: 1 }] };
  const { root, deeds, id } = await written();
  const setup = deeds as unknown as { host: DeedHost };
  setup.host.judge = async () => verdict;
  writeFileSync(join(root, "src", "auto.ts"), CODE.replace("20 *", "15 *"));
  expect(deeds.act(root, { action: "check", id }).sentences[0]!.state).toBe("checking");
  await flush();
  expect(deeds.state(root).sentences[0]).toMatchObject({ state: "false", why: "It waits 15 minutes now.", words: "Drive starts the first idea after 15 quiet minutes." });
  // Fix the words: the sentence takes them and holds again.
  const fixed = deeds.act(root, { action: "words", id }).sentences[0]!;
  expect(fixed).toMatchObject({ state: "true", text: "Drive starts the first idea after 15 quiet minutes." });
  expect(deeds.state(root).sentences[0]!.state).toBe("true");
  verdict = { holds: true, why: "", words: "" };
});

test("editing a sentence starts a chat that changes the code until it is true", async () => {
  const { root, deeds, turns, tool, id } = await written();
  const working = deeds.act(root, { action: "make", id, text: "Drive starts the first idea after 10 quiet minutes." }).sentences[0]!;
  expect(working).toMatchObject({ state: "working", sessionId: "s2", was: "Drive starts the first idea after 20 quiet minutes." });
  await flush();
  expect(turns[1]).toMatchObject({ sessionId: "s2", mode: "ask" });
  expect(turns[1]!.prompt).toContain("10 quiet minutes");
  expect(tool("deed_settle").available!("s2")).toBe(true);
  expect(tool("deed_write").available!("s2")).toBe(false);
  writeFileSync(join(root, "src", "auto.ts"), CODE.replace("20 *", "10 *"));
  await tool("deed_settle").execute({ made: true, anchors: [{ path: "src/auto.ts", line: 1 }] }, { workspaceRoot: root, signal: new AbortController().signal, sessionId: "s2" });
  turns[1]!.end();
  await flush();
  const made = deeds.state(root).sentences[0]!;
  expect(made).toMatchObject({ state: "true", text: "Drive starts the first idea after 10 quiet minutes.", files: 1, madeAt: expect.any(String) });
  expect(deeds.act(root, { action: "seen", id }).sentences[0]!.madeAt).toBeUndefined();
});

test("a chat that ends without settling marks the sentence failed", async () => {
  const { root, deeds, turns, id } = await written();
  deeds.act(root, { action: "make", id, text: "Drive never starts on its own." });
  await flush();
  turns[1]!.end();
  await flush();
  expect(deeds.state(root).sentences[0]).toMatchObject({ state: "failed", why: "The chat ended without making it true." });
});

test("a wish waits pale, and Drive sees it as work the person asked for", async () => {
  const { root, deeds } = await written();
  const deed = deeds.act(root, { action: "wish", text: "Drive starts ideas at night only." });
  const wish = deed.sentences.find((sentence) => sentence.state === "wish")!;
  expect(wish.section).toBe("Drive");
  expect(deeds.wishSignals(root)).toMatchObject([{ id: `wish:${wish.id.slice(0, 8)}`, source: "deed", title: "Make true: Drive starts ideas at night only." }]);
  expect(deeds.act(root, { action: "remove", id: wish.id }).sentences).toHaveLength(1);
  expect(deeds.wishSignals(root)).toEqual([]);
});

test("work that stopped with the daemon says so", async () => {
  const { root, deeds, id } = await written();
  deeds.act(root, { action: "make", id, text: "Drive starts the first idea after 5 quiet minutes." });
  // A new daemon has no record of the chat.
  const restarted = new DeedBook((deeds as unknown as { directory: string }).directory, { startSession: () => "x", startTurn: async () => {}, archive: () => {}, judge: async () => ({ holds: true, why: "", words: "" }), test: async () => ({ ok: true, passed: 0, failed: 0, ms: 0 }) });
  expect(restarted.state(root).sentences[0]).toMatchObject({ state: "failed", why: "It stopped when Demesne restarted." });
});

test("a live word must be in the sentence and its token on the line", () => {
  const root = project();
  const sentence = "Drive starts the first idea after 20 quiet minutes.";
  expect(pinValue(root, sentence, { text: "20", path: "src/auto.ts", line: 1, literal: "20" })).toMatchObject({ kind: "number", text: "20", literal: "20", line: 1 });
  expect(pinValue(root, sentence, { text: "30", path: "src/auto.ts", line: 1, literal: "20" })).toBeNull();
  expect(pinValue(root, sentence, { text: "20", path: "src/auto.ts", line: 2, literal: "20" })).toBeNull();
  // "0" is inside 60_000 but not a token of its own.
  expect(pinValue(root, "It waits 0 minutes.", { text: "0", path: "src/auto.ts", line: 1, literal: "0" })).toBeNull();
  // A word needs real alternatives to be live.
  expect(pinValue(root, "Tick returns the quiet time.", { text: "quiet", path: "src/auto.ts", line: 5, literal: "QUIET_MS" })).toBeNull();
  expect(pinValue(root, "Tick returns the quiet time.", { text: "quiet", path: "src/auto.ts", line: 5, literal: "QUIET_MS", choices: [{ word: "daily", literal: "PER_DAY" }] })).toMatchObject({ kind: "choice", choices: [{ word: "quiet", literal: "QUIET_MS" }, { word: "daily", literal: "PER_DAY" }] });
});

test("numbers keep the way the sentence says them", () => {
  expect(numberText(10, "20")).toBe("10");
  expect(numberText(5, "three")).toBe("five");
  expect(numberText(5, "Three")).toBe("Five");
  expect(numberText(42, "three")).toBe("42");
});

async function live(test?: DeedHost["test"]) {
  const setup = book(test ? { test } : {});
  const { root, deeds, turns, tool } = setup;
  writeFileSync(join(root, "src", "auto.test.ts"), "// tests\n");
  deeds.act(root, { action: "write" });
  await flush();
  await tool("deed_write").execute({ sections: [{ name: "Drive", sentences: [
    { text: "Drive starts the first idea after 20 quiet minutes.", anchors: [{ path: "src/auto.ts", line: 1 }], values: [{ text: "20", path: "src/auto.ts", line: 1, literal: "20" }], tests: ["src/auto.test.ts", "missing.test.ts"] },
    { text: "It runs at most three ideas a day.", anchors: [{ path: "src/auto.ts", line: 2 }], values: [{ text: "three", path: "src/auto.ts", line: 2, literal: "3" }] },
  ] }] }, { workspaceRoot: root, signal: new AbortController().signal, sessionId: "s1" });
  turns[0]!.end();
  await flush();
  const [quiet, perDay] = deeds.state(root).sentences;
  return { ...setup, quiet: quiet!, perDay: perDay! };
}

test("dragging a number changes that one token in the code and the sentence", async () => {
  const { root, deeds, perDay } = await live();
  expect(perDay.values).toHaveLength(1);
  const deed = deeds.act(root, { action: "set", id: perDay.id, value: perDay.values![0]!.id, to: 5 });
  expect(deed.sentences[1]).toMatchObject({ text: "It runs at most five ideas a day.", state: "true" });
  expect(readFileSync(join(root, "src", "auto.ts"), "utf8")).toContain("export const PER_DAY = 5;");
  // The sentence still holds the code it now rests on; Undo puts both back.
  expect(deeds.state(root).sentences[1]!.state).toBe("true");
  expect(deeds.act(root, { action: "undo", id: perDay.id }).sentences[1]!.text).toBe("It runs at most three ideas a day.");
  expect(readFileSync(join(root, "src", "auto.ts"), "utf8")).toBe(CODE);
});

test("a changed value is proved by its tests, and put back when they fail", async () => {
  let ok = true;
  const ran: string[][] = [];
  const { root, deeds, quiet } = await live(async (_workspace, files) => { ran.push(files); return ok ? { ok, passed: 14, failed: 0, ms: 1400 } : { ok, passed: 13, failed: 1, ms: 900, detail: "(fail) waits 20 minutes" }; });
  expect(quiet.tests).toEqual(["src/auto.test.ts"]);
  const proving = deeds.act(root, { action: "set", id: quiet.id, value: quiet.values![0]!.id, to: 10 });
  expect(proving.sentences[0]!.proof).toMatchObject({ state: "running", files: ["src/auto.test.ts"] });
  await flush();
  expect(deeds.state(root).sentences[0]).toMatchObject({ text: "Drive starts the first idea after 10 quiet minutes.", proof: { state: "passed", passed: 14, ms: 1400 } });
  ok = false;
  const value = deeds.state(root).sentences[0]!.values![0]!.id;
  deeds.act(root, { action: "set", id: quiet.id, value, to: 1 });
  await flush();
  const back = deeds.state(root).sentences[0]!;
  expect(back).toMatchObject({ text: "Drive starts the first idea after 10 quiet minutes.", proof: { state: "failed", putBack: true, detail: "(fail) waits 20 minutes" } });
  expect(readFileSync(join(root, "src", "auto.ts"), "utf8")).toContain("QUIET_MS = 10 * 60_000");
  expect(ran).toHaveLength(2);
});

test("Prove it runs each sentence with tests in turn and counts what failed", async () => {
  const { root, deeds, quiet } = await live(async () => ({ ok: false, passed: 0, failed: 2, ms: 5, detail: "two failed" }));
  const started = deeds.act(root, { action: "prove" });
  expect(started.proving).toMatchObject({ total: 1, done: 0, running: true });
  for (let i = 0; i < 5; i++) await flush();
  const deed = deeds.state(root);
  expect(deed.proving).toMatchObject({ total: 1, done: 1, failed: 1, running: false });
  expect(deed.sentences.find((sentence) => sentence.id === quiet.id)).toMatchObject({ proof: { state: "failed" }, why: "Its tests fail: two failed" });
  expect(deeds.touching(root, ["src/auto.ts"]).map((sentence) => sentence.id)).toEqual([quiet.id]);
});
