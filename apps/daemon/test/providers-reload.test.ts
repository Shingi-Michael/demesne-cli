import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDaemonApp } from "../src/app.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test("/v1/providers/reload rebuilds providers and reports a switch; unsupported without a reloader", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "providers-reload-")));
  roots.push(root);
  let calls = 0;
  const reloadProviders = async () => { calls++; return { switched: true, model: "qwen3.8-27b", provider: "Qwen on PC", previous: { model: "gpt-6-astra", provider: "ChatGPT" } }; };
  for (const [options, status] of [[{ reloadProviders }, 200], [{}, 400]] as const) {
    const app = createDaemonApp({ databasePath: join(root, String(status), "state.sqlite"), ...options });
    const server = Bun.serve({ port: 0, fetch: app.fetch });
    try {
      const response = await fetch(new URL("/v1/providers/reload", server.url), { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      expect(response.status).toBe(status);
      if (status === 200) expect(await response.json()).toMatchObject({ switched: true, model: "qwen3.8-27b" });
    } finally { server.stop(true); await app.close(); }
  }
  expect(calls).toBe(1);
});
