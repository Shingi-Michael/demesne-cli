import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import packageJson from "../package.json" with { type: "json" };
import { buildVersionArgs, resolveBuildVersion } from "./build-version.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

for (const override of ["9.9.9", undefined]) {
  test(`compiled version keeps ${override ? "the release override" : "the package fallback"} without runtime build settings`, () => {
    const root = mkdtempSync(join(tmpdir(), "demesne version-"));
    roots.push(root);
    const entry = join(root, "version-check.ts"), executable = join(root, process.platform === "win32" ? "version-check.exe" : "version-check");
    const versionModule = fileURLToPath(new URL("../apps/daemon/src/version.ts", import.meta.url));
    writeFileSync(entry, `import { VERSION } from ${JSON.stringify(versionModule)};\nconsole.log(VERSION);\n`);
    const version = resolveBuildVersion({ DEMESNE_BUILD_VERSION: override });
    expect(version).toBe(override ?? packageJson.version);
    const env = { ...process.env };
    delete env.DEMESNE_BUILD_VERSION;
    const build = Bun.spawnSync([process.execPath, "build", entry, "--compile", ...buildVersionArgs(version), "--outfile", executable], { env });
    if (build.exitCode !== 0) throw new Error(build.stderr.toString());
    for (const runtime of [env, { ...env, DEMESNE_BUILD_VERSION: "8.8.8" }]) {
      const result = Bun.spawnSync([executable], { env: runtime });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString().trim()).toBe(version);
    }
  }, 30_000);
}
