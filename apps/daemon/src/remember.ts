import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord, pickOption, styleLines, stylesOf } from "@demesne/protocol";
import { forgetLearnedRule, saveDesignRule, saveLearnedRule, saveStyle } from "./design-guide.ts";
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

/// A Foundry mockup by id, for keeping the style the person picked from it (pass 246 A).
export type MockupReader = (id: string) => { title: string; source: string } | null;

export function rememberTool(mockup?: MockupReader): AgentTool {
  return {
    definition: {
      name: "remember",
      description: "Save a standing rule the user gives for this project (\"always…\", \"never…\", \"from now on…\", \"remember that…\") to the project's DEMESNE.md, so every later chat here follows it. One short line, in the user's words. Not for facts about the task at hand, and not for things the code or git history already shows. A rule about how mockups and pages should look (colours, type, spacing, layout, what never to draw) takes design: true and goes to the design guide (.demesne/design.md) that every Foundry page follows.",
      inputSchema: {
        type: "object",
        properties: { rule: { type: "string", minLength: 1, maxLength: RULE_MAX }, design: { type: "boolean", description: "True for a rule about how things should look." },
          learned_from: { type: "string", maxLength: 120, description: "With design: taste you learned from their Foundry notes or picks, not said as a rule. Where it came from: \"♥ on Plans page\", \"picked on Plans page\", \"noted twice: Plans page, Gift page\"." },
          replaces: { type: "string", maxLength: 120, description: "With learned_from: words of an older learned line this one replaces." },
          forget: { type: "boolean", description: "With design: the person asked to forget a learned line; rule is some of its words." },
          style_of: { type: "string", maxLength: 80, description: "With design: the id of a Foundry page of styles the person picked a style from; rule is that style's name. Keeps it as the project's style." } },
        required: ["rule"],
        additionalProperties: false,
      },
    },
    permission(input) {
      // Taste learned from the person's own notes is Foundry's bookkeeping, like a save: it never asks.
      // Forgetting one is the person's own ask, and only ever takes a learned line away.
      if (isRecord(input) && input.design === true && (input.forget === true || (typeof input.learned_from === "string" && input.learned_from.trim()) || (typeof input.style_of === "string" && input.style_of.trim()))) return null;
      const rule = isRecord(input) && typeof input.rule === "string" ? input.rule : "";
      return { kind: "write", summary: `${isRecord(input) && input.design === true ? "Design rule" : "Remember"}: ${rule.slice(0, 100)}` };
    },
    async execute(input, context) {
      if (!isRecord(input) || typeof input.rule !== "string") throw toolError("MISSING_RULE", "remember needs a rule", "pass the rule as one short line");
      const rule = input.rule.replace(/\s+/g, " ").trim().replace(/^[-*]\s+/, "");
      if (!rule) throw toolError("MISSING_RULE", "the rule is empty", "pass the rule as one short line");
      if (rule.length > RULE_MAX) throw toolError("RULE_TOO_LONG", `the rule is over ${RULE_MAX} characters`, "say it in one short line");
      // The style they picked from a page of styles: its values are read from the page, never retyped.
      if (input.design === true && typeof input.style_of === "string" && input.style_of.trim()) {
        const found = mockup?.(input.style_of.trim());
        const styles = found ? stylesOf(found.source)?.styles ?? [] : [];
        if (!found || !styles.length) throw toolError("NO_STYLES", `no Foundry page of styles has the id ${input.style_of.trim()}`, "pass the id of the mockup that showed the styles (foundry_read lists them)");
        const at = pickOption(styles.map((style) => style.name), rule);
        if (at < 0) throw toolError("NO_SUCH_STYLE", `“${found.title}” has no style called ${rule}`, `its styles are ${styles.map((style) => style.name).join(", ")}; pass one of those names as rule`);
        const style = styles[at]!;
        const kept = saveStyle(context.workspaceRoot, style.name, `picked on ${found.title.slice(0, 60)}`, styleLines(style));
        return JSON.stringify({ ...kept, style: style.name, note: kept.saved ? "It is the project's style now: later mockups here are drawn in it. Tell the person in a few words." : "It already is the project's style." });
      }
      if (input.design === true && input.forget === true) {
        const gone = forgetLearnedRule(context.workspaceRoot, rule);
        return JSON.stringify(gone.forgotten ? { path: gone.path, forgotten: true, note: "Forgotten: later mockups no longer follow it." } : { path: gone.path, forgotten: false, learned: gone.left, note: "No learned line holds those words. Use words from one of these lines." });
      }
      const from = typeof input.learned_from === "string" ? input.learned_from.replace(/[\s()]+/g, " ").trim().slice(0, 120) : "";
      if (input.design === true && from) {
        const kept = saveLearnedRule(context.workspaceRoot, rule.slice(0, 200), from, typeof input.replaces === "string" ? input.replaces : "");
        return JSON.stringify(kept.saved ? { ...kept, rule, learned: true, note: "Learned: later mockups here start from it. No need to tell the person more than a few words." } : { ...kept, learned: true, note: "The design guide already says this." });
      }
      if (input.design === true) {
        const kept = saveDesignRule(context.workspaceRoot, rule);
        return JSON.stringify(kept.saved ? { ...kept, rule, note: "In the design guide: it holds from the next mockup on." } : { ...kept, note: "Already in the design guide." });
      }
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
