import { expect, test } from "bun:test";
import { loadConfig, validateConfigDocument } from "../src/index.ts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const codex = { auth: "codex", id: "Codex", model: "codex/gpt-6.1-sol", context_window: 32768, max_output_tokens: 8192 };

test("Codex configuration uses namespaced models and a managed app server without an endpoint", () => {
  expect(() => validateConfigDocument({ additional_providers: { codex } })).not.toThrow();
  for (const provider of [
    { ...codex, url: "https://api.openai.com/v1" },
    { ...codex, api_key: "fixture-key" },
    { ...codex, auth_profile: "another-app" },
    { ...codex, model: "gpt-6.1-sol" },
    { ...codex, allowed_models: ["gpt-6.1-sol"] },
  ]) expect(() => validateConfigDocument({ additional_providers: { codex: provider } })).toThrow();
  expect(() => validateConfigDocument({ additional_providers: { local: { model: "local", context_window: 32768, max_output_tokens: 8192 } } })).toThrow("requires url");
});

test("environment overrides cannot introduce raw Codex model IDs or another transport", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-env-")), path = join(root, "config.toml");
  try {
    writeFileSync(path, '[provider]\nauth = "codex"\nmodel = "codex/gpt-6.1-sol"\n');
    for (const env of [{ DEMESNE_MODEL: "gpt-6.1-sol" }, { DEMESNE_API_KEY: "fixture-key" }, { DEMESNE_PROVIDER_URL: "https://api.openai.com/v1" }])
      expect(() => loadConfig({ userConfigPath: path, includeProject: false, env })).toThrow();
    expect(loadConfig({ userConfigPath: path, includeProject: false, env: { DEMESNE_MODEL: "codex/gpt-6-astra" } }).config.provider.model).toBe("codex/gpt-6-astra");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
