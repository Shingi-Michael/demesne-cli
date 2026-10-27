import { describe, expect, test } from "bun:test";
import {
  parseSemVer,
  formatSemVer,
  compareSemVer,
  bumpSemVer,
  inferBumpType,
} from "./version.ts";

describe("version parsing and manipulation", () => {
  test("parseSemVer parses valid semver strings with and without v prefix", () => {
    expect(parseSemVer("0.1.0")).toEqual({ major: 0, minor: 1, patch: 0, prerelease: undefined });
    expect(parseSemVer("v1.2.3")).toEqual({ major: 1, minor: 2, patch: 3, prerelease: undefined });
    expect(parseSemVer("v2.0.0-beta.1")).toEqual({ major: 2, minor: 0, patch: 0, prerelease: "beta.1" });
  });

  test("parseSemVer throws on invalid strings", () => {
    expect(() => parseSemVer("invalid")).toThrow();
    expect(() => parseSemVer("1.2")).toThrow();
    expect(() => parseSemVer("1.2.3.4")).toThrow();
  });

  test("formatSemVer formats semver correctly", () => {
    expect(formatSemVer({ major: 1, minor: 0, patch: 2 })).toBe("1.0.2");
    expect(formatSemVer({ major: 1, minor: 0, patch: 2, prerelease: "alpha" })).toBe("1.0.2-alpha");
  });

  test("compareSemVer sorts versions correctly", () => {
    const v1 = parseSemVer("0.1.0");
    const v2 = parseSemVer("0.1.1");
    const v3 = parseSemVer("0.2.0");
    const v4 = parseSemVer("1.0.0");
    expect(compareSemVer(v1, v2)).toBeLessThan(0);
    expect(compareSemVer(v2, v1)).toBeGreaterThan(0);
    expect(compareSemVer(v2, v3)).toBeLessThan(0);
    expect(compareSemVer(v3, v4)).toBeLessThan(0);
    expect(compareSemVer(v1, v1)).toBe(0);
  });

  test("bumpSemVer increments major, minor, or patch correctly", () => {
    const base = parseSemVer("0.1.2");
    expect(formatSemVer(bumpSemVer(base, "patch"))).toBe("0.1.3");
    expect(formatSemVer(bumpSemVer(base, "minor"))).toBe("0.2.0");
    expect(formatSemVer(bumpSemVer(base, "major"))).toBe("1.0.0");
  });

  test("inferBumpType infers semver bump from commit messages", () => {
    expect(inferBumpType(["fix: typo in readme", "docs: update install"])).toBe("patch");
    expect(inferBumpType(["feat: add hot reloading of daemon and ui"])).toBe("minor");
    expect(inferBumpType(["Add Foundry for creating artifacts"])).toBe("minor");
    expect(inferBumpType(["feat!: remove old legacy api", "fix: something"])).toBe("major");
    expect(inferBumpType(["BREAKING CHANGE: drop node 18 support"])).toBe("major");
  });
});
