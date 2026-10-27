import { createHash } from "node:crypto";

const jwt = (claims: Record<string, unknown>) => `${Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
export const ACCOUNT_ID = "acct-fixture-0001";
export const auth = (plan = "pro") => ({ "https://api.openai.com/auth": { chatgpt_account_id: ACCOUNT_ID, chatgpt_plan_type: plan } });

/** A fake Codex issuer: PKCE-checked code exchange and rotating refresh tokens. */
export function fakeCodexIssuer() {
  let authorize: URL;
  let refreshCount = 0, refreshError: string | undefined, expiresIn = 3600;
  const exchanges: URLSearchParams[] = [];
  const requests: { url: string; init?: RequestInit }[] = [];
  const access = (n: string, ttl = expiresIn) => jwt({ exp: Math.floor(Date.now() / 1000) + ttl, ...auth(), marker: n });
  const fetcher = (async (input: unknown, init?: RequestInit) => {
    const url = String(input); requests.push({ url, init });
    if (url === "https://auth.openai.com/oauth/token") {
      const body = new URLSearchParams(String(init?.body)); exchanges.push(body);
      if (body.get("grant_type") === "refresh_token") {
        refreshCount++; await Bun.sleep(25);
        if (refreshError) return Response.json({ error: refreshError }, { status: 400 });
        return Response.json({ id_token: jwt({ email: "person@example.test", ...auth() }), access_token: access(`refreshed-${refreshCount}`, 3600), refresh_token: `refresh-rotated-${refreshCount}`, token_type: "Bearer", expires_in: 3600 });
      }
      if (createHash("sha256").update(body.get("code_verifier")!).digest("base64url") !== authorize.searchParams.get("code_challenge")) throw new Error("PKCE mismatch");
      if (body.get("redirect_uri") !== authorize.searchParams.get("redirect_uri")) throw new Error("Callback mismatch");
      return Response.json({ id_token: jwt({ email: "person@example.test", ...auth() }), access_token: access("initial"), refresh_token: "refresh-secret", token_type: "Bearer", expires_in: expiresIn });
    }
    throw new Error("Unexpected outbound request: " + url);
  }) as typeof fetch;
  return { fetch: fetcher, exchanges, requests, jwt, get refreshCount() { return refreshCount; },
    set refreshError(value: string | undefined) { refreshError = value; }, set expiresIn(value: number) { expiresIn = value; },
    async callback(url: string, values: Record<string, string | null> = {}) {
      authorize = new URL(url);
      const callback = new URL(authorize.searchParams.get("redirect_uri")!);
      callback.hostname = "127.0.0.1";
      callback.search = new URLSearchParams({ state: authorize.searchParams.get("state")!, code: "fixture-code", ...Object.fromEntries(Object.entries(values).filter(([, v]) => v !== null)) as Record<string, string> }).toString();
      for (const [key, value] of Object.entries(values)) if (value === null) callback.searchParams.delete(key);
      return fetch(callback, { redirect: "manual" });
    },
  };
}
