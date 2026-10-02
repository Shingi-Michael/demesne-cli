import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { createHash } from "node:crypto";

export async function fakeChatGPT() {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = { ...await exportJWK(publicKey), kid: "fixture", alg: "RS256", use: "sig" };
  let authorize: URL;
  let nonceOverride: string | undefined, audienceOverride: string | undefined, subject = "account-1";
  let scope = "openid email profile offline_access resource.invoke chatgpt.tokens.use.direct";
  let refreshError: string | undefined;
  let refreshCount = 0, expires = 3600;
  const exchanges: URLSearchParams[] = [];
  const requests: { url: string; init?: RequestInit }[] = [];
  const fetcher = (async (input: unknown, init?: RequestInit) => {
    const url = String(input); requests.push({ url, init });
    if (url.endsWith("/.well-known/jwks.json")) return Response.json({ keys: [jwk] });
    if (url.endsWith("/.well-known/openid-configuration")) return Response.json({ revocation_endpoint: "https://auth.openai.com/revoke" });
    if (url.endsWith("/revoke")) return new Response("");
    if (url.endsWith("/oauth/token")) {
      const body = new URLSearchParams(String(init?.body)); exchanges.push(body);
      if (body.get("grant_type") === "refresh_token") {
        refreshCount++; await Bun.sleep(25);
        if (refreshError) return Response.json({ error: refreshError }, { status: 400 });
        return Response.json({ access_token: `access-refreshed-${refreshCount}`, refresh_token: `refresh-rotated-${refreshCount}`, token_type: "Bearer", expires_in: 3600, scope });
      }
      if (createHash("sha256").update(body.get("code_verifier")!).digest("base64url") !== authorize.searchParams.get("code_challenge")) throw new Error("PKCE mismatch");
      if (body.get("redirect_uri") !== authorize.searchParams.get("redirect_uri")) throw new Error("Callback mismatch");
      const idToken = await new SignJWT({ email: "person@example.test", nonce: nonceOverride ?? authorize.searchParams.get("nonce") })
        .setProtectedHeader({ alg: "RS256", kid: "fixture" }).setIssuer("https://auth.openai.com").setAudience(audienceOverride ?? body.get("client_id")!).setSubject(subject).setIssuedAt().setExpirationTime("1h").sign(privateKey);
      return Response.json({ access_token: "access-secret", refresh_token: "refresh-secret", id_token: idToken, token_type: "Bearer", expires_in: expires, scope });
    }
    if (url.endsWith("/v1/models")) return Response.json({ models: [{ slug: "model-fixture", display_name: "Fixture", visibility: "list", context_window: 64000 }] });
    throw new Error("Unexpected outbound request: " + url);
  }) as typeof fetch;
  return { fetch: fetcher, exchanges, requests, get refreshCount() { return refreshCount; },
    set refreshError(value: string | undefined) { refreshError = value; },
    set expires(value: number) { expires = value; }, set scope(value: string) { scope = value; },
    set nonce(value: string | undefined) { nonceOverride = value; }, set audience(value: string | undefined) { audienceOverride = value; }, set subject(value: string) { subject = value; },
    async callback(url: string, values: Record<string, string | null> = {}) {
      authorize = new URL(url);
      const callback = new URL(authorize.searchParams.get("redirect_uri")!);
      callback.search = new URLSearchParams({ state: authorize.searchParams.get("state")!, code: "fixture-code", client_id: "oaiapp_fixture", ...Object.fromEntries(Object.entries(values).filter(([, v]) => v !== null)) as Record<string, string> }).toString();
      for (const [key, value] of Object.entries(values)) if (value === null) callback.searchParams.delete(key);
      return fetch(callback, { redirect: "manual" });
    },
  };
}
