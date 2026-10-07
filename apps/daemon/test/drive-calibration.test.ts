import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DriveFix, DriveProposal } from "@demesne/protocol";
import { applyCalibration, calibrate, CalibrationLog, outcomeOf, scoreProposal, type CalibrationRecord } from "../src/drive-calibration.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const record = (confidence: CalibrationRecord["confidence"], outcome: CalibrationRecord["outcome"], minutes = 10, actualMinutes: number | null = null): CalibrationRecord =>
  ({ at: "now", workspace: "/w", proposalId: "p", kind: "fix", confidence, minutes, actualMinutes, outcome });
const fix = (status: DriveFix["status"], extra: Partial<DriveFix> = {}) =>
  ({ id: "f", workspace: "/w", title: "T", signals: [], proposal: { id: "p", kind: "fix", title: "T", why: "W", minutes: 10, confidence: "high" }, branch: "b", path: "/p", base: "abc",
    sessionId: null, turnId: null, status, startedAt: "2026-10-07T00:00:00.000Z", finishedAt: "2026-10-07T00:12:00.000Z", ...extra }) as DriveFix;
const proposal = (title: string, confidence: DriveProposal["confidence"], minutes: number, value = 3): DriveProposal =>
  ({ id: title, kind: "fix", title, why: "", evidence: ["s"], minutes, coders: 1, confidence, value, urgent: false, score: scoreProposal({ value, confidence, minutes, coders: 1 }, false) });

test("outcomes: applied and PR land, a reviewed discard misses, a correct no-change investigation says nothing", () => {
  expect(outcomeOf(fix("applied"), "ready")).toBe("landed");
  expect(outcomeOf(fix("pr"), "ready")).toBe("landed");
  expect(outcomeOf(fix("discarded"), "ready")).toBe("discarded");
  expect(outcomeOf(fix("discarded"), "failed")).toBe("failed");
  expect(outcomeOf(fix("discarded", { unchanged: true }), "failed")).toBe("unchanged");
  expect(outcomeOf(fix("discarded", { unchanged: true, proposal: { id: "p", kind: "investigate", title: "T", why: "W" } }), "failed")).toBeNull();
  expect(outcomeOf(fix("ready"), "running")).toBeNull();
});

test("calibration: a few outcomes move each level from its prior, time scales only once enough runs are timed", () => {
  const empty = calibrate([]);
  expect(empty.levels).toEqual({ high: { landed: 0, total: 0, weight: 1 }, medium: { landed: 0, total: 0, weight: 0.7 }, low: { landed: 0, total: 0, weight: 0.4 } });
  expect(empty.timeRatio).toBe(1);
  // Two missed high-confidence picks: (0 + 1·3) / (2 + 3).
  const missed = calibrate([record("high", "discarded", 10, 30), record("high", "failed"), record("low", "landed", 10, 30)]);
  expect(missed.levels.high).toEqual({ landed: 0, total: 2, weight: 0.6 });
  expect(missed.levels.low).toEqual({ landed: 1, total: 1, weight: 0.55 });
  expect(missed).toMatchObject({ landed: 1, total: 3, timed: 2, timeRatio: 1 });
  // Three timed runs: the median ratio, clamped to 0.25–4.
  expect(calibrate([record("high", "landed", 10, 30), record("high", "landed", 10, 20), record("high", "landed", 10, 500)]).timeRatio).toBe(3);
  expect(calibrate([record("high", "landed", 10, 500), record("high", "landed", 10, 500), record("high", "landed", 10, 500)]).timeRatio).toBe(4);
});

test("a calibrated queue re-ranks: a level that keeps missing sinks, and estimates are scaled", () => {
  const queue = [proposal("Confident", "high", 30), proposal("Careful", "medium", 30)].sort((a, b) => b.score - a.score);
  expect(queue.map((item) => item.title)).toEqual(["Confident", "Careful"]);
  expect(applyCalibration(queue, null)).toBe(queue);
  const calibration = calibrate([...Array.from({ length: 4 }, () => record("high", "discarded", 10, 20)), ...Array.from({ length: 4 }, () => record("medium", "landed", 10, 20))]);
  const ranked = applyCalibration(queue, calibration);
  expect(ranked.map((item) => item.title)).toEqual(["Careful", "Confident"]);
  expect(ranked.map((item) => item.expectedMinutes)).toEqual([60, 60]);
  expect(ranked[0]!.minutes).toBe(30);
});

test("the log keeps each workspace's outcomes and skips runs that aren't proposals", () => {
  const root = mkdtempSync(join(tmpdir(), "drive-calibration-")); roots.push(root);
  const log = new CalibrationLog(join(root, "data", "drive-calibration.jsonl"));
  expect(log.calibration("/w")).toBeNull();
  log.settle(fix("applied"), "ready");
  log.settle(fix("discarded", { proposal: undefined }), "ready");
  log.settle(fix("discarded", { workspace: "/other" }), "ready");
  expect(log.records("/w")).toEqual([expect.objectContaining({ outcome: "landed", confidence: "high", minutes: 10, actualMinutes: 12 })]);
  expect(log.calibration("/other")).toMatchObject({ landed: 0, total: 1 });
});
