import { describe, expect, test } from "bun:test";
import { checks, compareLines, contactSheet, QUALITY_CASES, score, summary, type PageResult, type Report } from "./foundry-quality.ts";

const plain = { sizes: 4, body: 14, lead: 1.86, rhythm: 0.96, aligned: 1, colours: 1, surface: 0.06 };
const designed = { sizes: 5, body: 12, lead: 3.1, rhythm: 0.92, aligned: 0.94, colours: 7, surface: 0.4 };
const page = (id: string, value: number | null): PageResult => ({ id, prompt: `ask ${id}`, title: value === null ? null : `Page ${id}`, kind: value === null ? null : "html", bytes: 2048, versions: 1,
  score: value, checks: value === null ? null : checks(designed, 0), design: value === null ? null : designed, issues: [], shots: [], seconds: 30, rounds: 3, outputTokens: 4000, calls: [], error: null });

describe("Foundry quality ruler", () => {
  test("twelve fixed asks with unique ids", () => {
    expect(QUALITY_CASES).toHaveLength(12);
    expect(new Set(QUALITY_CASES.map((item) => item.id)).size).toBe(12);
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
