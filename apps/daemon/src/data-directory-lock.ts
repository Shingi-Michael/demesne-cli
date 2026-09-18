import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface LockOwner {
  pid: number;
  nonce: string;
  acquiredAt: string;
}

export interface DataDirectoryLock {
  release(): void;
}

export function acquireDataDirectoryLock(dataDirectory: string): DataDirectoryLock {
  const lockPath = join(dataDirectory, "daemon.lock");
  const owner: LockOwner = { pid: process.pid, nonce: randomUUID(), acquiredAt: new Date().toISOString() };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      mkdirSync(lockPath, { mode: 0o700 });
      writeFileSync(join(lockPath, "owner.json"), JSON.stringify(owner), { flag: "wx", mode: 0o600 });
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          const current = readOwner(lockPath);
          if (current?.nonce !== owner.nonce) return;
          const releasePath = `${lockPath}.release-${owner.nonce}`;
          try {
            renameSync(lockPath, releasePath);
            rmSync(releasePath, { recursive: true, force: true });
          } catch {
            // A missing or replaced lock is not ours to remove.
          }
        },
      };
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      const current = readOwner(lockPath);
      if (!current) throw new Error(`Demesne data directory has an unreadable lock: ${lockPath}`);
      if (processExists(current.pid)) {
        throw new Error(`Demesne data directory is already in use by PID ${current.pid}`);
      }
      const stalePath = `${lockPath}.stale-${randomUUID()}`;
      try {
        renameSync(lockPath, stalePath);
        rmSync(stalePath, { recursive: true, force: true });
      } catch (claimError) {
        if (!isMissing(claimError)) throw claimError;
      }
    }
  }
  throw new Error(`Could not acquire Demesne data directory lock: ${lockPath}`);
}

function readOwner(lockPath: string): LockOwner | null {
  try {
    const value: unknown = JSON.parse(readFileSync(join(lockPath, "owner.json"), "utf8"));
    if (!value || typeof value !== "object") return null;
    const owner = value as Partial<LockOwner>;
    if (!Number.isSafeInteger(owner.pid) || (owner.pid ?? 0) <= 0 || typeof owner.nonce !== "string" || !owner.nonce) {
      return null;
    }
    return { pid: owner.pid!, nonce: owner.nonce, acquiredAt: typeof owner.acquiredAt === "string" ? owner.acquiredAt : "" };
  } catch {
    return null;
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
