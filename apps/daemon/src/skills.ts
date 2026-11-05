/// Skills for the model (pass 118): the one-liners in the system prompt and
/// the use_skill tool. Loading skills is shared with the desktop's Customize
/// page (@demesne/drive/skills.ts).
import { homedir } from "node:os";
import { loadSkills, missingPaths, noteSkillUse, type Skill } from "@demesne/drive/skills.ts";
import type { AgentTool, ToolContext } from "./tools.ts";

export { loadSkills };
/// Only this many one-liners ride along in every request.
const LISTED_MAX = 40;

/// The system prompt's part: the one-liners, how to use them, and when to
/// offer saving steps as a new skill. Static per project, so the cache holds.
export function skillsGuidance(skills: Skill[], attended = true): string {
  const listed = skills.slice(0, LISTED_MAX).map((skill) => `- ${skill.name}: ${skill.description}`);
  return [
    "Skills are saved steps for work that comes up again.",
    listed.length ? `When a task matches one below, call use_skill with its name before anything else and follow its steps:\n${listed.join("\n")}` : "There are no skills here yet.",
    attended && "When the person asks to save steps as a skill, or the same steps just worked in this chat for the second time, end your answer with one line offering to save them as a skill. "
      + "Once they say yes, write .demesne/skills/<name>/SKILL.md (name in lowercase with dashes) with front matter name and description (one line starting \"Use when\"), then the steps as a short numbered list.",
  ].filter(Boolean).join("\n");
}

/// use_skill: the steps of one skill, counted as a use.
export function useSkillTool(options: { home?: string; now?: () => Date } = {}): AgentTool {
  return {
    definition: {
      name: "use_skill",
      description: "Get a skill's steps by its name (listed in the system prompt) when the task matches it, then follow them.",
      inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false },
    },
    permission: () => null,
    async execute(input: unknown, context: ToolContext) {
      const name = typeof (input as { name?: unknown } | null)?.name === "string" ? (input as { name: string }).name.trim().toLowerCase() : "";
      const home = options.home ?? homedir();
      const skills = loadSkills(context.workspaceRoot, home);
      const skill = skills.find((item) => item.name === name);
      if (!skill) return JSON.stringify({ error: `No skill named ${JSON.stringify(name)}`, skills: skills.map((item) => item.name) });
      noteSkillUse(skill.path, home, options.now?.() ?? new Date());
      const missing = missingPaths(skill, context.workspaceRoot);
      return JSON.stringify({ name: skill.name, steps: skill.steps,
        ...(missing.length ? { note: `These paths it names are gone: ${missing.join(", ")}. Adapt, and offer to update the skill.` } : {}) });
    },
  };
}
