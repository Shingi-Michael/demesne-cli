import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireDataDirectoryLock } from "../src/data-directory-lock.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("data directory lock", () => {
  test("excludes a second live daemon and releases idempotently", () => {
    const directory = workspace();
    const first = acquireDataDirectoryLock(directory);
    expect(() => acquireDataDirectoryLock(directory)).toThrow(`already in use by PID ${process.pid}`);
    first.release();
    first.release();
    const second = acquireDataDirectoryLock(directory);
    second.release();
  });

  test("claims a valid stale lock before acquiring", () => {
    const directory = workspace();
    const lockPath = join(directory, "daemon.lock");
    mkdirSync(lockPath, { mode: 0o700 });
    writeFileSync(join(lockPath, "owner.json"), JSON.stringify({
      pid: 2_147_483_647,
      nonce: "stale-owner",
      acquiredAt: "2026-01-01T00:00:00.000Z",
    }));
    const lock = acquireDataDirectoryLock(directory);
    lock.release();
  });
});

function workspace(): string {
  const directory = mkdtempSync(join(tmpdir(), "demesne-lock-test-"));
  temporaryDirectories.push(directory);
  return directory;
}
