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

test("Customize lists skills with their uses and gone paths, and edits only SKILL.md one folder down", async () => {
  const { customizePage, lastUsed } = await import("../customize-page.ts");
  const base = mkdtempSync(join(tmpdir(), "demesne-skills-"));
  const root = join(base, "project"), home = join(base, "home");
  mkdirSync(join(root, ".demesne", "skills", "release-check"), { recursive: true });
  mkdirSync(join(home, ".demesne", "skills", "rebuild-demesne"), { recursive: true });
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFileSync(join(root, "scripts", "check.ts"), "");
  writeFileSync(join(root, ".demesne", "skills", "release-check", "SKILL.md"), "---\nname: release-check\ndescription: Use before merging to main.\n---\n1. Run `scripts/check.ts`.\n2. Run `scripts/check-ui.ts`.\n");
  const mine = join(home, ".demesne", "skills", "rebuild-demesne", "SKILL.md");
  writeFileSync(mine, "---\nname: rebuild-demesne\ndescription: Use when Mike asks to rebuild the Mac app.\n---\n1. Build it.\n");
  writeFileSync(join(home, ".demesne", "skill-uses.json"), JSON.stringify({ [mine]: { count: 9, last: new Date().toISOString() } }));
  const view = customizeView(root, home);
  expect(view.skills).toMatchObject([
    { name: "release-check", mine: false, uses: 0, missing: ["scripts/check-ui.ts"] },
    { name: "rebuild-demesne", mine: true, uses: 9 },
  ]);
  const html = customizePage(view, { editing: null, error: "" }, { servers: [], heartbeat: false }, true);
  expect(html).toContain("Skills");
  expect(html).toContain("names scripts/check-ui.ts, which is gone");
  expect(html).toContain("yours, every project · used 9 times · last today");
  expect(lastUsed("2026-11-04T10:00:00", new Date("2026-11-05T09:00:00"))).toBe("yesterday");

  expect(customizable(mine, root, home)).toBe(true);
  expect(customizable(join(root, ".demesne", "skills", "SKILL.md"), root, home)).toBe(false);
  expect(customizable(join(root, ".demesne", "skills", "a", "b", "SKILL.md"), root, home)).toBe(false);
  expect(customizable(join(root, ".demesne", "skills", "a", "other.md"), root, home)).toBe(false);
  const made = newCustomizable("skill", "Fix Mac Hangs", root, home);
  expect(made).toBe(join(root, ".demesne", "skills", "fix-mac-hangs", "SKILL.md"));
  expect(readFileSync(made, "utf8")).toContain("name: fix-mac-hangs");
});
