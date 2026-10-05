import { expect, test } from "bun:test";
import { GraphicsHost } from "../host.ts";
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
  const host = new GraphicsHost({ workspace: f.workspace, settings: f.settings, client: f.client, providerAccounts: accounts, changed: () => {} });
  try {
    const old = host.handle("provider-signin", { key: "new:codex" });
    expect(host.providers.signingIn).toBe("new:codex");
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
  const host = new GraphicsHost({ workspace: f.workspace, settings: f.settings, client: f.client, changed: () => { publications++; }, providerAccounts: {
    signingIn: "new:codex", list: async () => [], signIn: () => login.promise, signOut: async () => ({ label: "unused" }),
    cancel() { cancelled++; login.reject(new Error("Cancelled on close.")); },
  } });
  try {
    const flow = host.handle("provider-signin", { key: "new:codex" });
    host.dispose();
    const before = publications;
    await flow;
    expect(cancelled).toBe(1);
    expect(publications).toBe(before);
  } finally { await f.close(); }
});
