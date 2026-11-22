import { expect, test } from "bun:test";
import { PILL_HEIGHT, pillHTML, pillSeconds, placePill, type Stage } from "../pill.ts";

// Pass 260 A: every passing notice is a pill, in the seat beside what it is about.

// The real window at 1440 x 900, as measured for the mock.
const stage: Stage = {
  width: 1440, height: 900,
  composer: { left: 353, top: 792, width: 750, height: 76 },
  main: { left: 282, top: 48, width: 860, height: 842 },
  release: { left: 12, top: 835.5, width: 248, height: 24.5 },
  cards: { left: 1142, top: 48, width: 274, height: 842 },
  anchor: { left: 695.6, top: 208.8, width: 50.1, height: 20 },
};

test("the middle seat is centred on the composer, 10px above it", () => {
  expect(placePill({ seat: "middle" }, stage)).toEqual({ seat: "middle", left: 728, bottom: 118 });
});

test("the left and right seats share one line, each as wide as its column", () => {
  const left = placePill({ seat: "left" }, stage), right = placePill({ seat: "right" }, stage);
  expect(left).toEqual({ seat: "left", left: 12, width: 248, top: 835.5 - 6 - PILL_HEIGHT });
  expect(right).toEqual({ seat: "right", left: 1142, width: 274, top: left.top });
});

test("Copied sits centred over the button you pressed", () => {
  const place = placePill({ seat: "at" }, stage);
  expect(place.seat).toBe("at");
  expect(place.left).toBeCloseTo(720.65);
  expect(place.top).toBeCloseTo(176.8);
});

test("a seat that is not on screen hands its pill to the middle", () => {
  const folded = { ...stage, release: null, cards: null, anchor: null };
  for (const seat of ["left", "right", "at"] as const) expect(placePill({ seat }, folded)).toEqual({ seat: "middle", left: 728, bottom: 118 });
  // The right seat keeps its line by the composer when only the sidebar is folded.
  expect(placePill({ seat: "right" }, { ...stage, release: null }).top).toBe(793);
});

test("with no composer on screen the middle is the foot of the page", () => {
  expect(placePill({ seat: "middle" }, { ...stage, composer: null })).toEqual({ seat: "middle", left: 712, bottom: 34 });
});

test("a quick word is quick, a long one gets time, and never more than twelve seconds", () => {
  expect(pillSeconds({ seat: "at", words: "Copied" })).toBe(2.5);
  expect(pillSeconds({ seat: "middle", words: "Saved notes.md" })).toBe(4);
  expect(pillSeconds({ seat: "left", words: "0.9.3 is ready", action: { label: "Restart", run() {} } })).toBe(6);
  expect(pillSeconds({ seat: "middle", words: "x".repeat(400) })).toBe(12);
  expect(pillSeconds({ seat: "middle", words: "x", seconds: 8 })).toBe(8);
});

test("the pill is the memory pill's glass: mark, words, at most one action, a ring when it stays", () => {
  const html = pillHTML({ seat: "left", mark: "up", words: "0.9.3 <is> ready", need: true, action: { label: "Restart", run() {} } });
  expect(html).toContain('class="mp-pill"');
  expect(html).toContain("0.9.3 &lt;is&gt; ready");
  expect(html).toContain('<button type="button" class="pill-act">Restart</button>');
  expect(html).toContain("pill-need");
  expect(html).toContain("mp-ring");
  const quick = pillHTML({ seat: "at", mark: "copy", words: "Copied" });
  expect(quick).not.toContain("mp-ring");
  expect(quick).not.toContain("pill-act");
  expect(quick).not.toContain("pill-need");
});
