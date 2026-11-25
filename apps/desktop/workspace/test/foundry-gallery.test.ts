/// Pass 273 A: Foundry's front page, a card for everything made, pinned first.
import { expect, test } from "bun:test";
import type { FoundryArtifact, FoundryShelfVersion } from "@demesne/protocol";
import { ago, galleryGrid, galleryItems, galleryPage, pageHead, projectName, thumbHTML, type GalleryView } from "../foundry-gallery.ts";
import { foundryPage } from "../foundry-page.ts";

const at = (hours: number) => new Date(Date.parse("2026-11-24T20:00:00Z") - hours * 3_600_000).toISOString();
const item = (id: string, title: string, kind: FoundryArtifact["kind"], workspace: string | null, hours: number, description = ""): FoundryArtifact =>
  ({ id, title, kind, workspace, sessionId: `s-${id}`, createdAt: at(hours), updatedAt: at(hours), version: 1, description, basedOn: null });
const list = [
  item("plans", "Plans page", "html", "/work/slow-pour", 2, "Monthly, yearly and gift plans"),
  item("soil", "Soil samples", "markdown", "/work/soil-lab", 3),
  item("orders", "Weekly orders", "dashboard", "/work/slow-pour", 30),
  item("flow", "Booking flow", "mermaid", null, 5),
];
const versions: FoundryShelfVersion[] = list.map((one) => ({ artifactId: one.id, version: 1, createdAt: one.updatedAt, sessionId: one.sessionId, note: "" }));
const view = (gallery: Partial<GalleryView["gallery"]> = {}, more: Partial<GalleryView> = {}): GalleryView => ({
  list, versions, gallery: { query: "", filter: "all", one: null, ...gallery }, here: "/work/slow-pour", pins: [], shared: new Set(), chatTitle: (id) => id === "s-flow" ? "Clinic booking" : null, now: Date.parse("2026-11-24T20:00:00Z"), ...more });
const titles = (items: FoundryArtifact[]) => items.map((one) => one.title);

test("everything made, newest first, with the pinned ones on top in the order pinned", () => {
  expect(titles(galleryItems(view()).rest)).toEqual(["Plans page", "Soil samples", "Booking flow", "Weekly orders"]);
  const pinned = galleryItems(view({}, { pins: ["orders", "flow"] }));
  expect(titles(pinned.pinned)).toEqual(["Weekly orders", "Booking flow"]);
  expect(titles(pinned.rest)).toEqual(["Plans page", "Soil samples"]);
});

test("the filters: this project, pinned, shared", () => {
  expect(titles(galleryItems(view({ filter: "here" })).rest)).toEqual(["Plans page", "Weekly orders"]);
  expect(titles(galleryItems(view({ filter: "pinned" }, { pins: ["soil"] })).pinned)).toEqual(["Soil samples"]);
  expect(titles(galleryItems(view({ filter: "shared" }, { shared: new Set(["flow"]) })).rest)).toEqual(["Booking flow"]);
  expect(galleryItems(view({ filter: "here" }, { here: null })).rest.map((one) => one.id)).toEqual(["flow"]);
});

test("the search reads the name, description, kind, project and chat, and what the daemon found on the pages", () => {
  expect(titles(galleryItems(view({ query: "gift" })).rest)).toEqual(["Plans page"]);
  expect(titles(galleryItems(view({ query: "soil lab" })).rest)).toEqual(["Soil samples"]);
  expect(titles(galleryItems(view({ query: "dashboard" })).rest)).toEqual(["Weekly orders"]);
  expect(titles(galleryItems(view({ query: "clinic" })).rest)).toEqual(["Booking flow"]);
  expect(titles(galleryItems(view({ query: "nitrogen" }, { found: new Set(["soil"]) })).rest)).toEqual(["Soil samples"]);
});

test("the front page: search, four filters, a card per mockup with its pin and a button that opens it", () => {
  const html = galleryPage(view({}, { pins: ["plans"], shared: new Set(["plans"]) }));
  expect(html).toContain('id="fg-q"');
  expect(html.match(/class="fg-chip[ "]/g)?.length).toBe(4);
  expect(html).toContain('<h2 class="fg-group">Pinned</h2>');
  expect(html).toContain('<h2 class="fg-group">Recent</h2>');
  expect(html.match(/class="fg-card/g)?.length).toBe(4);
  expect(html).toContain("Prototype · slow-pour · 2h ago · Shared");
  expect(html).toContain('data-action="foundry-one" data-args="{&quot;id&quot;:&quot;plans&quot;}"');
  expect(html).toContain('aria-label="Unpin Plans page"');
  expect(html).toContain("Diagram · Just a chat");
});

test("an empty filter or search says so", () => {
  expect(galleryGrid(view({ filter: "pinned" }))).toContain("Nothing pinned yet");
  expect(galleryGrid(view({ query: "zebra" }))).toContain("Nothing matches “zebra”.");
  expect(galleryGrid(view({ filter: "shared", query: "zebra" }))).toContain("Nothing shared matches");
  expect(galleryPage(view({}, { list: [] }))).toContain("Nothing made yet");
});

test("a card's picture is the newest page, drawn small with no demo or input; a document shows its words", () => {
  const frame = thumbHTML(list[0]!, list[0]!.updatedAt);
  expect(frame).toContain("foundry://artifact/plans?v=1&amp;at=");
  expect(frame).not.toContain("stack=1");
  expect(frame).toContain("inert");
  expect(thumbHTML(list[1]!, list[1]!.updatedAt)).toContain('class="fd-doc markdown fg-doc" data-md="soil:1"');
});

test("opened from the front page, the long page keeps every mockup under the line back", () => {
  const html = foundryPage({ list, versions, error: "", chatTitle: () => null, head: pageHead() });
  expect(html).toContain('data-action="foundry-home"');
  expect(html).not.toContain(">Foundry</h1>");
  expect(html.match(/class="fd-item/g)?.length).toBe(versions.length);
  expect(html).toContain('data-fd="plans:1"');
});

test("small words", () => {
  const now = Date.parse("2026-11-24T20:00:00Z");
  expect(ago(at(0), now)).toBe("Just now");
  expect(ago(new Date(now - 12 * 60_000).toISOString(), now)).toBe("12 min ago");
  expect(ago(at(3), now)).toBe("3h ago");
  expect(projectName("/Users/me/work/slow-pour/")).toBe("slow-pour");
  expect(projectName(null)).toBe("Just a chat");
});

test("step 2: a row of kinds over the cards, each starting a new chat with its words, named for the project", async () => {
  const { makeRow, MAKE_KINDS } = await import("../foundry-gallery.ts");
  const row = makeRow("/work/slow-pour");
  expect(row).toContain("Make something new in slow-pour");
  expect(row.match(/class="fg-mk"/g)?.length).toBe(MAKE_KINDS.length);
  expect(row).toContain('data-action="foundry-make" data-args="{&quot;kind&quot;:&quot;deck&quot;}"');
  expect(makeRow(null)).toContain("Make something new</span>");
  expect(MAKE_KINDS.every((one) => one.start.startsWith("/foundry Make a"))).toBe(true);
  expect(galleryPage(view())).toContain('class="fg-make"');
  expect(galleryPage(view({}, { list: [] }))).toContain('class="fg-make"');
});

test("piece 1 of pass 274: the project's look is one quiet line under the make row, with nothing to press", async () => {
  const { lookLine } = await import("../foundry-gallery.ts");
  const look = { from: ["tailwind.config.ts", "src/app/globals.css"], colors: [{ name: "primary", value: "#0f766e" }, { name: "paper", value: "#fbfaf7" }], fonts: ["Georgia", "Inter"], corners: ["10px"], components: ["Button"], componentCount: 14, kit: "shadcn/ui" };
  const line = lookLine("/work/harbor-clinic", look);
  expect(line).toContain("harbor-clinic’s look");
  expect(line).toContain('<i style="background:#0f766e" title="primary #0f766e"></i>');
  expect(line).toContain("<span>Georgia and Inter</span><span>10px corners</span><span>14 components</span><span>shadcn/ui</span>");
  expect(line).toContain("read from tailwind.config.ts and src/app/globals.css");
  expect(line).not.toContain("<button");
  expect(lookLine("/work/harbor-clinic", null)).toBe("");
  expect(lookLine(null, look)).toBe("");
  expect(galleryPage({ ...view(), here: "/work/harbor-clinic", look })).toContain('class="fg-look"');
  expect(galleryPage(view())).not.toContain('class="fg-look"');
});
