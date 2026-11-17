import { describe, expect, test } from "bun:test";
import { newNoteStore, notesLine, notesMessage, partName, partWord, readPart, type FoundryNote, type NotePart } from "../foundry-notes.ts";
import { splitPastes } from "../pastes.ts";

const part = (given: Partial<NotePart>): NotePart => ({ tag: "div", role: "", type: "", cls: "", label: "", text: "", heading: "", kids: 0, selector: "div", html: "<div></div>", ...given });

describe("notes on a mockup (pass 233 A)", () => {
  test("a part is called what a person would call it", () => {
    expect(partWord(part({ tag: "button" }))).toBe("button");
    expect(partWord(part({ tag: "div", role: "tab" }))).toBe("tab");
    expect(partWord(part({ tag: "input", type: "checkbox" }))).toBe("tick box");
    expect(partWord(part({ tag: "input", type: "text" }))).toBe("field");
    expect(partWord(part({ tag: "d-toggle" }))).toBe("switch");
    expect(partWord(part({ tag: "div", cls: "stat-card wide" }))).toBe("card");
    expect(partWord(part({ tag: "div", cls: "toolbar" }))).toBe("bar");
    expect(partWord(part({ tag: "div", cls: "starboard" }))).toBe("part");
  });

  test("the tag's name is the part's own short words, then what it is", () => {
    expect(partName(part({ tag: "button", text: "Save" }))).toBe("Save button");
    expect(partName(part({ tag: "button", label: "Pin Drive picks", text: "📌" }))).toBe("Pin Drive picks button");
    expect(partName(part({ tag: "div", cls: "card", heading: "Overdue", text: "Overdue 12 invoices £4,200", kids: 3 }))).toBe("Overdue card");
    // A piece that holds several things is never named by all the words inside it.
    expect(partName(part({ tag: "nav", cls: "tabs", text: "All Open Paid Overdue", kids: 4 }))).toBe("Bar");
    expect(partName(part({ tag: "div", role: "tablist", text: "All Open Paid", kids: 3 }))).toBe("Tabs");
    expect(partName(part({ tag: "div", cls: "r", heading: "Drive picks", text: "Drive picks 📌", kids: 2 }))).toBe("Drive picks");
    expect(partName(part({ tag: "h3", text: "Pinned" }))).toBe("Pinned heading");
    expect(partName(part({ tag: "p", text: "Orders, beans and what is running low this week" }))).toBe("“Orders, beans and what…”");
    expect(partName(part({ tag: "div" }))).toBe("Part");
    expect(partName(part({ tag: "div", role: "tab", text: "Tab" }))).toBe("Tab");
  });

  const save: FoundryNote = { part: part({ tag: "button", text: "Save", selector: "form > button.primary", html: '<button class="primary">Save</button>' }), name: "Save button", text: "Make it green" };
  const tabs: FoundryNote = { part: part({ tag: "nav", selector: "nav.tabs", html: "<nav class=\"tabs\">…</nav>" }), name: "Tabs", text: "Drop the last one", option: { index: 1, name: "B · Tabs on top" } };

  test("the notes go as one message: what the person said, then the detail for the model folded under it", () => {
    const sent = notesMessage({ id: "a1", title: "Ledger invoices", version: 3 }, [save, tabs], [0]);
    const [said, detail] = splitPastes(sent);
    expect(said).toEqual({ kind: "text", text: "On “Ledger invoices”:\n1 · Save button: Make it green\n2 · Tabs in B · Tabs on top: Drop the last one" });
    expect(detail?.kind).toBe("parts");
    expect(detail!.text.split("\n")).toEqual([
      'Notes on parts of the Foundry mockup "Ledger invoices" (id a1, v3). Change only these parts, each as its note says, and leave everything else exactly as it is: foundry_read it, then one foundry_edit. The attached picture shows part 1 as the person saw it, in that order.',
      "1. Save button: Make it green", "   selector `form > button.primary`", '   <button class="primary">Save</button>',
      "2. Tabs in B · Tabs on top: Drop the last one", "   selector `nav.tabs`", '   <nav class="tabs">…</nav>',
    ]);
    const one = notesMessage({ id: "a1", title: "Ledger invoices", version: 3 }, [save]);
    expect(one).toContain("Notes on one part of the Foundry mockup");
    expect(one).toContain("Change only this part, as its note says");
    expect(one).not.toContain("attached");
    expect(notesMessage({ id: "a1", title: "Ledger invoices", version: 3 }, [save, tabs], [0, 1])).toContain("The attached pictures show parts 1, 2 as the person saw them, in that order.");
    expect(notesMessage({ id: "a1", title: "x", version: 1 }, [])).toBe("");
  });

  test("the line under a mockup says how many notes wait and how to send them, or that they are being worked on", () => {
    expect(notesLine(0, 0)).toBe("");
    expect(notesLine(1, 0)).toMatch(/^<button type="button" class="fd-notes-send" data-notes-send>1 note waiting · send <kbd>(⌘↵|Ctrl ↵)<\/kbd><\/button>$/);
    expect(notesLine(3, 0)).toContain("3 notes waiting");
    expect(notesLine(0, 2)).toBe('<i class="fd-notes-work" aria-hidden="true"></i><span>Working on 2 notes…</span>');
    // More notes written while the first ones are with the model.
    expect(notesLine(1, 2)).toContain("Working on 2 notes…</span><button");
    expect(notesLine(0, 0, "No new version came back. <b>")).toBe('<span class="fd-quiet">No new version came back. &lt;b&gt;</span>');
    expect(notesLine(2, 0, "Not sent")).not.toContain("Not sent");
  });

  test("what a frame says about a part is taken with care: the page in it was written by a model", () => {
    const rect = { x: 10, y: 20, w: 100, h: 30 };
    expect(readPart(null)).toBeNull();
    expect(readPart({ selector: "div", rect: { x: 1, y: 2, w: "3", h: 4 } })).toBeNull();
    expect(readPart({ rect })).toBeNull();
    const read = readPart({ tag: "BUTTON", role: 7, selector: "button", text: "x".repeat(500), html: "y".repeat(5000), kids: 4.7, rect: { ...rect, extra: 1 } })!;
    expect(read).toMatchObject({ tag: "button", role: "", selector: "button", kids: 4, rect });
    expect(read.text.length).toBe(120);
    expect(read.html.length).toBe(700);
    expect(readPart({ selector: "a", kids: -3, rect })!.kids).toBe(0);
  });

  test("a new store holds nothing", () => {
    const store = newNoteStore();
    expect([store.waiting.size, store.working.size, store.said.size, store.draft]).toEqual([0, 0, 0, null]);
  });
});
