import { describe, expect, test } from "bun:test";
import { knobProblem, knobsMessage, knobStep, knobValue, readKnobLine, readKnobs } from "../src/foundry-knobs.ts";

const page = (head: string, css = ":root{--pad:14px;--r:10px;--hue:175} main{padding:var(--pad);border-radius:var(--r);background:hsl(var(--hue) 70% 26%)}") =>
  `<!doctype html><html><head>${head}<style>${css}</style></head><body><main>Book a visit</main></body></html>`;
const ROOM = '<meta name="knob" content="Room | --pad | 8 | 24 | px">', CORNERS = "<meta content='Corners | --r | 0 | 20 | px' name='knob'>", WARMTH = '<meta name="knob" content="Warmth | --hue | 150 | 200 | ">';

describe("Foundry knobs", () => {
  test("a page's knobs are read with the values it declares", () => {
    expect(readKnobs(page(ROOM + CORNERS + WARMTH))).toEqual([
      { label: "Room", name: "--pad", min: 8, max: 24, unit: "px", value: 14 },
      { label: "Corners", name: "--r", min: 0, max: 20, unit: "px", value: 10 },
      { label: "Warmth", name: "--hue", min: 150, max: 200, unit: "", value: 175 },
    ]);
    expect(readKnobs(page(""))).toEqual([]);
    expect(knobProblem(page(""))).toBeNull();
    expect(knobProblem(page(ROOM + CORNERS + WARMTH))).toBeNull();
  });
  test("a line that isn't a knob is not one", () => {
    expect(readKnobLine("Room | --pad | 8 | 24 | px")).toEqual({ label: "Room", name: "--pad", min: 8, max: 24, unit: "px" });
    for (const bad of ["Room | pad | 8 | 24 | px", "Room | --pad | 24 | 8 | px", "Room | --pad | 8 | 24 | furlongs", "| --pad | 8 | 24", "Room | --pad | | 24", "<b>Room</b> | --pad | 8 | 24", "Room | --pad"]) expect(readKnobLine(bad)).toBeNull();
  });
  test("what is wrong with a knob goes back in words", () => {
    expect(knobProblem(page('<meta name="knob" content="Room | pad | 8 | 24">'))).toContain("can't be read");
    expect(knobProblem(page('<meta name="knob" content="Glow | --glow | 0 | 10 | px">'))).toContain("never sets it to a number");
    expect(knobProblem(page(ROOM, ":root{--pad:14px} main{padding:14px}"))).toContain("nothing on the page uses var(--pad)");
    expect(knobProblem(page(ROOM, ":root{--pad:40px} main{padding:var(--pad)}"))).toContain("Start it inside its range");
    expect(knobProblem(page(ROOM + ROOM))).toContain("Two knobs turn --pad");
    expect(knobProblem(page(ROOM + CORNERS + WARMTH + '<meta name="knob" content="A | --a1 | 0 | 1"><meta name="knob" content="B | --b1 | 0 | 1">'))).toContain("at most 4");
  });
  test("the settings a person left go to the chat as one message, only what moved", () => {
    const knobs = readKnobs(page(ROOM + CORNERS + WARMTH));
    const message = knobsMessage({ id: "abc", title: "Booking page", version: 3 }, knobs, { "--pad": 18, "--r": 10, "--hue": 162 });
    expect(message).toContain('"Booking page" (id abc, v3)');
    expect(message).toContain("- Room: --pad 18px (was 14px)");
    expect(message).toContain("- Warmth: --hue 162 (was 175)");
    expect(message).not.toContain("Corners");
    expect(message).toContain("foundry_edit only those values");
    expect(knobsMessage({ id: "abc", title: "Booking page", version: 3 }, knobs, { "--pad": 14 })).toBe("");
  });
  test("values and steps read plainly", () => {
    expect(knobValue({ unit: "px" }, 18)).toBe("18px");
    expect(knobValue({ unit: "rem" }, 1.2500001)).toBe("1.25rem");
    expect(knobStep({ min: 8, max: 24 })).toBe(0.5);
    expect(knobStep({ min: 150, max: 200 })).toBe(1);
    expect(knobStep({ min: 1, max: 2 })).toBe(0.05);
  });
});
