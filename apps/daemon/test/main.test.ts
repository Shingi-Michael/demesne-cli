import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const temporaryDirectories: string[] = [];
const mainPath = join(import.meta.dir, "../src/main.ts");

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("daemon configuration", () => {
  test("legacy runtime configuration starts without launching its process and preserves a usable fallback", async () => {
    for (const fallback of [false, true]) {
      const directory = mkdtempSync(join(tmpdir(), "demesne-retired-startup-"));
      temporaryDirectories.push(directory);
      const reserved = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("fixture") });
      const port = reserved.port!;
      await reserved.stop(true);
      const configPath = join(directory, "config.toml"), marker = join(directory, "runtime-started"), binary = join(directory, "obsolete-runtime");
      writeFileSync(binary, `#!/usr/bin/env bun\nimport { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "unexpected launch");\n`, { mode: 0o755 });
      writeFileSync(configPath, '[provider]\nauth = "codex"\nmodel = "codex/gpt-6.1-sol"\ncontext_window = 272000\nmax_output_tokens = 16384\n'
        + (fallback ? '\n[additional_providers.local]\nid = "Local fixture"\nurl = "http://127.0.0.1:1/v1"\nmodel = "local-model"\ncontext_window = 32768\nmax_output_tokens = 1536\n' : ""));
      const env: Record<string, string | undefined> = { ...process.env, DEMESNE_CONFIG_FILE: configPath, DEMESNE_DATA_DIR: directory,
        DEMESNE_PORT: String(port), DEMESNE_HOST: "127.0.0.1", DEMESNE_DAEMON_TOKEN: "retirement-fixture", DEMESNE_CODEX_BIN: binary };
      for (const key of Object.keys(env)) if (key.startsWith("DEMESNE_") && !["DEMESNE_CONFIG_FILE", "DEMESNE_DATA_DIR", "DEMESNE_PORT", "DEMESNE_HOST", "DEMESNE_DAEMON_TOKEN", "DEMESNE_CODEX_BIN"].includes(key)) delete env[key];
      const child = Bun.spawn([process.execPath, mainPath], { env, stdout: "pipe", stderr: "pipe" });
      const stderr = new Response(child.stderr).text(), stdout = new Response(child.stdout).text();
      let exited = false;
      void child.exited.then(() => { exited = true; });
      let health: Record<string, unknown> | undefined;
      try {
        const deadline = Date.now() + 8000;
        while (!exited && Date.now() < deadline && !health) {
          try {
            const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(200) });
            if (response.ok) health = await response.json() as Record<string, unknown>;
          } catch { /* Wait only for this private fixture daemon to start. */ }
          if (!health) await new Promise(resolve => setTimeout(resolve, 25));
        }
        if (exited) throw new Error(`Fixture daemon exited: ${await stderr}`);
        expect(health).toMatchObject({ status: "ok", provider: fallback ? "Local fixture" : "placeholder", model: fallback ? "local-model" : "deterministic" });
        expect(existsSync(marker)).toBe(false);
      } finally {
        if (!exited) child.kill("SIGTERM");
        await child.exited;
        await Promise.all([stdout, stderr]);
      }
    }
  }, 20_000);
  test("requires capacity and output limits for configured providers", async () => {
    const directory = mkdtempSync(join(tmpdir(), "demesne-main-test-"));
    temporaryDirectories.push(directory);
    const env: Record<string, string | undefined> = {
      ...process.env,
      DEMESNE_DATA_DIR: directory,
      DEMESNE_MODEL: "model",
      DEMESNE_CONFIG_FILE: join(directory, "missing-config.toml"),
    };
    delete env.DEMESNE_CONTEXT_WINDOW;
    delete env.DEMESNE_MAX_OUTPUT_TOKENS;
    delete env.DEMESNE_RUNTIME_PROFILE;
    const child = Bun.spawn([process.execPath, mainPath], { env, stdout: "pipe", stderr: "pipe" });
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(code).not.toBe(0);
    expect(stderr).toContain("DEMESNE_CONTEXT_WINDOW is required");
  });
});
