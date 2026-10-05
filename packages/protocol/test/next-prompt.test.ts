import { expect, test } from "bun:test";
import { NextPromptFilter, splitNextPrompt } from "../src/next-prompt.ts";

test("splitNextPrompt removes the hidden suggestion and returns it, even mid-stream", () => {
  expect(splitNextPrompt("All four tests pass.\n\n<next>Add a retry test for timeouts</next>")).toEqual({ text: "All four tests pass.", next: "Add a retry test for timeouts" });
  expect(splitNextPrompt("No suggestion here.")).toEqual({ text: "No suggestion here.", next: null });
  // Still streaming: an unfinished tag never shows.
  expect(splitNextPrompt("Done.\n\n<next>Add a ret").text).toBe("Done.");
  expect(splitNextPrompt("Done.\n\n<ne").text).toBe("Done.");
  expect(splitNextPrompt("Use a < b here").text).toBe("Use a < b here");
  expect(splitNextPrompt("Done.<next>  </next>").next).toBeNull();
});

test("NextPromptFilter streams the answer and drops the tag split across deltas", () => {
  const filter = new NextPromptFilter();
  const parts = ["All tests", " pass.\n\n<ne", "xt>Add a retry", " test</ne", "xt>"];
  const out = parts.map((part) => filter.push(part)).join("") + filter.end();
  expect(out).toBe("All tests pass.\n\n");
  expect(filter.next).toBe("Add a retry test");
  const plain = new NextPromptFilter();
  expect(plain.push("a <b> and <n") + plain.push("ope") + plain.end()).toBe("a <b> and <nope");
});
