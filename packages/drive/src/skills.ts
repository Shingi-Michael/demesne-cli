/// Skills (pass 118): know-how the agent picks up by itself. A skill is a
/// folder with a SKILL.md: a name, one line on when to use it, and the
/// steps. The model sees only the one-liners; when a task matches, it calls
/// use_skill and follows the steps, so nobody types a command. Skills live in
/// the project (`.demesne/skills/<name>/SKILL.md`) or are yours in every
/// project (`~/.demesne/skills/<name>/SKILL.md`); the project's wins a name.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface Skill {
  name: string;
  /// When to use it, in one line ("Use when …").
  description: string;
  path: string;
  /// Yours in every project, not the project's.
  mine: boolean;
  steps: string;
}
export interface SkillUse { count: number; last: string }

const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const STEPS_MAX = 16 * 1024;

/// The front matter's name and description, and the steps after it.
export function parseSkill(text: string, folder: string): { name: string; description: string; steps: string } | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  const head = match?.[1] ?? "", steps = (match?.[2] ?? text).trim();
  const field = (key: string) => new RegExp(`^${key}:\\s*(.+)$`, "m").exec(head)?.[1]?.trim().replace(/^["']|["']$/g, "") ?? "";
  const name = (field("name") || folder).toLowerCase();
  const description = field("description").replace(/\s+/g, " ").slice(0, 300);
  if (!NAME.test(name) || !description || !steps) return null;
  return { name, description, steps: steps.slice(0, STEPS_MAX) };
}

function skillsIn(folder: string, mine: boolean): Skill[] {
  let names: string[];
  try { names = readdirSync(folder).sort(); } catch { return []; }
  return names.flatMap((entry) => {
    const path = join(folder, entry, "SKILL.md");
    try {
      if (!statSync(path).isFile()) return [];
      const parsed = parseSkill(readFileSync(path, "utf8"), entry);
      return parsed ? [{ ...parsed, path, mine }] : [];
    } catch { return []; }
  });
}

/// The project's skills, then yours (a project skill wins its name).
export function loadSkills(root: string | null | undefined, home = homedir()): Skill[] {
  const project = root ? skillsIn(join(root, ".demesne", "skills"), false) : [];
  const yours = skillsIn(join(home, ".demesne", "skills"), true).filter((skill) => !project.some((item) => item.name === skill.name));
  return [...project, ...yours];
}

const usesPath = (home: string) => join(home, ".demesne", "skill-uses.json");
export function skillUses(home = homedir()): Record<string, SkillUse> {
  try { const parsed = JSON.parse(readFileSync(usesPath(home), "utf8")); return parsed && typeof parsed === "object" ? parsed : {}; } catch { return {}; }
}
export function noteSkillUse(path: string, home: string, now: Date) {
  const uses = skillUses(home);
  uses[path] = { count: (uses[path]?.count ?? 0) + 1, last: now.toISOString() };
  try { mkdirSync(dirname(usesPath(home)), { recursive: true }); writeFileSync(usesPath(home), `${JSON.stringify(uses, null, 1)}\n`); } catch { /* a count is not worth failing a turn */ }
}

/// Paths a skill's steps name in `code` that are no longer in the project:
/// a skill that names a script which is gone needs updating.
export function missingPaths(skill: Skill, root: string | null | undefined): string[] {
  if (!root) return [];
  const named = [...skill.steps.matchAll(/`([^`\s]+\/[^`\s]+\.[a-z0-9]{1,5})`/gi)].map((match) => match[1]!)
    .filter((path) => !path.startsWith("~") && !path.startsWith("/") && !path.includes("<") && !path.includes("$"));
  return [...new Set(named)].filter((path) => !existsSync(join(root, path)));
}

