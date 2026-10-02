import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, constants } from "node:fs";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { lock } from "proper-lockfile";
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from "jose";

export const CHATGPT_API = "https://api.openai.com/v1";
export const CHATGPT_USAGE = "https://chatgpt.com/settings/usage";
const ISSUER = "https://auth.openai.com";
const SCOPES = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const TERMINAL_REFRESH = new Set(["invalid_grant", "invalid_refresh_token", "token_expired", "refresh_token_expired", "refresh_token_invalidated", "refresh_token_reused"]);
export class ChatGPTAuthError extends Error {
  constructor(message: string, readonly code?: string) { super(message); this.name = "ChatGPTAuthError"; }
}
export interface ChatGPTAccount {
  id: string;
  email?: string;
  label: string;
  signedIn: boolean;
  planEnabled: boolean;
  acknowledged: boolean;
}
interface Registration {
  id: string; clientId: string; issuer: string; subject: string; email?: string;
  accessToken?: string; refreshToken?: string; idToken?: string;
  expiresAt?: number; earliestRefreshAt?: number; scopes: string[]; acknowledged: boolean;
}
interface Vault { version: 1; hostId: string; accounts: Registration[] }
export interface ChatGPTLogin { url: string; account: Promise<ChatGPTAccount>; close(): Promise<void> }
type Fetcher = typeof fetch;
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 128 * 1024;
const random = () => randomBytes(32).toString("base64url");
const planEnabled = (a: Registration) => a.scopes.includes("chatgpt.tokens.use.direct") && a.scopes.includes("resource.invoke");
const summary = (a: Registration): ChatGPTAccount => ({ id: a.id, email: a.email, label: `${a.email ?? "ChatGPT account"} · ${a.id.slice(0, 8)}`, signedIn: !!a.accessToken, planEnabled: !!a.accessToken && planEnabled(a), acknowledged: a.acknowledged });

/** Demesne's own credentials. Never consults another application's auth files. */
export class ChatGPTAuth {
  private readonly directory: string;
  private readonly path: string;
  private readonly fetcher: Fetcher;
  constructor(dataDirectory: string, options: { fetch?: Fetcher } = {}) {
    this.directory = join(dataDirectory, "auth");
    this.path = join(this.directory, "chatgpt.json");
    this.fetcher = options.fetch ?? fetch;
  }
  async accounts(): Promise<ChatGPTAccount[]> { return this.read().accounts.map(summary); }
  async acknowledge(id: string): Promise<void> {
    await this.locked(() => { const vault = this.read(); this.get(vault, id).acknowledged = true; this.write(vault); });
  }
  private get(vault: Vault, id: string): Registration {
    const account = vault.accounts.find(a => a.id === id);
    if (!account) throw new ChatGPTAuthError("ChatGPT account not found. Run demesne auth login chatgpt.", "account_missing");
    return account;
  }
  async beginLogin(options: { accountId?: string; consent?: boolean; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<ChatGPTLogin> {
    options.signal?.throwIfAborted();
    const { hostId, previous } = await this.locked(() => {
      const vault = this.read(); this.write(vault);
      return { hostId: vault.hostId, previous: options.accountId ? { ...this.get(vault, options.accountId) } : undefined };
    }, options.signal);
    const controller = new AbortController();
    const state = random(), nonce = random(), verifier = random();
    let resolve!: (a: ChatGPTAccount) => void, reject!: (e: Error) => void;
    const account = new Promise<ChatGPTAccount>((yes, no) => { resolve = yes; reject = no; });
    // Attach a handler immediately: browser launch may take longer than cancellation.
    void account.catch(() => {});
    let settled = false, exchanging = false;
    const finish = (error?: Error, value?: ChatGPTAccount) => {
      if (settled) return;
      settled = true; clearTimeout(timer); options.signal?.removeEventListener("abort", abort);
      if (error) { controller.abort(error); reject(error); } else resolve(value!);
      // Let the current callback response flush before closing the listener.
      void server.stop();
    };
    const abort = () => finish(new ChatGPTAuthError("ChatGPT sign-in cancelled.", "cancelled"));
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 30, async fetch(request) {
      const url = new URL(request.url);
      const reply = (message: string, status = 200) => new Response(message, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'" } });
      if (url.pathname !== "/auth/callback" || url.host !== `127.0.0.1:${server.port}` || request.method !== "GET") return reply("Not found", 404);
      const received = url.searchParams.getAll("state");
      if (received.length !== 1 || Buffer.byteLength(received[0]!) !== Buffer.byteLength(state) || !timingSafeEqual(Buffer.from(received[0]!), Buffer.from(state))) return reply("Invalid sign-in state. Return to Demesne and retry.", 400);
      if (settled || exchanging) return reply("This sign-in attempt has already been used.", 409);
      if (url.searchParams.has("error")) {
        finish(new ChatGPTAuthError("ChatGPT sign-in was declined. Return to Demesne to try again.", "access_denied"));
        return reply("Sign-in cancelled. You can return to Demesne.");
      }
      const code = url.searchParams.get("code"), callbackClient = url.searchParams.get("client_id");
      const clientId = callbackClient ?? previous?.clientId;
      if (!code || code.length > 8192 || url.searchParams.getAll("code").length !== 1 || !clientId || !/^oaiapp_[A-Za-z0-9_-]+$/.test(clientId) || url.searchParams.getAll("client_id").length > 1 || previous && clientId !== previous.clientId) {
        finish(new ChatGPTAuthError("ChatGPT returned an incomplete or mismatched registration. Start sign-in again.", "registration_mismatch"));
        return reply("Sign-in could not be validated. Return to Demesne.", 400);
      }
      exchanging = true;
      try {
        const value = await complete(code, clientId);
        finish(undefined, value);
        return reply("Connected to Demesne. You can close this tab and return to your terminal.");
      } catch (error) {
        finish(error instanceof ChatGPTAuthError ? error : new ChatGPTAuthError("ChatGPT sign-in could not be verified. Try again.", "verification_failed"));
        return reply("Sign-in failed. Return to Demesne to retry.", 400);
      }
    } });
    const redirectUri = `http://127.0.0.1:${server.port}/auth/callback`;
    const timer = setTimeout(() => finish(new ChatGPTAuthError("ChatGPT sign-in timed out. Try again.", "timeout")), options.timeoutMs ?? 600_000);
    const complete = async (code: string, clientId: string) => {
      const token = await this.token({ grant_type: "authorization_code", client_id: clientId, code, code_verifier: verifier, redirect_uri: redirectUri, resource: CHATGPT_API }, controller.signal);
      if (!text(token.id_token)) throw new ChatGPTAuthError("ChatGPT did not return an identity token.");
      const jwks = await this.json(`${ISSUER}/.well-known/jwks.json`, { signal: controller.signal });
      if (!Array.isArray(jwks.keys)) throw new ChatGPTAuthError("ChatGPT returned invalid signing keys.");
      const { payload } = await jwtVerify(token.id_token, createLocalJWKSet(jwks as unknown as JSONWebKeySet), { issuer: ISSUER, audience: clientId, requiredClaims: ["exp", "sub", "nonce"], algorithms: ["RS256", "ES256"] });
      if (payload.nonce !== nonce || !text(payload.sub) || previous && (payload.sub !== previous.subject || payload.iss !== previous.issuer)) throw new ChatGPTAuthError("ChatGPT returned a different account. Add it as another account instead.", "identity_mismatch");
      const id = createHash("sha256").update(JSON.stringify([ISSUER, payload.sub, clientId])).digest("hex").slice(0, 24);
      const registration: Registration = { id, clientId, issuer: ISSUER, subject: payload.sub, email: typeof payload.email === "string" ? payload.email : undefined,
        scopes: [], acknowledged: previous?.acknowledged ?? false };
      this.applyToken(registration, token, true);
      return this.locked(() => {
        controller.signal.throwIfAborted();
        const vault = this.read(), existing = vault.accounts.find(a => a.id === id);
        registration.acknowledged ||= existing?.acknowledged ?? false;
        vault.accounts = [...vault.accounts.filter(a => a.id !== id), registration];
        this.write(vault); return summary(registration);
      }, controller.signal);
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    const url = new URL(`${ISSUER}/api/accounts/authorize`);
    url.search = new URLSearchParams({ client_id: previous?.clientId ?? "dynamic_agent_client", ...(previous ? {} : { agent_name_hint: "Demesne" }), ext_agent_host_id: hostId,
      response_type: "code", redirect_uri: redirectUri, scope: SCOPES, resource: CHATGPT_API, state, nonce, code_challenge_method: "S256",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"), ...(options.consent ? { prompt: "consent" } : {}) }).toString();
    // Deliberately omit optional identity hints: this URL is safe for the renderer and clipboard.
    return { url: url.href, account, close: async () => { abort(); await server.stop(true); } };
  }
  async accessToken(id: string, signal?: AbortSignal): Promise<string> {
    return this.locked(async () => {
      const vault = this.read(), account = this.get(vault, id), now = Date.now();
      if (!account.accessToken) throw new ChatGPTAuthError("ChatGPT is signed out. Run demesne auth login chatgpt --account " + id, "signed_out");
      if (!planEnabled(account)) throw new ChatGPTAuthError("ChatGPT plan use is not enabled. Sign in again with --consent.", "plan_disabled");
      if ((account.expiresAt ?? 0) > now + 60_000 || (account.earliestRefreshAt ?? 0) > now && (account.expiresAt ?? 0) > now) return account.accessToken;
      if (!account.refreshToken) throw new ChatGPTAuthError("Sign in to ChatGPT again to renew this session.", "signed_out");
      try {
        const token = await this.token({ grant_type: "refresh_token", client_id: account.clientId, refresh_token: account.refreshToken, resource: CHATGPT_API }, signal);
        this.applyToken(account, token, false); this.write(vault);
      } catch (error) {
        if (error instanceof ChatGPTAuthError && TERMINAL_REFRESH.has(error.code ?? "")) {
          this.clearTokens(account); this.write(vault);
          throw new ChatGPTAuthError("ChatGPT session expired. Sign in again to continue.", error.code);
        }
        throw error;
      }
      if (!planEnabled(account)) throw new ChatGPTAuthError("ChatGPT plan permission is no longer enabled. Sign in again with --consent.", "plan_disabled");
      return account.accessToken!;
    }, signal);
  }
  async logout(id: string): Promise<{ revoked: boolean }> {
    return this.locked(async () => {
      const vault = this.read(), account = this.get(vault, id);
      let revoked = !account.refreshToken;
      try {
        if (account.refreshToken) {
          const discovery = await this.json(`${ISSUER}/.well-known/openid-configuration`);
          const endpoint = new URL(String(discovery.revocation_endpoint));
          if (endpoint.origin !== ISSUER || endpoint.username || endpoint.password) throw new Error("Invalid revocation endpoint");
          const response = await this.fetcher(endpoint, { method: "POST", redirect: "manual", signal: AbortSignal.timeout(15_000), headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ token: account.refreshToken, token_type_hint: "refresh_token", client_id: account.clientId }) });
          revoked = response.ok; await response.body?.cancel();
        }
      } catch { /* Sign-out still clears local credentials when remote revocation is unavailable. */ }
      this.clearTokens(account); this.write(vault); return { revoked };
    });
  }
  private clearTokens(a: Registration) { delete a.accessToken; delete a.refreshToken; delete a.idToken; delete a.expiresAt; delete a.earliestRefreshAt; a.scopes = []; }
  private applyToken(a: Registration, token: Record<string, unknown>, initial: boolean) {
    if (!text(token.access_token) || !text(token.refresh_token) || typeof token.token_type !== "string" || token.token_type.toLowerCase() !== "bearer" || typeof token.expires_in !== "number" || !Number.isFinite(token.expires_in) || token.expires_in <= 0 || initial && typeof token.scope !== "string") throw new ChatGPTAuthError("ChatGPT returned an invalid token response.", "invalid_token_response");
    a.accessToken = token.access_token; a.refreshToken = token.refresh_token; a.expiresAt = Date.now() + token.expires_in * 1000;
    if (typeof token.scope === "string") a.scopes = token.scope.split(/\s+/).filter(Boolean);
    if (initial && text(token.id_token)) a.idToken = token.id_token;
    const earliest = typeof token.earliest_refresh_at === "number" ? token.earliest_refresh_at * 1000 : typeof token.earliest_refresh_at === "string" ? Date.parse(token.earliest_refresh_at) : NaN;
    a.earliestRefreshAt = Number.isFinite(earliest) && earliest < a.expiresAt ? earliest : undefined;
  }
  private async token(body: Record<string, string>, signal?: AbortSignal) {
    return this.json(`${ISSUER}/api/accounts/oauth/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body), signal });
  }
  private async json(url: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
    let response: Response;
    try { response = await this.fetcher(url, { ...init, redirect: "manual", signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000) }); }
    catch { throw new ChatGPTAuthError("Could not reach ChatGPT authentication. Try again when connected.", "network_error"); }
    const reader = response.body?.getReader(); let result = "", bytes = 0;
    try {
      if (!reader) throw new Error();
      const decoder = new TextDecoder();
      while (true) { const { value, done } = await reader.read(); if (done) break; bytes += value.byteLength; if (bytes > 1024 * 1024) throw new Error(); result += decoder.decode(value, { stream: true }); }
      result += decoder.decode();
      const parsed: unknown = JSON.parse(result);
      if (!record(parsed)) throw new Error();
      if (!response.ok) {
        const code = typeof parsed.error === "string" && /^[a-z0-9_]{1,80}$/.test(parsed.error) ? parsed.error : undefined;
        throw new ChatGPTAuthError(`ChatGPT authentication failed (${code ?? response.status}). Try signing in again.`, code);
      }
      return parsed;
    } catch (error) { if (error instanceof ChatGPTAuthError) throw error; throw new ChatGPTAuthError("ChatGPT authentication returned an invalid response."); }
    finally { await reader?.cancel().catch(() => {}); }
  }
  private secureDirectory() {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const stat = lstatSync(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ChatGPTAuthError("Demesne's auth directory must be a private local directory.");
    chmodSync(this.directory, 0o700);
  }
  private read(): Vault {
    if (!existsSync(this.path)) return { version: 1, hostId: `urn:uuid:${randomUUID()}`, accounts: [] };
    const fd = openSync(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (lstatSync(this.path).size > 4 * 1024 * 1024) throw new Error();
      const v = JSON.parse(readFileSync(fd, "utf8")) as Vault;
      if (v.version !== 1 || typeof v.hostId !== "string" || !v.hostId.startsWith("urn:uuid:") || !Array.isArray(v.accounts) || v.accounts.some(a => !a.id || !a.clientId.startsWith("oaiapp_") || a.issuer !== ISSUER || !a.subject || !Array.isArray(a.scopes))) throw new Error();
      return v;
    } catch { throw new ChatGPTAuthError("Demesne's ChatGPT credential file is invalid. Restore it before signing in again."); }
    finally { closeSync(fd); }
  }
  private write(vault: Vault) {
    this.secureDirectory();
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try {
      try { writeFileSync(fd, JSON.stringify(vault)); fsyncSync(fd); }
      finally { closeSync(fd); }
      renameSync(temporary, this.path);
    } finally { rmSync(temporary, { force: true }); }
  }
  /** A file lock serializes rotating refresh tokens across CLI, graphics host and daemon. */
  private async locked<T>(work: () => T | Promise<T>, signal?: AbortSignal): Promise<T> {
    this.secureDirectory();
    const started = Date.now();
    let release: (() => Promise<void>) | undefined;
    while (!release) {
      signal?.throwIfAborted();
      try {
        release = await lock(this.directory, { lockfilePath: join(this.directory, "chatgpt.lock"), realpath: false, stale: 60_000, update: 10_000, retries: 0 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ELOCKED") throw error;
        if (Date.now() - started > 30_000) throw new ChatGPTAuthError("Another Demesne process is updating ChatGPT credentials. Try again shortly.");
        await Bun.sleep(50);
      }
    }
    try { signal?.throwIfAborted(); return await work(); }
    finally { await release(); }
  }
}
