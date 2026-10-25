import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@demesne/config";
import { writeSetupConfig } from "../src/setup.ts";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "demesne-setup-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("writeSetupConfig", () => {
  test("writes a validated provider configuration", () => {
    const home = temporaryDirectory();
    const configPath = join(home, ".demesne", "config.toml");
    const { backup } = writeSetupConfig(configPath, {
      providerUrl: "http://127.0.0.1:11436/v1",
      providerId: "llama.cpp",
      model: "qwen3.8-q4_0-100k-b256",
      contextWindow: 100_000,
      maxOutputTokens: 1_536,
      theme: "auto",
    });
    expect(backup).toBeNull();
    const loaded = loadConfig({ env: {}, userConfigPath: configPath, projectConfigPath: null });
    expect(loaded.config.provider.url).toBe("http://127.0.0.1:11436/v1");
    expect(loaded.config.provider.id).toBe("llama.cpp");
    expect(loaded.config.provider.model).toBe("qwen3.8-q4_0-100k-b256");
    expect(loaded.config.provider.contextWindow).toBe(100_000);
    expect(loaded.config.provider.maxOutputTokens).toBe(1_536);
    expect(loaded.config.theme).toBe("auto");
  });

  test("preserves unrelated settings and backs up an existing file", () => {
    const home = temporaryDirectory();
    const configPath = join(home, "config.toml");
    writeFileSync(configPath, `
[permissions]
allow = ["run_command:git status"]

[notifications]
enabled = false
`);
    const { backup } = writeSetupConfig(configPath, {
      providerUrl: "http://127.0.0.1:11434/v1",
      providerId: "ollama",
      model: "local",
      contextWindow: 8_192,
      maxOutputTokens: 1_536,
    });
    expect(backup).toBe(`${configPath}.bak`);
    expect(existsSync(`${configPath}.bak`)).toBe(true);
    const loaded = loadConfig({ env: {}, userConfigPath: configPath, projectConfigPath: null });
    expect(loaded.config.permissions.allow).toEqual(["run_command:git status"]);
    expect(loaded.config.notifications.enabled).toBe(false);
    expect(loaded.config.provider.model).toBe("local");
  });

  test("rejects an output reserve that does not fit the context window", () => {
    const configPath = join(temporaryDirectory(), "config.toml");
    expect(() => writeSetupConfig(configPath, {
      providerUrl: "http://127.0.0.1:11434/v1",
      providerId: "ollama",
      model: "local",
      contextWindow: 8_192,
      maxOutputTokens: 8_192,
    })).toThrow(/smaller than the context window/);
    expect(existsSync(configPath)).toBe(false);
  });

  test("rejects a non-loopback cleartext provider URL", () => {
    const configPath = join(temporaryDirectory(), "config.toml");
    expect(() => writeSetupConfig(configPath, {
      providerUrl: "http://models.example.com/v1",
      providerId: "openai-compatible",
      model: "local",
      contextWindow: 8_192,
      maxOutputTokens: 1_536,
    })).toThrow(/HTTPS/);
  });
});
