import { expect, test } from "bun:test";
import { BUILT_PAGE, builtMatches, builtOf, builtPage, builtVerdict, type BuiltRecord } from "../src/foundry-built.ts";

const record = (looks: BuiltRecord["looks"], left = ""): BuiltRecord => ({ from: { id: "plans", version: 2, title: "Plans <page>" }, option: "Yearly first", where: "localhost:5173/pricing", pick: "pick-1", looks, left });
const off = { picture: "look-1", differences: [{ box: "10,20,30,40", what: "Opens on Monthly; the pick opens on Yearly." }], more: 2 };
const fixed = { picture: "look-2", differences: [], more: 0 };

test("the verdict is the latest look's: matches, or how many still differ", () => {
  expect(builtVerdict(record([off]))).toBe("3 still differ");
  expect(builtMatches(record([off]))).toBe(false);
  expect(builtVerdict(record([off, fixed]))).toBe("matches");
  expect(builtVerdict(record([{ ...off, more: 0 }]))).toBe("1 still differs");
});

test("the record's page puts the pick beside the result, and the first look's rings beside the list", () => {
  const page = builtPage(record([off, fixed]));
  expect(BUILT_PAGE.test(page)).toBe(true);
  expect(page).toContain('<d-shot src="pick-1"');
  expect(page).toContain('<d-shot src="look-2" alt="What was built">');
  expect(page).toContain('<d-shot src="look-1" marks="10,20,30,40"');
  expect(page).toContain("Built, first look");
  expect(page).toContain("<s>fixed</s>");
  expect(page).toContain("And 2 smaller differences, fixed too.");
  // Words are escaped; the record reads back whole.
  expect(page).toContain("Plans &lt;page&gt;, v2");
  expect(page).not.toContain("Plans <page>");
  expect(builtOf(page)).toEqual(record([off, fixed]));
  expect(builtOf("<d-review></d-review>")).toBeNull();
});

test("a build that still differs rings what is left on the result and says why", () => {
  const page = builtPage(record([off], "The heading font is not in the project yet."));
  expect(page).toContain('<d-shot src="look-1" marks="10,20,30,40" alt="What was built">');
  expect(page).toContain("3 still differ");
  expect(page).toContain("Left as it is: The heading font is not in the project yet.");
  expect(page).not.toContain("Built, first look");
  expect(page).not.toContain("<s>fixed</s>");
});
