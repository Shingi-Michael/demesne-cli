import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rememberTool, withRule } from "../src/remember.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const project = () => { const root = mkdtempSync(join(tmpdir(), "demesne-remember-")); roots.push(root); return root; };
const run = (root: string, rule: string) => rememberTool().execute({ rule }, { workspaceRoot: root, signal: new AbortController().signal }).then(JSON.parse);

test("a rule starts DEMESNE.md when the project has no instructions", async () => {
  const root = project();
  expect(await run(root, "Always run the tests with bun")).toEqual({ path: "DEMESNE.md", saved: true, rule: "Always run the tests with bun" });
  expect(readFileSync(join(root, "DEMESNE.md"), "utf8")).toBe("## Remembered\n\n- Always run the tests with bun\n");
});

test("rules go under Remembered in the file the project has, once each", async () => {
  const root = project();
  writeFileSync(join(root, "AGENTS.md"), "# Agents\n\nBe brief.\n\n## Remembered\n\n- Use tabs\n\n## Later\n\nText.\n");
  await run(root, "Never push to main");
  expect((await run(root, "never push to main")).saved).toBe(false);
  expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toBe("# Agents\n\nBe brief.\n\n## Remembered\n\n- Use tabs\n- Never push to main\n\n## Later\n\nText.\n");
});

test("a heading is added after what is there", () => {
  expect(withRule("# Project\n\nNotes.\n", "Keep it short")).toBe("# Project\n\nNotes.\n\n## Remembered\n\n- Keep it short\n");
  expect(withRule("## Remembered\n", "One")).toBe("## Remembered\n\n- One\n");
});

test("asks like an edit", () => {
  expect(rememberTool().permission({ rule: "Always use bun" })).toEqual({ kind: "write", summary: "Remember: Always use bun" });
});
