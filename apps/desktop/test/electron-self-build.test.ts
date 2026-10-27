import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builtApp, demesneProject, findBun, installedBundle, isDemesneProject, swapScript } from "../electron/self-build.ts";

test("only Demesne itself, with the script that builds its page, counts", () => {
  const root = mkdtempSync(join(tmpdir(), "demesne-self-"));
  expect(isDemesneProject(root)).toBe(false);
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "demesne-cli" }));
  // Demesne by name, but a checkout from before the page builder: the line can say so.
  expect(isDemesneProject(root)).toBe(false);
  expect(demesneProject(root)).toBe("behind");
  mkdirSync(join(root, "scripts"));
  writeFileSync(join(root, "scripts/prepare-ui.ts"), "");
  expect(isDemesneProject(root)).toBe(true);
  expect(demesneProject(root)).toBe("yes");
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "something-else" }));
  expect(isDemesneProject(root)).toBe(false);
  expect(demesneProject(root)).toBe("no");
  expect(demesneProject(join(root, "missing"))).toBe("no");
});

test("Bun is found on the PATH, where its installer puts it, or where DEMESNE_BUN says", () => {
  const have = new Set(["/opt/homebrew/bin/bun", "/Users/mike/.bun/bin/bun"]);
  const exists = (path: string) => have.has(path);
  expect(findBun({ PATH: "/usr/bin:/bin", HOME: "/Users/mike" }, exists, "darwin")).toBe("/Users/mike/.bun/bin/bun");
  expect(findBun({ PATH: "/usr/bin:/bin", HOME: "/Users/nobody" }, exists, "darwin")).toBe("/opt/homebrew/bin/bun");
  expect(findBun({ PATH: "/usr/bin", HOME: "/home/x" }, () => false, "linux")).toBeNull();
  expect(findBun({ DEMESNE_BUN: "/somewhere/bun" }, () => false, "linux")).toBe("/somewhere/bun");
});

test("Keep knows the built app and the installed one on the Mac only", () => {
  expect(builtApp("/p", "darwin", "arm64")).toBe("/p/apps/desktop/release/mac-arm64/Demesne.app");
  expect(builtApp("/p", "darwin", "x64")).toBe("/p/apps/desktop/release/mac/Demesne.app");
  expect(builtApp("/p", "linux", "x64")).toBeNull();
  expect(installedBundle("/Users/mike/Applications/Demesne.app/Contents/MacOS/Demesne", "darwin")).toBe("/Users/mike/Applications/Demesne.app");
  expect(installedBundle("/Users/mike/projects/demesne-cli/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron", "darwin")).toBe("/Users/mike/projects/demesne-cli/node_modules/electron/dist/Electron.app");
  expect(installedBundle("/usr/lib/demesne/demesne-desktop", "linux")).toBeNull();
});

test("the swap waits for this process, trashes the old app, puts the staged one in its place", () => {
  const script = swapScript(4242, "/Users/mike/Library/Application Support/Demesne/look/keep/Demesne.app", "/Users/mike/Applications/Demesne.app", true);
  expect(script).toContain("while kill -0 4242");
  expect(script).toContain("pkill -f '/Users/mike/Applications/Demesne.app/Contents/Resources/backend/demesned'");
  expect(script).toContain(`mv '/Users/mike/Applications/Demesne.app' "$HOME/.Trash/Demesne-$(date +%Y%m%d-%H%M%S).app" || exit 1`);
  expect(script).toContain("ditto '/Users/mike/Library/Application Support/Demesne/look/keep/Demesne.app' '/Users/mike/Applications/Demesne.app' || exit 1");
  expect(script.trim().endsWith("open '/Users/mike/Applications/Demesne.app'")).toBe(true);
  expect(swapScript(1, "/s", "/b", false)).not.toContain("open ");
  expect(swapScript(1, "/it's", "/b", false)).toContain(`'/it'\\''s'`);
});
