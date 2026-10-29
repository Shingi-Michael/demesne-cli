import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig } from "@demesne/config";

const assistant = resolve(import.meta.dir, "../../../scripts/assistant");
// The same parsing keep-running.ps1 does: "--flag value" per line, # comments skipped.
const serverArgs = new Map(readFileSync(join(assistant, "llama-server.args"), "utf8").split(/\r?\n/)
  .map((line) => line.trim()).filter((line) => line && !line.startsWith("#"))
  .map((line) => { const [flag, value = ""] = line.split(/\s+(.*)/); return [flag!, value] as const; }));

describe("assistant services", () => {
  const { config } = loadConfig({ userConfigPath: join(assistant, "assistant.toml"), includeProject: false, env: {} });

  test("Demesne's config and the model server agree on the 128K cap, the port and the model", () => {
    expect(Number(serverArgs.get("--ctx-size"))).toBe(131_072);
    expect(config.provider.contextWindow).toBe(Number(serverArgs.get("--ctx-size")));
    expect(config.provider.url).toBe(`http://127.0.0.1:${serverArgs.get("--port")}/v1`);
    expect(config.provider.model).toBe(serverArgs.get("--alias")!);
    // Qwen3.8-27B stops generating past ~130K prompt tokens.
    expect(config.provider.contextWindow! - config.provider.maxOutputTokens!).toBeLessThan(130_000);
  });

  test("the model server only listens on this machine and runs one request at a time", () => {
    expect(serverArgs.get("--host")).toBe("127.0.0.1");
    expect(serverArgs.get("--parallel")).toBe("1");
    expect(config.inferenceSlots).toBe(1);
  });

  test("the installer fills in the model and names files that exist", () => {
    expect(serverArgs.get("--model")).toBe("@MODEL@");
    const installer = readFileSync(join(assistant, "install.ps1"), "utf8");
    for (const file of installer.matchAll(/Join-Path \$here '(\w[^']+)'/g)) expect(() => readFileSync(join(assistant, ...file[1]!.split("\\")))).not.toThrow();
  });

  test("the installer's header explains every option it takes", () => {
    const installer = readFileSync(join(assistant, "install.ps1"), "utf8");
    const options = [...installer.slice(installer.indexOf("param(")).split(")\n")[0]!.matchAll(/\] \$(\w+)/g)].map((match) => match[1]!);
    expect(options).toContain("NoModel");
    expect(options).toContain("LlamaArgs");
    for (const option of options) expect(installer).toMatch(new RegExp(`^#\\s+-${option}\\b`, "m"));
  });
});
