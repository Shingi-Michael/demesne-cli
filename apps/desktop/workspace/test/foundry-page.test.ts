import { expect, test } from "bun:test";
import type { FoundryArtifact } from "@demesne/protocol";
import { foundryPage, openHead, savedLine, shelfKey, stageHTML, wipeHTML } from "../foundry-page.ts";

const artifact = (id: string, title: string, kind: FoundryArtifact["kind"] = "html"): FoundryArtifact =>
  ({ id, title, kind, workspace: null, sessionId: "s1", createdAt: "2026-11-07T10:00:00Z", updatedAt: "2026-11-08T10:00:00Z", version: 2, description: "", basedOn: null });
const now = new Date();
const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9).toISOString();
const earlier = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 9).toISOString();

test("Foundry is one long page: every version, newest first, under its day, at real size", () => {
  const html = foundryPage({
    list: [artifact("a1", "Coffee pricing"), artifact("b2", "Brief", "markdown")],
    versions: [
      { artifactId: "a1", version: 2, createdAt: today, sessionId: "s1", note: "Blue" },
      { artifactId: "b2", version: 1, createdAt: today, sessionId: null, note: "" },
      { artifactId: "a1", version: 1, createdAt: earlier, sessionId: "s1", note: "" },
      { artifactId: "gone", version: 1, createdAt: earlier, sessionId: null, note: "" },
    ],
    error: "",
    chatTitle: (id) => id === "s1" ? "Pricing page" : null,
  });
  // Two days, the newest first.
  expect(html.match(/class="fd-day"/g)?.length).toBe(2);
  expect(html.indexOf(">Today<")).toBeLessThan(html.indexOf(">Yesterday<"));
  expect(html).not.toContain("fd-days");
  // Each version once, its line and its page; a deleted artifact's versions drop out.
  expect(html.match(/class="fd-item"/g)?.length).toBe(3);
  expect(html).toContain(`data-fd="${shelfKey("a1", 2)}"`);
  expect(html).toMatch(/from <button[^>]*data-action="select-session"[^>]*>“Pricing page”<\/button>/);
  expect(html).toContain("<b>v2 · Blue</b>");
  expect(html).toContain("foundry://artifact/a1?v=1&amp;stack=1");
  expect(html).toContain('loading="lazy"');
  // A document renders through the sanitizer once it scrolls near.
  expect(html).toContain(`data-md="${shelfKey("b2", 1)}"`);
  // Nothing to press on a mockup: only links to where it came from.
  expect(html).not.toMatch(/<button[^>]*data-action="foundry-(version|close|delete|export)/);
});

test("an empty Foundry says how mockups get there", () => {
  expect(foundryPage({ list: [], versions: [], error: "", chatTitle: () => null })).toContain("Nothing made yet");
  expect(foundryPage({ list: null, versions: null, error: "", chatTitle: () => null })).toContain("Reading Foundry");
});

test("a mockup shows its description, its version's name and what it was based on (pass 208 A)", () => {
  const html = foundryPage({
    list: [{ ...artifact("a1", "Roaster pricing"), description: "Three plans. Try the yearly switch." }, { ...artifact("p2", "Roaster pricing, phone"), basedOn: { id: "a1", version: 2 } }],
    versions: [{ artifactId: "p2", version: 1, createdAt: today, sessionId: null, note: "First take" }],
    error: "",
    chatTitle: () => null,
  });
  expect(html).not.toContain("Three plans");
  expect(html).toContain("<b>v1 · First take</b>");
  expect(html).toMatch(/based on <button[^>]*data-action="foundry-open"[^>]*>Roaster pricing v2<\/button>/);
  expect(html).toContain('data-args="{&quot;id&quot;:&quot;a1&quot;,&quot;version&quot;:2}"');
});

test("what one ask made sits together, the one it would use first and marked (pass 208 A)", () => {
  const list = [{ ...artifact("calm", "Calm"), description: "Quiet." }, artifact("bold", "Bold"), artifact("old", "Old")];
  const versions = [
    { artifactId: "calm", version: 1, createdAt: today, sessionId: "s1", turnId: "t1", note: "", recommended: false },
    { artifactId: "bold", version: 1, createdAt: today, sessionId: "s1", turnId: "t1", note: "", recommended: true },
    { artifactId: "old", version: 3, createdAt: today, sessionId: "s1", turnId: "t0", note: "", recommended: true },
  ];
  const html = foundryPage({ list, versions, error: "", chatTitle: () => null });
  expect(html.indexOf('data-fd="bold:1"')).toBeLessThan(html.indexOf('data-fd="calm:1"'));
  expect(html).toContain("<p class=\"fd-desc\">Quiet.</p>");
  // Only where one ask made several does the pick show.
  expect(html.match(/fd-rec-pill/g)?.length).toBe(1);
  expect(html).toMatch(/class="fd-item fd-rec" data-fd="bold:1"/);
});

test("each version says why it looks the way it does, quietly under the description (pass 218 A)", () => {
  const html = foundryPage({
    list: [{ ...artifact("a1", "Roastery pricing"), description: "Three plans." }],
    versions: [
      { artifactId: "a1", version: 2, createdAt: today, sessionId: null, note: "Middle leads", why: { direction: "Warm paper & a serif.", look: "The dark middle plan.", dropped: "" } },
      { artifactId: "a1", version: 1, createdAt: today, sessionId: null, note: "" },
    ],
    error: "",
    chatTitle: () => null,
  });
  // Direction and what to look at; a line with nothing dropped is left out, and so is a version saved before.
  expect(html.match(/class="fd-why"/g)?.length).toBe(1);
  expect(html).toContain("<dt>Direction</dt><dd>Warm paper &amp; a serif.</dd><dt>Look at</dt><dd>The dark middle plan.</dd></dl>");
  expect(html).not.toContain("<dt>Dropped</dt>");
  expect(html.indexOf("fd-desc")).toBeLessThan(html.indexOf("fd-why"));
  expect(html.indexOf("fd-why")).toBeLessThan(html.indexOf("fd-ver"));
});

test("a version that follows what you liked before says so in a fourth quiet line (pass 245 A)", () => {
  const page = (followed: string) => foundryPage({
    list: [{ ...artifact("a1", "Checkout page"), description: "The last step." }],
    versions: [{ artifactId: "a1", version: 1, createdAt: today, sessionId: null, note: "", why: { direction: "Warm paper.", look: "The total.", dropped: "A coupon box.", followed } }],
    error: "",
    chatTitle: () => null,
  });
  expect(page("Serif headings; one accent, on Pay only")).toContain("<dt>Dropped</dt><dd>A coupon box.</dd><dt>Your taste</dt><dd>Serif headings; one accent, on Pay only</dd></dl>");
  // Nothing learned applied: no line, never an empty one.
  for (const none of ["none", "None apply here.", ""]) expect(page(none)).not.toContain("Your taste");
});

test("a version quotes the ask that made it, and says which merged pull request built it (pass 219 A)", () => {
  const prOpened = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 10).toISOString();
  const later = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 11).toISOString();
  const long = `Make the middle plan the obvious choice, ${"and keep it calm ".repeat(12)}please`;
  const html = foundryPage({
    list: [artifact("a1", "Roastery pricing"), artifact("p2", "Roastery pricing, phone"), artifact("o3", "Opening hours")],
    versions: [
      { artifactId: "p2", version: 1, createdAt: later, sessionId: "s1", note: "", ask: "Now show me the pricing on a phone" },
      { artifactId: "a1", version: 2, createdAt: today, sessionId: "s1", note: "", ask: long },
      { artifactId: "a1", version: 1, createdAt: earlier, sessionId: "s1", note: "" },
      { artifactId: "o3", version: 1, createdAt: today, sessionId: "s2", note: "", ask: "Hours <card>" },
    ],
    error: "",
    chatTitle: () => null,
    builtIn: (id) => id === "s1" ? { number: 622, createdAt: prOpened } : null,
  });
  expect(html).toContain('<p class="fd-ask">You asked <q title="Now show me the pricing on a phone">Now show me the pricing on a phone</q></p>');
  // A long ask is cut on the page and whole on hover; it is escaped.
  expect(html).toContain(`title="${long}"`);
  expect(html).toMatch(/<q title="[^"]+">Make the middle plan[^<]{100,160}…<\/q>/);
  expect(html).toContain("Hours &lt;card&gt;");
  // Built: only the newest version of each mockup the chat made before it opened the pull request.
  expect(html.match(/class="fd-built"/g)?.length).toBe(1);
  expect(html).toMatch(/data-fd="a1:2"[\s\S]*?built in <button[^>]*data-action="pr-github"[^>]*data-args="\{&quot;id&quot;:&quot;s1&quot;\}"[^>]*>#622<\/button>/);
  expect(html.slice(html.indexOf('data-fd="p2:1"'), html.indexOf('data-fd="a1:2"'))).not.toContain("fd-built");
  // Older versions saved before asks were kept show no line.
  expect(html.match(/class="fd-ask"/g)?.length).toBe(3);
});

test("the newest version of a page can take notes, and a version made from notes shows what changed (pass 233 A)", () => {
  const html = foundryPage({
    list: [artifact("a1", "Coffee pricing"), artifact("b2", "Brief", "markdown"), artifact("c3", "Badge", "svg")],
    versions: [
      { artifactId: "a1", version: 2, createdAt: today, sessionId: "s1", note: "Blue" },
      { artifactId: "a1", version: 1, createdAt: earlier, sessionId: "s1", note: "" },
      { artifactId: "b2", version: 2, createdAt: today, sessionId: null, note: "" },
      { artifactId: "c3", version: 2, createdAt: today, sessionId: null, note: "" },
    ],
    error: "", chatTitle: () => null, changed: new Set([shelfKey("a1", 2)]),
  });
  const section = (key: string) => html.slice(html.indexOf(`data-fd="${key}"`)).split("</section>")[0]!;
  // The line that says notes wait is there, empty and hidden, only under the newest version of a page with parts.
  expect(section(shelfKey("a1", 2))).toContain('<p class="fd-notes" aria-live="polite" hidden></p>');
  expect(section(shelfKey("a1", 1))).not.toContain("fd-notes");
  expect(section(shelfKey("b2", 2))).not.toContain("fd-notes");
  expect(section(shelfKey("c3", 2))).not.toContain("fd-notes");
  // At rest nothing new shows: no button, no field.
  expect(section(shelfKey("a1", 2))).not.toMatch(/fn-|<input|<form/);
  // The version the notes made outlines what changed, once.
  expect(section(shelfKey("a1", 2))).toMatch(/v=2&amp;stack=1&amp;at=\d+&amp;first=1"/);
  expect(section(shelfKey("a1", 1))).not.toContain("first=1");
});

test("pass 262 C: the mockup you open grows where it sits, with a quiet head line, and only that one", () => {
  const view = {
    list: [artifact("a1", "Orders board"), artifact("b2", "Menu")],
    versions: [
      { artifactId: "a1", version: 2, createdAt: today, sessionId: "s1", note: "Timers" },
      { artifactId: "b2", version: 2, createdAt: today, sessionId: null, note: "" },
      { artifactId: "a1", version: 1, createdAt: earlier, sessionId: "s1", note: "First" },
    ],
    error: "",
    chatTitle: () => null,
  };
  // Closed: every name opens its mockup here; no head line anywhere.
  const closed = foundryPage(view);
  expect(closed).toMatch(/data-action="foundry-grow"[^>]*data-args="\{&quot;id&quot;:&quot;a1&quot;,&quot;version&quot;:2\}"/);
  expect(closed).not.toContain("fd-hd");
  // Open at v2: only that one grows and carries ‹ v2 ›, code, save a copy and close.
  const open = foundryPage({ ...view, open: { id: "a1", at: 2, shown: 2 } });
  expect(open.match(/fd-item[^"]*fd-open/g)?.length).toBe(1);
  expect(open).toContain(`fd-open" data-fd="${shelfKey("a1", 2)}"`);
  expect(open.match(/class="fd-hd"/g)?.length).toBe(1);
  expect(open).toContain('<span class="fd-hd-v" aria-live="polite">v2</span>');
  expect(open).toMatch(/data-action="foundry-shown" data-args="\{&quot;version&quot;:1\}"/);
  expect(open).toMatch(/<button type="button" class="fd-hd-b" disabled aria-label="Later version">/);
  for (const action of ["foundry-code", "foundry-copy", "foundry-shrink"]) expect(open).toContain(`data-action="${action}"`);
  // Stepping back shows v1 in the same place, with v1's own line; notes stay with the newest version.
  const back = foundryPage({ ...view, open: { id: "a1", at: 2, shown: 1 } });
  expect(back).toContain(`fd-open" data-fd="${shelfKey("a1", 2)}"`);
  expect(back).toContain("<b>v1 · First</b>");
  expect(back).toContain("foundry://artifact/a1?v=1&amp;stack=1");
  expect(back.split(`data-fd="${shelfKey("a1", 2)}"`)[1]!.split("</section>")[0]).not.toContain("fd-notes");
  // The code view replaces the page with its source, escaped; the saved line offers Show and the other format.
  const code = foundryPage({ ...view, open: { id: "a1", at: 2, shown: 2, code: "<div class=\"x\">hi</div>" } });
  expect(code).toContain('<pre class="fd-code"');
  expect(code).toContain("&lt;div class=&quot;x&quot;&gt;hi&lt;/div&gt;");
  expect(code).toMatch(/aria-label="Show the page" title="Show the page" aria-pressed="true"/);
  // The line after a save is painted in place, so saving never reloads the mockups.
  expect(open).toContain('<p class="fd-said" role="status" data-kind="html" hidden></p>');
  expect(savedLine({ id: "a1", at: 2, shown: 2, said: "Saved Orders board v2.html to Downloads", saved: { path: "/x", pdf: false, ready: false } }, "html"))
    .toBe('Saved Orders board v2.html to Downloads<button type="button" class="fd-said-b" data-action="foundry-copy-show">Show</button>');
  // Piece 6 of pass 274: a deck saves as PowerPoint; the other files are offered once, in words.
  const deckLine = savedLine({ id: "d", at: 1, shown: 1, said: "Saved Plan v1.pptx to Downloads", saved: { path: "/y", pdf: false, ready: true, others: ["pdf", "html"] } }, "deck");
  expect(deckLine).toContain(`data-args='{&quot;format&quot;:&quot;pdf&quot;}'>Also as PDF</button>`);
  expect(deckLine).toContain(">Also as a web page</button>");
  expect(savedLine({ id: "s", at: 1, shown: 1, said: "Saved Budget v1.xlsx to Downloads", saved: { path: "/y", pdf: false, ready: true, others: ["csv"] } }, "sheet")).toContain(">Also as CSV</button>");
  expect(savedLine({ id: "d", at: 1, shown: 1, said: "Saved Plan v1.pdf to Downloads", saved: { path: "/y", pdf: true, ready: false, others: [] } }, "deck")).not.toContain("Also as");
  expect(savedLine({ id: "r", at: 1, shown: 1, said: "Saved Counter v1.html to Downloads", saved: { path: "/z", pdf: false, ready: true } }, "react")).toContain(">Also as the .jsx</button>");
  expect(savedLine({ id: "a1", at: 2, shown: 2 }, "html")).toBe("");
});

test("step 3: a deck, doc or dashboard's newest version can be edited in place", () => {
  const open = { id: "d", at: 3, shown: 3 };
  expect(openHead(open, [1, 2, 3], "doc")).toContain('aria-label="Edit the text"');
  expect(openHead(open, [1, 2, 3], "html")).not.toContain("Edit the");
  expect(openHead({ ...open, shown: 2 }, [1, 2, 3], "doc")).toContain('disabled aria-label="Edit the newest version"');
  // While editing: Done, and nothing else to step to or read.
  const editing = openHead({ ...open, editing: { source: "# Hi", base: 3, changes: 1 } }, [1, 2, 3], "doc");
  expect(editing).toContain('aria-label="Done editing"');
  expect(editing).not.toContain("Show the code");
  expect(editing).toContain('disabled aria-label="Earlier version"');
  // The frame comes with its text editable, and nothing plays on it.
  const stage = stageHTML({ id: "d", title: "Plan", kind: "deck" }, { version: 3, createdAt: "2026-11-22T10:00:00Z", stage: null }, false, true);
  expect(stage).toContain("&amp;edit=1");
  expect(stage).not.toContain("data-deck");
  expect(stageHTML({ id: "d", title: "Plan", kind: "deck" }, { version: 3, createdAt: "2026-11-22T10:00:00Z", stage: null })).toContain("data-deck");
});

test("step 4: compare lays the version before over the shown one", () => {
  const open = { id: "d", at: 2, shown: 2 };
  expect(openHead(open, [1, 2], "html")).toContain('aria-label="Compare with v1"');
  expect(openHead({ ...open, shown: 1 }, [1, 2], "html")).toContain('disabled aria-label="Nothing earlier to compare with"');
  const comparing = openHead({ ...open, compare: true }, [1, 2], "doc");
  expect(comparing).toContain('aria-label="Stop comparing"');
  expect(comparing).not.toContain("Edit the text");
  const wipe = wipeHTML("<i>one</i>", "<i>two</i>", 1, 2);
  expect(wipe).toContain('class="fd-wipe-before"><i>one</i>');
  expect(wipe).toContain('role="slider"');
  expect(wipe).toContain('aria-label="Drag to compare v1 and v2"');
  expect(stageHTML({ id: "d", title: "Plan", kind: "deck" }, { version: 1, createdAt: "2026-11-22T10:00:00Z", stage: null }, false, false, true)).not.toContain("data-deck");
});

test("step 7: a new mockup can start from the version shown, but not while you edit", () => {
  const open = { id: "d", at: 3, shown: 2 };
  expect(openHead(open, [1, 2, 3], "html")).toContain('data-action="foundry-branch"');
  expect(openHead(open, [1, 2, 3], "html")).toContain('aria-label="Start a new one from v2"');
  expect(openHead({ ...open, shown: 3, editing: { source: "# Hi", base: 3, changes: 0 } }, [1, 2, 3], "doc")).not.toContain("foundry-branch");
});

test("step 8: share asks first, then shows the link to copy, open or take down", () => {
  const open = { id: "d", at: 3, shown: 3 };
  expect(openHead(open, [1, 2, 3], "html")).toContain('aria-label="Share v3 as a link"');
  const asking = savedLine({ ...open, share: { asking: true } }, "html");
  expect(asking).toContain("Publish v3 to a link anyone can open, on your GitHub Pages?");
  expect(asking).toContain(">Publish</button>");
  expect(asking).toContain(">Not now</button>");
  const shared = savedLine({ ...open, said: "Shared v3:", share: { url: "https://me.github.io/demesne-shares/abc/", version: 3 } }, "html");
  expect(shared).toContain("me.github.io/demesne-shares/abc/");
  expect(shared).toContain(">Copy link</button>");
  expect(shared).toContain(">Stop sharing</button>");
});
