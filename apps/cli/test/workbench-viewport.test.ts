import { describe, expect, test } from "bun:test";
import { ConversationViewport } from "../src/workbench/viewport.ts";

describe("ConversationViewport", () => {
  test("shows the tail of the content and pads short transcripts", () => {
    const viewport = new ConversationViewport();
    viewport.setLines(["a", "b", "c", "d"]);
    expect(viewport.visible(2)).toEqual(["c", "d"]);
    expect(viewport.visible(6)).toEqual(["", "", "a", "b", "c", "d"]);
    expect(viewport.atBottom).toBe(true);
  });

  test("scrolls up and down with clamping", () => {
    const viewport = new ConversationViewport();
    viewport.setLines(Array.from({ length: 20 }, (_, index) => `line ${index}`));
    viewport.scrollUp(5);
    expect(viewport.atBottom).toBe(false);
    expect(viewport.visible(3)).toEqual(["line 12", "line 13", "line 14"]);
    viewport.scrollDown(100);
    expect(viewport.atBottom).toBe(true);
    expect(viewport.visible(2)).toEqual(["line 18", "line 19"]);
  });

  test("clamps scrolling beyond the top", () => {
    const viewport = new ConversationViewport();
    viewport.setLines(["a", "b", "c"]);
    viewport.scrollUp(999);
    expect(viewport.visible(3)).toEqual(["a", "b", "c"]);
    viewport.toTop();
    expect(viewport.visible(2)).toEqual(["a", "b"]);
    viewport.toBottom();
    expect(viewport.visible(2)).toEqual(["b", "c"]);
  });

  test("handles empty content", () => {
    const viewport = new ConversationViewport();
    viewport.setLines([]);
    expect(viewport.visible(3)).toEqual(["", "", ""]);
    viewport.scrollUp(5);
    expect(viewport.atBottom).toBe(true);
  });
});
