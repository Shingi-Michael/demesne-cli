import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addMemory, forgetMemory, MEMORY_FILE, MEMORY_GUIDANCE, MEMORY_KEPT, memoryBlock, memoryFile, parseMemory, readMemory, scopeFor } from "../src/memory.ts";
import { rememberTool } from "../src/remember.ts";
import { agentSystemPrompt } from "../src/engine.ts";

// Pass 249 A: one memory, two halves (about you, this project), learned
// quietly through remember and read once when a chat starts.

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const temp = (name: string) => { const dir = mkdtempSync(join(tmpdir(), `demesne-memory-${name}-`)); dirs.push(dir); return dir; };
const signal = new AbortController().signal;

test("a line is kept once, says where and when, and the oldest go past the limit", () => {
  const home = temp("home"), path = memoryFile("you", undefined, home)!;
  expect(path).toBe(join(home, MEMORY_FILE));
  expect(addMemory(path, "you", "Skip the summary at the end", "", "2026-11-21").saved).toBe(true);
  expect(addMemory(path, "you", "skip the summary at the end.", "", "2026-11-22").saved).toBe(false);
  const content = readFileSync(path, "utf8");
  expect(content.startsWith("# About you")).toBe(true);
  expect(content).toContain("- Skip the summary at the end (2026-11-21)");
  expect(readMemory(path)).toEqual([{ text: "Skip the summary at the end", from: "", day: "2026-11-21" }]);
  // An older line said again moves to the newest place.
  addMemory(path, "you", "Calm greys", "", "2026-11-21");
  addMemory(path, "you", "Skip the summary at the end", "", "2026-11-23");
  expect(readMemory(path).map((line) => line.text)).toEqual(["Calm greys", "Skip the summary at the end"]);
  for (let index = 0; index < MEMORY_KEPT + 5; index++) addMemory(path, "you", `Rule ${index}`, "", "2026-11-21");
  const lines = readMemory(path);
  expect(lines).toHaveLength(MEMORY_KEPT);
  expect(lines.at(-1)!.text).toBe(`Rule ${MEMORY_KEPT + 4}`);
});

test("text you wrote above the lines stays, and a line can be forgotten by its words", () => {
  const root = temp("project"), path = memoryFile("project", root)!;
  mkdirSync(join(root, ".demesne", "memory"), { recursive: true });
  writeFileSync(path, "# Mine\n\nMy own notes.\n\n- Uses bun, not npm\n");
  addMemory(path, "project", "Releases build only on the Mac", "", "2026-11-21");
  expect(readFileSync(path, "utf8").startsWith("# Mine\n\nMy own notes.\n\n- Uses bun, not npm\n- Releases build only on the Mac")).toBe(true);
  expect(forgetMemory(path, "project", "build only on the mac")).toEqual({ forgotten: true, text: "Releases build only on the Mac", left: ["Uses bun, not npm"] });
  expect(forgetMemory(path, "project", "nothing like it").forgotten).toBe(false);
  expect(parseMemory("- a (from x, 2026-01-02)\nnot a line\n* b")).toEqual([{ text: "a", from: "from x", day: "2026-01-02" }, { text: "b", from: "", day: "" }]);
});

test("a chat outside a project keeps everything about you", () => {
  const home = temp("home");
  expect(scopeFor("project", undefined, home)).toBe("you");
  expect(scopeFor("project", home, home)).toBe("you");
  expect(scopeFor("project", join(home, "code"), home)).toBe("project");
});

test("the block a chat starts with has both halves, newest kept when long", () => {
  const home = temp("home"), root = join(temp("root"), "slow-pour");
  expect(memoryBlock(root, home)).toBeNull();
  addMemory(memoryFile("you", root, home)!, "you", "Skip the summary at the end", "", "2026-11-21");
  addMemory(memoryFile("project", root, home)!, "project", "Uses bun, not npm", "", "2026-11-21");
  const block = memoryBlock(root, home)!;
  expect(block).toContain("About the person (every project):\n- Skip the summary at the end");
  expect(block).toContain("About slow-pour:\n- Uses bun, not npm");
  // Outside a project only the person's half is there.
  expect(memoryBlock(home, home)).not.toContain("About slow-pour");
  expect(memoryBlock(home, home)).toContain("Skip the summary");
});

test("remember with learned saves quietly, to the right half, and forgets", async () => {
  const home = temp("home"), root = temp("root");
  const tool = rememberTool(undefined, home);
  expect(tool.permission({ rule: "Uses bun", learned: "project" })).toBeNull();
  expect(tool.permission({ rule: "Always run tests" })).not.toBeNull();
  const kept = JSON.parse(await tool.execute({ rule: "Uses bun, not npm", learned: "project" }, { workspaceRoot: root, signal }));
  expect(kept).toMatchObject({ memory: "project", saved: true, text: "Uses bun, not npm" });
  const you = JSON.parse(await tool.execute({ rule: "Skip the summary at the end", learned: "you" }, { workspaceRoot: root, signal }));
  expect(you.memory).toBe("you");
  expect(readMemory(memoryFile("you", root, home)).map((line) => line.text)).toEqual(["Skip the summary at the end"]);
  expect(readMemory(memoryFile("project", root)).map((line) => line.text)).toEqual(["Uses bun, not npm"]);
  // No DEMESNE.md was written for either.
  expect(() => readFileSync(join(root, "DEMESNE.md"))).toThrow();
  const gone = JSON.parse(await tool.execute({ rule: "uses bun", learned: "project", forget: true }, { workspaceRoot: root, signal }));
  expect(gone).toMatchObject({ forgotten: true, text: "Uses bun, not npm" });
});

test("the chat's instructions carry the guidance and what it remembered", () => {
  const definitions = [{ name: "remember", description: "", inputSchema: { type: "object" } }];
  const prompt = agentSystemPrompt({ workspaceRoot: "/tmp/x", definitions, memory: "# Remembered\n\n- Uses bun" });
  expect(prompt).toContain(MEMORY_GUIDANCE);
  expect(prompt).toContain("# Remembered\n\n- Uses bun");
  expect(agentSystemPrompt({ workspaceRoot: "/tmp/x", definitions: [] })).not.toContain(MEMORY_GUIDANCE);
});
