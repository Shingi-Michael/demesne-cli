import { expect, test } from "bun:test";
import { WorkspaceHost } from "../host.ts";
import type { ProviderAccounts } from "../providers.ts";
import { fixture } from "./fixture.ts";

test("a cancelled browser flow cannot erase a newer sign-in or its cancel state", async () => {
  const f = await fixture();
  let pending: ReturnType<typeof Promise.withResolvers<{ label: string }>> | undefined;
  const accounts: Pick<ProviderAccounts, "signingIn" | "list" | "signIn" | "signOut" | "cancel"> = {
    signingIn: null,
    list: async () => [],
    signIn(key) {
      this.cancel();
      this.signingIn = key;
      pending = Promise.withResolvers<{ label: string }>();
      return pending.promise;
    },
    signOut: async () => ({ label: "unused" }),
    cancel() { pending?.reject(new Error("Previous sign-in cancelled.")); this.signingIn = null; },
  };
  const host = new WorkspaceHost({ workspace: f.workspace, settings: f.settings, client: f.client, providerAccounts: accounts, changed: () => {} });
  try {
    const old = host.handle("provider-signin", { key: "new:chatgpt" });
    expect(host.providers.signingIn).toBe("new:chatgpt");
    const current = host.handle("provider-signin", { key: "new:openrouter" });
    await old;
    expect(host.providers).toMatchObject({ signingIn: "new:openrouter", message: "Finish signing in in your browser." });
    await host.handle("provider-cancel", {});
    await current;
    expect(host.providers).toMatchObject({ signingIn: null, message: "Sign-in cancelled." });
  } finally { host.dispose(); await f.close(); }
});

test("closing the host cancels its browser sign-in without publishing a stale error", async () => {
  const f = await fixture();
  const login = Promise.withResolvers<{ label: string }>();
  let cancelled = 0, publications = 0;
  const host = new WorkspaceHost({ workspace: f.workspace, settings: f.settings, client: f.client, changed: () => { publications++; }, providerAccounts: {
    signingIn: "new:chatgpt", list: async () => [], signIn: () => login.promise, signOut: async () => ({ label: "unused" }),
    cancel() { cancelled++; login.reject(new Error("Cancelled on close.")); },
  } });
  try {
    const flow = host.handle("provider-signin", { key: "new:chatgpt" });
    host.dispose();
    const before = publications;
    await flow;
    expect(cancelled).toBe(1);
    expect(publications).toBe(before);
  } finally { await f.close(); }
});

test("Google discovery returns metadata without publishing a key or reloading providers", async () => {
  const f = await fixture();
  let reloads = 0, cancelled = 0;
  f.client.reloadProviders = async () => { reloads++; throw new Error("must not reload"); };
  const googleAI = {
    discover: async (_key: unknown) => ({ models: [{ id: "gemini-fixture", contextWindow: 32768, maxOutputTokens: 8192 }] }),
    test: async () => ({ message: "Passed; key not saved" }),
    save: async () => ({ label: "Google AI Studio", model: "gemini-fixture" }),
    cancel() { cancelled++; },
  };
  const host = new WorkspaceHost({ workspace: f.workspace, settings: f.settings, client: f.client, googleAI, changed: () => {} });
  try {
    expect(await host.handle("google-ai-check", { operationId: "fixture-op", apiKey: "fake-key-never-persist" })).toEqual(await googleAI.discover(""));
    await host.handle("google-ai-test", { operationId: "fixture-op", apiKey: "fake-key-never-persist", model: "gemini-fixture" });
    expect(JSON.stringify(host.snapshot())).not.toContain("fake-key-never-persist");
    expect(reloads).toBe(0);
    await expect(host.handle("google-ai-save", { operationId: "fixture-op", apiKey: "fake-key-never-persist", model: "gemini-fixture" })).rejects.toThrow("explicit permission");
    expect(reloads).toBe(0);
    const beforeCancel = cancelled;
    await host.handle("google-ai-cancel", { operationId: "fixture-op" });
    expect(cancelled).toBe(beforeCancel); // a completed operation is not cancelled
  } finally { host.dispose(); await f.close(); }
  expect(cancelled).toBe(3);
});

test("Google Save reports a saved-but-not-reloaded credential without leaking daemon errors", async () => {
  const f = await fixture();
  let saves = 0, reloads = 0;
  f.client.reloadProviders = async () => { reloads++; throw new Error("fake-key-reload-secret"); };
  const host = new WorkspaceHost({ workspace: f.workspace, settings: f.settings, client: f.client, changed: () => {}, googleAI: {
    discover: async () => ({ models: [] }), test: async () => ({ message: "ok" }), cancel() {},
    save: async () => { saves++; return { label: "Google AI Studio", model: "gemini-fixture" }; },
  } });
  try {
    const result = await host.handle("google-ai-save", { operationId: "fixture-save", key: "new:google", apiKey: "fake-key-reload-secret", model: "gemini-fixture", remember: true });
    expect(saves).toBe(1); expect(reloads).toBe(1);
    expect(JSON.stringify(result)).toContain("saved locally");
    expect(JSON.stringify([result, host.snapshot()])).not.toContain("fake-key-reload-secret");
  } finally { host.dispose(); await f.close(); }
});
test("Google cancellation survives a stale session and cannot cancel a newer operation", async () => {
  const f = await fixture();
  let pending: ReturnType<typeof Promise.withResolvers<{ models: [] }>> | undefined, cancelled = 0;
  const host = new WorkspaceHost({ workspace: f.workspace, settings: f.settings, client: f.client, changed: () => {}, googleAI: {
    discover() { pending = Promise.withResolvers<{ models: [] }>(); return pending.promise; },
    test: async () => ({ message: "ok" }), save: async () => ({ label: "Google AI Studio", model: "gemini-fixture" }),
    cancel() { cancelled++; pending?.reject(new Error("cancelled")); },
  } });
  try {
    const old = host.handle("google-ai-check", { operationId: "old", apiKey: "fixture-key" }).catch(error => error.message);
    const next = host.handle("google-ai-check", { operationId: "next", apiKey: "fixture-key" }).catch(error => error.message);
    expect(await old).toBe("cancelled");
    const before = cancelled;
    await host.handle("google-ai-cancel", { operationId: "old", sessionId: "stale-session" });
    expect(cancelled).toBe(before);
    await host.handle("google-ai-cancel", { operationId: "next", sessionId: "stale-session" });
    expect(cancelled).toBe(before + 1);
    expect(await next).toBe("cancelled");
  } finally { host.dispose(); await f.close(); }
});
test("a committed Google key removal still reloads providers when backup cleanup warns", async () => {
  const f = await fixture();
  let reloads = 0;
  f.client.reloadProviders = async () => { reloads++; return { switched: false, model: "fixture", provider: "Local", previous: { model: "fixture", provider: "Local" } }; };
  const host = new WorkspaceHost({ workspace: f.workspace, settings: f.settings, client: f.client, changed: () => {}, providerAccounts: {
    signingIn: null, cancel() {}, signIn: async () => ({ label: "unused" }),
    list: async () => [{ key: "google", kind: "google", label: "Google AI Studio", status: "signed-out", detail: "No saved key", active: false }],
    signOut: async () => ({ label: "Google AI Studio", warning: "Key removed; backup cleanup needs attention." }),
  } });
  try {
    await host.handle("google-ai-disconnect", { key: "google" });
    expect(reloads).toBe(1);
    expect(host.providers.message).toContain("backup cleanup needs attention");
  } finally { host.dispose(); await f.close(); }
});