import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join, resolve } from "node:path";

interface SemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease?: string;
}

const root = resolve(import.meta.dir, "..");
const pkgPath = join(root, "package.json");

export function parseSemVer(str: string): SemVer {
  const clean = str.trim().replace(/^v/, "");
  const [core, prerelease] = clean.split("-", 2);
  const parts = core.split(".").map((n) => Number.parseInt(n, 10));
  if (parts.length !== 3 || parts.some((p) => Number.isNaN(p) || p < 0)) {
    throw new Error(`Invalid semver version: "${str}"`);
  }
  return {
    major: parts[0],
    minor: parts[1],
    patch: parts[2],
    prerelease,
  };
}

export function formatSemVer(v: SemVer): string {
  const base = `${v.major}.${v.minor}.${v.patch}`;
  return v.prerelease ? `${base}-${v.prerelease}` : base;
}

export function compareSemVer(a: SemVer, b: SemVer): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  if (a.prerelease && !b.prerelease) return -1;
  if (!a.prerelease && b.prerelease) return 1;
  return 0;
}

export function bumpSemVer(v: SemVer, type: "major" | "minor" | "patch"): SemVer {
  switch (type) {
    case "major":
      return { major: v.major + 1, minor: 0, patch: 0 };
    case "minor":
      return { major: v.major, minor: v.minor + 1, patch: 0 };
    case "patch":
      return { major: v.major, minor: v.minor, patch: v.patch + 1 };
  }
}

export function getLatestTag(): string | null {
  try {
    const proc = Bun.spawnSync(["git", "tag", "-l", "v*"], { cwd: root });
    if (proc.exitCode !== 0) return null;
    const stdout = proc.stdout.toString().trim();
    if (!stdout) return null;
    const tags = stdout
      .split("\n")
      .map((t) => t.trim())
      .filter((t) => /^v\d+\.\d+\.\d+/.test(t));
    if (!tags.length) return null;
    tags.sort((a, b) => compareSemVer(parseSemVer(a), parseSemVer(b)));
    return tags.at(-1) ?? null;
  } catch {
    return null;
  }
}

export function getCommitsSince(tag: string | null): string[] {
  try {
    const range = tag ? `${tag}..HEAD` : "HEAD";
    const proc = Bun.spawnSync(["git", "log", range, "--format=%s%n%b%n---COMMIT_END---"], { cwd: root });
    if (proc.exitCode !== 0) return [];
    return proc.stdout
      .toString()
      .split("---COMMIT_END---")
      .map((c) => c.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function inferBumpType(commits: string[]): "major" | "minor" | "patch" {
  let hasMinor = false;
  for (const commit of commits) {
    if (/BREAKING[ -]CHANGE:/i.test(commit) || /^[a-z]+(\([^\)]+\))?!:/m.test(commit)) {
      return "major";
    }
    if (/^(feat|feature)(\([^\)]+\))?:/im.test(commit) || /^Add /m.test(commit)) {
      hasMinor = true;
    }
  }
  return hasMinor ? "minor" : "patch";
}

export function getCurrentPackageVersion(): string {
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  return pkg.version ?? "0.1.0";
}

export function setPackageVersion(version: string): void {
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  pkg.version = version;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf8");
}

// CLI Execution
if (import.meta.main) {
  const args = process.argv.slice(2);
  let explicitVersion: string | null = null;
  let bumpType: "major" | "minor" | "patch" | null = null;
  let write = false;
  let github = false;
  let mode: "current" | "next" | "tag" = "next";

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--current") mode = "current";
    else if (arg === "--next") mode = "next";
    else if (arg === "--tag") mode = "tag";
    else if (arg === "--write") write = true;
    else if (arg === "--github") github = true;
    else if (arg === "--bump" && args[i + 1]) {
      const b = args[++i];
      if (b === "major" || b === "minor" || b === "patch") bumpType = b;
      else throw new Error(`Unknown bump type: ${b}`);
    } else if (arg.startsWith("--bump=")) {
      const b = arg.slice("--bump=".length);
      if (b === "major" || b === "minor" || b === "patch") bumpType = b;
      else throw new Error(`Unknown bump type: ${b}`);
    } else if (arg === "--set" && args[i + 1]) {
      explicitVersion = args[++i].replace(/^v/, "");
    } else if (arg.startsWith("--set=")) {
      explicitVersion = arg.slice("--set=".length).replace(/^v/, "");
    }
  }

  const pkgVersion = getCurrentPackageVersion();
  const latestTag = getLatestTag();
  const baseVersion = latestTag ? latestTag.replace(/^v/, "") : pkgVersion;
  const parsedBase = parseSemVer(baseVersion);

  let targetVersion: string;

  if (explicitVersion) {
    targetVersion = formatSemVer(parseSemVer(explicitVersion));
  } else if (bumpType) {
    targetVersion = formatSemVer(bumpSemVer(parsedBase, bumpType));
  } else {
    const commits = getCommitsSince(latestTag);
    // If no new commits and we have a tag, keep current version unless pkg is ahead
    if (commits.length === 0 && latestTag) {
      targetVersion = formatSemVer(parsedBase);
    } else {
      const inferred = inferBumpType(commits);
      const bumped = bumpSemVer(parsedBase, inferred);
      // If package.json is already higher than bumped, honor package.json
      const parsedPkg = parseSemVer(pkgVersion);
      if (compareSemVer(parsedPkg, bumped) > 0) {
        targetVersion = formatSemVer(parsedPkg);
      } else {
        targetVersion = formatSemVer(bumped);
      }
    }
  }

  if (write) {
    setPackageVersion(targetVersion);
    console.log(`Updated package.json version to ${targetVersion}`);
  }

  const commits = getCommitsSince(latestTag);
  const shouldRelease = Boolean(explicitVersion || bumpType || commits.length > 0 || !latestTag);

  if (github && process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `version=${targetVersion}\n`, "utf8");
    appendFileSync(process.env.GITHUB_OUTPUT, `tag=v${targetVersion}\n`, "utf8");
    appendFileSync(process.env.GITHUB_OUTPUT, `previous_tag=${latestTag ?? ""}\n`, "utf8");
    appendFileSync(process.env.GITHUB_OUTPUT, `should_release=${shouldRelease ? "true" : "false"}\n`, "utf8");
    appendFileSync(process.env.GITHUB_OUTPUT, `commit_count=${commits.length}\n`, "utf8");
  }

  if (mode === "current") {
    console.log(latestTag ? latestTag.replace(/^v/, "") : pkgVersion);
  } else if (mode === "tag") {
    console.log(`v${targetVersion}`);
  } else {
    console.log(targetVersion);
  }
}
