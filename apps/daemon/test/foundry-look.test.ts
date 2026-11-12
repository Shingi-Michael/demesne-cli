import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DemesneStore } from "@demesne/storage";
import type { StructuredToolResult } from "../src/artifacts.ts";
import { foundryEditTool, foundrySaveTool } from "../src/foundry.ts";
import { designReport, LOOKS_PER_TURN, lookCommand, lookReport, type FoundryLook, type LookResult } from "../src/foundry-look.ts";

/// Why a test page looks the way it does (pass 218 A).
const W = { direction: "Plain, for a test.", look_at: "The heading." };

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64").toString("base64");
const result = (issues: string[] = []): LookResult => ({ pages: [{ width: 1280, height: 900, issues, png: PNG }, { width: 390, height: 2000, issues: [], png: PNG }], errors: [] });
const context = (turnId: string) => ({ workspaceRoot: "/tmp", signal: new AbortController().signal, turnId });

test("the look's command is the app this daemon was bundled in, or the one named", () => {
  const root = mkdtempSync(join(tmpdir(), "demesne-look-"));
  try {
    const backend = join(root, "Demesne.app", "Contents", "Resources", "backend");
    mkdirSync(backend, { recursive: true });
    expect(lookCommand({}, join(backend, "demesned"), "darwin")).toBeNull();
    mkdirSync(join(root, "Demesne.app", "Contents", "MacOS"));
    writeFileSync(join(root, "Demesne.app", "Contents", "MacOS", "Demesne"), "");
    expect(lookCommand({}, join(backend, "demesned"), "darwin")).toEqual([join(backend, "..", "..", "MacOS", "Demesne")]);
    expect(lookCommand({ DEMESNE_FOUNDRY_LOOK: "0" }, join(backend, "demesned"), "darwin")).toBeNull();
    expect(lookCommand({ DEMESNE_ELECTRON: "/e", DEMESNE_ELECTRON_APP: "/app" }, "/bin/bun", "linux")).toEqual(["/e", "/app"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the report names each width's problems and says what to do next", () => {
  const found = lookReport(result(["Text spills out of its box: button \"Today\""]), false);
  expect(found.look["desktop 1280px"]).toEqual(["Text spills out of its box: button \"Today\""]);
  expect(found.look["phone 390px"]).toBe("no layout problems found");
  expect(String(found.look.next)).toContain("one foundry_edit");
  expect(found.images.map((image) => image.filename)).toEqual(["foundry-look-1280.png", "foundry-look-390.png"]);
  expect(String(lookReport(result(), false).look.next)).toContain("without saving again");
  expect(String(lookReport(result(["x"]), true).look.next)).toContain("last look");
});

test("a saved HTML page comes back with its look, twice per turn at most; SVG goes without", async () => {
  const store = new DemesneStore(":memory:");
  const seen: string[] = [];
  const look: FoundryLook = async (page) => { seen.push(page.source); return result(seen.length === 1 ? ["Scrolls sideways by 120px at 390px wide"] : []); };
  try {
    const looks = new Map<string, number>();
    const save = foundrySaveTool(store, look, looks), edit = foundryEditTool(store, look, looks);
    const first = await save.executeWithArtifacts!({ kind: "html", title: "Garden plan", description: "A test page.", why: W, source: "<main>plan</main>" }, context("t1")) as StructuredToolResult;
    const saved = JSON.parse(first.text);
    expect(saved.version).toBe(1);
    expect(saved.look["desktop 1280px"]).toEqual(["Scrolls sideways by 120px at 390px wide"]);
    expect(first.images).toHaveLength(2);
    // A fix after a look that found problems says what it fixes first, by rule (step 3).
    await expect(edit.executeWithArtifacts!({ id: saved.id, base_version: 1, edits: [{ find: "plan", replace: "plan!" }] }, context("t1"))).rejects.toThrow("Critique before you fix");
    await expect(save.executeWithArtifacts!({ id: saved.id, base_version: 1, source: "<main>plan!</main>" }, context("t1"))).rejects.toThrow("fix it with foundry_edit");
    const fixed = await edit.executeWithArtifacts!({ id: saved.id, base_version: 1, why: W, critique: "Rule 11: it scrolls sideways at phone width; I will let the row wrap.", edits: [{ find: "plan", replace: "plan!" }] }, context("t1")) as StructuredToolResult;
    expect(seen.at(-1)).toBe("<main>plan!</main>");
    expect(String(JSON.parse(fixed.text).look.next)).toContain("last look");
    // Its own fixes stay in version 1 (pass 197 A: one ask, one version).
    expect(JSON.parse(fixed.text).version).toBe(1);
    const third = await edit.executeWithArtifacts!({ id: saved.id, base_version: 1, why: W, edits: [{ find: "plan!", replace: "plan?" }] }, context("t1"));
    expect(typeof third).toBe("string");
    expect(JSON.parse(third as string).look).toBeUndefined();
    // A new turn looks again.
    const next = await edit.executeWithArtifacts!({ id: saved.id, base_version: 1, why: W, edits: [{ find: "plan?", replace: "plan." }] }, context("t2"));
    expect(typeof next).toBe("object");
    expect(JSON.parse((next as StructuredToolResult).text).version).toBe(2);
    const svg = await save.executeWithArtifacts!({ kind: "svg", title: "Mark", description: "A test page.", recommended: true, why: W, source: "<svg viewBox=\"0 0 1 1\"/>" }, context("t1"));
    expect(typeof svg).toBe("string");
    expect(seen).toHaveLength(3);
  } finally { store.close(); }
});

test("a page saves as before when the look can't run", async () => {
  const store = new DemesneStore(":memory:");
  try {
    const save = foundrySaveTool(store, async () => null);
    const saved = await save.executeWithArtifacts!({ kind: "html", title: "Plain", description: "A test page.", why: W, source: "<p>hi</p>" }, context("t1"));
    expect(typeof saved).toBe("string");
    expect(JSON.parse(saved as string).version).toBe(1);
    expect(LOOKS_PER_TURN).toBe(2);
  } finally { store.close(); }
});

test("a model that sees gets the look's pictures in its next round, even without tool pictures switched on", async () => {
  const { createDaemonApp } = await import("../src/app.ts");
  const sharp = (await import("sharp")).default;
  const png = (await sharp({ create: { width: 40, height: 30, channels: 3, background: "white" } }).png().toBuffer()).toString("base64");
  const root = mkdtempSync(join(tmpdir(), "demesne-look-loop-"));
  let round = 0, pictures = 0, said = "";
  const finished = Promise.withResolvers<void>();
  const app = createDaemonApp({ databasePath: join(root, "state.sqlite"), heartbeat: { enabled: false },
    foundryLook: async () => ({ pages: [{ width: 1280, height: 800, issues: ["Text cut off in h1"], png }, { width: 390, height: 900, issues: [], png }], errors: [] }),
    processor: { providerId: "test", modelId: "look-test", vision: true, contextCapacity: 32768, maxOutputTokens: 1024, async listModels() { return []; },
      async *stream(messages) {
        if (++round === 1) { yield { type: "tool_call_delta" as const, index: 0, idDelta: "save", nameDelta: "foundry_save", argumentsDelta: JSON.stringify({ kind: "html", title: "Garden plan", description: "A test page.", why: W, source: "<h1>Garden</h1>" }) }; return; }
        pictures = messages.flatMap((message) => message.imageInputs ?? []).length;
        said = String(messages.findLast((message) => message.role === "tool")?.content);
        yield { type: "text_delta" as const, delta: "Looked" }; finished.resolve();
      } } });
  const post = (path: string, body: unknown) => app.fetch(new Request(`http://localhost${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  try {
    const { session } = await (await post("/v1/sessions", { title: "Look", plain: true })).json();
    await post(`/v1/sessions/${session.id}/turns`, { content: "Mock up a garden plan" });
    await finished.promise;
    expect(said).toContain("Text cut off in h1");
    expect(pictures).toBe(2);
  } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
});

test("the model sees its page's design numbers against targets, by the guide's rule (step 3)", () => {
  const design = { sizes: 9, body: 14, lead: 1.6, rhythm: 0.93, aligned: 0.9, colours: 5, surface: 0.1 };
  const { off, ok } = designReport(design);
  expect(off).toEqual([
    "rule 3: 9 text sizes; aim for 3 to 6 from the kit's scale",
    "rule 2: the biggest text is 1.6x the body; one thing should lead at 2.8x or more",
    "rule 8: 10% of the first screen is more than blank paper; aim for a third or more",
  ]);
  expect(ok).toHaveLength(3);
  expect(designReport(undefined)).toEqual({ off: [], ok: [] });
  // Only the desktop picture's numbers count; numbers off target make it a page to critique and fix.
  const looked: LookResult = { pages: [{ width: 1280, height: 900, issues: [], png: PNG, design }, { width: 390, height: 900, issues: [], png: PNG, design: { ...design, sizes: 4 } }], errors: [] };
  const report = lookReport(looked, false);
  expect(report.found).toBe(true);
  expect((report.look.design as { off_target: string[] }).off_target).toHaveLength(3);
  expect(String(report.look.next)).toContain("Critique before you fix");
  expect(String(report.look.next)).toContain("never repeat it to the person");
  // The critique runs in a fixed order, marks severity and keeps what works.
  for (const words of ["1 first impression", "2 usability", "3 hierarchy", "4 consistency", "5 accessibility", "critical, moderate or minor", "one thing that works and must stay"]) expect(String(report.look.next)).toContain(words);
  // On target, nothing is owed; the last look owes nothing either.
  const fine = { sizes: 4, body: 14, lead: 3.4, rhythm: 0.95, aligned: 0.9, colours: 5, surface: 0.5 };
  expect(lookReport({ pages: [{ width: 1280, height: 900, issues: [], png: PNG, design: fine }], errors: [] }, false).found).toBe(false);
  expect(lookReport(looked, true).found).toBe(false);
  // Demesne draws the ready kinds, so a deck's numbers judge nothing.
  expect(lookReport(looked, false, false).look.design).toBeUndefined();
  expect(lookReport(looked, false, false).found).toBe(false);
});
