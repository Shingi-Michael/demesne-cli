import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAccountSettings, loadCliSettings } from "../src/cli-config.ts";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "demesne-cli-config-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("loadCliSettings", () => {
  test("ChatGPT account settings use machine credentials and daemon when a project overrides session settings", () => {
    const root = temporaryDirectory(), home = join(root, "home"), workspace = join(root, "project");
    const configPath = join(home, ".demesne/config.toml");
    mkdirSync(join(home, ".demesne"), { recursive: true });
    mkdirSync(join(workspace, ".demesne"), { recursive: true });
    writeFileSync(configPath, `data_dir = "${join(root, "machine-data")}"\nserver = "http://127.0.0.1:7437"\n`);
    writeFileSync(join(workspace, ".demesne/config.toml"), `data_dir = "${join(root, "project-data")}"\nserver = "http://127.0.0.1:7537"\n`);
    const settings = loadCliSettings({ env: {}, home, workspaceRoot: workspace });
    expect(settings.dataDirectory).toBe(join(root, "project-data"));
    expect(settings.accountDataDirectory).toBe(join(root, "machine-data"));
    expect(loadAccountSettings({ env: {}, home })).toEqual({ configPath, dataDirectory: join(root, "machine-data"), server: "http://127.0.0.1:7437" });
    const env = { DEMESNE_CONFIG_FILE: join(root, "new-config.toml"), DEMESNE_DATA_DIR: join(root, "environment-data"), DEMESNE_SERVER: "http://127.0.0.1:7637" };
    expect(loadAccountSettings({ home, env })).toEqual({ configPath: env.DEMESNE_CONFIG_FILE, dataDirectory: env.DEMESNE_DATA_DIR, server: env.DEMESNE_SERVER });
    expect(loadAccountSettings({ home, env, serverOverride: "http://127.0.0.1:7737" }).server).toBe("http://127.0.0.1:7737");
    writeFileSync(join(workspace, ".demesne/config.toml"), "broken = true\n");
    expect(loadCliSettings({ env: {}, home, workspaceRoot: workspace, includeProject: false }).dataDirectory).toBe(join(root, "machine-data"));
  });
  test("falls back to loopback defaults without any configuration", () => {
    const home = temporaryDirectory();
    const settings = loadCliSettings({ env: {}, home, workspaceRoot: home });
    expect(settings.server).toBe("http://127.0.0.1:7337");
    expect(settings.dataDirectory).toBe(join(home, ".demesne"));
    expect(settings.theme).toBe("auto");
    expect(settings.autoStart).toBe("prompt");
    expect(settings.configPath).toBe(join(home, ".demesne", "config.toml"));
    expect(settings.loaded.files.user).toBeNull();
  });

  test("reads server, theme, data directory, and auto-start from the user config", () => {
    const home = temporaryDirectory();
    const configDirectory = join(home, ".demesne");
    mkdirSync(configDirectory);
    writeFileSync(join(configDirectory, "config.toml"), `
server = "http://127.0.0.1:9000"
data_dir = "${join(home, "data")}"
theme = "light"

[daemon]
auto_start = "always"
`);
    const settings = loadCliSettings({ env: {}, home, workspaceRoot: home });
    expect(settings.server).toBe("http://127.0.0.1:9000");
    expect(settings.dataDirectory).toBe(join(home, "data"));
    expect(settings.theme).toBe("light");
    expect(settings.autoStart).toBe("always");
    expect(settings.configPath).toBe(join(configDirectory, "config.toml"));
  });

  test("lets the --server override win over files and environment", () => {
    const home = temporaryDirectory();
    const settings = loadCliSettings({
      serverOverride: "http://127.0.0.1:9999",
      env: { DEMESNE_SERVER: "http://127.0.0.1:8888" },
      home,
      workspaceRoot: home,
    });
    expect(settings.server).toBe("http://127.0.0.1:9999");
  });

  test("merges project configuration over the user file", () => {
    const home = temporaryDirectory();
    const workspace = temporaryDirectory();
    mkdirSync(join(home, ".demesne"));
    writeFileSync(join(home, ".demesne", "config.toml"), `theme = "light"\n`);
    mkdirSync(join(workspace, ".demesne"));
    writeFileSync(join(workspace, ".demesne", "config.toml"), `theme = "dark"\nserver = "http://127.0.0.1:7000"\n`);
    const settings = loadCliSettings({ env: {}, home, workspaceRoot: workspace });
    expect(settings.theme).toBe("dark");
    expect(settings.server).toBe("http://127.0.0.1:7000");
    expect(settings.loaded.files.project).toBe(join(workspace, ".demesne", "config.toml"));
  });

  test("derives the default server from daemon host and port", () => {
    const home = temporaryDirectory();
    mkdirSync(join(home, ".demesne"));
    writeFileSync(join(home, ".demesne", "config.toml"), `[daemon]\nhost = "127.0.0.1"\nport = 7400\n`);
    const settings = loadCliSettings({ env: {}, home, workspaceRoot: home });
    expect(settings.server).toBe("http://127.0.0.1:7400");
  });

  test("brackets an IPv6 daemon host", () => {
    const home = temporaryDirectory();
    mkdirSync(join(home, ".demesne"));
    writeFileSync(join(home, ".demesne", "config.toml"), `[daemon]\nhost = "::1"\nport = 7400\n`);
    const settings = loadCliSettings({ env: {}, home, workspaceRoot: home });
    expect(settings.server).toBe("http://[::1]:7400");
  });
});
