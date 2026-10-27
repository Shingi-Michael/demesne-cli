import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadConfig } from "@demesne/config";

const assistant = resolve(import.meta.dir, "../../../scripts/assistant");
const unit = readFileSync(join(assistant, "llama-server.service"), "utf8");
const flag = (name: string) => unit.match(new RegExp(`--${name} (\\S+)`))?.[1];

const temporaryDirectories: string[] = [];
afterEach(() => { for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe("assistant services", () => {
  const { config } = loadConfig({ userConfigPath: join(assistant, "assistant.toml"), includeProject: false, env: {} });

  test("Demesne's config and the model server agree on the 128K cap, the port and the model", () => {
    expect(Number(flag("ctx-size"))).toBe(131_072);
    expect(config.provider.contextWindow).toBe(Number(flag("ctx-size")));
    expect(config.provider.url).toBe(`http://127.0.0.1:${flag("port")}/v1`);
    expect(config.provider.model).toBe(flag("alias")!);
    // Qwen3.8-27B stops generating past ~130K prompt tokens.
    expect(config.provider.contextWindow! - config.provider.maxOutputTokens!).toBeLessThan(130_000);
  });

  test("the model server only listens on this machine and runs one request at a time", () => {
    expect(flag("host")).toBe("127.0.0.1");
    expect(flag("parallel")).toBe("1");
    expect(config.inferenceSlots).toBe(1);
  });

  test("install --dry-run fills in the paths without installing anything", () => {
    const directory = mkdtempSync(join(tmpdir(), "demesne assistant-"));
    temporaryDirectories.push(directory);
    const model = join(directory, "model.gguf"), server = join(directory, "llama-server");
    writeFileSync(model, "");
    writeFileSync(server, "#!/bin/sh\n");
    chmodSync(server, 0o755);
    const run = Bun.spawnSync(["bash", join(assistant, "install.sh"), "--model", model, "--llama-server", server, "--demesned", "/opt/demesned", "--dry-run"], { stdout: "pipe", stderr: "pipe" });
    const output = run.stdout.toString();
    expect(run.exitCode).toBe(0);
    expect(output).toContain(`ExecStart="${server}"`);
    expect(output).toContain(`--model "${model}"`);
    expect(output).toContain("ExecStart=/opt/demesned");
    expect(output).not.toContain("@");
  });

  test("install refuses to run without a model", () => {
    const run = Bun.spawnSync(["bash", join(assistant, "install.sh"), "--dry-run"], { stdout: "pipe", stderr: "pipe" });
    expect(run.exitCode).toBe(1);
    expect(run.stderr.toString()).toContain("--model");
  });
});
