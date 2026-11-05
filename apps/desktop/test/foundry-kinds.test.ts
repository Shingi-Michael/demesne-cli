import { expect, test } from "bun:test";
import { chartSVG, compact, fillRows, frontMatter, parseChart, renderDashboard, renderDeck, renderDoc, slideLayout, splitSlides, statsHTML } from "../electron/foundry-kinds.ts";
import { exportedSource, FOUNDRY_KIT, foundryDocument } from "../electron/policy.ts";
import { CHANGED_SCRIPT, withChanges } from "../electron/foundry-changed.ts";

test("front matter is read from the top only, and the rest is the body", () => {
  const { meta, body } = frontMatter("---\ntitle: Q1 launch\ntheme: forest\naccent: \"#8fd6a9\"\n---\n# Hello\n");
  expect(meta).toEqual({ title: "Q1 launch", theme: "forest", accent: "#8fd6a9" });
  expect(body).toBe("# Hello\n");
  // A deck that starts with a slide break is not front matter.
  expect(frontMatter("---\n# One\n---\n# Two").meta).toEqual({});
});

test("a deck splits on lines that are only ---, never inside code", () => {
  expect(splitSlides("# One\n\n---\n\n# Two\n----\n# Three")).toEqual(["# One\n", "\n# Two", "# Three"]);
  expect(splitSlides("# Code\n```\n---\n```\n---\n# After")).toHaveLength(2);
  expect(splitSlides("\n---\n<!-- layout: title -->\n---\n# Only")).toEqual(["# Only"]);
});

test("a slide's layout follows its content unless it names one", () => {
  expect(slideLayout("# Q1 launch\nWhat happened.", 0)).toBe("title");
  expect(slideLayout("# 3.1×\nSign-ups tripled.", 2)).toBe("number");
  expect(slideLayout("> The free tier filled the funnel.\n>\n> Priya", 3)).toBe("quote");
  expect(slideLayout("## Growth\n```chart\nvalues: 1, 2\n```", 3)).toBe("chart");
  expect(slideLayout("## Where\n- Search\n- Paid\n```chart\nvalues: 1, 2\n```", 3)).toBe("split");
  expect(slideLayout("## Next\n- One\n- Two\n- Three", 4)).toBe("points");
  expect(slideLayout("## Ship it on Friday", 4)).toBe("statement");
  expect(slideLayout("<!-- layout: quote -->\n## Not really a quote", 4)).toBe("quote");
});

test("a chart block reads its series, and draws bars, lines and a donut", () => {
  const spec = parseChart("type: line\ntitle: Sign-ups\nlabels: W1, W2, W3\nSearch: 400, 600, 900\nPaid: 300, 350, 300\nunit: %");
  expect(spec).toEqual({ type: "line", title: "Sign-ups", labels: ["W1", "W2", "W3"], series: [{ name: "Search", values: [400, 600, 900] }, { name: "Paid", values: [300, 350, 300] }], unit: "%", note: "" });
  expect(parseChart("type: pie\nvalues: 1, 2").type).toBe("bar");
  expect(chartSVG(parseChart("type: bar\nlabels: a, b\nvalues: 1200, 3700"))).toContain("3,700");
  expect(chartSVG(parseChart("type: line\nvalues: 1, 2, 3"))).toContain("<polyline");
  const donut = chartSVG(parseChart("type: donut\nlabels: Search, Paid\nvalues: 75, 25"));
  expect(donut).toContain("75%");
  expect(donut).toContain("Search");
  expect(chartSVG(parseChart("title: Empty"))).toContain("No numbers");
  expect([compact(1200), compact(12_500), compact(3_400_000), compact(0.5)]).toEqual(["1,200", "12.5k", "3.4M", "0.5"]);
});

test("stats are one tile per line, coloured by the delta's sign", () => {
  const html = statsHTML("Sign-ups | 3,700 | +210% | a week\nChurn | 2.3% | −0.4 pt\nbroken line");
  expect(html.match(/class="k-stat"/g)).toHaveLength(2);
  expect(html).toContain('<b class="up">+210%</b>');
  expect(html).toContain('<b class="down">−0.4 pt</b>');
});

test("a deck draws each slide with its layout, footer and the deck's look", () => {
  const html = renderDeck("---\ntitle: Q1 launch\ntheme: forest\n---\n# Q1 launch\nWhat happened.\n\n---\n\n# 3.1×\nSign-ups tripled.\n\n---\n\n## Growth\n```chart\nvalues: 1, 2, 3\n```", "Untitled");
  expect(html.match(/<section class="slide"/g)).toHaveLength(3);
  expect(html).toContain('data-look="forest"');
  expect(html).toContain('data-layout="number"');
  expect(html).toContain("2 / 3");
  expect(html).toContain('<link rel="stylesheet" href="foundry://kit/kinds.css">');
  expect(html).toContain('<script src="foundry://kit/kinds.js"></script>');
  // An unknown look or a colour that isn't a hex colour is ignored.
  expect(renderDeck("---\ntheme: neon\naccent: red;}body{x\n---\n# A", "A")).not.toMatch(/data-look=|--accent:red/);
});

test("a doc takes its title from the front matter or its first heading, with contents for three or more sections", () => {
  const doc = renderDoc("# The brief\n\n## One\nx\n## Two\ny\n## Two\nz\n\n> [!WARNING]\n> Careful.", "Untitled");
  expect(doc).toContain("<h1>The brief</h1>");
  expect(doc).toContain('<h2 id="two-2">Two</h2>');
  expect(doc).toContain('class="doc-toc"');
  expect(doc).toContain('<aside class="k-callout warn"><b>Warning</b>');
  expect(renderDoc("Just words.", "Fallback")).toContain("<h1>Fallback</h1>");
  expect(renderDoc("| a | n |\n| - | - |\n| x | 1,200 |", "T")).toContain('<td class="num">1,200</td>');
});

test("a dashboard groups cards under its headings, and a card left alone takes the row", () => {
  const html = renderDashboard("# Launch\nSix weeks in\n\n```stats\nSign-ups | 3,700\n```\n\n## Growth\n```chart\nvalues: 1, 2\n```\n\nNotes here.\n\n```chart\ntype: donut\nvalues: 1, 2\n```", "Untitled");
  expect(html).toContain("<h1>Launch</h1>");
  expect(html).toContain('<p class="dash-lede">Six weeks in</p>');
  expect(html).toContain('<h2 class="eyebrow">Growth</h2>');
  expect(html.match(/span-half/g)).toHaveLength(1);
  expect(html.match(/span-note/g)).toHaveLength(1);
  expect(html.match(/span-all/g)!.length).toBeGreaterThanOrEqual(2);
  expect(fillRows(['<div class="k-card span-half">', '<div class="k-card span-all">', '<div class="k-card span-third">'])).toEqual(['<div class="k-card span-all">', '<div class="k-card span-all">', '<div class="k-card span-all">']);
});

test("the frame draws the ready kinds, and Export inlines their kit files", () => {
  expect(FOUNDRY_KIT["kinds.css"]!.path).toBe("kit/kinds.css");
  expect(FOUNDRY_KIT["kinds.js"]!.path).toBe("kit/kinds.js");
  const page = foundryDocument("deck", "# Hello", "Hello");
  expect(page).toContain('data-kind="deck"');
  const out = exportedSource(page, { style: "body{}", script: "anime", kinds: { style: ".slide{}", script: "deck()</script>" } });
  expect(out).toContain("<style>\n.slide{}</style>");
  expect(out).toContain("<script>deck()<\\/script></script>");
  expect(out).not.toContain("foundry://kit/kinds");
  expect(out).not.toContain("foundry://kit/base.css");
});

test("a new version's first show carries the previous one, for outlining what changed", () => {
  const page = withChanges("<!doctype html><body><h1>New</h1></body></html>", "<body><h1>Old</h1><script>x</script></body>");
  expect(page.indexOf("__demesneChangedFrom")).toBeLessThan(page.lastIndexOf("</body>"));
  expect(page).toContain(CHANGED_SCRIPT);
  // The previous page can't close the script that carries it.
  expect(page).not.toContain("<script>x</script>");
  expect(page).toContain("\\u003cscript>x\\u003c/script>");
  expect(withChanges("<p>no body</p>", "<p>old</p>")).toStartWith("<p>no body</p>\n<script>");
});
