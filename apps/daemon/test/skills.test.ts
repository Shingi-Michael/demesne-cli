import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSkills, skillsGuidance, useSkillTool } from "../src/skills.ts";
import { parseSkill } from "@demesne/drive/skills.ts";
import { agentSystemPrompt } from "../src/engine.ts";

function setup() {
  const base = mkdtempSync(join(tmpdir(), "demesne-skill-"));
  const root = join(base, "project"), home = join(base, "home");
  const write = (folder: string, name: string, text: string) => { mkdirSync(join(folder, ".demesne", "skills", name), { recursive: true }); writeFileSync(join(folder, ".demesne", "skills", name, "SKILL.md"), text); };
  write(root, "fix-mac-test-hangs", "---\nname: fix-mac-test-hangs\ndescription: Use when a desktop test hangs on the Mac but passes on Linux.\n---\n1. Run it alone.\n2. Point fakes at 127.0.0.1:9.\n");
  write(home, "rebuild-demesne", "---\nname: rebuild-demesne\ndescription: Use when Mike asks to rebuild the Mac app.\n---\n1. Build.\n");
  write(home, "fix-mac-test-hangs", "---\ndescription: Mine, but the project's wins.\n---\nx\n");
  write(home, "broken", "no front matter description");
  return { root, home };
}

test("skills load from the project and from you; the project's wins a name; bad ones are skipped", () => {
  const { root, home } = setup();
  const skills = loadSkills(root, home);
  expect(skills.map((skill) => [skill.name, skill.mine])).toEqual([["fix-mac-test-hangs", false], ["rebuild-demesne", true]]);
  expect(parseSkill("---\nname: Bad Name\ndescription: x\n---\nsteps", "f")).toBeNull();
});

test("the model sees only the one-liners, and is told when to offer saving", () => {
  const { root, home } = setup();
  const text = skillsGuidance(loadSkills(root, home));
  expect(text).toContain("- rebuild-demesne: Use when Mike asks to rebuild the Mac app.");
  expect(text).not.toContain("127.0.0.1:9");
  expect(text).toContain(".demesne/skills/<name>/SKILL.md");
  expect(skillsGuidance([], false)).not.toContain("offering to save");
  const prompt = agentSystemPrompt({ workspaceRoot: root, definitions: [useSkillTool({ home }).definition] });
  expect(prompt).toContain("call use_skill");
  expect(agentSystemPrompt({ workspaceRoot: root, definitions: [] })).not.toContain("use_skill");
});

test("use_skill gives the steps and counts the use", async () => {
  const { root, home } = setup();
  const tool = useSkillTool({ home, now: () => new Date("2026-11-05T10:00:00Z") });
  const context = { workspaceRoot: root, signal: new AbortController().signal };
  const result = JSON.parse(await tool.execute({ name: "fix-mac-test-hangs" }, context));
  expect(result.steps).toContain("127.0.0.1:9");
  await tool.execute({ name: "fix-mac-test-hangs" }, context);
  const uses = JSON.parse(readFileSync(join(home, ".demesne", "skill-uses.json"), "utf8"));
  expect(Object.values(uses)).toEqual([{ count: 2, last: "2026-11-05T10:00:00.000Z" }]);
  expect(JSON.parse(await tool.execute({ name: "nope" }, context)).skills).toEqual(["fix-mac-test-hangs", "rebuild-demesne"]);
});
