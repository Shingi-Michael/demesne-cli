import { describe, expect, test } from "bun:test";
import { cleanKnobs, knobsHTML } from "../foundry-knobs.ts";

const ROOM = { label: "Room", name: "--pad", min: 8, max: 24, unit: "px", value: 14 };

describe("Foundry knobs over an opened mockup", () => {
  test("only sound knobs a page reports are drawn, four at most", () => {
    expect(cleanKnobs([ROOM, { ...ROOM, name: "--pad" }, { ...ROOM, name: "color" }, { ...ROOM, name: "--x", min: 9, max: 1 }, { ...ROOM, name: "--y", unit: "furlong" }, { ...ROOM, name: "--z", value: 99 }, null, "x"]))
      .toEqual([ROOM, { ...ROOM, name: "--z", value: 24 }]);
    expect(cleanKnobs("nope")).toEqual([]);
    expect(cleanKnobs(Array.from({ length: 9 }, (_, at) => ({ ...ROOM, name: `--k${at}` }))).length).toBe(4);
  });
  test("a slider per knob, and the send line hidden until one moves", () => {
    const html = knobsHTML([ROOM, { label: 'A "b" <c>', name: "--r", min: 0, max: 20, unit: "px", value: 10 }]);
    expect(html).toContain('<input type="range" min="8" max="24" step="0.5" value="14" data-knob="--pad"');
    expect(html).toContain("<output>14px</output>");
    expect(html).toContain("A &quot;b&quot; &lt;c&gt;");
    expect(html).toContain('data-action="foundry-knobs-send" hidden');
    expect(knobsHTML([])).toBe("");
  });
});
