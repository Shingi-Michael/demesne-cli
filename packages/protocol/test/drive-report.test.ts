import { expect, test } from "bun:test";
import { formatDriveReport, parseDriveReport } from "../src/drive-report.ts";

test("a Drive report reads back as the receipt it was written from", () => {
  const report = { title: "Make the parser strict", fix: "f1", chat: "s-mission", branch: "drive/mission-make-1a2b", status: "ready" as const,
    diff: { files: 2, additions: 12, deletions: 3, paths: ["parser.ts", "parser.test.ts"] }, headline: "1 of 1 task verified · 1 check passing",
    summary: "Parser is strict now.\n\nThe tests cover the old loose case." };
  const content = formatDriveReport(report);
  expect(content.startsWith("Drive report: Make the parser strict\n")).toBe(true);
  // The chat's model is told what it is and to answer briefly without tools.
  expect(content).toContain("use no tools");
  expect(parseDriveReport(content)).toEqual(report);
  const { diff: _diff, headline: _headline, ...bare } = report;
  expect(parseDriveReport(formatDriveReport({ ...bare, status: "failed", summary: "" }))).toEqual({ ...bare, status: "failed", summary: "Drive gave no summary." });
  expect(parseDriveReport("Make the parser strict")).toBeNull();
});
