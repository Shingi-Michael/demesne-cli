import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/// Cached update check for `demesne --version`.
///
/// The result is cached for a day, network failures are silent, and scripts
/// (non-TTY stdout) skip the check unless `--check` is explicit. Opt out with
/// `DEMESNE_NO_UPDATE_CHECK=1`.

export const UPDATE_CHECK_TTL_MS = 24 * 60 * 60 * 1_000;
export const UPDATE_CHECK_REPOSITORY = "Shingi-Michael/demesne-cli";

export interface UpdateCheckResult {
  latest: string | null;
  updateAvailable: boolean;
  checkedAt: string | null;
  skipped: boolean;
}

export interface UpdateCheckOptions {
  currentVersion: string;
  cachePath: string | null;
  fetch?: typeof fetch;
  now?: () => number;
  env?: Record<string, string | undefined>;
  repository?: string;
}

export async function checkForUpdate(options: UpdateCheckOptions): Promise<UpdateCheckResult> {
  const env = options.env ?? process.env;
  if (env.DEMESNE_NO_UPDATE_CHECK === "1" || env.DEMESNE_NO_UPDATE_CHECK === "true") {
    return { latest: null, updateAvailable: false, checkedAt: null, skipped: true };
  }

  const now = (options.now ?? Date.now)();
  const cached = readCache(options.cachePath);
  if (cached && now - Date.parse(cached.checkedAt) < UPDATE_CHECK_TTL_MS) {
    return {
      latest: cached.latest,
      updateAvailable: cached.latest ? isNewer(cached.latest, options.currentVersion) : false,
      checkedAt: cached.checkedAt,
      skipped: false,
    };
  }

  try {
    const response = await (options.fetch ?? fetch)(
      `https://api.github.com/repos/${options.repository ?? UPDATE_CHECK_REPOSITORY}/releases/latest`,
      {
        headers: { Accept: "application/vnd.github+json" },
        signal: AbortSignal.timeout(2_000),
      },
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json() as { tag_name?: unknown };
    const latest = typeof body.tag_name === "string" ? body.tag_name.replace(/^v/, "") : null;
    const checkedAt = new Date(now).toISOString();
    writeCache(options.cachePath, { latest, checkedAt });
    return {
      latest,
      updateAvailable: latest ? isNewer(latest, options.currentVersion) : false,
      checkedAt,
      skipped: false,
    };
  } catch {
    return { latest: null, updateAvailable: false, checkedAt: null, skipped: false };
  }
}

/// Numeric component comparison. Pre-release suffixes are ignored, which is
/// sufficient for the project's plain semantic versions.
export function isNewer(candidate: string, current: string): boolean {
  const parse = (value: string) => value
    .split(/[.-]/)
    .map((part) => Number(part))
    .filter((part) => Number.isFinite(part));
  const left = parse(candidate);
  const right = parse(current);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    if (a !== b) return a > b;
  }
  return false;
}

interface CacheEntry {
  latest: string | null;
  checkedAt: string;
}

function readCache(path: string | null): CacheEntry | null {
  if (!path || !existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<CacheEntry>;
    if (typeof value.checkedAt === "string" && Number.isFinite(Date.parse(value.checkedAt))) {
      return {
        latest: typeof value.latest === "string" ? value.latest : null,
        checkedAt: value.checkedAt,
      };
    }
  } catch {
    // A corrupt cache is treated as absent.
  }
  return null;
}

function writeCache(path: string | null, entry: CacheEntry): void {
  if (!path) return;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
  } catch {
    // The cache is an optimization; failing to write it is not an error.
  }
}
