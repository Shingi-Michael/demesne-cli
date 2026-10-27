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
