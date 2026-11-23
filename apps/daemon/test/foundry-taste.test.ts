import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DemesneStore } from "@demesne/storage";
import { designGuideBlock, LEARNED_HEADING, LEARNED_HOW, LEARNED_MAX, learnedIn, learnedRules, withLearnedRule, withoutLearnedRule } from "../src/design-guide.ts";
import { briefOf, foundryEditTool, foundryReadTool, foundrySaveTool, TASTE_ANSWER } from "../src/foundry.ts";
import { rememberTool } from "../src/remember.ts";

// Pass 245 A, taste that carries over: what the person keeps, picks and asks
// for twice on a project's mockups becomes short lines in its design guide,
// and the next mockup says which of them it follows.

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const project = () => { const root = mkdtempSync(join(tmpdir(), "demesne-taste-")); roots.push(root); return root; };
const signal = new AbortController().signal;
const guide = (root: string) => readFileSync(join(root, ".demesne/design.md"), "utf8");

test("a learned line starts the section, says where it came from, and is kept once", () => {
  const first = withLearnedRule("", "Serif headings on warm paper", "♥ on Plans page");
  expect(first).toBe(`# Design guide\n\n${LEARNED_HEADING}\n\nFoundry adds these from what you keep, pick and ask for twice on mockups here. Edit or delete any line.\n\n- Serif headings on warm paper (♥ on Plans page)\n`);
  expect(learnedRules(first)).toEqual(["Serif headings on warm paper (♥ on Plans page)"]);
  // The same rule from somewhere else is not said twice.
  expect(withLearnedRule(first, "serif headings on warm paper.", "picked on Gift page")).toBe(first);
  // A guide the person wrote keeps its own rules; the section goes after them.
  const theirs = "# Design guide\n\n## Rules\n\n- Never use gradients\n";
  const added = withLearnedRule(theirs, "One accent colour, on the button only", "noted twice: Plans page, Gift page");
  expect(added.startsWith(theirs)).toBe(true);
  expect(learnedRules(added)).toEqual(["One accent colour, on the button only (noted twice: Plans page, Gift page)"]);
  // The next one goes under it, before whatever follows the section.
  const between = withLearnedRule(`${added}\n## Later\n\nText.\n`, "Prices in the body face", "picked on Plans page");
  expect(learnedRules(between)).toHaveLength(2);
  expect(between.indexOf("Prices in the body face")).toBeLessThan(between.indexOf("## Later"));
  expect(learnedRules(theirs)).toEqual([]);
});

test("a newer note wins, the oldest goes past twelve, and one can be forgotten", () => {
  let content = withLearnedRule("", "Orange accents on every card", "♥ on Plans page");
  content = withLearnedRule(content, "Serif headings", "♥ on Plans page");
  // A note that goes against an older line takes its place.
  content = withLearnedRule(content, "One accent colour, on the button only", "noted twice: Plans page, Gift page", "orange accents");
  expect(learnedRules(content)).toEqual(["One accent colour, on the button only (noted twice: Plans page, Gift page)", "Serif headings (♥ on Plans page)"]);
  for (let index = 0; index < LEARNED_MAX; index++) content = withLearnedRule(content, `Rule ${index}`, "♥ on Plans page");
  const kept = learnedRules(content);
  expect(kept).toHaveLength(LEARNED_MAX);
  expect(kept[0]).toBe("Rule 0 (♥ on Plans page)");
  expect(kept.at(-1)).toBe(`Rule ${LEARNED_MAX - 1} (♥ on Plans page)`);
  const without = withoutLearnedRule(content, "Rule 3");
  expect(learnedRules(without)).toHaveLength(LEARNED_MAX - 1);
  expect(without).not.toContain("Rule 3 ");
  expect(withoutLearnedRule(content, "nothing like it")).toBe(content);
  // Only learned lines are ever taken away, never a rule the person wrote.
  const theirs = "## Rules\n\n- Never use gradients\n";
  expect(withoutLearnedRule(theirs, "gradients")).toBe(theirs);
});

test("remember keeps learned taste without asking, and forgets a line when told", async () => {
  const root = project(), tool = rememberTool(), context = { workspaceRoot: root, signal };
  // What the person said as a rule still asks like an edit; what Foundry learned from their notes does not.
  expect(tool.permission({ rule: "Never use gradients", design: true })).toEqual({ kind: "write", summary: "Design rule: Never use gradients" });
  expect(tool.permission({ rule: "Serif headings", design: true, learned_from: "♥ on Plans page" })).toBeNull();
  expect(tool.permission({ rule: "Serif headings", design: true, forget: true })).toBeNull();
  expect(tool.permission({ rule: "Serif headings", learned_from: "♥ on Plans page" })).not.toBeNull();

  const kept = JSON.parse(await tool.execute({ rule: "Serif headings on warm paper", design: true, learned_from: "♥ on Plans page" }, context));
  expect(kept).toMatchObject({ path: ".demesne/design.md", saved: true, learned: true, rule: "Serif headings on warm paper" });
  expect(learnedIn(root)).toEqual(["Serif headings on warm paper (♥ on Plans page)"]);
  expect(JSON.parse(await tool.execute({ rule: "Serif headings on warm paper", design: true, learned_from: "picked on Gift page" }, context)).saved).toBe(false);
  await tool.execute({ rule: "Sans headings, one weight", design: true, learned_from: "noted twice: Plans page (v2), Gift page", replaces: "serif headings" }, context);
  expect(learnedIn(root)).toEqual(["Sans headings, one weight (noted twice: Plans page v2 , Gift page)"]);

  const missed = JSON.parse(await tool.execute({ rule: "rounded corners", design: true, forget: true }, context));
  expect(missed).toMatchObject({ forgotten: false, learned: ["Sans headings, one weight (noted twice: Plans page v2 , Gift page)"] });
  expect(JSON.parse(await tool.execute({ rule: "sans headings", design: true, forget: true }, context)).forgotten).toBe(true);
  expect(learnedIn(root)).toEqual([]);
  expect(guide(root)).toContain(LEARNED_HEADING);
  // Nothing to forget and no guide: no file is made.
  const empty = project();
  expect(JSON.parse(await tool.execute({ rule: "anything", design: true, forget: true }, { workspaceRoot: empty, signal })).forgotten).toBe(false);
  expect(existsSync(join(empty, ".demesne/design.md"))).toBe(false);
});

test("the design guide tells the model about learned lines only when there are some", () => {
  expect(designGuideBlock([])).not.toContain("why.followed");
  expect(designGuideBlock([{ path: ".demesne/design.md", content: "## Rules\n\n- Never use gradients\n", truncated: false }])).not.toContain("why.followed");
  const block = designGuideBlock([{ path: ".demesne/design.md", content: withLearnedRule("", "Serif headings", "♥ on Plans page"), truncated: false }]);
  expect(block).toContain("- Serif headings (♥ on Plans page)");
  expect(block.endsWith(LEARNED_HOW)).toBe(true);
});

const WALK = [{ what: "A page for a test.", parts: [{ name: "Heading", says: "Says what it is." }, { name: "Body", says: "Holds the rest." }], why: "Kept plain for the test." }];
const W = { direction: "Warm paper, for people who buy by taste.", look_at: "The total.", starts_from: "new", walkthrough: WALK };
const page = (word: string) => `<!doctype html><html><body><main><h1>${word}</h1></main></body></html>`;

test("a new mockup says which learned likes it follows, asked once", async () => {
  const store = new DemesneStore(":memory:"), root = project();
  try {
    const save = foundrySaveTool(store), edit = foundryEditTool(store);
    const { session } = store.createSession("Slow Pour", root);
    const turn = (ask: string) => { const { turn: made } = store.createTurn(session.id, ask); store.startTurn(made.id); return { workspaceRoot: root, signal, sessionId: session.id, turnId: made.id }; };
    const done = (context: { turnId: string }) => store.completeTurn(context.turnId);

    // Nothing learned yet: nothing is asked.
    const t1 = turn("Show me the plans page");
    const plans = JSON.parse(await save.execute({ kind: "html", title: "Plans page", description: "The three plans.", source: page("Plans"), why: W }, t1));
    expect(plans.message).not.toContain(TASTE_ANSWER);
    done(t1);

    mkdirSync(join(root, ".demesne"), { recursive: true });
    writeFileSync(join(root, ".demesne/design.md"), withLearnedRule(withLearnedRule("", "Serif headings on warm paper", "♥ on Plans page"), "One accent colour, on the button only", "noted twice: Plans page, Gift page"));

    // A new mockup that does not say is told the lines, once.
    const t2 = turn("Now the checkout page");
    const input = { kind: "html", title: "Checkout page", description: "The last step before paying.", source: page("Checkout"), why: W };
    await expect(save.execute(input, t2)).rejects.toThrow(/\[taste\][\s\S]*2 lines learned[\s\S]*- Serif headings on warm paper \(♥ on Plans page\)[\s\S]*why\.followed/);
    const saved = JSON.parse(await save.execute({ ...input, why: { ...W, followed: "Serif headings on warm paper; one accent, on Pay only" } }, t2));
    expect(saved.message).toContain(TASTE_ANSWER);
    // The fix after its own look is not asked again, and keeps what the version said.
    const fixed = JSON.parse(await edit.execute({ id: saved.id, base_version: saved.version, edits: [{ find: "Checkout", replace: "Check out" }], critique: "The heading read as one word." }, t2));
    expect(fixed.version).toBe(saved.version);
    done(t2);
    const found = store.getFoundryArtifact(saved.id)!;
    expect(found.versions.at(-1)!.why?.followed).toBe("Serif headings on warm paper; one accent, on Pay only");
    expect(briefOf(found).brief?.at(-1)).toMatchObject({ followed: "Serif headings on warm paper; one accent, on Pay only" });

    // A later change to it in another turn says so again; "none" is an answer, and is not shown as followed.
    const t3 = turn("Make the total bigger");
    const change = { id: saved.id, base_version: saved.version, edits: [{ find: "Check out", replace: "Pay" }], why: { direction: "Same paper.", look_at: "The bigger total." } };
    await expect(edit.execute(change, t3)).rejects.toThrow(/\[taste\]/);
    const second = JSON.parse(await edit.execute({ ...change, why: { ...change.why, followed: "none" } }, t3));
    expect(second.message).not.toContain(TASTE_ANSWER);
    done(t3);
    expect(briefOf(store.getFoundryArtifact(saved.id)!).brief?.at(-1)).not.toHaveProperty("followed");

    const t4 = turn("And the gift page");
    // Asked once: a second try that still does not say goes through rather than looping.
    await expect(save.execute({ ...input, title: "Gift page" }, t4)).rejects.toThrow(/\[taste\]/);
    expect(JSON.parse(await save.execute({ ...input, title: "Gift page" }, t4)).version).toBe(1);
    done(t4);

    // A document is not a look: nothing is asked.
    const t5 = turn("Write the launch notes");
    expect(JSON.parse(await save.execute({ kind: "markdown", title: "Launch notes", description: "Notes for the launch.", source: "# Launch\n\nNotes." }, t5)).version).toBe(1);
  } finally { store.close(); }
});

test("reading a mockup hands back the changes asked on the project's other mockups", async () => {
  const store = new DemesneStore(":memory:");
  try {
    const { session } = store.createSession("Slow Pour", "/tmp");
    const make = (title: string, workspace: string | null = "/work/slow-pour") => {
      const { turn } = store.createTurn(session.id, `Show me the ${title}`);
      const made = store.saveFoundryArtifact({ kind: "html", title, source: page(title), sessionId: session.id, turnId: turn.id, workspace });
      store.startTurn(turn.id); store.completeTurn(turn.id);
      return made;
    };
    const plans = make("Plans page"), gift = make("Gift page"), other = make("Invoice", "/work/ledger");
    const read = async (id: string) => JSON.parse(await foundryReadTool(store).execute({ id }, { workspaceRoot: "/tmp", signal, sessionId: session.id } as never));
    expect((await read(gift.id)).taste_rule).toBeUndefined();

    const notes = (mockup: { id: string; title: string }, lines: string) => `On “${mockup.title}”:\n${lines}\n\n\`\`\`parts\nNotes pinned on the Foundry mockup "${mockup.title}" (id ${mockup.id}, v1). Change only…\n1. change, Daily card: not this one, it is the folded detail\n\`\`\``;
    for (const content of [
      notes(plans, "1 · Daily card: Less orange, it shouts\n♥ · “Most chosen”: Keep this tag\n2 · The page: More room at the top"),
      notes(other, "1 · Total: Bigger"),
      `${notes(plans, "1 · Daily card: Less orange, it shouts")}\n\n${notes(gift, "1 · Ribbon: Too orange")}`,
    ]) { const { turn } = store.createTurn(session.id, content); store.startTurn(turn.id); store.completeTurn(turn.id); }

    // Changes only (keeps belong to their own mockup), newest first, once each, from the same project, never this mockup's own.
    expect(store.foundryChangesElsewhere(gift.id)).toEqual([
      { on: "Plans page", note: "Daily card: Less orange, it shouts" },
      { on: "Plans page", note: "The page: More room at the top" },
    ]);
    expect(store.foundryChangesElsewhere(plans.id)).toEqual([{ on: "Gift page", note: "Ribbon: Too orange" }]);
    expect(store.foundryChangesElsewhere(other.id)).toEqual([]);
    const got = await read(gift.id);
    expect(got.changes_elsewhere).toEqual(store.foundryChangesElsewhere(gift.id));
    expect(got.taste_rule).toMatch(/remember \{design: true, learned_from\}/);
    // What they like on this mockup is taste on its own.
    const liked = await read(plans.id);
    expect(liked.liked).toEqual(["“Most chosen”: Keep this tag"]);
    expect(liked.taste_rule).toBeDefined();
    expect((await read(other.id)).taste_rule).toBeUndefined();
  } finally { store.close(); }
});
