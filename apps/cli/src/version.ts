import packageJson from "../../../package.json" with { type: "json" };

/// The product version is defined once in the root package manifest so the
/// CLI, the daemon's health response, and release tooling cannot drift.
export const VERSION: string = packageJson.version;
