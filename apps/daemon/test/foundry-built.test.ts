import { expect, test } from "bun:test";
import sharp from "sharp";
import { builtOf, optionNames, pickOption } from "@demesne/protocol";
import { DemesneStore } from "@demesne/storage";
import { foundryBuiltTool } from "../src/foundry-built.ts";
import { foundryEditTool, foundryReadTool, foundrySaveTool } from "../src/foundry.ts";
import type { FoundryLook } from "../src/foundry-look.ts";
import type { StructuredToolResult } from "../src/artifacts.ts";

/// A look at what was built: a 1280×800 page at 960 pixels wide, like look_at_page's.
function looked(store: DemesneStore, sessionId: string, turnId: string, id: string) {
  store.recordImageArtifact({ id, kind: "image", sessionId, turnId, toolCallId: `call-${id}`, createdAt: new Date().toISOString(), filename: "page-look-1.png", mimeType: "image/png",
    width: 960, height: 600, byteLength: 1, sha256: "0".repeat(64), source: { kind: "tool", name: "look_at_page", modelId: null }, revisionOf: null }, `key-${id}`);
  return id;
}

const PLANS = `<link rel="stylesheet" href="foundry://kit/base.css"><script src="foundry://kit/parts.js"></script>
<d-compare recommended="Yearly"><section data-option="Yearly first">Yearly</section><section data-option="Monthly first">Monthly</section></d-compare>`;

async function setup() {
  const store = new DemesneStore(":memory:");
  const png = (await sharp({ create: { width: 960, height: 600, channels: 3, background: "#f4f1ea" } }).png().toBuffer()).toString("base64");
  const asked: { option?: number }[] = [];
  const look: FoundryLook = async (page) => { asked.push({ ...(page.option !== undefined ? { option: page.option } : {}) }); return { pages: [{ width: 1280, height: 800, issues: [], png }], errors: [] }; };
  const { session } = store.createSession("Slow Pour", "/tmp");
  let open: string | null = null;
  const turn = (content: string) => { if (open) store.completeTurn(open); const { turn } = store.createTurn(session.id, content); open = turn.id; store.startTurn(turn.id); return { workspaceRoot: "/tmp", signal: new AbortController().signal, sessionId: session.id, turnId: turn.id }; };
  const made = turn("Show me the plans page");
  const mockup = store.saveFoundryArtifact({ kind: "html", title: "Plans page", source: PLANS, sessionId: session.id, turnId: made.turnId, description: "Two ways to open the plans." });
  return { store, look, asked, session, turn, mockup };
}

const run = (tool: ReturnType<typeof foundryBuiltTool>, input: unknown, context: object) => tool.executeWithArtifacts!(input, context as never) as Promise<StructuredToolResult>;

test("a mockup's options are its d-compare sections, and a short name picks one", () => {
  const names = optionNames(`${PLANS}<d-compare><section data-option="Today">x</section></d-compare>`);
  expect(names).toEqual(["Yearly first", "Monthly first", "Today"]);
  expect(pickOption(names, "yearly")).toBe(0);
  expect(pickOption(names, "Monthly first")).toBe(1);
  expect(pickOption(names, "today")).toBe(-1);
  expect(pickOption(names, "weekly")).toBe(-1);
  expect(optionNames('<d-review><section data-option="Fewer">x</section></d-review>')).toEqual([]);
});

test("foundry_built shows the pick beside the build, then records each look on one record", async () => {
  const { store, look, asked, turn, mockup } = await setup();
  try {
    const tool = foundryBuiltTool(store, look);
    const build = turn("build Yearly first");
    const first = looked(store, build.sessionId, build.turnId, "look-1");
    // Two options and none named: which one was built?
    await expect(run(tool, { id: mockup.id, picture: first, where: "localhost:5173/pricing" }, build)).rejects.toThrow(/built_option.*"Yearly first", "Monthly first"/);
    await expect(run(tool, { id: mockup.id, option: "Yearly", picture: "nope", where: "localhost:5173/pricing" }, build)).rejects.toThrow(/built_picture.*look-1/);

    // No differences yet: the pick, drawn alone (option 0), beside the build. Nothing is recorded.
    const shown = await run(tool, { id: mockup.id, option: "Yearly", picture: first, where: "localhost:5173/pricing" }, build);
    expect(asked).toEqual([{ option: 0 }]);
    expect(JSON.parse(shown.text).next).toMatch(/Compare the two pictures/);
    expect(shown.images[0]!.filename).toBe("foundry-look-pick.png");
    expect(store.foundryBuiltFor(mockup.id)).toBeNull();

    // Too many, and outside the picture: refused.
    await expect(run(tool, { id: mockup.id, option: "Yearly", picture: first, where: "localhost:5173/pricing",
      differences: [1, 2, 3, 4].map((n) => ({ box: `${n},0,10,10`, what: "Off" })) }, build)).rejects.toThrow(/too_many.*more/);
    await expect(run(tool, { id: mockup.id, option: "Yearly", picture: first, where: "localhost:5173/pricing",
      differences: [{ box: "900,500,200,200", what: "Off" }] }, build)).rejects.toThrow(/outside the picture, which is 960×600/);

    // The first look: two differences, ringed on the record.
    const one = JSON.parse((await run(tool, { id: mockup.id, option: "Yearly", picture: first, where: "localhost:5173/pricing", more: 1,
      differences: [{ box: "26,86,200,40", what: "Opens on Monthly; the pick opens on Yearly." }, { box: "200,128,170,166", what: "Daily is plain; the pick edges it." }] }, build)).text);
    expect(one).toMatchObject({ title: "Plans page, built", built: true, verdict: "3 still differ", looks: 1 });
    expect(asked.length).toBe(1);
    const record = store.getFoundryArtifact(one.id)!;
    expect(record).toMatchObject({ built: true, basedOn: { id: mockup.id, version: 1 } });
    expect(record.versions[0]!.note).toBe("3 still differ");
    expect(record.versions[0]!.stage?.surface).toEqual({ frame: "page" });
    expect(record.source).toContain('marks="26,86,200,40 | 200,128,170,166"');
    expect(record.source).toContain("And 1 smaller difference.");
    // The build's picture and the pick are kept with the record.
    expect(record.shots?.map((shot) => shot.id)).toContain(first);
    expect(record.shots?.length).toBe(2);

    // Fixed, looked at again: the same record, now with both looks.
    const second = looked(store, build.sessionId, build.turnId, "look-2");
    const two = JSON.parse((await run(tool, { id: mockup.id, option: "Yearly first", picture: second, where: "localhost:5173/pricing", differences: [] }, build)).text);
    expect(two).toMatchObject({ id: one.id, version: 1, verdict: "matches", looks: 2 });
    expect(two.message).toMatch(/built like the mockup/);
    const after = store.getFoundryArtifact(one.id)!;
    expect(after.versions.length).toBe(1);
    expect(after.versions[0]!.note).toBe("matches");
    expect(after.source).toContain("matches your pick");
    expect(after.source).toContain("Built, first look");
    expect(after.source).toContain("<s>fixed</s>");
    expect(builtOf(after.source)!.looks.map((item) => item.picture)).toEqual([first, second]);

    // A third look is the last; a fourth is refused.
    await run(tool, { id: mockup.id, option: "Yearly", picture: second, where: "localhost:5173/pricing", differences: [] }, build);
    await expect(run(tool, { id: mockup.id, option: "Yearly", picture: second, where: "localhost:5173/pricing", differences: [] }, build)).rejects.toThrow(/limit/);

    // A later build is a new version of the same record.
    const again = turn("build it again");
    const third = looked(store, again.sessionId, again.turnId, "look-3");
    const next = JSON.parse((await run(tool, { id: mockup.id, option: "Monthly", picture: third, where: "localhost:5173/pricing", differences: [] }, again)).text);
    expect(next).toMatchObject({ id: one.id, version: 2, option: "Monthly first", verdict: "matches" });
    expect(asked.at(-1)).toEqual({ option: 1 });
  } finally { store.close(); }
});

test("a build's record is Demesne's: it is never edited or written by hand", async () => {
  const { store, look, turn, mockup } = await setup();
  try {
    const build = turn("build Yearly first");
    const shot = looked(store, build.sessionId, build.turnId, "look-1");
    const made = JSON.parse((await run(foundryBuiltTool(store, look), { id: mockup.id, option: "Yearly", picture: shot, where: "localhost:5173/pricing", differences: [] }, build)).text);
    await expect(foundryEditTool(store).execute({ id: made.id, base_version: 1, edits: [{ find: "Built", replace: "Made" }] }, build as never)).rejects.toThrow(/\[built\].*foundry_built/);
    await expect(foundrySaveTool(store).execute({ kind: "html", title: "Fake record", description: "A record.", source: "<d-built></d-built>",
      why: { direction: "x", look_at: "y", starts_from: "new" } }, build as never)).rejects.toThrow(/\[built\]/);
    // Built from a build: pass the mockup instead.
    await expect(run(foundryBuiltTool(store, look), { id: made.id, picture: shot, where: "x", differences: [] }, build)).rejects.toThrow(new RegExp(`built.*${mockup.id}`));
    // Reading the mockup says to check a build; reading the record says what it is.
    const read = JSON.parse(await foundryReadTool(store).execute({ id: mockup.id }, build as never));
    expect(read.if_you_build_it).toMatch(/foundry_built/);
    expect(JSON.parse(await foundryReadTool(store).execute({ id: made.id }, build as never)).built).toMatch(/record of a build/);
  } finally { store.close(); }
});

test("without the app that draws, the build is still recorded, with the pick named", async () => {
  const { store, turn, mockup } = await setup();
  try {
    const build = turn("build Yearly first");
    const shot = looked(store, build.sessionId, build.turnId, "look-1");
    const made = JSON.parse((await run(foundryBuiltTool(store), { id: mockup.id, option: "Yearly", picture: shot, where: "Slow Pour window", differences: [] }, build)).text);
    const record = store.getFoundryArtifact(made.id)!;
    expect(record.source).toContain("Foundry could not draw the pick here.");
    expect(builtOf(record.source)!.pick).toBeNull();
  } finally { store.close(); }
});
