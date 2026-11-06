import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "@demesne/protocol";
import { INSTRUCTION_FILE_NAMES } from "./instructions.ts";
import { toolError, type AgentTool } from "./tools.ts";

/// "Always run the tests with bun": a standing rule you give in a chat, saved
/// to the project's instructions file (DEMESNE.md, or AGENTS.md when that is
/// the one there), under "## Remembered", so every later chat in the project
/// starts with it. The file is read each turn, so it holds from the next one.

export const REMEMBERED_HEADING = "## Remembered";
const RULE_MAX = 400;

/// The file the rule goes in: the project's instructions file, else a new DEMESNE.md.
export function instructionFileOf(root: string): string {
  return INSTRUCTION_FILE_NAMES.find((name) => existsSync(join(root, name))) ?? INSTRUCTION_FILE_NAMES[0];
}

/// The file with `rule` added as a bullet under the Remembered heading (made
/// at the end when missing). Unchanged when the rule is already there.
export function withRule(content: string, rule: string): string {
  const line = `- ${rule}`;
  const lines = content.split("\n");
  const heading = lines.findIndex((text) => text.trim() === REMEMBERED_HEADING);
  if (heading === -1) {
    const body = content.replace(/\s+$/, "");
    return `${body ? `${body}\n\n` : ""}${REMEMBERED_HEADING}\n\n${line}\n`;
  }
  let end = heading + 1;
  while (end < lines.length && !/^#{1,2}\s/.test(lines[end]!)) end++;
  const section = lines.slice(heading + 1, end);
  if (section.some((text) => text.trim().toLowerCase() === line.toLowerCase())) return content;
  let at = end;
  while (at > heading + 1 && !lines[at - 1]!.trim()) at--;
  lines.splice(at, 0, ...(at === heading + 1 ? ["", line] : [line]));
  return lines.join("\n");
}

export function rememberTool(): AgentTool {
  return {
    definition: {
      name: "remember",
      description: "Save a standing rule the user gives for this project (\"always…\", \"never…\", \"from now on…\", \"remember that…\") to the project's DEMESNE.md, so every later chat here follows it. One short line, in the user's words. Not for facts about the task at hand, and not for things the code or git history already shows.",
      inputSchema: {
        type: "object",
        properties: { rule: { type: "string", minLength: 1, maxLength: RULE_MAX } },
        required: ["rule"],
        additionalProperties: false,
      },
    },
    permission(input) {
      const rule = isRecord(input) && typeof input.rule === "string" ? input.rule : "";
      return { kind: "write", summary: `Remember: ${rule.slice(0, 100)}` };
    },
    async execute(input, context) {
      if (!isRecord(input) || typeof input.rule !== "string") throw toolError("MISSING_RULE", "remember needs a rule", "pass the rule as one short line");
      const rule = input.rule.replace(/\s+/g, " ").trim().replace(/^[-*]\s+/, "");
      if (!rule) throw toolError("MISSING_RULE", "the rule is empty", "pass the rule as one short line");
      if (rule.length > RULE_MAX) throw toolError("RULE_TOO_LONG", `the rule is over ${RULE_MAX} characters`, "say it in one short line");
      const name = instructionFileOf(context.workspaceRoot);
      const path = join(context.workspaceRoot, name);
      const before = existsSync(path) ? readFileSync(path, "utf8") : "";
      const after = withRule(before, rule);
      if (after === before) return JSON.stringify({ path: name, saved: false, note: "Already remembered." });
      writeFileSync(path, after, "utf8");
      return JSON.stringify({ path: name, saved: true, rule });
    },
  };
}
