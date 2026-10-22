import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DriveAwayRequest, DriveProposal } from "@demesne/protocol";
import { AUTO_RUNS_PER_DAY, DriveAutoRuns, type DriveAutoHost } from "../src/drive-auto.ts";

const idea = (id: string): DriveProposal => ({ id, kind: "tidy", title: `Tidy ${id}`, why: "It's untidy.", evidence: [], minutes: 5, confidence: "high", coders: 1, urgent: false, value: 1, cost: 1 } as never);

function setup(overrides: Partial<DriveAutoHost> = {}) {
  let now = Date.parse("2026-10-21T10:00:00Z");
  const started: (DriveAwayRequest & { auto: true })[] = [];
  const host: DriveAutoHost = {
    workspaces: () => ["/w"], trusted: () => true, busy: () => false,
    lastActivity: () => now - 25 * 60_000,
    ideas: () => ({ generatedAt: new Date(now - 60_000).toISOString(), proposals: ["A", "B", "C", "D", "E"].map(idea), signals: [] }),
    start: (request) => { started.push(request); },
    ...overrides,
  };
  const file = join(mkdtempSync(join(tmpdir(), "drive-auto-")), "drive-auto.json");
  // The daemon has been up for a while.
  now -= 60 * 60_000;
  const auto = new DriveAutoRuns(file, host, () => now);
  now += 60 * 60_000;
  return { auto, started, file, host, advance: (ms: number) => { now += ms; } };
}

test("a quiet project runs its top idea on its own, one new idea each time", () => {
  const { auto, started } = setup();
  expect(auto.state("/w")).toMatchObject({ on: true, usedToday: 0 });
  expect(auto.tick()).toEqual(["/w"]);
  expect(started.map((request) => [request.auto, request.items.map((item) => item.proposal.title)])).toEqual([[true, ["Tidy A"]]]);
  auto.tick();
  expect(started.at(-1)!.items[0]!.proposal.title).toBe("Tidy B");
  expect(auto.state("/w").usedToday).toBe(2);
});

test("it stops at the daily limit and starts again the next day", () => {
  const { auto, started, advance } = setup();
  for (let index = 0; index < AUTO_RUNS_PER_DAY + 2; index++) auto.tick();
  expect(started).toHaveLength(AUTO_RUNS_PER_DAY);
  advance(24 * 3_600_000);
  expect(auto.tick()).toEqual(["/w"]);
  expect(started.at(-1)!.items[0]!.proposal.title).toBe("Tidy D");
});

test("it waits while you're working, while Drive is busy, and in projects you left", () => {
  const busy = setup({ busy: () => true });
  expect(busy.auto.tick()).toEqual([]);
  const recent = setup({ lastActivity: () => Date.parse("2026-10-21T09:50:00Z") });
  expect(recent.auto.tick()).toEqual([]);
  const working = setup({ lastActivity: () => null });
  expect(working.auto.tick()).toEqual([]);
  const left = setup({ lastActivity: () => Date.parse("2026-10-20T08:00:00Z") });
  expect(left.auto.tick()).toEqual([]);
  const untrusted = setup({ trusted: () => false });
  expect(untrusted.auto.tick()).toEqual([]);
  const stale = setup({ ideas: () => ({ generatedAt: "2026-10-20T08:00:00Z", proposals: [idea("A")], signals: [] }) });
  expect(stale.auto.tick()).toEqual([]);
});

test("the switch turns it off for one project and is remembered", () => {
  const { auto, started, file, host } = setup();
  expect(auto.set("/w", false).on).toBe(false);
  expect(auto.tick()).toEqual([]);
  expect(started).toEqual([]);
  let clock = Date.parse("2026-10-21T09:00:00Z");
  const reopened = new DriveAutoRuns(file, host, () => clock);
  clock = Date.parse("2026-10-21T10:00:00Z");
  expect(reopened.state("/w").on).toBe(false);
  expect(reopened.set("/w", true).on).toBe(true);
  expect(reopened.tick()).toEqual(["/w"]);
});

test("a daemon that just started waits out its own quiet minutes first", () => {
  let now = Date.parse("2026-10-21T10:00:00Z");
  const started: unknown[] = [];
  const host: DriveAutoHost = {
    workspaces: () => ["/w"], trusted: () => true, busy: () => false,
    lastActivity: () => Date.parse("2026-10-21T08:00:00Z"),
    ideas: () => ({ generatedAt: new Date(now).toISOString(), proposals: [idea("A")], signals: [] }),
    start: (request) => { started.push(request); },
  };
  const auto = new DriveAutoRuns(join(mkdtempSync(join(tmpdir(), "drive-auto-")), "drive-auto.json"), host, () => now);
  expect(auto.tick()).toEqual([]);
  now += 19 * 60_000;
  expect(auto.tick()).toEqual([]);
  now += 2 * 60_000;
  expect(auto.tick()).toEqual(["/w"]);
});
