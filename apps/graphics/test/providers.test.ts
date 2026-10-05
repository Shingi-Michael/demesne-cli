import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderAccounts } from "../providers.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test("lists providers with their sign-in state and signs out of OpenRouter by removing only its key", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "providers-")));
  roots.push(root);
  const configPath = join(root, "config.toml");
  writeFileSync(configPath, [
    "[provider]", 'id = "Qwen on PC"', 'url = "http://100.115.125.89:8081/v1"', 'allow_http_endpoint = "http://100.115.125.89:8081/v1"', 'model = "qwen3.8-27b"', "context_window = 32768", "max_output_tokens = 8192", "",
    "[additional_providers.openrouter]", 'id = "OpenRouter"', 'url = "https://openrouter.ai/api/v1"', 'api_key = "sk-or-test"', 'model = "z-ai/glm"', "context_window = 128000", "max_output_tokens = 16000", "",
  ].join("\n"));
  const accounts = new ProviderAccounts({ configPath, dataDirectory: root, open: async () => {} });
  const before = await accounts.list("Qwen on PC");
  expect(before.map((item) => [item.key, item.kind, item.status, item.active])).toEqual([
    ["provider", "local", "local", true],
    ["openrouter", "openrouter", "signed-in", false],
    ["new:chatgpt", "chatgpt", "signed-out", false],
  ]);
  expect(await accounts.signOut("openrouter")).toEqual({ label: "OpenRouter" });
  const config = readFileSync(configPath, "utf8");
  expect(config).not.toContain("sk-or-test");
  expect(config).toContain('model = "z-ai/glm"');
  expect((await accounts.list("Qwen on PC")).find((item) => item.key === "openrouter")).toMatchObject({ status: "signed-out", detail: "Signed out" });
  await expect(accounts.signOut("provider")).rejects.toThrow(/no account/);
});
