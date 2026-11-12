import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearDesignGuideCache, DESIGN_GUIDE_MAX_BYTES, DESIGN_RULES, designGuideBlock, loadDesignGuides, saveDesignRule, withDesignRule } from "../src/design-guide.ts";
import { agentSystemPrompt } from "../src/engine.ts";
import { foundrySaveTool } from "../src/foundry.ts";
import { rememberTool } from "../src/remember.ts";
import { DemesneStore } from "@demesne/storage";

// The design guide: Demesne's numbered rules, the person's own on top, and a
// rule said in a chat kept for every later mockup.

const made: string[] = [];
const folder = () => { const path = mkdtempSync(join(tmpdir(), "demesne-design-")); made.push(path); return path; };
afterEach(() => { for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true }); clearDesignGuideCache(); });

test("Demesne's rules are numbered, and say what the old paragraph said", () => {
  const block = designGuideBlock([]);
  expect(block).toContain("1. Direction first");
  expect(block).toContain("14. Avoid stock AI looks");
  // From the design plugin's checklists: readable text and tap sizes, every state, and plain words.
  expect(block).toContain("4.5:1 contrast");
  expect(block).toContain("at least 44px each way");
  expect(block).toContain("15. Every state it can be in is designed");
  expect(block).toContain(`${DESIGN_RULES.length}. Words are part of the design`);
  expect(block).toContain("\"Delete 3 files?\", never \"Are you sure?\"");
  for (const words of ["the kit is the floor", "var(--text-xs|sm|md|lg|xl|display)", "var(--space-1…8)", "cards side by side the same height", "phone width", "never more than three", "prefers-reduced-motion: reduce", "never lorem ipsum"])
    expect(block).toContain(words);
  // Demesne's own look, for a mockup of Demesne.
  expect(block).toContain("no side panels and no menus");
  expect(block).not.toContain("The person's own design rules");
  // About the size of the paragraph it replaces.
  expect(block.length).toBeLessThan(4600);
});

test("your guide for every chat and the project's are both read, the project's last", () => {
  const home = folder(), project = folder();
  mkdirSync(join(home, ".demesne"));
  writeFileSync(join(home, ".demesne/design.md"), "- Never purple.\n");
  expect(loadDesignGuides(project, home).map((guide) => guide.path)).toEqual(["~/.demesne/design.md"]);
  writeFileSync(join(project, "DESIGN.md"), "- Serif headlines.\n");
  clearDesignGuideCache();
  expect(loadDesignGuides(project, home).map((guide) => guide.path)).toEqual(["~/.demesne/design.md", "DESIGN.md"]);
  // .demesne/design.md is the project's guide when both are there.
  mkdirSync(join(project, ".demesne"));
  writeFileSync(join(project, ".demesne/design.md"), "- Hairlines, never boxes.\n");
  const guides = loadDesignGuides(project, home);
  expect(guides.map((guide) => guide.path)).toEqual(["~/.demesne/design.md", ".demesne/design.md"]);
  const block = designGuideBlock(guides);
  expect(block).toContain("They win over every rule above");
  expect(block.indexOf("Never purple.")).toBeLessThan(block.indexOf("Hairlines, never boxes."));
  // A chat outside a project works in home: one file, read once.
  expect(loadDesignGuides(home, home)).toHaveLength(1);
  // An empty guide is no guide, and a huge one is cut.
  writeFileSync(join(project, ".demesne/design.md"), "x".repeat(DESIGN_GUIDE_MAX_BYTES + 10));
  clearDesignGuideCache();
  expect(loadDesignGuides(project, home)[1]!.truncated).toBe(true);
});

test("the guide comes with Foundry's tools, not before", () => {
  const home = folder(), project = folder();
  const store = new DemesneStore(":memory:");
  try {
    const definitions = [foundrySaveTool(store).definition];
    const waiting = agentSystemPrompt({ workspaceRoot: project, definitions, designing: false, home });
    expect(waiting).not.toContain("# Design guide");
    const loaded = agentSystemPrompt({ workspaceRoot: project, definitions, designing: true, home });
    expect(loaded).toContain("# Design guide");
    // Without tool search the tools are always there, and so is the guide.
    expect(agentSystemPrompt({ workspaceRoot: project, definitions, home })).toContain("# Design guide");
    expect(agentSystemPrompt({ workspaceRoot: project, definitions: [], home })).not.toContain("# Design guide");
  } finally { store.close(); }
});

test("a rule said in a chat is kept in the guide, once", async () => {
  const project = folder();
  const context = { workspaceRoot: project, signal: new AbortController().signal } as never;
  const tool = rememberTool();
  expect(tool.permission({ rule: "Never use purple", design: true })).toEqual({ kind: "write", summary: "Design rule: Never use purple" });
  const kept = JSON.parse(await tool.execute({ rule: "Never use purple", design: true }, context));
  expect(kept).toMatchObject({ path: ".demesne/design.md", saved: true });
  expect(readFileSync(join(project, ".demesne/design.md"), "utf8")).toBe("# Design guide\n\nRules every mockup follows. One per line; edit freely.\n\n## Rules\n\n- Never use purple\n");
  expect(JSON.parse(await tool.execute({ rule: "never use purple", design: true }, context)).saved).toBe(false);
  await tool.execute({ rule: "Lists always get hairline dividers", design: true }, context);
  expect(loadDesignGuides(project, folder())[0]!.content).toContain("- Never use purple\n- Lists always get hairline dividers");
  // An ordinary rule still goes to the project's instructions.
  expect(JSON.parse(await tool.execute({ rule: "Run tests with bun" }, context)).path).toBe("DEMESNE.md");
  // A guide written by hand keeps its words; the rule goes under Rules.
  expect(withDesignRule("# Our look\n\nCalm and dense.\n", "No gradients")).toBe("# Our look\n\nCalm and dense.\n\n## Rules\n\n- No gradients\n");
  expect(saveDesignRule(project, "Never use purple").saved).toBe(false);
});
