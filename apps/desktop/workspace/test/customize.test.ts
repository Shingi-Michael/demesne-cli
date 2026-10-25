import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { customizable, customizeView, newCustomizable, readCustomizable, writeCustomizable } from "../customize.ts";

test("Customize lists a project's instructions, commands and workflows, and edits only those", () => {
  const base = mkdtempSync(join(tmpdir(), "demesne-customize-"));
  const root = join(base, "project"), home = join(base, "home");
  mkdirSync(join(root, ".demesne", "workflows"), { recursive: true });
  mkdirSync(join(home, ".demesne", "commands"), { recursive: true });
  writeFileSync(join(root, "AGENTS.md"), "# Use bun\nNo GitHub CI.\n");
  writeFileSync(join(root, ".demesne", "workflows", "release.md"), "---\ndescription: Cut a release\n---\n## Build\nBuild it.\ncheck: bun test\n\n## Tag\nTag it.\n");
  writeFileSync(join(home, ".demesne", "commands", "standup.md"), "---\ndescription: What I did\n---\nSummarize.\n");
  const view = customizeView(root, home);
  expect(view.instructions).toMatchObject({ name: "AGENTS.md", exists: true, first: "Use bun" });
  expect(view.workflows).toMatchObject([{ name: "release", description: "Cut a release", steps: 2, checks: 1, mine: false }]);
  expect(view.commands).toMatchObject([{ name: "standup", description: "What I did", mine: true }]);
  // A plain chat has no instructions, only your own files.
  expect(customizeView(null, home).instructions).toBeNull();

  const made = newCustomizable("command", "Ship It", root, home);
  expect(made).toBe(join(root, ".demesne", "commands", "ship-it.md"));
  expect(() => newCustomizable("command", "ship-it", root, home)).toThrow("already exists");
  writeCustomizable(made, "Commit and push", root, home);
  expect(readFileSync(made, "utf8")).toBe("Commit and push\n");
  expect(readCustomizable(join(root, "DEMESNE.md"), root, home)).toBe("");

  for (const path of [join(root, "src", "index.md"), join(root, ".demesne", "commands", "nested", "x.md"), join(root, "package.json"), join(base, "AGENTS.md"), join(root, ".demesne", "commands", "..", "..", "AGENTS.md.bak")])
    expect(customizable(path, root, home)).toBe(false);
  // A symlink in the commands folder can't reach a file outside it.
  symlinkSync(join(root, "package.json"), join(root, ".demesne", "commands", "evil.md"));
  expect(customizable(join(root, ".demesne", "commands", "evil.md"), root, home)).toBe(false);
  expect(() => writeCustomizable(join(root, "src.md"), "x", root, home)).toThrow("isn't one Customize edits");
});
