/// Pass 263 A: every variant explained, and up to five variants as tabs.
import { expect, test } from "bun:test";
import { cleanWalk, walkFor, walkProblem } from "@demesne/protocol";
import { DemesneStore } from "@demesne/storage";
import { foundryEditTool, foundryReadTool, foundrySaveTool } from "../src/foundry.ts";

const part = (name: string, at?: string) => ({ name, says: `${name} does its job.`, ...(at ? { at } : {}) });
const entry = (option: string) => ({ option, what: `${option}, for regulars.`, parts: [part("Grid", ".grid"), part("Key", "#key")], why: "They plan the week.", differs: `${option} is its own shape.`, next: "A weekend row." });
const page = (names: string[]) => `<script src="foundry://kit/parts.js"></script><d-compare recommended="${names[0]}">${names.map((name) => `<section data-option="${name}"><div class="grid">${name}</div><p id="key">k</p></section>`).join("")}</d-compare>`;
const why = (walkthrough: unknown) => ({ direction: "Calm, for a studio.", look_at: "The week.", starts_from: "new", walkthrough });

test("a walkthrough is cleaned: long words cut, empty parts dropped, at most five", () => {
  const walk = cleanWalk([{ option: " Week ", what: "x".repeat(900), parts: [part("A", ".a"), { name: "", says: "no name" }, { name: "B", says: "  spaced   out  " }], why: "w" }, "junk", ...Array.from({ length: 6 }, (_, i) => entry(`V${i}`))])!;
  expect(walk.length).toBe(5);
  expect(walk[0]).toEqual({ option: "Week", what: "x".repeat(500), parts: [{ name: "A", says: "A does its job.", at: ".a" }, { name: "B", says: "spaced out" }], why: "w" });
  expect(cleanWalk([])).toBeUndefined();
  expect(cleanWalk("no")).toBeUndefined();
});

test("each variant finds its own walkthrough, by name or the start of it", () => {
  const walk = cleanWalk([entry("Week grid"), entry("Day view")]);
  expect(walkFor(walk, "Day view")?.option).toBe("Day view");
  expect(walkFor(walk, "week grid")?.option).toBe("Week grid");
  expect(walkFor(cleanWalk([{ option: "B", what: "b", parts: [part("x"), part("y")], why: "y" }]), "B · Yearly first")?.option).toBe("B");
  expect(walkFor(walk, "Compact")).toBeUndefined();
  expect(walkFor(cleanWalk([{ what: "one", parts: [part("x"), part("y")], why: "y" }]), undefined)?.what).toBe("one");
});

test("what a walkthrough lacks is said plainly", () => {
  expect(walkProblem(undefined, [])).toContain("Explain what you made");
  expect(walkProblem(cleanWalk([entry("Week grid")]), ["Week grid", "Day view"])).toContain('no entry for "Day view"');
  expect(walkProblem(cleanWalk([{ ...entry("A"), differs: "" }, entry("B")]), ["A", "B"])).toContain('Say how "A" differs');
  expect(walkProblem(cleanWalk([{ ...entry("A"), parts: [part("x")] }, entry("B")]), ["A", "B"])).toContain("at least two parts");
  // Today is the comparison, never a variant to explain.
  expect(walkProblem(cleanWalk([entry("A"), entry("B")]), ["Today", "A", "B"])).toBe("");
});

test("a mockup saves only with its walkthrough, one per variant, and keeps it", async () => {
  const store = new DemesneStore(":memory:");
  try {
    // Each ask its own chat, so each save is a new version.
    const turn = (text: string) => { const { session } = store.createSession("Schedule"); return { workspaceRoot: "/tmp", signal: new AbortController().signal, sessionId: session.id, turnId: store.createTurn(session.id, text).turn.id }; };
    const save = foundrySaveTool(store), edit = foundryEditTool(store);
    const names = ["Week grid", "Day view", "By teacher", "Compact"];
    const input = { title: "Class schedule", kind: "html", description: "This week's classes, four ways.", source: page(names) };
    const t1 = turn("mock the schedule");
    await expect(save.execute({ ...input, why: why(undefined) }, t1)).rejects.toThrow("Explain what you made");
    await expect(save.execute({ ...input, why: why(names.slice(0, 3).map(entry)) }, t1)).rejects.toThrow('no entry for "Compact"');
    const saved = JSON.parse(await save.execute({ ...input, why: why(names.map(entry)) }, t1));
    expect(saved.message).toContain("hand the work over in full");
    expect(store.listFoundryVersions()[0]!.why?.walk?.map((item) => item.option)).toEqual(names);
    expect(store.listFoundryVersions()[0]!.why?.walk?.[0]?.parts[0]).toEqual({ name: "Grid", says: "Grid does its job.", at: ".grid" });
    // A later ask that changes the words keeps the walkthrough while it still covers the variants…
    const t2 = turn("bigger times");
    await edit.execute({ id: saved.id, base_version: 1, why: why(undefined), edits: [{ find: "k</p>", replace: "key</p>", all: true }] }, t2);
    expect(store.getFoundryArtifact(saved.id)!.versions[0]!.why?.walk?.length).toBe(4);
    // …and asks again when a variant is added.
    const t3 = turn("one more");
    await expect(edit.execute({ id: saved.id, base_version: 2, why: why(undefined), edits: [{ find: "</d-compare>", replace: '<section data-option="Wall chart"><div class="grid">w</div></section></d-compare>' }] }, t3))
      .rejects.toThrow('no entry for "Wall chart"');
    // A why changed without edits keeps the walkthrough too.
    await edit.execute({ id: saved.id, why: { direction: "Warmer.", look_at: "Today." } }, t3);
    expect(store.getFoundryArtifact(saved.id)!.versions[0]!.why).toMatchObject({ direction: "Warmer.", walk: [{ option: "Week grid" }, {}, {}, {}] });
    // Reading it back hands the walkthrough to the model with the rest of the why.
    expect(JSON.stringify(JSON.parse(await foundryReadTool(store).execute({ id: saved.id }, t3)))).toContain("Week grid, for regulars.");
  } finally { store.close(); }
});

test("a drawing and a doc need no walkthrough", async () => {
  const store = new DemesneStore(":memory:");
  try {
    const turn = (text: string) => { const { session } = store.createSession("Other"); return { workspaceRoot: "/tmp", signal: new AbortController().signal, sessionId: session.id, turnId: store.createTurn(session.id, text).turn.id }; };
    const save = foundrySaveTool(store);
    expect(JSON.parse(await save.execute({ title: "Mark", kind: "svg", description: "A mark.", why: { direction: "Warm.", look_at: "The circle.", starts_from: "new" }, source: "<svg/>" }, turn("a logo"))).version).toBe(1);
    expect(JSON.parse(await save.execute({ title: "Brief", kind: "doc", description: "A brief.", source: "# Brief" }, turn("a brief"))).version).toBe(1);
  } finally { store.close(); }
});
