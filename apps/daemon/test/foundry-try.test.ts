import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DemesneStore } from "@demesne/storage";
import { foundryTryTool, TRIES_PER_TURN } from "../src/foundry.ts";
import { FOUNDRY_LOOK_PREFIX, lookReport, type FoundryTry } from "../src/foundry-look.ts";
import { PLAN_MODE_TOOL_NAMES } from "../src/engine.ts";

const PNG = Buffer.from("png").toString("base64");

function setup(tryer: FoundryTry) {
  const root = mkdtempSync(join(tmpdir(), "demesne-try-"));
  const store = new DemesneStore(join(root, "state.sqlite"));
  const tool = foundryTryTool(store, tryer);
  const run = (input: unknown, turnId = "t1") => tool.executeWithArtifacts!(input, { turnId, signal: new AbortController().signal } as never);
  return { store, tool, run, done: () => { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("foundry_try runs checked steps on the page and reports each one, the tree and the pictures", async () => {
  const plans: unknown[] = [];
  const { store, run, done } = setup(async (page, plan) => {
    plans.push({ page: page.title, ...plan });
    return { width: plan.width, steps: [{ step: "click “Add”", ok: true, said: 'button "Add" → new text “Milk”' }, { step: "click “Share”", ok: false, said: 'button "Share" is covered by nav "Tab bar", so a person can\'t reach it' }],
      tree: ['heading "Groceries"  0,0 390×32'], errors: [], pictures: [{ after: "click “Share”", png: PNG }] };
  });
  try {
    const page = store.saveFoundryArtifact({ title: "Groceries", kind: "html", source: "<h1>Groceries</h1>" });
    const result = await run({ id: page.id, width: "phone", steps: [{ click: "Add" }, { click: "Share" }, { key: "enter" }] }) as { text: string; images: { filename: string }[] };
    expect(plans[0]).toEqual({ page: "Groceries", width: 390, steps: [{ click: "Add" }, { click: "Share" }, { key: "Enter" }] });
    const said = JSON.parse(result.text);
    expect(said.steps).toEqual(['✓ click “Add”: button "Add" → new text “Milk”', '✕ click “Share”: button "Share" is covered by nav "Tab bar", so a person can\'t reach it']);
    expect(said.tree_after).toEqual(['heading "Groceries"  0,0 390×32']);
    expect(said.next).toMatch(/Fix what went wrong/);
    // Named like the look's pictures, so a model that sees gets them.
    expect(result.images[0]!.filename.startsWith(FOUNDRY_LOOK_PREFIX)).toBe(true);
  } finally { done(); }
});

test("foundry_try refuses bad steps, things with nothing to try, and a fourth try in a turn", async () => {
  const { store, run, done } = setup(async (_page, plan) => ({ width: plan.width, steps: [{ step: "wait 1ms", ok: true, said: "" }], tree: [], errors: [], pictures: [] }));
  try {
    const page = store.saveFoundryArtifact({ title: "List", kind: "html", source: "<p>x</p>" });
    const badge = store.saveFoundryArtifact({ title: "Badge", kind: "svg", source: "<svg/>" });
    await expect(run({ id: page.id, steps: [{ drag: "x" }] })).rejects.toThrow(/\[invalid\].*needs one of/);
    await expect(run({ id: badge.id, steps: [{ wait: 1 }] })).rejects.toThrow(/nothing to try/);
    await expect(run({ id: "missing", steps: [{ wait: 1 }] })).rejects.toThrow(/not_found/);
    for (let index = 0; index < TRIES_PER_TURN; index++) expect(JSON.parse(((await run({ id: page.id, steps: [{ wait: 1 }] })) as { text: string }).text).next).toMatch(/Every step/);
    await expect(run({ id: page.id, steps: [{ wait: 1 }] })).rejects.toThrow(/\[limit\]/);
    // A new turn starts again.
    expect(await run({ id: page.id, steps: [{ wait: 1 }] }, "t2")).toBeTruthy();
  } finally { done(); }
});

test("the look points a page with controls at foundry_try, and plan mode may try", () => {
  const look = { pages: [{ width: 1280, height: 800, issues: [], png: PNG }], errors: [] };
  expect(String(lookReport(look, false).look.next)).toContain("foundry_try");
  expect(String(lookReport(look, true).look.next)).not.toContain("foundry_try");
  expect(PLAN_MODE_TOOL_NAMES.has("foundry_try")).toBe(true);
});
