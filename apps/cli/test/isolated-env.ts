import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/// Environment for a spawned CLI that cannot see the developer's own setup:
/// a fresh HOME, so ~/.demesne config, history and caches are absent, and no
/// inherited DEMESNE_* overrides. Tests add what they need through `extra`,
/// including their own HOME when they already manage a temporary directory.
export function isolatedCliEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith("DEMESNE_")) env[key] = value;
  }
  return { ...env, HOME: extra.HOME ?? mkdtempSync(join(tmpdir(), "demesne-home-")), ...extra };
}
