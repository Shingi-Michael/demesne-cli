import { expect, test } from "bun:test";
import { commandIcon, groupWords, plainName } from "../command-menu";

test("names lose the slash and groups read in sentence case", () => {
  expect(plainName("/compact")).toBe("compact");
  expect(plainName("compact")).toBe("compact");
  expect(groupWords("YOUR WORKFLOWS")).toBe("Your workflows");
  expect(groupWords("session")).toBe("Session");
});

test("every command has an icon, and unknown ones get a generic one", () => {
  for (const id of ["new", "compact", "workflow:ship", "custom:lint", "file", "something-new"]) expect(commandIcon(id)).toContain("<path d=\"M");
  expect(commandIcon("something-new")).toBe(commandIcon("another"));
  expect(commandIcon("compact")).not.toBe(commandIcon("undo"));
});

test("the six groups have headings and a fixed order", async () => {
  const { sectionRank, sectionTitle } = await import("../command-menu");
  const { SLASH_COMMANDS } = await import("@demesne/brand");
  expect(sectionTitle("turn")).toBe("The last turn");
  expect(sectionTitle("app")).toBe("Demesne");
  expect(sectionRank("chat")).toBeLessThan(sectionRank("app"));
  // Built-in commands are already in group order, one run per group.
  const ranks = SLASH_COMMANDS.map((command) => sectionRank(command.section));
  expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  expect(SLASH_COMMANDS.find((command) => command.id === "compact")?.section).toBe("turn");
});
