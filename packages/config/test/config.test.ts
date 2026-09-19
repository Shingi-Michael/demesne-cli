import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertProviderUrl,
  assertServerUrl,
  ConfigError,
  loadConfig,
  parseConfigDocument,
  renderConfigDocument,
  renderUserConfig,
  updateUserConfig,
  validateConfigDocument,
} from "../src/index.ts";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "demesne-config-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function writeConfig(directory: string, contents: string): string {
  const path = join(directory, "config.toml");
  writeFileSync(path, contents);
  return path;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("loadConfig", () => {
  test("returns defaults when no files or environment exist", () => {
    const loaded = loadConfig({
      env: {},
      userConfigPath: null,
      projectConfigPath: null,
    });
    expect(loaded.config.daemon.autoStart).toBe("prompt");
    expect(loaded.config.permissions.allow).toEqual([]);
    expect(loaded.config.notifications).toEqual({ enabled: true, minimumDurationMs: 30_000 });
    expect(loaded.config.ui).toEqual({ intro: true, hyperlinks: true });
    expect(loaded.files).toEqual({ user: null, project: null });
    expect(loaded.sources).toEqual({});
  });

  test("reads user configuration and records its source", () => {
    const directory = temporaryDirectory();
    const path = writeConfig(directory, `
server = "http://127.0.0.1:9000"
theme = "light"
inference_slots = 2

[provider]
url = "http://127.0.0.1:11436/v1"
id = "llama.cpp"
model = "qwen3.8-q4_0-100k-b256"
context_window = 100000
max_output_tokens = 1536
reasoning_effort = "none"

[daemon]
auto_start = "always"

[permissions]
allow = ["run_command:git status"]

[notifications]
enabled = false
minimum_duration_ms = 1000

[ui]
intro = false
`);
    const loaded = loadConfig({ env: {}, userConfigPath: path, projectConfigPath: null });
    expect(loaded.files.user).toBe(path);
    expect(loaded.config.server).toBe("http://127.0.0.1:9000");
    expect(loaded.config.theme).toBe("light");
    expect(loaded.config.inferenceSlots).toBe(2);
    expect(loaded.config.provider.model).toBe("qwen3.8-q4_0-100k-b256");
    expect(loaded.config.provider.contextWindow).toBe(100_000);
    expect(loaded.config.daemon.autoStart).toBe("always");
    expect(loaded.config.permissions.allow).toEqual(["run_command:git status"]);
    expect(loaded.config.notifications.enabled).toBe(false);
    expect(loaded.config.ui.intro).toBe(false);
    expect(loaded.sources["provider.model"]).toBe("user");
    expect(loaded.sources.server).toBe("user");
  });

  test("lets project configuration override the user file", () => {
    const directory = temporaryDirectory();
    const userPath = writeConfig(directory, `theme = "light"\n`);
    const projectPath = join(directory, "project.toml");
    writeFileSync(projectPath, `theme = "dark"\nserver = "http://127.0.0.1:8000"\n`);
    const loaded = loadConfig({
      env: {},
      userConfigPath: userPath,
      projectConfigPath: projectPath,
    });
    expect(loaded.config.theme).toBe("dark");
    expect(loaded.config.server).toBe("http://127.0.0.1:8000");
    expect(loaded.sources.theme).toBe("project");
    expect(loaded.files.project).toBe(projectPath);
  });

  test("lets environment variables override every file layer", () => {
    const directory = temporaryDirectory();
    const userPath = writeConfig(directory, `
[provider]
model = "from-file"
context_window = 8192
`);
    const loaded = loadConfig({
      env: {
        DEMESNE_MODEL: "from-env",
        DEMESNE_CONTEXT_WINDOW: "32768",
        DEMESNE_ALLOWED_MODELS: "a, b",
        DEMESNE_INCLUDE_USAGE: "false",
      },
      userConfigPath: userPath,
      projectConfigPath: null,
    });
    expect(loaded.config.provider.model).toBe("from-env");
    expect(loaded.config.provider.contextWindow).toBe(32_768);
    expect(loaded.config.provider.allowedModels).toEqual(["a", "b"]);
    expect(loaded.config.provider.includeUsage).toBe(false);
    expect(loaded.sources["provider.model"]).toBe("env");
  });

  test("ignores project configuration when includeProject is false", () => {
    const directory = temporaryDirectory();
    const projectPath = join(directory, "project.toml");
    writeFileSync(projectPath, `theme = "dark"\n`);
    const loaded = loadConfig({
      env: {},
      userConfigPath: null,
      projectConfigPath: projectPath,
      includeProject: false,
    });
    expect(loaded.config.theme).toBeUndefined();
    expect(loaded.files.project).toBeNull();
  });

  test("rejects unknown keys instead of ignoring typos", () => {
    const directory = temporaryDirectory();
    const path = writeConfig(directory, `them = "dark"\n`);
    expect(() => loadConfig({ env: {}, userConfigPath: path, projectConfigPath: null }))
      .toThrow(/unknown key "them"/);
  });

  test("reports invalid TOML with the file path", () => {
    const directory = temporaryDirectory();
    const path = writeConfig(directory, `theme = \n`);
    expect(() => loadConfig({ env: {}, userConfigPath: path, projectConfigPath: null }))
      .toThrow(ConfigError);
    try {
      loadConfig({ env: {}, userConfigPath: path, projectConfigPath: null });
    } catch (error) {
      expect((error as ConfigError).path).toBe(path);
    }
  });

  test("rejects invalid types and ranges", () => {
    expect(() => validateConfigDocument({ inference_slots: 0 })).toThrow(/positive integer/);
    expect(() => validateConfigDocument({ inference_slots: 1.5 })).toThrow(/positive integer/);
    // Themes are named and extensible, so an unknown name is accepted here and
    // degrades to the default when it is resolved. Only a non-string is wrong.
    expect(() => validateConfigDocument({ theme: "sepia" })).not.toThrow();
    expect(() => validateConfigDocument({ theme: 7 })).toThrow(/must be a string/);
    expect(() => validateConfigDocument({ theme: "  " })).toThrow(/must not be empty/);
    expect(() => validateConfigDocument({ provider: { reasoning_effort: "turbo" } })).toThrow(/none, low, medium, high, max/);
    expect(() => validateConfigDocument({ daemon: { port: 70000 } })).toThrow(/between 1 and 65535/);
    expect(() => validateConfigDocument({ permissions: { allow: ["a", "a"] } })).toThrow(/duplicates/);
    expect(() => validateConfigDocument({ provider: { url: "http://example.com/v1" } })).toThrow(/HTTPS/);
    expect(() => validateConfigDocument({ provider: { unknown: true } })).toThrow(/unknown key "unknown"/);
  });

  test("rejects malformed server and provider URLs", () => {
    expect(() => assertServerUrl("not a url")).toThrow(/valid URL/);
    expect(() => assertServerUrl("ftp://example.com")).toThrow(/HTTP or HTTPS/);
    expect(() => assertServerUrl("http://user:pass@127.0.0.1:7337")).toThrow(/credentials/);
    expect(() => assertProviderUrl("http://example.com/v1")).toThrow(/HTTPS/);
    expect(() => assertProviderUrl("http://127.0.0.1:11434/v1")).not.toThrow();
    expect(() => assertProviderUrl("https://models.example.com/v1")).not.toThrow();
  });

  test("reads MCP server configuration", () => {
    const directory = temporaryDirectory();
    const path = writeConfig(directory, `
[mcp.servers.files]
command = "npx"
args = ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
env = { TOKEN = "secret" }
timeout_ms = 15000
`);
    const loaded = loadConfig({ env: {}, userConfigPath: path, projectConfigPath: null });
    expect(loaded.config.mcp.servers).toEqual({
      files: {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
        env: { TOKEN: "secret" },
        timeoutMs: 15_000,
      },
    });
    expect(loaded.sources["mcp.servers"]).toBe("user");
  });

  test("rejects malformed MCP servers", () => {
    expect(() => validateConfigDocument({ mcp: { servers: { files: { args: ["x"] } } } }))
      .toThrow(/command/);
    expect(() => validateConfigDocument({ mcp: { servers: { "bad name": { command: "x" } } } }))
      .toThrow(/mcp\.servers/);
    expect(() => validateConfigDocument({ mcp: { servers: { files: { command: "x", env: { A: 1 } } } } }))
      .toThrow(/env/);
    expect(() => validateConfigDocument({ mcp: { servers: { files: { command: "x", timeout_ms: -1 } } } }))
      .toThrow(/positive integer/);
  });
});

describe("parseConfigDocument", () => {
  test("returns a plain record for a valid document", () => {
    const parsed = parseConfigDocument(`theme = "dark"\n`);
    expect(parsed).toEqual({ theme: "dark" });
  });
});

describe("renderUserConfig", () => {
  test("round-trips generated configuration through the loader", () => {
    const rendered = renderUserConfig({
      server: "http://127.0.0.1:7337",
      theme: "auto",
      provider: {
        url: "http://127.0.0.1:11436/v1",
        id: "llama.cpp",
        model: 'qwen"3',
        contextWindow: 100_000,
        maxOutputTokens: 1536,
        reasoningEffort: "none",
      },
      daemon: { autoStart: "always" },
      permissions: { allow: ["run_command:git status"] },
      ui: { intro: false },
    });
    const directory = temporaryDirectory();
    const path = writeConfig(directory, rendered);
    const loaded = loadConfig({ env: {}, userConfigPath: path, projectConfigPath: null });
    expect(loaded.config.server).toBe("http://127.0.0.1:7337");
    expect(loaded.config.theme).toBe("auto");
    expect(loaded.config.provider.model).toBe('qwen"3');
    expect(loaded.config.provider.contextWindow).toBe(100_000);
    expect(loaded.config.daemon.autoStart).toBe("always");
    expect(loaded.config.permissions.allow).toEqual(["run_command:git status"]);
    expect(loaded.config.ui.intro).toBe(false);
  });

  test("omits unset values so defaults stay defaults", () => {
    const rendered = renderUserConfig({ provider: { model: "local" } });
    expect(rendered).toContain("model = \"local\"");
    expect(rendered).not.toContain("auto_start");
    expect(rendered).not.toContain("intro");
  });
});

describe("renderConfigDocument", () => {
  test("round-trips nested tables and scalar arrays", () => {
    const document = {
      server: "http://127.0.0.1:7337",
      inference_slots: 1,
      provider: { model: "local", context_window: 32_768, include_usage: true },
      permissions: { allow: ["run_command:git status", "run_command:bun test"] },
      ui: { intro: false },
    };
    const rendered = renderConfigDocument(document);
    expect(parseConfigDocument(rendered)).toEqual(document);
    validateConfigDocument(parseConfigDocument(rendered));
  });

  test("renders nested tables such as MCP servers", () => {
    const document = {
      mcp: {
        servers: {
          files: { command: "npx", args: ["-y", "server"], env: { TOKEN: "secret" } },
        },
      },
    };
    const rendered = renderConfigDocument(document);
    expect(parseConfigDocument(rendered)).toEqual(document);
    validateConfigDocument(parseConfigDocument(rendered));
  });

  test("rejects unsupported values such as arrays of tables", () => {
    expect(() => renderConfigDocument({ provider: { model: [{ nested: true }] } }))
      .toThrow(ConfigError);
  });
});

describe("updateUserConfig", () => {
  test("creates a private config file and parent directory", () => {
    const directory = temporaryDirectory();
    const path = join(directory, "nested", "config.toml");
    const { backup } = updateUserConfig(path, { provider: { model: "local", context_window: 8_192 } });
    expect(backup).toBeNull();
    const loaded = loadConfig({ env: {}, userConfigPath: path, projectConfigPath: null });
    expect(loaded.config.provider.model).toBe("local");
    expect(loaded.config.provider.contextWindow).toBe(8_192);
  });

  test("preserves unrelated keys and backs up the previous file", () => {
    const directory = temporaryDirectory();
    const path = writeConfig(directory, `
theme = "light"

[permissions]
allow = ["run_command:git status"]

[notifications]
enabled = false
`);
    const { backup } = updateUserConfig(path, { provider: { model: "local" } });
    expect(backup).toBe(`${path}.bak`);
    const loaded = loadConfig({ env: {}, userConfigPath: path, projectConfigPath: null });
    expect(loaded.config.theme).toBe("light");
    expect(loaded.config.permissions.allow).toEqual(["run_command:git status"]);
    expect(loaded.config.notifications.enabled).toBe(false);
    expect(loaded.config.provider.model).toBe("local");
  });

  test("validates the merged result before writing", () => {
    const directory = temporaryDirectory();
    const path = writeConfig(directory, `theme = "light"\n`);
    expect(() => updateUserConfig(path, { inference_slots: -1 })).toThrow(ConfigError);
    const loaded = loadConfig({ env: {}, userConfigPath: path, projectConfigPath: null });
    expect(loaded.config.theme).toBe("light");
  });
});
