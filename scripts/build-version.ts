import packageJson from "../package.json" with { type: "json" };

export function resolveBuildVersion(env: Record<string, string | undefined> = process.env): string {
  return env.DEMESNE_BUILD_VERSION || packageJson.version;
}

/** Which build this is: the commit and when it was built. The app and the
 * daemon it bundles share one, so the app can tell a daemon left running
 * from an older build (the version stays the same between releases). */
export function resolveBuildId(env: Record<string, string | undefined> = process.env): string {
  if (env.DEMESNE_BUILD_ID) return env.DEMESNE_BUILD_ID;
  let commit = "dev";
  try { commit = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], { cwd: import.meta.dir }).stdout.toString().trim() || commit; } catch {}
  return `${commit}.${Date.now().toString(36)}`;
}

/** Standalone executables keep the release version and build after the build
 * environment disappears, and cannot have their identity changed by a runtime variable. */
export function buildVersionArgs(version = resolveBuildVersion(), build = resolveBuildId()): string[] {
  return ["--define", `process.env.DEMESNE_BUILD_VERSION=${JSON.stringify(version)}`, "--define", `process.env.DEMESNE_BUILD_ID=${JSON.stringify(build)}`];
}
