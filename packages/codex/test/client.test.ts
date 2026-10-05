import { describe, expect, test } from "bun:test";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { harness } from "./fixture.ts";

describe("managed Codex app-server connection", () => {
  test("isolates credentials and workspace, negotiates experimental RPC, and correlates concurrent replies", async () => {
    const prior = process.env.CODEX_ACCESS_TOKEN;
    process.env.CODEX_ACCESS_TOKEN = "fixture-ambient-secret";
    const h = await harness();
    try {
      await Promise.all([h.client.start(), h.client.start()]);
      expect(h.spawnOptions.env.CODEX_HOME).toBe(join(h.dataDir, "codex"));
      expect(h.spawnOptions.env.CODEX_ACCESS_TOKEN).toBeUndefined();
      expect(h.spawnOptions.cwd).toBe(join(h.dataDir, "codex", "workspace"));
      expect((await stat(h.client.home)).mode & 0o777).toBe(0o700);
      expect(h.frames.filter((f) => f.method === "initialize")).toHaveLength(1);
      expect(h.frames[0]?.params).toMatchObject({ clientInfo: { name: "demesne" }, capabilities: { experimentalApi: true } });
      expect(h.frames[1]?.method).toBe("initialized");
      expect(h.args).toContain("features.shell_tool=false");
      expect(h.args).toContain("features.skip_host_skill_discovery=true");
      expect(h.args).toContain("notify=[]");
      const first = h.client.request<string>("one");
      const second = h.client.request<string>("two");
      await new Promise<void>((done) => setTimeout(done, 0));
      const one = h.frames.find((f) => f.method === "one")!;
      const two = h.frames.find((f) => f.method === "two")!;
      h.send({ id: two.id, result: "second" }); h.send({ id: one.id, result: "first" });
      expect(await first).toBe("first"); expect(await second).toBe("second");
    } finally { if (prior === undefined) delete process.env.CODEX_ACCESS_TOKEN; else process.env.CODEX_ACCESS_TOKEN = prior; await h.close(); }
  });

  test("notifications survive UTF-8 split frames and unsubscribe; unsupported requests are rejected", async () => {
    const h = await harness();
    try {
      await h.client.start();
      const notifications: unknown[] = [];
      const off = h.client.onNotification((event) => notifications.push(event));
      const frame = Buffer.from(JSON.stringify({ method: "item/agentMessage/delta", params: { delta: "hello 🌍" } }) + "\n");
      h.raw(frame.subarray(0, frame.length - 4)); h.raw(frame.subarray(frame.length - 4));
      expect(notifications).toEqual([{ method: "item/agentMessage/delta", params: { delta: "hello 🌍" } }]);
      off(); h.send({ method: "ignored", params: {} }); expect(notifications).toHaveLength(1);
      h.send({ id: "unsupported", method: "item/commandExecution/requestApproval", params: {} });
      expect(h.frames.at(-1)).toMatchObject({ id: "unsupported", error: { code: -32601 } });
      h.client.onServerRequest((request) => request.method === "item/tool/call");
      h.send({ id: "tool", method: "item/tool/call", params: {} });
      expect(h.frames.at(-1)?.id).toBe("unsupported");
      h.client.respond("tool", { contentItems: [{ type: "inputText", text: "done" }], success: true });
      expect(h.frames.at(-1)).toMatchObject({ id: "tool", result: { success: true } });
    } finally { await h.close(); }
  });

  test("request cancellation and deadlines clean pending requests without losing later replies", async () => {
    const h = await harness();
    try {
      await h.client.start();
      const signal = new AbortController();
      const cancelled = h.client.request("held", {}, { signal: signal.signal });
      await Promise.resolve(); signal.abort();
      await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
      await expect(h.client.request("timed", {}, { timeoutMs: 2 })).rejects.toThrow("timed out");
      h.route((frame) => h.send({ id: frame.id, result: true }));
      expect(await h.client.request<boolean>("next")).toBe(true);
    } finally { await h.close(); }
  });

  test("child exit wakes notification waiters and rejects outstanding requests", async () => {
    const h = await harness();
    try {
      await h.client.start();
      let error: Error | undefined;
      h.client.onClose((failure) => { error = failure; });
      const pending = h.client.request("held");
      await new Promise<void>((done) => setTimeout(done, 0)); h.exit();
      await expect(pending).rejects.toThrow("stopped unexpectedly");
      expect(error?.message).toContain("stopped unexpectedly");
    } finally { await h.close(); }
  });

  test("malformed and oversized frames fail without exposing raw process output", async () => {
    for (const frame of ["not-json secret\n", "x".repeat(1_100)]) {
      const h = await harness({ maxFrameBytes: 1_024 });
      try {
        await h.client.start();
        const pending = h.client.request("held");
        await Promise.resolve(); h.raw(frame);
        await expect(pending).rejects.toThrow();
      } finally { await h.close(); }
    }
  });

  test("fails closed when managed configuration supplies native MCP tools or reenables workspace tools", async () => {
    for (const config of [{ mcp_servers: { forced: { enabled: true } } }, { features: { shell_tool: true } }, { project_doc_max_bytes: 2_048 }, { notify: ["fixture-command"] }]) {
      const h = await harness();
      try { h.configure(config); await expect(h.client.start()).rejects.toThrow(); }
      finally { await h.close(); }
    }
  });

  test("rejects custom OpenAI endpoints and credentials before account or model requests", async () => {
    for (const config of [
      { openai_base_url: "https://example.com/v1" },
      { chatgpt_base_url: "https://example.com/backend-api/" },
      { chatgpt_base_url: "http://chatgpt.com/backend-api/" },
      { chatgpt_base_url: "https://chatgpt.com/backend-api/?redirect=example.com" },
      { model_providers: { openai: { env_key: "CUSTOM_API_KEY", requires_openai_auth: false } } },
    ]) {
      const h = await harness();
      try {
        h.configure(config);
        await expect(h.client.request("account/read")).rejects.toThrow();
        expect(h.frames.some((frame) => frame.method === "account/read" || frame.method === "model/list")).toBe(false);
      } finally { await h.close(); }
    }
  });

  test("unsafe owned profile routing is rejected before the child can refresh its catalog", async () => {
    for (const content of [
      'openai_base_url = "https://example.com/v1"',
      'chatgpt_base_url = "https://example.com/backend-api/"',
      '[model_providers.openai]\nenv_key = "CUSTOM_API_KEY"',
      '[profiles.alternate]\nopenai_base_url = "https://example.com/v1"',
    ]) {
      const h = await harness();
      try {
        await mkdir(h.client.home, { recursive: true });
        await writeFile(join(h.client.home, "config.toml"), content);
        await expect(h.client.start()).rejects.toThrow();
        expect(h.frames).toHaveLength(0);
        expect(h.args).toHaveLength(0);
      } finally { await h.close(); }
    }
  });
});
