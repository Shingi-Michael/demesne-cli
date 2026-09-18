import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkForUpdate, isNewer, UPDATE_CHECK_TTL_MS } from "../src/update-check.ts";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "demesne-update-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("isNewer", () => {
  test("compares numeric version components", () => {
    expect(isNewer("0.2.0", "0.1.0")).toBe(true);
    expect(isNewer("0.1.1", "0.1.0")).toBe(true);
    expect(isNewer("1.0.0", "0.9.9")).toBe(true);
    expect(isNewer("0.1.0", "0.1.0")).toBe(false);
    expect(isNewer("0.1.0", "0.2.0")).toBe(false);
  });
});

describe("checkForUpdate", () => {
  test("fetches, reports, and caches the latest release", async () => {
    const directory = temporaryDirectory();
    const cachePath = join(directory, "update-check.json");
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ tag_name: "v0.2.0" }), { status: 200 });
    }) as unknown as typeof fetch;
    const now = Date.parse("2026-01-01T00:00:00.000Z");

    const first = await checkForUpdate({ currentVersion: "0.1.0", cachePath, fetch: fetchImpl, now: () => now, env: {} });
    expect(first).toMatchObject({ latest: "0.2.0", updateAvailable: true, skipped: false });
    expect(calls).toBe(1);
    expect(JSON.parse(readFileSync(cachePath, "utf8"))).toMatchObject({ latest: "0.2.0" });

    const second = await checkForUpdate({ currentVersion: "0.1.0", cachePath, fetch: fetchImpl, now: () => now, env: {} });
    expect(second.updateAvailable).toBe(true);
    expect(calls).toBe(1);

    const later = await checkForUpdate({
      currentVersion: "0.1.0",
      cachePath,
      fetch: fetchImpl,
      now: () => now + UPDATE_CHECK_TTL_MS + 1,
      env: {},
    });
    expect(later.updateAvailable).toBe(true);
    expect(calls).toBe(2);
  });

  test("stays silent on network failures", async () => {
    const directory = temporaryDirectory();
    const fetchImpl = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    const result = await checkForUpdate({
      currentVersion: "0.1.0",
      cachePath: join(directory, "update-check.json"),
      fetch: fetchImpl,
      env: {},
    });
    expect(result).toEqual({ latest: null, updateAvailable: false, checkedAt: null, skipped: false });
  });

  test("respects the environment opt-out without fetching", async () => {
    const directory = temporaryDirectory();
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const result = await checkForUpdate({
      currentVersion: "0.1.0",
      cachePath: join(directory, "update-check.json"),
      fetch: fetchImpl,
      env: { DEMESNE_NO_UPDATE_CHECK: "1" },
    });
    expect(result.skipped).toBe(true);
    expect(calls).toBe(0);
  });
});
