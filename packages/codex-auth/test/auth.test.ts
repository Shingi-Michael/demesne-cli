import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAuth, CODEX_CLIENT_ID } from "../src/index.ts";
import { ACCOUNT_ID, auth as authClaims, fakeCodexIssuer } from "./fixture.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
let nextPort = 14550 + Math.floor(Math.random() * 400);
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "codex-auth-test-")); roots.push(root);
  const fake = fakeCodexIssuer(), auth = new CodexAuth(root, { fetch: fake.fetch, callbackPort: nextPort++ });
  const signIn = async () => { const login = await auth.beginLogin(); try { expect((await fake.callback(login.url)).status).toBe(200); return await login.account; } finally { await login.close(); } };
  return { root, fake, auth, signIn };
}

test("browser sign-in uses Codex's registration and keeps owner-only tokens with the billed account", async () => {
  const { root, fake, auth } = fixture();
  const login = await auth.beginLogin();
  try {
    const url = new URL(login.url), params = url.searchParams;
    expect(url.origin + url.pathname).toBe("https://auth.openai.com/oauth/authorize");
    expect(params.get("client_id")).toBe(CODEX_CLIENT_ID); expect(params.get("code_challenge_method")).toBe("S256");
    expect(params.get("codex_cli_simplified_flow")).toBe("true"); expect(params.get("id_token_add_organizations")).toBe("true");
    expect(params.get("scope")).toContain("offline_access");
    expect(params.get("redirect_uri")).toMatch(/^http:\/\/localhost:\d+\/auth\/callback$/);
    expect((await fake.callback(login.url)).status).toBe(200);
    const account = await login.account;
    expect(account).toEqual({ signedIn: true, email: "person@example.test", planType: "pro", accountId: ACCOUNT_ID });
    expect(await auth.accountId()).toBe(ACCOUNT_ID);
    expect(await auth.accessToken()).toMatch(/^eyJ/);
    expect(fake.exchanges[0]!.get("client_id")).toBe(CODEX_CLIENT_ID); expect(fake.exchanges[0]!.has("client_secret")).toBe(false);
    expect(statSync(join(root, "auth")).mode & 0o777).toBe(0o700); expect(statSync(join(root, "auth/codex.json")).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(await auth.status())).not.toMatch(/refresh-secret|eyJ/);
    expect(fake.requests.every(r => r.init?.redirect === "manual")).toBe(true);
  } finally { await login.close(); }
});

test("invalid state cannot consume an attempt, and a declined sign-in never exchanges a code", async () => {
  const { fake, auth } = fixture();
  const login = await auth.beginLogin();
  try {
    expect((await fake.callback(login.url, { state: "wrong" })).status).toBe(400);
    expect((await fake.callback(login.url, { code: null, error: "access_denied" })).status).toBe(200);
    await expect(login.account).rejects.toMatchObject({ code: "access_denied" });
    expect(fake.exchanges).toHaveLength(0);
    expect((await auth.status()).signedIn).toBe(false);
  } finally { await login.close(); }
});

test("an expired access token is refreshed once under the lock and the rotated refresh token is kept", async () => {
  const { root, fake, auth, signIn } = fixture();
  fake.expiresIn = 30;
  await signIn();
  const [a, b] = await Promise.all([auth.accessToken(), auth.accessToken()]);
  expect(a).toBe(b); expect(fake.refreshCount).toBe(1);
  expect(JSON.parse(readFileSync(join(root, "auth/codex.json"), "utf8")).tokens.refreshToken).toBe("refresh-rotated-1");
  expect(fake.exchanges.at(-1)!.get("grant_type")).toBe("refresh_token");
  expect(fake.exchanges.at(-1)!.get("client_id")).toBe(CODEX_CLIENT_ID);
});

test("a terminal refresh rejection signs out; a transient one keeps the tokens", async () => {
  const { fake, auth, signIn } = fixture();
  fake.expiresIn = 30;
  await signIn();
  fake.refreshError = "server_error";
  await expect(auth.accessToken()).rejects.toThrow(/server_error/);
  expect((await auth.status()).signedIn).toBe(true);
  fake.refreshError = "invalid_grant";
  await expect(auth.accessToken()).rejects.toMatchObject({ code: "invalid_grant" });
  expect((await auth.status()).signedIn).toBe(false);
  await expect(auth.accessToken()).rejects.toMatchObject({ code: "signed_out" });
});

test("the earlier managed Codex home's sign-in carries over once, then is refreshed", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-auth-legacy-")); roots.push(root);
  const fake = fakeCodexIssuer();
  mkdirSync(join(root, "codex"), { recursive: true });
  const old = { auth_mode: "chatgpt", OPENAI_API_KEY: null, tokens: { id_token: fake.jwt({ email: "old@example.test", ...authClaims("prolite") }), access_token: fake.jwt({ exp: 1, ...authClaims("prolite") }), refresh_token: "legacy-refresh", account_id: ACCOUNT_ID }, last_refresh: "2026-10-05T22:36:41Z" };
  writeFileSync(join(root, "codex/auth.json"), JSON.stringify(old));
  const auth = new CodexAuth(root, { fetch: fake.fetch, callbackPort: nextPort++ });
  expect(await auth.status()).toEqual({ signedIn: true, email: "old@example.test", planType: "prolite", accountId: ACCOUNT_ID });
  expect(await auth.accessToken()).toMatch(/^eyJ/);
  expect(fake.exchanges[0]!.get("refresh_token")).toBe("legacy-refresh");
  // The vault is the source from now on; the old home is not re-read.
  writeFileSync(join(root, "codex/auth.json"), "garbage");
  expect((await auth.status()).signedIn).toBe(true);
  await auth.logout();
  expect((await auth.status()).signedIn).toBe(false);
});

test("a busy callback port is reported instead of a hung sign-in", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-auth-port-")); roots.push(root);
  const port = nextPort++;
  const holder = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("busy") });
  try {
    const auth = new CodexAuth(root, { fetch: fakeCodexIssuer().fetch, callbackPort: port });
    await expect(auth.beginLogin()).rejects.toMatchObject({ code: "port_in_use" });
  } finally { await holder.stop(true); }
});
