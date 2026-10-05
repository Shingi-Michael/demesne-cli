import { describe, expect, test } from "bun:test";
import { CodexAuth, defaultModel } from "../src/index.ts";
import { harness } from "./fixture.ts";

describe("Codex sign-in and model catalog", () => {
  test("returns account metadata without token fields", async () => {
    const h = await harness();
    const auth = new CodexAuth(h.dataDir, { client: h.client });
    try {
      h.route((frame) => h.send({ id: frame.id, result: { account: { type: "chatgpt", email: "test@example.com", planType: "plus", accessToken: "fixture-secret" }, requiresOpenaiAuth: true } }));
      expect(await auth.status()).toEqual({ signedIn: true, authMode: "chatgpt", email: "test@example.com", planType: "plus", requiresOpenaiAuth: true });
    } finally { await auth.close(); await h.close(); }
  });

  test("login completion can precede start response and cancellation becomes a no-op after success", async () => {
    const h = await harness();
    const auth = new CodexAuth(h.dataDir, { client: h.client });
    try {
      h.route((frame) => {
        if (frame.method === "account/login/start") {
          h.send({ method: "account/login/completed", params: { loginId: "login-one", success: true, error: null } });
          h.send({ id: frame.id, result: { type: "chatgpt", loginId: "login-one", authUrl: "https://auth.openai.com/authorize?state=fixture" } });
        } else if (frame.method === "account/read") h.send({ id: frame.id, result: { account: { type: "chatgpt", planType: "plus" }, requiresOpenaiAuth: true } });
      });
      const login = await auth.beginLogin();
      expect(login.url).toStartWith("https://auth.openai.com/");
      expect((await login.complete).signedIn).toBe(true);
      await login.cancel(); await login.cancel();
      expect(h.frames.some((f) => f.method === "account/login/cancel")).toBe(false);
    } finally { await auth.close(); await h.close(); }
  });

  test("cancelled login settles even if upstream cancellation fails", async () => {
    const h = await harness();
    const auth = new CodexAuth(h.dataDir, { client: h.client });
    try {
      h.route((frame) => {
        if (frame.method === "account/login/start") h.send({ id: frame.id, result: { type: "chatgpt", loginId: "login-two", authUrl: "https://auth.openai.com/authorize" } });
        if (frame.method === "account/login/cancel") h.send({ id: frame.id, error: { code: 1, message: "cancel failure" } });
      });
      const login = await auth.beginLogin();
      await expect(login.cancel()).rejects.toThrow("cancel failure");
      await expect(login.complete).rejects.toThrow("cancelled");
      await login.cancel();
    } finally { await auth.close(); await h.close(); }
  });

  test("rejects non-OpenAI browser URLs", async () => {
    const h = await harness();
    const auth = new CodexAuth(h.dataDir, { client: h.client });
    try {
      h.route((frame) => h.send({ id: frame.id, result: { type: "chatgpt", loginId: "bad", authUrl: "file:///tmp/login" } }));
      await expect(auth.beginLogin()).rejects.toThrow("unsupported browser login URL");
    } finally { await auth.close(); await h.close(); }
  });

  test("paginates dynamic reasoning metadata, omits hidden/duplicate models, and selects exact Sol 6.1", async () => {
    const h = await harness();
    const auth = new CodexAuth(h.dataDir, { client: h.client });
    const model = (name: string, extra = {}) => ({ id: name, model: name, displayName: name, defaultReasoningEffort: "high", supportedReasoningEfforts: [{ reasoningEffort: "high" }, { reasoningEffort: "xhigh" }], ...extra });
    try {
      h.route((frame) => {
        const second = (frame.params as { cursor?: string }).cursor;
        h.send({ id: frame.id, result: second ? { data: [model("gpt-6.1-sol"), model("gpt-6-astra")], nextCursor: null } : { data: [model("gpt-6-astra", { isDefault: true }), model("hidden", { hidden: true })], nextCursor: "page-two" } });
      });
      const models = await auth.listModels();
      expect(models.map((m) => m.model)).toEqual(["gpt-6-astra", "gpt-6.1-sol"]);
      expect(models[1]?.reasoningEfforts).toEqual(["high", "xhigh"]);
      expect(models[1]?.inputModalities).toEqual(["text", "image"]);
      expect(defaultModel(models)).toBe("gpt-6.1-sol");
    } finally { await auth.close(); await h.close(); }
  });

  test("stops repeated model pagination cursors", async () => {
    const h = await harness();
    const auth = new CodexAuth(h.dataDir, { client: h.client });
    try {
      h.route((frame) => h.send({ id: frame.id, result: { data: [], nextCursor: "repeat" } }));
      await expect(auth.listModels()).rejects.toThrow("repeated model catalog cursor");
    } finally { await auth.close(); await h.close(); }
  });
});
