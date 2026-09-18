import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@demesne/config";
import { runSetup, writeSetupConfig } from "../src/setup.ts";

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

describe("runSetup", () => {
  const nonInteractiveStreams = {
    input: { isTTY: false } as unknown as NodeJS.ReadStream,
    output: { isTTY: false, write: () => true } as unknown as NodeJS.WriteStream,
  };

  test("writes configuration without prompting when given provider and model", async () => {
    const home = temporaryDirectory();
    const result = await runSetup({
      home,
      yes: true,
      providerUrl: "http://127.0.0.1:11434/v1",
      model: "qwen3.8-8k-b256:latest",
      contextWindow: 8_192,
      maxOutputTokens: 1_536,
      theme: "dark",
      ...nonInteractiveStreams,
    });
    expect(result.nonInteractive).toBe(true);
    expect(result.providerId).toBe("ollama");
    const loaded = loadConfig({
      env: {},
      userConfigPath: join(home, ".demesne", "config.toml"),
      projectConfigPath: null,
    });
    expect(loaded.config.provider.model).toBe("qwen3.8-8k-b256:latest");
    expect(loaded.config.provider.contextWindow).toBe(8_192);
    expect(loaded.config.theme).toBe("dark");
  });

  test("defaults the context window and output reserve for automation", async () => {
    const home = temporaryDirectory();
    const result = await runSetup({
      home,
      yes: true,
      providerUrl: "https://models.example.com/v1",
      model: "remote-model",
      ...nonInteractiveStreams,
    });
    expect(result.contextWindow).toBe(32_768);
    expect(result.maxOutputTokens).toBe(1_536);
    expect(result.providerId).toBe("openai-compatible");
  });

  test("explains how to run non-interactively without a terminal", async () => {
    await expect(runSetup({
      home: temporaryDirectory(),
      providerUrl: "http://127.0.0.1:11434/v1",
      ...nonInteractiveStreams,
    })).rejects.toThrow(/--provider-url and --model/);
  });

  test("never leaves a partially written file on validation failure", async () => {
    const home = temporaryDirectory();
    await expect(runSetup({
      home,
      yes: true,
      providerUrl: "http://127.0.0.1:11434/v1",
      model: "local",
      contextWindow: 1_024,
      maxOutputTokens: 2_048,
      ...nonInteractiveStreams,
    })).rejects.toThrow(/smaller than the context window/);
    expect(existsSync(join(home, ".demesne", "config.toml"))).toBe(false);
  });
});
