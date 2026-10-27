import packageJson from "../package.json" with { type: "json" };

export function resolveBuildVersion(env: Record<string, string | undefined> = process.env): string {
  return env.DEMESNE_BUILD_VERSION || packageJson.version;
}

/** Standalone executables keep the release version after the build environment
 * disappears, and cannot have their identity changed by a runtime variable. */
export function buildVersionArgs(version = resolveBuildVersion()): string[] {
  return ["--define", `process.env.DEMESNE_BUILD_VERSION=${JSON.stringify(version)}`];
}
