import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { appBundle, buildParts, isDemesneSource, SelfBuilder, swapScript } from "../self-build.ts";

function source(): { root: string; commit: string } {
  const root = mkdtempSync(join(tmpdir(), "demesne-self-"));
  mkdirSync(join(root, "apps/desktop/electron"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "demesne" }));
  writeFileSync(join(root, "apps/desktop/electron/main.ts"), "");
  const git = (...args: string[]) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: root, encoding: "utf8" }).stdout.trim();
  git("init", "-q"); git("add", "."); git("commit", "-qm", "one");
  return { root, commit: git("rev-parse", "--short", "HEAD") };
}

describe("Demesne rebuilding itself", () => {
  test("reads the app's build id as its commit and build time", () => {
    expect(buildParts("c81831c.mvw2vmza")).toEqual({ commit: "c81831c", at: parseInt("mvw2vmza", 36) });
    expect(buildParts("")).toBeNull();
    expect(buildParts("dev.123")).toBeNull();
  });

  test("knows the installed Mac app from the host's path", () => {
    expect(appBundle("/Users/m/Applications/Demesne.app/Contents/Resources/backend/demesne-host")).toBe("/Users/m/Applications/Demesne.app");
    expect(appBundle("/home/m/demesne/apps/desktop/build/backend/demesne-host")).toBeNull();
  });

  test("only Demesne's own source counts, and a folder behind the app can't rebuild it", () => {
    const { root, commit } = source();
    expect(isDemesneSource(root)).toBe(true);
    const other = mkdtempSync(join(tmpdir(), "demesne-other-"));
    writeFileSync(join(other, "package.json"), JSON.stringify({ name: "shop" }));
    expect(isDemesneSource(other)).toBe(false);
    const options = { execPath: "/Applications/Demesne.app/Contents/Resources/backend/demesne-host", home: "/nowhere", logDir: () => root, platform: "darwin", changed: () => {} };
    const current = new SelfBuilder({ ...options, app: `${commit}.mvw2vmza` }).view(root);
    expect(current).toMatchObject({ source: true, behind: false, can: true, state: "idle" });
    // An app built from a commit this folder doesn't have.
    expect(new SelfBuilder({ ...options, app: "abcdef1.mvw2vmza" }).view(root)).toMatchObject({ source: true, behind: true, can: false });
    expect(new SelfBuilder({ ...options, app: `${commit}.mvw2vmza`, platform: "linux" }).view(root).can).toBe(false);
    expect(new SelfBuilder({ ...options, app: `${commit}.mvw2vmza` }).view(other)).toMatchObject({ source: false, can: false });
  });

  test("the swap waits for the app to quit, keeps the old one and puts it back if the copy fails", () => {
    const script = swapScript(42, "/A/Demesne.app", "/src/release/mac-arm64/Demesne.app", "/A/Demesne.app.prev");
    expect(script).toContain("while kill -0 42");
    expect(script).toContain("mv '/A/Demesne.app' '/A/Demesne.app.prev' || { open '/A/Demesne.app'; exit 1; }");
    expect(script).toContain("cp -R '/src/release/mac-arm64/Demesne.app' '/A/Demesne.app' || { rm -rf '/A/Demesne.app'; mv '/A/Demesne.app.prev' '/A/Demesne.app'; }");
    expect(script.trim().endsWith("open '/A/Demesne.app'")).toBe(true);
  });
});
