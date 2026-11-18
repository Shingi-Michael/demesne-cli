import { describe, expect, test } from "bun:test";
import { demoControls, drawnSurface, parseDemo, parseStage, parseSurface, reviewOf, reviewProblem, shotBox, shotsOf, stageFromText, stageText } from "../src/foundry-stage.ts";

describe("A mockup's surface and demo (pass 221 A)", () => {
  test("a step written as an action and a selector is the same step", () => {
    expect(parseDemo([{ action: "click", selector: "#start", say: "Begin" }, { action: "type", text: "Milk", target: "Item" }, { action: "wait", value: 300 }]))
      .toEqual([{ click: "#start", say: "Begin" }, { type: "Milk", into: "Item" }, { wait: 300 }]);
  });

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

describe("A review of something that exists (pass 223 A, from a real picture since pass 240 A)", () => {
  const cut = '<d-shot src="shot-1" box="0,0,10,10"></d-shot>';
  const part = (name: string, options: string[], extra = 'why="One line on what is wrong."', pick = options[1] ?? "") =>
    `<section data-part="${name}" ${extra}><d-compare${pick ? ` recommended="${pick}"` : ""}>${options.map((option) => `<section data-option="${option}">${option === "Today" ? cut : '<div class="box">x</div>'}</section>`).join("")}</d-compare></section>`;
  const review = (parts: string[], today = '<section data-today><d-shot src="shot-1" marks="0,0,10,10 | 20,0,10,10 | 40,0,10,10"></d-shot></section>') => `<d-review>${today}${parts.join("")}</d-review>`;
  const good = review([part("Switches", ["Today", "Grouped", "Three levels", "Important first"]), part("Save", ["Today", "Saves as you switch", "A bar that follows you"])]);

  test("its shape is read from the markup: today, the marks, and each part's options and pick", () => {
    expect(reviewOf("<main>a page</main>")).toBeNull();
    expect(reviewOf(good)).toEqual({ today: true, shot: true, marks: 3, parts: [
      { name: "Switches", why: "One line on what is wrong.", options: ["Grouped", "Three levels", "Important first"], today: true, recommended: true, todayShot: true },
      { name: "Save", why: "One line on what is wrong.", options: ["Saves as you switch", "A bar that follows you"], today: true, recommended: true, todayShot: true }] });
    // Marks written as selectors or on the piece still count, and text inside scripts is not markup.
    const marked = review([part("Save", ["Today", "A", "B"])], '<section data-today><button data-mark="1">Save</button></section>') + `<script>"<section data-part='x'>"</script>`;
    expect(reviewOf(marked)).toMatchObject({ today: true, shot: false, marks: 1, parts: [{ name: "Save" }] });
    expect(reviewOf(review([part("Save", ["Today", "A", "B"])], '<section data-today marks=".a | .b"><main>screen</main></section>'))!.marks).toBe(2);
    // A why with a > in it is still one attribute.
    expect(reviewOf(review([part("Save", ["Today", "A", "B"], 'why="Save is 640px > one screen below"')]))!.parts[0]!.why).toBe("Save is 640px > one screen below");
  });

  test("a review that holds is let through; each way it can fall short is named with its fix", () => {
    expect(reviewProblem(good)).toBeNull();
    expect(reviewProblem("<main>not a review</main>")).toBeNull();
    expect(reviewProblem(review([part("Save", ["Today", "A", "B"])], ""))).toContain("the screen as it is today");
    expect(reviewProblem(review([]))).toContain("names no part");
    // Real models built the whole sheet in a script three times in five; the refusal says so instead of "has none".
    const built = "<script>const sheet = `" + good.replace(/`/g, "") + "`;</script><script src=\"foundry://kit/parts.js\"></script><script>document.body.innerHTML = sheet;</script>";
    expect(reviewProblem(built)).toContain("built by a script");
    expect(reviewProblem(built)).toContain("plain markup");
    expect(reviewProblem(`<d-review id="r"></d-review><script>r.innerHTML = '<section data-today marks=".a">x</section><section data-part="Save" why="w">y</section>';</script>`)).toContain("built by a script");
    // A script that only fills a section is fine: the sections themselves are in the page.
    expect(reviewProblem(good + `<script>document.querySelector("[data-today]").append("more");</script>`)).toBeNull();
    expect(reviewProblem(review(["One", "Two", "Three", "Four"].map((name) => part(name, ["Today", "A", "B"])), '<section data-today><d-shot src="s" marks="1,1,1,1|1,1,1,1|1,1,1,1|1,1,1,1"></d-shot></section>'))).toContain("[too_many_parts]");
    expect(reviewProblem(review([part("Save", ["Today", "A", "B"])], '<section data-today><d-shot src="shot-1"></d-shot></section>'))).toContain("No part is marked");
    // Pass 240 A: Today is a real picture, never a drawing, and so is each part's Today.
    expect(reviewProblem(review([part("Save", ["Today", "A", "B"])], '<section data-today marks=".a"><main>screen</main></section>'))).toContain("[review_shot]");
    expect(reviewProblem(review([part("Save", ["Today", "A", "B"])], '<section data-today marks=".a"><main>screen</main></section>'))).toContain("capture_window");
    expect(reviewProblem(review([part("Save", ["Today", "A", "B"]).replace(cut, "<button>Save</button>")]))).toContain(`"Save"'s Today is drawn`);
    expect(reviewProblem(review([part("Save", ["Today", "A", "B"]).replace(cut, '<d-shot src="shot-1"></d-shot>')]))).toContain("[review_shot]");
    expect(reviewProblem(review([part("Save", ["Today", "A", "B"], "")]))).toContain("does not say why");
    expect(reviewProblem(review([part("Save", ["A", "B"])]))).toContain('has no "Today"');
    expect(reviewProblem(review([part("Save", ["Today", "A"])]))).toContain("one option beside Today");
    expect(reviewProblem(review([part("Save", ["Today", "A", "B", "C", "D"])]))).toContain("[too_many_options]");
    expect(reviewProblem(review([part("Save", ["Today", "A", "B"], undefined, "")]))).toContain("[no_recommendation]");
    // The pick has to be one of the options, and never Today.
    expect(reviewProblem(review([part("Save", ["Today", "A", "B"], undefined, "Today")]))).toContain("[no_recommendation]");
  });
});

describe("The real pictures a page shows (pass 240 A)", () => {
  test("every <d-shot> is read with its picture and boxes; scripts and comments are not markup", () => {
    expect(shotsOf(`<d-shot src="a" marks="1,2,3,4 | 5,6,7,8"></d-shot><d-shot src='b' box="0 0 10 10"></d-shot><!-- <d-shot src="c"> --><script>"<d-shot src='d'>"</script>`)).toEqual([
      { src: "a", box: null, marks: ["1,2,3,4", "5,6,7,8"] }, { src: "b", box: "0 0 10 10", marks: [] }]);
  });
  test("a box is four numbers with a size", () => {
    expect(shotBox("12, 40, 1416 ,52")).toEqual({ x: 12, y: 40, width: 1416, height: 52 });
    expect(shotBox("1 2 3 4")).toEqual({ x: 1, y: 2, width: 3, height: 4 });
    expect(shotBox("1,2,0,4")).toBeNull();
    expect(shotBox("#top")).toBeNull();
    expect(shotBox("1,2,3")).toBeNull();
  });
});
