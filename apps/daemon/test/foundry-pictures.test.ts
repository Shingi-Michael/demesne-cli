/// Step 6: a picture from the chat in any mockup, as picture:IMAGE_ID.
import { expect, test } from "bun:test";
import { picturesOf } from "@demesne/protocol";
import { DemesneStore } from "@demesne/storage";
import { PICTURE_RULES, foundryEditTool, foundrySaveTool } from "../src/foundry.ts";

function picture(store: DemesneStore, sessionId: string, turnId: string, id: string) {
  store.recordImageArtifact({ id, kind: "image", sessionId, turnId, toolCallId: `call-${id}`, createdAt: new Date().toISOString(), filename: "logo.png", mimeType: "image/png",
    width: 400, height: 200, byteLength: 1, sha256: "0".repeat(64), source: { kind: "attachment" }, revisionOf: null } as never, `key-${id}`);
  return id;
}
const WALK = [{ what: "A page for a test.", parts: [{ name: "Heading", says: "Says what it is." }, { name: "Body", says: "Holds the rest." }], why: "Kept plain for the test." }];
const W = { direction: "Plain, for a test.", look_at: "The logo.", starts_from: "new", walkthrough: WALK };

test("the pictures a source names, once each, wherever an address goes", () => {
  expect(picturesOf('<img src="picture:logo-1"><div style="background:url(picture:photo_2)"></div><img src="picture:logo-1">')).toEqual(["logo-1", "photo_2"]);
  expect(picturesOf("![Logo](picture:abc) and a picture: of nothing")).toEqual(["abc"]);
  expect(picturesOf("no pictures here")).toEqual([]);
});

test("a mockup shows only pictures this chat has, and keeps them", async () => {
  const store = new DemesneStore(":memory:");
  try {
    const { session } = store.createSession("Pictures");
    const { turn } = store.createTurn(session.id, "make a landing page with my logo");
    const logo = picture(store, session.id, turn.id, "logo-aaa");
    const context = { workspaceRoot: "/tmp", signal: new AbortController().signal, sessionId: session.id, turnId: turn.id };
    const input = (source: string) => ({ title: "Landing", kind: "doc", description: "A landing page with the logo.", source, why: W });
    await expect(foundrySaveTool(store).execute(input("# Hi\n\n![Logo](picture:nope)\n"), context)).rejects.toThrow('"picture:nope" is not a picture this chat has');
    await expect(foundrySaveTool(store).execute(input("# Hi\n\n![Logo](picture:nope)\n"), context)).rejects.toThrow("logo-aaa (logo.png, 400×200)");
    const saved = JSON.parse(await foundrySaveTool(store).execute(input(`# Hi\n\n![Logo](picture:${logo})\n`), context));
    expect(store.getFoundryArtifact(saved.id)!.shots?.map((shot) => shot.id)).toEqual([logo]);
    // Kept with the mockup: an edit from another chat still may show it.
    const other = store.createSession("Other"), later = store.createTurn(other.session.id, "shorter");
    const edited = JSON.parse(await foundryEditTool(store).execute({ id: saved.id, base_version: 1, edits: [{ find: "# Hi", replace: "# Hello" }], note: "shorter" },
      { workspaceRoot: "/tmp", signal: new AbortController().signal, sessionId: other.session.id, turnId: later.turn.id }));
    expect(edited.version).toBe(2);
  } finally { store.close(); }
});

test("the model is told how to use a picture in any kind", () => {
  expect(PICTURE_RULES).toContain("<img src>");
  expect(PICTURE_RULES).toContain("![Logo](picture:IMAGE_ID)");
  expect(PICTURE_RULES).toContain("dropped on a mockup");
  const store = new DemesneStore(":memory:");
  try { expect(foundrySaveTool(store).definition.description).toContain("picture:IMAGE_ID"); } finally { store.close(); }
});
