import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatGPTAuth } from "../src/index.ts";
import { fakeChatGPT } from "./fixture.ts";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "chatgpt-auth-test-")); roots.push(root);
  const fake = await fakeChatGPT(), auth = new ChatGPTAuth(root, { fetch: fake.fetch });
  const signIn = async () => { const login = await auth.beginLogin(); try { expect((await fake.callback(login.url)).status).toBe(200); return await login.account; } finally { await login.close(); } };
  return { root, fake, auth, signIn };
}

test("dynamic registration verifies identity and saves owner-only credentials separately from public account metadata", async () => {
  const { root, fake, auth } = await fixture();
  const login = await auth.beginLogin();
  try {
    const url = new URL(login.url), params = url.searchParams;
    expect(url.origin + url.pathname).toBe("https://auth.openai.com/api/accounts/authorize");
    expect(params.get("client_id")).toBe("dynamic_agent_client"); expect(params.get("agent_name_hint")).toBe("Demesne");
    expect(params.get("resource")).toBe("https://api.openai.com/v1"); expect(params.get("code_challenge_method")).toBe("S256");
    expect(params.get("redirect_uri")).toMatch(/^http:\/\/127.0.0.1:\d+\/auth\/callback$/);
    expect(JSON.parse(readFileSync(join(root, "auth/chatgpt.json"), "utf8")).hostId).toBe(params.get("ext_agent_host_id"));
    expect((await fake.callback(login.url)).status).toBe(200);
    const account = await login.account;
    expect(account.planEnabled).toBe(true); expect(account.acknowledged).toBe(false);
    expect(await auth.accessToken(account.id)).toBe("access-secret");
    expect(JSON.stringify(await auth.accounts())).not.toMatch(/access-secret|refresh-secret|eyJ/);
    expect(statSync(join(root, "auth")).mode & 0o777).toBe(0o700); expect(statSync(join(root, "auth/chatgpt.json")).mode & 0o777).toBe(0o600);
    expect(fake.exchanges[0]!.get("client_id")).toBe("oaiapp_fixture"); expect(fake.exchanges[0]!.has("client_secret")).toBe(false);
    expect(fake.requests.every(r => r.init?.redirect === "manual")).toBe(true);
  } finally { await login.close(); }
});

test("invalid state cannot consume an attempt, and access_denied never exchanges a code", async () => {
  const { fake, auth } = await fixture();
  const login = await auth.beginLogin();
  expect((await fake.callback(login.url, { state: "wrong" })).status).toBe(400);
  expect(fake.exchanges).toHaveLength(0);
  await fake.callback(login.url, { error: "access_denied" });
  await expect(login.account).rejects.toThrow("declined"); expect(fake.exchanges).toHaveLength(0);
  await login.close();
});

for (const scenario of ["nonce", "audience", "client"] as const) test(`rejects mismatched ${scenario} before storing credentials`, async () => {
  const { fake, auth } = await fixture();
  if (scenario === "nonce") fake.nonce = "wrong-nonce";
  if (scenario === "audience") fake.audience = "oaiapp_wrong";
  const login = await auth.beginLogin();
  await fake.callback(login.url, scenario === "client" ? { client_id: "dynamic_agent_client" } : {});
  await expect(login.account).rejects.toThrow(); expect(await auth.accounts()).toHaveLength(0); await login.close();
});

test("returning sign-in reuses host and issued client, omits identity hints, and rejects another verified identity", async () => {
  const { fake, auth, signIn } = await fixture();
  const account = await signIn();
  await auth.acknowledge(account.id);
  const login = await auth.beginLogin({ accountId: account.id });
  const p = new URL(login.url).searchParams;
  expect(p.get("client_id")).toBe("oaiapp_fixture"); expect(p.has("agent_name_hint")).toBe(false); expect(p.has("id_token_hint")).toBe(false);
  await fake.callback(login.url, { client_id: null });
  expect((await login.account).id).toBe(account.id); expect((await auth.accounts())[0]!.acknowledged).toBe(true); await login.close();
  const wrong = await auth.beginLogin({ accountId: account.id }); fake.subject = "different-person";
  await fake.callback(wrong.url); await expect(wrong.account).rejects.toThrow("different account");
  expect(await auth.accounts()).toHaveLength(1); await wrong.close();
});

test("missing plan scopes retain identity but block inference", async () => {
  const { fake, auth, signIn } = await fixture(); fake.scope = "openid email profile";
  const account = await signIn(); expect(account.signedIn).toBe(true); expect(account.planEnabled).toBe(false);
  await expect(auth.accessToken(account.id)).rejects.toThrow("not enabled");
  const login = await auth.beginLogin({ accountId: account.id, consent: true });
  expect(new URL(login.url).searchParams.get("prompt")).toBe("consent"); await login.close();
});

test("concurrent clients rotate a refresh token only once and persist the replacement", async () => {
  const { root, fake, auth, signIn } = await fixture(); fake.expires = 1;
  const account = await signIn();
  const secondClient = new ChatGPTAuth(root, { fetch: fake.fetch });
  const tokens = await Promise.all([auth.accessToken(account.id), secondClient.accessToken(account.id), auth.accessToken(account.id)]);
  expect(tokens).toEqual(["access-refreshed-1", "access-refreshed-1", "access-refreshed-1"]); expect(fake.refreshCount).toBe(1);
  const saved = JSON.parse(readFileSync(join(root, "auth/chatgpt.json"), "utf8")).accounts[0];
  expect(saved.refreshToken).toBe("refresh-rotated-1");
  const refresh = fake.exchanges.find(b => b.get("grant_type") === "refresh_token")!;
  expect(refresh.get("client_id")).toBe("oaiapp_fixture"); expect(refresh.get("resource")).toBe("https://api.openai.com/v1"); expect(refresh.has("scope")).toBe(false);
});

test("terminal refresh rejection clears tokens but retains the account registration", async () => {
  const { root, fake, auth, signIn } = await fixture(); fake.expires = 1;
  const account = await signIn(); fake.refreshError = "refresh_token_reused";
  await expect(auth.accessToken(account.id)).rejects.toThrow("expired");
  const saved = readFileSync(join(root, "auth/chatgpt.json"), "utf8");
  expect(saved).not.toContain("access-secret"); expect(saved).not.toContain("refresh-secret"); expect(saved).toContain("oaiapp_fixture");
  expect((await auth.accounts())[0]!.signedIn).toBe(false);
});

test("transient refresh failure preserves credentials", async () => {
  const { fake, auth, signIn } = await fixture(); fake.expires = 1;
  const account = await signIn(); fake.refreshError = "temporarily_unavailable";
  await expect(auth.accessToken(account.id)).rejects.toThrow(); expect((await auth.accounts())[0]!.signedIn).toBe(true);
  fake.refreshError = undefined; expect(await auth.accessToken(account.id)).toBe("access-refreshed-2");
});

test("logout revokes the refresh token and prevents later requests", async () => {
  const { fake, auth, signIn } = await fixture(); const account = await signIn();
  expect(await auth.logout(account.id)).toEqual({ revoked: true });
  const request = fake.requests.find(r => r.url.endsWith("/revoke"))!;
  expect(new URLSearchParams(String(request.init?.body)).get("token")).toBe("refresh-secret");
  expect((await auth.accounts())[0]!.signedIn).toBe(false);
  await expect(auth.accessToken(account.id)).rejects.toThrow("signed out");
});

test("cancellation and timeout close the callback listener without persisting tokens", async () => {
  const { auth } = await fixture(); const controller = new AbortController();
  const login = await auth.beginLogin({ signal: controller.signal }); controller.abort();
  await expect(login.account).rejects.toThrow("cancelled"); await login.close();
  const timed = await auth.beginLogin({ timeoutMs: 10 }); await expect(timed.account).rejects.toThrow("timed out"); await timed.close();
  expect(await auth.accounts()).toHaveLength(0);
});

test("separate Bun processes share a refresh lock", async () => {
  const { root, fake, signIn } = await fixture(); fake.expires = 1; const account = await signIn();
  let refreshes = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch() {
    refreshes++; await Bun.sleep(100);
    return Response.json({ access_token: "cross-process-access", refresh_token: "cross-process-refresh", token_type: "Bearer", expires_in: 3600 });
  } });
  const source = `import { ChatGPTAuth } from ${JSON.stringify(join(import.meta.dir, "../src/index.ts"))}; const auth = new ChatGPTAuth(${JSON.stringify(root)}, { fetch: (url, init) => fetch(${JSON.stringify(server.url.href)}, init) }); console.log(await auth.accessToken(${JSON.stringify(account.id)}));`;
  try {
    const children = [0, 1].map(() => Bun.spawn([process.execPath, "--eval", source], { stdout: "pipe", stderr: "pipe" }));
    const results = await Promise.all(children.map(async c => ({ code: await c.exited, out: await new Response(c.stdout).text(), err: await new Response(c.stderr).text() })));
    expect(results.map(r => r.code)).toEqual([0, 0]); expect(results.map(r => r.out.trim())).toEqual(["cross-process-access", "cross-process-access"]); expect(refreshes).toBe(1);
  } finally { await server.stop(true); }
});
