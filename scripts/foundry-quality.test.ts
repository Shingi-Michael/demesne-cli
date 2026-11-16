import { describe, expect, test } from "bun:test";
import { checks, compareLines, contactSheet, fitOf, holds, QUALITY_CASES, score, summary, type PageResult, type Report } from "./foundry-quality.ts";

const plain = { sizes: 4, body: 14, lead: 1.86, rhythm: 0.96, aligned: 1, colours: 1, surface: 0.06 };
const designed = { sizes: 5, body: 12, lead: 3.1, rhythm: 0.92, aligned: 0.94, colours: 7, surface: 0.4 };
const page = (id: string, value: number | null): PageResult => ({ id, prompt: `ask ${id}`, title: value === null ? null : `Page ${id}`, kind: value === null ? null : "html", bytes: 2048, versions: 1,
  score: value, checks: value === null ? null : checks(designed, 0), design: value === null ? null : designed, issues: [], shots: [], seconds: 30, rounds: 3, outputTokens: 4000, calls: [], error: null });

describe("Foundry quality ruler", () => {
  test("twelve whole-page asks, three small ones and two reviews, with unique ids", () => {
    expect(QUALITY_CASES).toHaveLength(17);
    expect(new Set(QUALITY_CASES.map((item) => item.id)).size).toBe(17);
    expect(QUALITY_CASES.filter((item) => item.fit?.review).map((item) => item.id)).toEqual(["review-settings", "review-sidebar"]);
    expect(QUALITY_CASES.slice(0, 12).some((item) => item.id.startsWith("small-"))).toBe(false);
    expect(QUALITY_CASES.filter((item) => item.id.startsWith("small-")).every((item) => item.fit?.surface?.includes("part"))).toBe(true);
  });
  test("a small part is not marked down for being small", () => {
    const pin = { sizes: 1, body: 14, lead: 1, rhythm: 0.95, aligned: 0.9, colours: 2, surface: 0.02 };
    expect(score(checks(pin, 0))).toBeLessThan(60);
    expect(score(checks(pin, 0, "part"))).toBe(100);
    expect(checks({ ...pin, sizes: 12 }, 0, "part").sizes).toBe(0);
    // The old flag still means an app window.
    expect(checks(pin, 0, true).lead).toBe(1);
    expect(checks(pin, 0, true).sizes).toBe(0.5);
  });
  test("what a page holds is counted from its markup, not its scripts", () => {
    const held = holds(`<style>button{}</style><d-compare><section data-option="Today"></section><section data-option="Quiet"></section><section data-option='Bare'></section></d-compare>`
      + `<dialog><form><input><button>Save</button></form></dialog><div role="dialog" aria-modal="true"></div><script>const a = "<button><form>";</script>`);
    expect(held.options).toBe(2);
    expect(held.forms).toBe(1);
    expect(held.controls).toBe(2);
    expect(held.dialogs).toBe(2);
  });
  test("as asked: the little dashboard that grew is caught, the one that kept to the ask is not", () => {
    const ask = QUALITY_CASES.find((item) => item.id === "dashboard")!.fit!;
    const kept = `<main><h1>42 km this week</h1><svg></svg><p>Next race: Two Oceans, 12 April</p></main>`;
    expect(fitOf(ask, { source: kept })).toEqual({ score: 1, misses: [] });
    const grew = kept + `<button>Log a run</button><button>Edit race</button><dialog><form><input><input><button>Save run</button></form></dialog><dialog><form><input><button>Save race</button></form></dialog>`;
    const fit = fitOf(ask, { source: grew });
    expect(fit.score).toBeLessThanOrEqual(0.6);
    expect(fit.misses.join(" ")).toContain("2 dialogs");
    expect(fit.misses.join(" ")).toContain("2 forms");
  });
  test("as asked: two versions means two, and a small thing sits on a part", () => {
    const two = QUALITY_CASES.find((item) => item.id === "demesne-topbar")!.fit!;
    const options = (names: string[]) => `<d-compare>${names.map((name) => `<section data-option="${name}"></section>`).join("")}</d-compare>`;
    expect(fitOf(two, { source: options(["Today", "Quiet", "Bare"]) }).misses).toEqual([]);
    expect(fitOf(two, { source: options(["Today", "Quiet", "Bare", "Hidden"]) }).misses).toEqual(["3 versions, 2 asked for"]);
    const toast = QUALITY_CASES.find((item) => item.id === "small-toast")!.fit!;
    const source = `<div role="status">File saved <button>Undo</button></div>`;
    expect(fitOf(toast, { source, surface: "part" }).score).toBe(1);
    expect(fitOf(toast, { source, surface: "browser" }).misses).toEqual(["asked for part, saved as browser"]);
  });
  test("as asked: an open design question is owed two or three options and a pick", () => {
    const ask = QUALITY_CASES.find((item) => item.id === "small-pin")!.fit!;
    const options = (names: string[], pick = "") => `<d-compare${pick ? ` recommended="${pick}"` : ""}>${names.map((name) => `<section data-option="${name}"><button>pin</button></section>`).join("")}</d-compare>`;
    expect(fitOf(ask, { source: options(["On hover", "Always", "On the right"], "On hover"), surface: "part" }).misses).toEqual([]);
    expect(fitOf(ask, { source: `<button>pin</button>`, surface: "part" }).misses).toEqual(["no options, two or three with a pick are owed"]);
    expect(fitOf(ask, { source: options(["On hover", "Always"]), surface: "part" }).misses).toEqual(["options with no pick"]);
  });
  test("as asked: a review is one sheet with the screen today and parts that each hold Today, options and a pick", () => {
    const ask = QUALITY_CASES.find((item) => item.id === "review-settings")!.fit!;
    const part = (name: string, options: string[]) => `<section data-part="${name}" why="What is wrong."><d-compare recommended="${options[1]}">${options.map((option) => `<section data-option="${option}">x</section>`).join("")}</d-compare></section>`;
    const sheet = (parts: string[]) => `<d-review><section data-today marks=".a | .b | .c | .d">screen</section>${parts.join("")}</d-review>`;
    expect(fitOf(ask, { source: sheet([part("Rows", ["Today", "A", "B"]), part("Save", ["Today", "A", "B", "C"])]) })).toEqual({ score: 1, misses: [] });
    // A whole redrawn page is not a review.
    expect(fitOf(ask, { source: `<d-demesne page="Settings"></d-demesne>` }).score).toBe(0);
    const four = fitOf(ask, { source: sheet(["One", "Two", "Three", "Four"].map((name) => part(name, ["Today", "A", "B"]))) });
    expect(four.score).toBe(0.5);
    expect(four.misses).toEqual(["This review has 4 parts; at most 3."]);
  });
  test("the report says how far the pages are what was asked, and names the misses", () => {
    const a = { ...page("a", 90), fit: { score: 0.5, misses: ["2 dialogs, at most 0 asked for"] } }, b = { ...page("b", null), fit: { score: 1, misses: [] } };
    const report: Report = { model: "m", when: "now", label: "test", results: [a, b, page("c", 80)] };
    expect(summary(report).fit).toBe(25);
    const lines = compareLines(report).join("\n");
    expect(lines).toContain("As asked 25");
    expect(lines).toContain("not as asked: a: 2 dialogs");
    expect(summary({ ...report, results: [page("c", 80)] }).fit).toBeNull();
    expect(contactSheet(report)).toContain("as asked 50%");
  });
  test("a designed page outscores plain text on paper", () => {
    expect(score(checks(designed, 0))).toBe(100);
    expect(score(checks(plain, 0))).toBeLessThan(75);
  });
  test("faults and a pile of sizes cost points", () => {
    expect(checks(designed, 3).faults).toBe(0.5);
    expect(checks(designed, 9).faults).toBe(0);
    expect(checks({ ...designed, sizes: 12 }, 0).sizes).toBe(0);
    expect(checks({ ...designed, colours: 20 }, 0).colours).toBe(0);
  });
  test("a page that wasn't made counts zero in the total", () => {
    const report: Report = { model: "m", when: "now", label: "test", results: [page("a", 90), page("b", null)] };
    expect(summary(report).score).toBe(45);
    expect(summary(report).made).toBe(1);
  });
  test("compare shows before and after, and the sheet escapes text", () => {
    const before: Report = { model: "m", when: "then", label: "main", results: [page("a", 60)] };
    const after: Report = { model: "m", when: "now", label: "<parts>", results: [page("a", 90)] };
    expect(compareLines(after, before)[0]).toContain("60 → 90");
    expect(compareLines(after, before).at(-1)).toContain("a");
    expect(contactSheet(after, before)).toContain("&lt;parts&gt;");
  });
});
