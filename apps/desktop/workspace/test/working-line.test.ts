import { expect, test } from "bun:test";
import { DWELL, thoughtHeading, workingPhrases } from "../working-line.ts";

const step = (verb: string, target: string, startedAt: number, running = false) => ({ verb, target, startedAt, running });

test("a thought's last heading is what the model is thinking about", () => {
  expect(thoughtHeading("**Looking at tabs**\n\nSome text.\n\n**Checking where a chat is first named**\n\nMore.")).toBe("Checking where a chat is first named");
  expect(thoughtHeading("No headings here, just thinking.")).toBeNull();
  expect(thoughtHeading(null)).toBeNull();
  expect(thoughtHeading("**Planning the edit:**")).toBe("Planning the edit");
});

test("the line takes turns with the thought and the step running now, all of it true", () => {
  const now = 100_000;
  expect(workingPhrases({ thinking: "**Checking tab names**", steps: [step("Read", "live.ts", now - 500, true)] }, now)).toEqual(["Checking tab names", "Reading live.ts"]);
  // Steps of one kind faster than a phrase can stay are counted, not flashed past.
  const burst = [step("Read", "a.ts", now - 900), step("Read", "b.ts", now - 600), step("Read", "c.ts", now - 300), step("Read", "d.ts", now - 100, true)];
  expect(workingPhrases({ thinking: null, steps: burst }, now)).toEqual(["Reading 4 files"]);
  expect(workingPhrases({ thinking: null, steps: burst }, now + DWELL)).toEqual(["Reading d.ts"]);
  // While it thinks between steps, it says what it has read for this.
  expect(workingPhrases({ thinking: "**Planning a short name**", steps: burst.map((item) => ({ ...item, running: false })) }, now)).toEqual(["Planning a short name", "4 files read so far"]);
  // A read of several files counts each one.
  expect(workingPhrases({ thinking: null, steps: burst.map((item, n) => ({ ...item, running: false, files: n === 0 ? 3 : 1 })) }, now)).toEqual(["6 files read so far"]);
  // Nothing to say yet is "Thinking"; waiting on you says only that.
  expect(workingPhrases({ thinking: "plain thought", steps: [] }, now)).toEqual(["Thinking"]);
  expect(workingPhrases({ thinking: "**A heading**", steps: [], fixed: "Waiting for your answer" }, now)).toEqual(["Waiting for your answer"]);
});
