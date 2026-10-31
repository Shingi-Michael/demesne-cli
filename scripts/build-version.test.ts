import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import packageJson from "../package.json" with { type: "json" };
import { buildVersionArgs, resolveBuildId, resolveBuildVersion } from "./build-version.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

for (const override of ["9.9.9", undefined]) {
  test(`compiled version keeps ${override ? "the release override" : "the package fallback"} without runtime build settings`, () => {
    const root = mkdtempSync(join(tmpdir(), "demesne version-"));
    roots.push(root);
    const entry = join(root, "version-check.ts"), executable = join(root, process.platform === "win32" ? "version-check.exe" : "version-check");
    const versionModule = fileURLToPath(new URL("../apps/daemon/src/version.ts", import.meta.url));
    writeFileSync(entry, `import { BUILD, VERSION } from ${JSON.stringify(versionModule)};\nconsole.log(VERSION + " " + BUILD);\n`);
    const version = resolveBuildVersion({ DEMESNE_BUILD_VERSION: override });
    expect(version).toBe(override ?? packageJson.version);
    const env = { ...process.env };
    delete env.DEMESNE_BUILD_VERSION;
    const build = Bun.spawnSync([process.execPath, "build", entry, "--compile", ...buildVersionArgs(version, "abc1234.test"), "--outfile", executable], { env });
    if (build.exitCode !== 0) throw new Error(build.stderr.toString());
    for (const runtime of [env, { ...env, DEMESNE_BUILD_VERSION: "8.8.8", DEMESNE_BUILD_ID: "other" }]) {
      const result = Bun.spawnSync([executable], { env: runtime });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString().trim()).toBe(`${version} abc1234.test`);
    }
  }, 30_000);
}

test("a build id names the commit and the moment of the build, unless one is given", () => {
  expect(resolveBuildId({ DEMESNE_BUILD_ID: "given" })).toBe("given");
  const first = resolveBuildId({});
  expect(first).toMatch(/^[0-9a-z]+\.[0-9a-z]+$/);
  expect(buildVersionArgs("1.0.0", "b")).toEqual(["--define", 'process.env.DEMESNE_BUILD_VERSION="1.0.0"', "--define", 'process.env.DEMESNE_BUILD_ID="b"']);
});
