import { describe, expect, test } from "bun:test";
import { demoControls, drawnSurface, parseDemo, parseStage, parseSurface, stageFromText, stageText } from "../src/foundry-stage.ts";

describe("A mockup's surface and demo (pass 221 A)", () => {
  test("a surface names a frame, and may size it and pick what it sits on", () => {
    expect(parseSurface({ frame: "phone" })).toEqual({ frame: "phone" });
    expect(parseSurface({ frame: "window", width: 900.4, height: 560, backdrop: "paper", title: " Settings " })).toEqual({ frame: "window", width: 900, height: 560, backdrop: "paper", title: "Settings" });
    expect(parseSurface({ frame: "part", height: 0 })).toEqual({ frame: "part", height: 0 });
    expect(() => parseSurface({ frame: "tablet" })).toThrow(/window, browser, phone, part, page/);
    expect(() => parseSurface({ frame: "window", width: 40 })).toThrow(/120 to 2400/);
    expect(() => parseSurface({ frame: "window", backdrop: "wood" })).toThrow(/desk, paper, dark, white/);
    expect(() => parseSurface("phone")).toThrow(/object/);
  });

  test("a surface left unsized is drawn at its frame's own size, on its frame's own backdrop", () => {
    expect(drawnSurface({ frame: "phone" })).toEqual({ frame: "phone", width: 390, height: 844, backdrop: "dark", title: "" });
    expect(drawnSurface({ frame: "part", width: 300 })).toEqual({ frame: "part", width: 300, height: 0, backdrop: "paper", title: "" });
  });

  test("a demo is foundry_try's steps, each with an optional line to show", () => {
    expect(parseDemo([{ hover: "Drive picks", say: "  Point at a chat  " }, { click: "Pin" }, { wait: 9000 }])).toEqual([{ hover: "Drive picks", say: "Point at a chat" }, { click: "Pin" }, { wait: 2000 }]);
    expect(() => parseDemo([])).toThrow(/one to 12/);
    expect(() => parseDemo([{ jump: "x" }])).toThrow(/click, type, key, scroll, hover or wait/);
    expect(() => parseDemo([{ click: "x", say: "y".repeat(121) }])).toThrow(/120/);
  });

  test("both are kept as JSON with a version, and read back", () => {
    const stage = parseStage({ surface: { frame: "browser", title: "shop.example" }, demo: [{ click: "Buy", say: "Buy it" }] })!;
    expect(stageFromText(stageText(stage))).toEqual(stage);
    expect(parseStage({})).toBeNull();
    expect(stageText(null)).toBe("");
    expect(stageFromText("not json")).toBeNull();
  });

  test("buttons that only run a demo are found by their text, real controls are not", () => {
    const page = `<button>▶ Replay</button><button class="x">Play demo</button><a href="#">Next step →</a><button>Reset animation</button>
      <button>Play</button><button>Next</button><button>Reset filters</button><button>Restart server</button><script>"<button>Replay</button>"</script>`;
    expect(demoControls(page)).toEqual(["▶ Replay", "Play demo", "Next step →", "Reset animation"]);
    expect(demoControls("<button>Save</button>")).toEqual([]);
    // A pretend state, by button or by a row of state names, is the same thing.
    expect(demoControls(`<button>Show error state</button><button>Simulate failure</button><a>Demo mode</a><label>State: empty</label>`)).toEqual(["Show error state", "Simulate failure", "Demo mode", "State: empty"]);
    expect(demoControls(`<div class="seg"><button>Default</button><button>Empty</button><button>Loading</button><button>Error</button></div>`)).toEqual(["Empty · Loading · Error"]);
    expect(demoControls(`<div role="tab">Hover</div><div role="tab">Pressed</div>`)).toEqual(["Hover · Pressed"]);
    // A real filter of outcomes is a control the product has.
    expect(demoControls(`<button>All</button><button>Error</button><button>Success</button><button>Done</button>`)).toEqual([]);
  });
});
