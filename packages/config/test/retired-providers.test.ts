import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, renderConfigDocument, updateUserConfig, validateConfigDocument } from "../src/index.ts";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const retired = { id: "Codex", auth: "codex", model: "codex/gpt-6.1-sol", context_window: 272_000, max_output_tokens: 16_384 };
const direct = { id: "ChatGPT", auth: "chatgpt", auth_profile: "own-account", url: "https://api.openai.com/v1", model: "gpt-6.1-sol", context_window: 272_000, max_output_tokens: 16_384 };
const local = { url: "http://127.0.0.1:1234/v1", model: "local-model", context_window: 32_768, max_output_tokens: 1536 };
function fixture(document: Record<string, unknown>) {
  const directory = mkdtempSync(join(tmpdir(), "demesne-retired-provider-"));
  directories.push(directory);
  const path = join(directory, "config.toml"), text = renderConfigDocument(document);
  writeFileSync(path, text);
  return { path, text, load: () => loadConfig({ userConfigPath: path, includeProject: false, env: {} }).config };
}

test("retired additional providers do not hide direct or local providers", () => {
  const { load } = fixture({ provider: local, additional_providers: { legacy: retired, chatgpt: direct }, theme: "light" });
  const config = load();
  expect(config.provider).toMatchObject({ model: "local-model", url: local.url });
  expect(config.additionalProviders?.chatgpt).toMatchObject({ auth: "chatgpt", authProfile: "own-account", model: "gpt-6.1-sol" });
  expect(config.additionalProviders?.legacy).toBeUndefined();
  expect(config.theme).toBe("light");
});

test("a retired primary promotes the first remaining provider with its original identity", () => {
  const { path, text, load } = fixture({ provider: retired, additional_providers: { retired, local, chatgpt: direct }, notifications: { enabled: false } });
  expect(load().provider).toMatchObject({ id: "local", model: "local-model", url: local.url });
  expect(load().additionalProviders).toEqual({ chatgpt: { id: "ChatGPT", auth: "chatgpt", authProfile: "own-account", url: direct.url, model: direct.model, contextWindow: 272_000, maxOutputTokens: 16_384 } });
  expect(load().notifications.enabled).toBe(false);
  expect(readFileSync(path, "utf8")).toBe(text);
});

test("a retired-only config reaches setup without converting model IDs or importing credentials", () => {
  const { path, load } = fixture({ provider: retired, additional_providers: { retired }, permissions: { allow: ["run_command:git status"] } });
  expect(load().provider).toEqual({});
  expect(load().additionalProviders).toEqual({});
  expect(load().permissions.allow).toEqual(["run_command:git status"]);
  const overridden = loadConfig({ userConfigPath: path, includeProject: false, env: { DEMESNE_MODEL: "local-model", DEMESNE_PROVIDER_URL: local.url } });
  expect(overridden.config.provider).toEqual({ model: "local-model", url: local.url });
});

test("the next config update backs up legacy settings and writes only surviving providers", () => {
  const { path, text, load } = fixture({ provider: retired, additional_providers: { chatgpt: direct, retired }, theme: "light", drive: { max_tasks: 4 } });
  const { backup, document } = updateUserConfig(path, { notifications: { enabled: false } });
  expect(backup).toBe(`${path}.bak`);
  expect(readFileSync(backup!, "utf8")).toBe(text);
  expect(document.provider).toEqual(direct);
  expect(document.additional_providers).toEqual({});
  expect(readFileSync(path, "utf8")).not.toContain('auth = "codex"');
  expect(load().provider).toMatchObject({ auth: "chatgpt", authProfile: "own-account", model: "gpt-6.1-sol" });
  expect(load().theme).toBe("light");
  expect(load().drive?.maxTasks).toBe(4);
});

test("retirement does not mask invalid settings on a surviving provider", () => {
  expect(() => validateConfigDocument({ provider: retired, additional_providers: { bad: { ...direct, context_window: 0 } } })).toThrow("positive integer");
  expect(() => validateConfigDocument({ provider: retired, additional_providers: { bad: { ...direct, max_output_tokens: 272_000 } } })).toThrow("smaller than context_window");
  expect(() => validateConfigDocument({ provider: retired, additional_providers: { bad: { auth: "chatgpt", model: "gpt-6.1-sol" } } })).toThrow("requires url");
  expect(() => validateConfigDocument({ provider: { ...direct, auth: "another-runtime" } })).toThrow("api-key, chatgpt");
});

test("config updates cannot reintroduce a retired provider", () => {
  const { path, text } = fixture({ provider: local });
  for (const patch of [{ provider: retired }, { additional_providers: { retired } }]) {
    expect(() => updateUserConfig(path, patch)).toThrow("api-key, chatgpt");
    expect(readFileSync(path, "utf8")).toBe(text);
  }
});
