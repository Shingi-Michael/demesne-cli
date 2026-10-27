import packageJson from "../../../package.json" with { type: "json" };

// Build scripts inline this expression for standalone executables. Source runs
// may still select a version through their environment.
export const VERSION: string = process.env.DEMESNE_BUILD_VERSION || packageJson.version;
