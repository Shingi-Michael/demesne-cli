import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DemesneStore } from "@demesne/storage";
import { designGuideBlock, pickedStyle, STYLE_HOW, withLearnedRule, withStyle, learnedRules } from "../src/design-guide.ts";
import { foundryEditTool, foundryReadTool, foundrySaveTool, PARTS_GUIDE, STYLES_ANSWER } from "../src/foundry.ts";
import { rememberTool, type MockupReader } from "../src/remember.ts";

// Pass 246 A, a range of styles: one page drawn in two or three styles a
// person tells apart, and the one they pick kept as the project's style.

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const project = () => { const root = mkdtempSync(join(tmpdir(), "demesne-styles-")); roots.push(root); return root; };
const signal = new AbortController().signal;

const style = (name: string, vars: string) => `<d-style name="${name}" made="${name}, in a line" vars="${vars}"></d-style>`;
const CLEAN = "--paper:#fff; --ink:#111417; --accent:#1f6f4a; --head:Inter,sans-serif; --font:Inter,sans-serif; --radius:8px";
const LABEL = "--paper:#1d1613; --ink:#f3e9da; --accent:#e0a93b; --head:'JetBrains Mono',monospace; --font:Inter,sans-serif; --radius:2px";
const PAPER = "--paper:#fbf7f2; --ink:#2a211b; --accent:#b9643c; --head:Georgia,serif; --font:Inter,sans-serif; --radius:14px";
const page = (styles: string, word = "Checkout") => `<!doctype html><html><head><link rel="stylesheet" href="foundry://kit/base.css"><script src="foundry://kit/parts.js"></script></head><body><d-styles recommended="Clean counter">${styles}</d-styles><main><h1>${word}</h1><button class="primary">Pay €200</button></main></body></html>`;
const THREE = style("Clean counter", CLEAN) + style("Roastery label", LABEL) + style("Warm paper", PAPER);
const WALK = [{ what: "A page for a test.", parts: [{ name: "Heading", says: "Says what it is." }, { name: "Body", says: "Holds the rest." }], why: "Kept plain for the test." }];
const W = { direction: "One checkout in three styles.", look_at: "The price and the Pay button.", starts_from: "new", walkthrough: WALK };

test("a page of styles is saved when the styles differ, and turned back when they are one look twice", async () => {
  const store = new DemesneStore(":memory:"), root = project();
  try {
    const save = foundrySaveTool(store), edit = foundryEditTool(store), read = foundryReadTool(store);
    const { session } = store.createSession("Slow Pour", root);
    const { turn } = store.createTurn(session.id, "Show me the checkout page in a few styles");
    store.startTurn(turn.id);
    const context = { workspaceRoot: root, signal, sessionId: session.id, turnId: turn.id };
    const input = { kind: "html", title: "Checkout page, three styles", description: "One checkout in three styles.", why: W };

    const twin = style("Clean counter", CLEAN) + style("Green counter", CLEAN.replace("#1f6f4a", "#0a58ca"));
    await expect(save.execute({ ...input, source: page(twin) }, context)).rejects.toThrow(/\[styles\] “Clean counter” and “Green counter” share their paper and their heading typeface/);
    await expect(save.execute({ ...input, source: page(style("Clean counter", CLEAN)) }, context)).rejects.toThrow(/a range is two or three/);

    const saved = JSON.parse(await save.execute({ ...input, source: page(THREE) }, context));
    expect(saved.version).toBe(1);
    // The answer names the styles, and the model is told how the pick is kept.
    expect(saved.message).toContain(STYLES_ANSWER);
    expect(saved.message).toContain(`remember {design: true, style_of: "${saved.id}", rule: "<style name>"}`);
    // An edit is checked the same way.
    await expect(edit.execute({ id: saved.id, base_version: 1, edits: [{ find: LABEL, replace: CLEAN }], critique: "Trying a twin." }, context)).rejects.toThrow(/share their paper/);
    store.completeTurn(turn.id);

    // Reading it back says which styles it holds and how to keep the pick, even after the save has left the chat.
    const got = JSON.parse(await read.execute({ id: saved.id }, { workspaceRoot: root, signal, sessionId: session.id } as never));
    expect(got.styles).toEqual(["Clean counter", "Roastery label", "Warm paper"]);
    expect(got.styles_rule).toContain(`style_of: "${saved.id}"`);
    // A page without styles says nothing of them.
    const { turn: next } = store.createTurn(session.id, "And the plans page");
    store.startTurn(next.id);
    const plain = JSON.parse(await save.execute({ kind: "html", title: "Plans page", description: "The plans.", why: W, source: "<main><h1>Plans</h1></main>" }, { ...context, turnId: next.id }));
    expect(plain.message).not.toContain(STYLES_ANSWER);
    expect(JSON.parse(await read.execute({ id: plain.id }, { workspaceRoot: root, signal, sessionId: session.id } as never)).styles).toBeUndefined();
  } finally { store.close(); }
});

test("the parts guide and the design guide say when and how to offer styles", () => {
  expect(PARTS_GUIDE).toContain('<d-styles recommended="Clean counter">');
  expect(PARTS_GUIDE).toContain("--paper:…; --ink:…; --accent:…; --head:…; --font:…; --radius:…");
  expect(PARTS_GUIDE).toContain("write the page ONCE on those variables");
  expect(designGuideBlock([])).toContain("Asked for styles or looks");
  expect(designGuideBlock([])).not.toContain(STYLE_HOW);
});

test("the style they pick becomes the project's style, read from the page", async () => {
  const root = project();
  const pages: Record<string, { title: string; source: string }> = { m1: { title: "Checkout page, three styles", source: page(THREE) }, plain: { title: "Plans page", source: "<main>Plans</main>" } };
  const reader: MockupReader = (id) => pages[id] ?? null;
  const tool = rememberTool(reader), context = { workspaceRoot: root, signal };
  // Their own pick, kept like a save: it never asks.
  expect(tool.permission({ rule: "Roastery label", design: true, style_of: "m1" })).toBeNull();
  expect(tool.permission({ rule: "Roastery label", style_of: "m1" })).not.toBeNull();

  const kept = JSON.parse(await tool.execute({ rule: "roastery", design: true, style_of: "m1" }, context));
  expect(kept).toMatchObject({ path: ".demesne/design.md", saved: true, style: "Roastery label" });
  const guide = () => readFileSync(join(root, ".demesne/design.md"), "utf8");
  expect(guide()).toBe([
    "# Design guide", "", "## Style", "",
    "Roastery label (picked on Checkout page, three styles). Foundry draws new mockups here in it. Edit any line, or pick another style to replace it.", "",
    "- Made of: Roastery label, in a line",
    "- Colours: paper #1d1613, ink #f3e9da, accent #e0a93b",
    "- Type: JetBrains Mono for headings, Inter for the rest",
    "- Corners: 2px",
    "- Values: `--paper: #1d1613; --ink: #f3e9da; --accent: #e0a93b; --head: 'JetBrains Mono',monospace; --font: Inter,sans-serif; --radius: 2px`",
    "",
  ].join("\n"));
  expect(pickedStyle(guide())).toBe("Roastery label");
  expect(JSON.parse(await tool.execute({ rule: "Roastery label", design: true, style_of: "m1" }, context)).saved).toBe(false);

  // One style per project: a newer pick replaces it, and the rest of the guide stays.
  writeFileSync(join(root, ".demesne/design.md"), withLearnedRule(`## Rules\n\n- Never use gradients\n\n${guide()}`, "Savings in euros", "♥ on Plans page"));
  await tool.execute({ rule: "Warm paper", design: true, style_of: "m1" }, context);
  expect(pickedStyle(guide())).toBe("Warm paper");
  expect(guide()).not.toContain("Roastery label");
  expect(guide().match(/^## Style$/gm)).toHaveLength(1);
  expect(guide()).toContain("- Never use gradients");
  expect(learnedRules(guide())).toEqual(["Savings in euros (♥ on Plans page)"]);
  expect(guide().indexOf("## Style")).toBeLessThan(guide().indexOf("## Learned from your notes"));

  // What it cannot keep, it says why.
  await expect(tool.execute({ rule: "Nordic", design: true, style_of: "m1" }, context)).rejects.toThrow(/has no style called Nordic/);
  await expect(tool.execute({ rule: "Warm paper", design: true, style_of: "plain" }, context)).rejects.toThrow(/no Foundry page of styles/);
  await expect(tool.execute({ rule: "Warm paper", design: true, style_of: "gone" }, context)).rejects.toThrow(/no Foundry page of styles/);
  const empty = project();
  await expect(rememberTool().execute({ rule: "Warm paper", design: true, style_of: "m1" }, { workspaceRoot: empty, signal })).rejects.toThrow(/no Foundry page of styles/);
  expect(existsSync(join(empty, ".demesne/design.md"))).toBe(false);
});

test("a guide with a picked style tells the model to draw in it", () => {
  const content = withStyle("", "Roastery label", "picked on Checkout page", ["- Colours: paper #1d1613"]);
  expect(pickedStyle(content)).toBe("Roastery label");
  expect(pickedStyle("## Rules\n\n- Never use gradients\n")).toBe("");
  const block = designGuideBlock([{ path: ".demesne/design.md", content, truncated: false }]);
  expect(block).toContain("- Colours: paper #1d1613");
  expect(block.endsWith(STYLE_HOW)).toBe(true);
  expect(designGuideBlock([{ path: ".demesne/design.md", content: "## Rules\n\n- Never use gradients\n", truncated: false }])).not.toContain(STYLE_HOW);
});
