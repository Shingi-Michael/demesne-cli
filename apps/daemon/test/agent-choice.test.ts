import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentChoice } from "../src/agent-choice.ts";

const fresh = () => new AgentChoice(join(mkdtempSync(join(tmpdir(), "agent-choice-")), "agent-choice.json"));

test("nothing saved: every agent works everywhere", () => {
  const choice = fresh();
  expect(choice.filter(["claude", "codex", "gemini"], "/p/a")).toEqual(["claude", "codex", "gemini"]);
});

test("the one switch turns every agent off", () => {
  const choice = fresh();
  choice.setOff(true);
  expect(choice.filter(["claude", "codex"], "/p/a")).toEqual([]);
  expect(choice.filter(["claude", "codex"])).toEqual([]);
  choice.setOff(false);
  expect(choice.filter(["claude", "codex"])).toEqual(["claude", "codex"]);
});

test("some projects: only where ticked, and the ticks are kept through Off", () => {
  const choice = fresh();
  choice.set("codex", "some", ["/p/a/"]);
  choice.set("gemini", "off");
  expect(choice.filter(["claude", "codex", "gemini"], "/p/a")).toEqual(["claude", "codex"]);
  expect(choice.filter(["claude", "codex", "gemini"], "/p/b")).toEqual(["claude"]);
  // Anywhere at all (the subagent model list): it works somewhere.
  expect(choice.allows("codex")).toBe(true);
  choice.set("codex", "off");
  expect(choice.allows("codex", "/p/a")).toBe(false);
  choice.set("codex", "some");
  expect(choice.read().agents.codex).toEqual({ mode: "some", projects: ["/p/a"] });
  choice.set("codex", "some", []);
  expect(choice.allows("codex")).toBe(false);
});
