import packageJson from "../../../package.json" with { type: "json" };

export const VERSION: string = process.env.DEMESNE_BUILD_VERSION || packageJson.version;
