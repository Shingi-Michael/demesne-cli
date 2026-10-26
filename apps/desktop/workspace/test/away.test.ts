import { expect, test } from "bun:test";
import { awaySentences, lastAsk, sinceWords, waitingAsk, type AwayInput, type AwayPart } from "../away.ts";

const base: AwayInput = {
  now: new Date(2026, 9, 24, 9, 0).getTime(),
  leftAt: new Date(2026, 9, 23, 23, 40).getTime(),
  branches: [], running: null, waiting: [], busy: [], routines: [], ideas: 0, asks: null,
  shown: { branches: false, drive: false, ideas: false, ask: null },
};
const words = (sentences: AwayPart[][]) => sentences.map((sentence) => sentence.map((part) => typeof part === "string" ? part : "name" in part ? part.name : "code" in part ? part.code : part.text).join("")).join(" ");

test("says when nothing moved, and since when", () => {
  expect(words(awaySentences(base))).toMatch(/^Nothing has moved since you left yesterday at [0-9:]+(?: [AP]M)?\.$/);
  expect(words(awaySentences({ ...base, leftAt: null }))).toBe("Nothing waits on you.");
});

test("what waits on you comes first, then Drive's branches", () => {
  const sentences = awaySentences({
    ...base,
    branches: [
      { title: "Cache the file list", status: "ready", finishedAt: new Date(2026, 9, 24, 2).toISOString() },
      { title: "Drop the sort helper", status: "ready", finishedAt: new Date(2026, 9, 24, 3).toISOString(), failedCheck: "bun test" },
    ],
    waiting: [{ sessionId: "s1", title: "Release script", ask: { kind: "permission", id: "p1", verb: "run", target: "git push", rule: null, allowedBefore: 0 } }],
  });
  expect(sentences).toHaveLength(2);
  expect(words(sentences)).toMatch(/^Release script is waiting on your yes to run git push\. Since you left yesterday at [0-9:]+(?: [AP]M)?, Drive finished two branches: Cache the file list passed its checks, Drop the sort helper failed a check \(bun test\)\.$/);
  const ask = sentences[0]![0] as { action: string; tone: string };
  expect(ask.action).toBe("away-ask");
  expect(ask.tone).toBe("warn");
});

test("a question opens its chat; three chats are counted", () => {
  const question = awaySentences({ ...base, waiting: [{ sessionId: "s1", title: "Tests", ask: { kind: "question", text: "Which one?" } }] });
  expect((question[0]![0] as { action: string }).action).toBe("select-session");
  expect(words(question)).toStartWith("Tests has a question for you.");
  const three = ["A", "B", "C"].map((title) => ({ sessionId: title, title, ask: null }));
  expect(words(awaySentences({ ...base, waiting: three }))).toStartWith("A and two other chats are waiting on you.");
});

test("work going on now says so, and that nothing waits", () => {
  const sentences = awaySentences({ ...base, running: { title: "Cache the file list", steps: 3 }, busy: [{ sessionId: "s2", title: "Release script" }] });
  expect(words(sentences)).toBe("Drive is working on Cache the file list, three steps in. Release script is still working. Nothing waits on you.");
  expect((sentences[0]![0] as { tone: string }).tone).toBe("live");
});

test("ideas fill in when there is room, never more than three sentences", () => {
  expect(words(awaySentences({ ...base, ideas: 4 }))).toEndWith("Drive has four ideas for this project.");
  const full = awaySentences({ ...base, ideas: 4, asks: { thisWeek: 3, lastWeek: 5 }, busy: [{ sessionId: "s", title: "X" }], routines: [{ title: "Morning paper", at: new Date(2026, 9, 24, 8, 30).toISOString(), sessionId: "r" }] });
  expect(full).toHaveLength(3);
  expect(words(full)).toContain("Your Morning paper ran at ");
});

test("reads what an approval wants from its summary", () => {
  expect(waitingAsk([{ id: "p", turnId: "t", toolCallId: "c", summary: 'run_command: {"argv":["/usr/bin/git","push"]}', rule: "run_command:git push", allowedBefore: 2 }]))
    .toEqual({ kind: "permission", id: "p", verb: "run", target: "git push", rule: "run_command:git push", allowedBefore: 2 });
  expect(waitingAsk([{ id: "p", turnId: "t", toolCallId: "c", summary: 'edit_file: {"path":"hello.ts","edits":[{"oldText":"a", "newText":"b' }])).toMatchObject({ verb: "edit", target: "" });
  expect(waitingAsk([])).toBeNull();
});

test("the last thing you asked skips Drive, mail and compactions", () => {
  expect(lastAsk([{ content: "make the folder rows match the mock\nmore" }, { content: "Continue", fromDrive: true }, { content: "summary", kind: "compaction" }])).toBe("make the folder rows match the mock");
  expect(lastAsk([])).toBe("");
});

test("since words", () => {
  const now = new Date(2026, 9, 24, 9, 0).getTime();
  expect(sinceWords(new Date(2026, 9, 24, 7, 5).getTime(), now)).toMatch(/^at /);
  expect(sinceWords(new Date(2026, 9, 21, 7, 5).getTime(), now)).toBe(`on ${new Date(2026, 9, 21).toLocaleDateString(undefined, { weekday: "long" })}`);
});
