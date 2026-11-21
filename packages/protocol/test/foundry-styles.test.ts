import { expect, test } from "bun:test";
import { optionNames, pickOption } from "../src/foundry-built.ts";
import { faceOf, isStyleColour, styleColours, styleLines, styleNames, stylesOf, stylesProblem, styleVars } from "../src/foundry-styles.ts";

// Pass 246 A, a range of styles: a page written once, drawn in two or three styles.
const style = (name: string, vars: string, made = `${name}, in a line`) => `<d-style name="${name}" made="${made}" vars="${vars}"></d-style>`;
const CLEAN = "--paper:#fff; --ink:#111417; --accent:#1f6f4a; --head:Inter,sans-serif; --font:Inter,sans-serif; --radius:8px; --line:#e3e6ea";
const LABEL = "--paper:#1d1613; --ink:#f3e9da; --accent:#e0a93b; --head:'JetBrains Mono',monospace; --font:Inter,sans-serif; --radius:2px; --line:#3d3028";
const PAPER = "--paper:#fbf7f2; --ink:#2a211b; --accent:#b9643c; --head:Georgia,serif; --font:Inter,sans-serif; --radius:14px; --line:#ece2d8";
const page = (styles: string, recommended = "Clean counter", body = "<main><h1>Checkout</h1></main>") =>
  `<!doctype html><html><head><link rel="stylesheet" href="foundry://kit/base.css"><script src="foundry://kit/parts.js"></script></head><body><d-styles recommended="${recommended}">${styles}</d-styles>${body}</body></html>`;
const THREE = style("Clean counter", CLEAN) + style("Roastery label", LABEL) + style("Warm paper", PAPER);

test("a page's styles are read in order, each with its name, its line and its values", () => {
  const found = stylesOf(page(THREE))!;
  expect(found.recommended).toBe("Clean counter");
  expect(found.styles.map((item) => item.name)).toEqual(["Clean counter", "Roastery label", "Warm paper"]);
  expect(found.styles[1]!.vars[3]).toEqual(["--head", "'JetBrains Mono',monospace"]);
  expect(styleNames(page(THREE))).toEqual(["Clean counter", "Roastery label", "Warm paper"]);
  expect(stylesOf("<main>No styles here</main>")).toBeNull();
  // A style drawn only in a script or a comment is not one.
  expect(stylesOf(`<script>document.write('<d-styles>')</script><!-- <d-styles> -->`)).toBeNull();
  // Each style is an option of the mockup: "build Roastery" finds it, and Foundry draws it alone by its index.
  expect(optionNames(page(THREE))).toEqual(["Clean counter", "Roastery label", "Warm paper"]);
  expect(pickOption(optionNames(page(THREE)), "roastery")).toBe(1);
});

test("a style only ever sets values", () => {
  expect(styleVars("--paper: #fff ;--ink:#111;; color:red; --x:url(http://a/b); --y:1px} body{display:none; --paper:#000; --z: a<b")).toEqual([["--paper", "#fff"], ["--ink", "#111"]]);
  expect(styleVars("--head:&quot;JetBrains Mono&quot;, monospace")).toEqual([["--head", '"JetBrains Mono", monospace']]);
  expect(faceOf("'JetBrains Mono', monospace")).toBe("JetBrains Mono");
  expect(isStyleColour("#1f6f4a")).toBe(true);
  expect(isStyleColour("rgb(31 111 74)")).toBe(true);
  for (const bad of ["red;background:url(x)", "url(x)", "#12", "", 4, "rgb(1,2,3));x:(", "x".repeat(80)]) expect(isStyleColour(bad)).toBe(false);
});

test("the swatches are paper, ink and accent first, five at most, each once", () => {
  const [clean] = stylesOf(page(THREE))!.styles;
  expect(styleColours(clean!)).toEqual(["#fff", "#111417", "#1f6f4a", "#e3e6ea"]);
  const many = stylesOf(page(style("Many", `${CLEAN}; --a:#010101; --b:#020202; --c:#fff`) + style("Roastery label", LABEL)))!.styles[0]!;
  expect(styleColours(many)).toEqual(["#fff", "#111417", "#1f6f4a", "#e3e6ea", "#010101"]);
});

test("a good range passes; what is wrong comes back as a hint", () => {
  expect(stylesProblem(page(THREE))).toBeNull();
  expect(stylesProblem(page(style("Clean counter", CLEAN) + style("Roastery label", LABEL)))).toBeNull();
  expect(stylesProblem("<main>No styles</main>")).toBeNull();
  // One style is not a range, and four is too many.
  expect(stylesProblem(page(style("Clean counter", CLEAN)))).toMatch(/\[styles\] This page has 1 style; a range is two or three/);
  expect(stylesProblem(page(THREE + style("Fourth", PAPER.replace("#fbf7f2", "#000"))))).toMatch(/has 4 styles/);
  // Every style has its own name, says what it is made of, and sets every value.
  expect(stylesProblem(page(style("Same", CLEAN) + style("same", LABEL), "Same"))).toMatch(/its own name/);
  expect(stylesProblem(page(style("Clean counter", CLEAN, "") + style("Roastery label", LABEL)))).toMatch(/“Clean counter” does not say what it is made of/);
  expect(stylesProblem(page(style("Clean counter", CLEAN) + style("Roastery label", LABEL.replace("--radius:2px; ", ""))))).toMatch(/“Roastery label” is missing --radius/);
  expect(stylesProblem(page(style("Clean counter", CLEAN) + style("Roastery label", LABEL.replace("; --line:#3d3028", ""))))).toMatch(/“Roastery label” does not set --line, which “Clean counter” sets/);
  expect(stylesProblem(page(style("Clean counter", CLEAN.replace("--paper:#fff", "--paper:white")) + style("Roastery label", LABEL)))).toMatch(/--paper, --ink and --accent are each one colour/);
  // A pick among them.
  expect(stylesProblem(page(THREE, ""))).toMatch(/\[no_recommendation\]/);
  expect(stylesProblem(page(THREE, "Nordic"))).toMatch(/\[no_recommendation\]/);
  expect(stylesProblem(page(THREE, "Roastery"))).toBeNull();
  // The same paper and the same heading type is one style twice, whatever else differs.
  const twin = style("Clean counter", CLEAN) + style("Green counter", CLEAN.replace("#1f6f4a", "#0a58ca").replace("--paper:#fff", "--paper: #FFF").replace("8px", "12px"));
  expect(stylesProblem(page(twin))).toMatch(/“Clean counter” and “Green counter” share their paper and their heading typeface/);
  // The same paper with another typeface is a different style.
  expect(stylesProblem(page(style("Clean counter", CLEAN) + style("Serif counter", CLEAN.replace("--head:Inter,sans-serif", "--head:Georgia,serif"))))).toBeNull();
  // Styles or options, not both; and the page has to be drawn by the parts and on the values.
  expect(stylesProblem(page(THREE, "Clean counter", `<d-compare recommended="A"><section data-option="A">a</section><section data-option="B">b</section></d-compare>`))).toMatch(/styles and options/);
  expect(stylesProblem(page(THREE).replace('<script src="foundry://kit/parts.js"></script>', ""))).toMatch(/needs the parts script/);
  const bare = page(THREE).replace('<link rel="stylesheet" href="foundry://kit/base.css">', "");
  expect(stylesProblem(bare)).toMatch(/would look the same in every style/);
  expect(stylesProblem(bare.replace("<main>", "<style>body{background:var(--paper);color:var(--ink);font-family:var(--font)}h1{font-family:var(--head)}button{background:var(--accent)}</style><main>"))).toBeNull();
});

test("a picked style is written as lines a person can read, with its exact values last", () => {
  const label = stylesOf(page(THREE))!.styles[1]!;
  expect(styleLines({ ...label, made: "Mono capitals · square corners" })).toEqual([
    "- Made of: Mono capitals · square corners",
    "- Colours: paper #1d1613, ink #f3e9da, accent #e0a93b, line #3d3028",
    "- Type: JetBrains Mono for headings, Inter for the rest",
    "- Corners: 2px",
    "- Values: `--paper: #1d1613; --ink: #f3e9da; --accent: #e0a93b; --head: 'JetBrains Mono',monospace; --font: Inter,sans-serif; --radius: 2px; --line: #3d3028`",
  ]);
  expect(styleLines(stylesOf(page(THREE))!.styles[0]!)[2]).toBe("- Type: Inter throughout");
});
