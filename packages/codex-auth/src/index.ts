import { chmodSync, closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { lock } from "proper-lockfile";

/// Codex's own sign-in: the ChatGPT account signed in the way the Codex CLI
/// signs in, so that requests to Codex's backend count against the Codex
/// plan. Demesne keeps these tokens in its own data directory and never
/// reads another application's credential file. The one exception is the
/// Codex home Demesne itself managed before (`<data_dir>/codex/auth.json`),
/// which is imported once so an earlier sign-in keeps working.

export const CODEX_ISSUER = "https://auth.openai.com";
export const CODEX_BACKEND = "https://chatgpt.com/backend-api/codex";
export const CODEX_USAGE = "https://chatgpt.com/settings/usage";
/// The Codex CLI's registration: its redirect is fixed to this loopback port.
export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CODEX_CALLBACK_PORT = 1455;
const SCOPES = "openid profile email offline_access api.connectors.read api.connectors.invoke";
const AUTH_CLAIM = "https://api.openai.com/auth";
const TERMINAL_REFRESH = new Set(["invalid_grant", "invalid_refresh_token", "token_expired", "refresh_token_expired", "refresh_token_invalidated", "refresh_token_reused"]);

export class CodexAuthError extends Error {
  constructor(message: string, readonly code?: string) { super(message); this.name = "CodexAuthError"; }
}
export interface CodexAccountStatus {
  signedIn: boolean;
  email?: string;
  /// "plus", "pro", "team"…, from the identity token when it says.
  planType?: string;
  /// The ChatGPT account the backend bills; sent with every request.
  accountId?: string;
}
interface Tokens { accessToken: string; refreshToken: string; idToken?: string; accountId: string; email?: string; planType?: string; expiresAt: number; lastRefresh: number }
interface Vault { version: 1; tokens?: Tokens }
export interface CodexLogin { url: string; account: Promise<CodexAccountStatus>; close(): Promise<void> }
type Fetcher = typeof fetch;
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 128 * 1024;
const random = () => randomBytes(32).toString("base64url");

/// The claims of a JWT, read without verification: the token came straight
/// from the issuer over TLS, and only its account id, e-mail and expiry are used.
export function jwtClaims(token: string): Record<string, unknown> {
  const parts = token.split(".");
  if (parts.length !== 3) return {};
  try { const parsed: unknown = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")); return record(parsed) ? parsed : {}; }
  catch { return {}; }
}
function identity(idToken: string | undefined, accessToken: string): { accountId?: string; email?: string; planType?: string } {
  const claims = idToken ? jwtClaims(idToken) : {}, access = jwtClaims(accessToken);
  const auth = record(claims[AUTH_CLAIM]) ? claims[AUTH_CLAIM] : record(access[AUTH_CLAIM]) ? access[AUTH_CLAIM] : {};
  const accountId = text(auth.chatgpt_account_id) ? auth.chatgpt_account_id : undefined;
  return { accountId, email: text(claims.email) ? claims.email : undefined, planType: text(auth.chatgpt_plan_type) ? auth.chatgpt_plan_type : undefined };
}
const status = (t: Tokens | undefined): CodexAccountStatus => t ? { signedIn: true, email: t.email, planType: t.planType, accountId: t.accountId } : { signedIn: false };

export class CodexAuth {
  private readonly directory: string;
  private readonly path: string;
  private readonly legacyPath: string;
  private readonly fetcher: Fetcher;
  private readonly port: number;
  constructor(dataDirectory: string, options: { fetch?: Fetcher; callbackPort?: number } = {}) {
    this.directory = join(dataDirectory, "auth");
    this.path = join(this.directory, "codex.json");
    this.legacyPath = join(dataDirectory, "codex", "auth.json");
    this.fetcher = options.fetch ?? fetch;
    this.port = options.callbackPort ?? CODEX_CALLBACK_PORT;
  }
  async status(): Promise<CodexAccountStatus> { return status(this.read().tokens); }

  /// Opens Codex's browser sign-in. The callback lands on the loopback port
  /// Codex's registration names, so a Codex CLI sign-in running at the same
  /// time takes the port first and this one says so.
  async beginLogin(options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<CodexLogin> {
    options.signal?.throwIfAborted();
    const controller = new AbortController();
    const state = random(), verifier = random();
    let resolve!: (a: CodexAccountStatus) => void, reject!: (e: Error) => void;
    const account = new Promise<CodexAccountStatus>((yes, no) => { resolve = yes; reject = no; });
    void account.catch(() => {});
    let settled = false, exchanging = false;
    const finish = (error?: Error, value?: CodexAccountStatus) => {
      if (settled) return;
      settled = true; clearTimeout(timer); options.signal?.removeEventListener("abort", abort);
      if (error) { controller.abort(error); reject(error); } else resolve(value!);
      void server.stop();
    };
    const abort = () => finish(new CodexAuthError("Codex sign-in cancelled.", "cancelled"));
    let server: ReturnType<typeof Bun.serve>;
    try {
      server = Bun.serve({ hostname: "127.0.0.1", port: this.port, idleTimeout: 30, async fetch(request) {
        const url = new URL(request.url);
        const reply = (message: string, status = 200) => new Response(message, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'" } });
        if (url.pathname !== "/auth/callback" || request.method !== "GET") return reply("Not found", 404);
        const received = url.searchParams.getAll("state");
        if (received.length !== 1 || Buffer.byteLength(received[0]!) !== Buffer.byteLength(state) || !timingSafeEqual(Buffer.from(received[0]!), Buffer.from(state))) return reply("Invalid sign-in state. Return to Demesne and retry.", 400);
        if (settled || exchanging) return reply("This sign-in attempt has already been used.", 409);
        if (url.searchParams.has("error")) {
          finish(new CodexAuthError("Codex sign-in was declined. Return to Demesne to try again.", "access_denied"));
          return reply("Sign-in cancelled. You can return to Demesne.");
        }
        const code = url.searchParams.get("code");
        if (!code || code.length > 8192 || url.searchParams.getAll("code").length !== 1) {
          finish(new CodexAuthError("Codex returned an incomplete sign-in. Start again.", "callback_invalid"));
          return reply("Sign-in could not be validated. Return to Demesne.", 400);
        }
        exchanging = true;
        try {
          finish(undefined, await complete(code));
          return reply("Connected to Demesne. You can close this tab.");
        } catch (error) {
          finish(error instanceof CodexAuthError ? error : new CodexAuthError("Codex sign-in could not be completed. Try again.", "exchange_failed"));
          return reply("Sign-in failed. Return to Demesne to retry.", 400);
        }
      } });
    } catch {
      throw new CodexAuthError(`Port ${this.port} is in use, so Codex's sign-in page cannot return here. Finish or close any other Codex sign-in, then retry.`, "port_in_use");
    }
    const redirectUri = `http://localhost:${this.port}/auth/callback`;
    const timer = setTimeout(() => finish(new CodexAuthError("Codex sign-in timed out. Try again.", "timeout")), options.timeoutMs ?? 600_000);
    const complete = async (code: string) => {
      const token = await this.token({ grant_type: "authorization_code", client_id: CODEX_CLIENT_ID, code, code_verifier: verifier, redirect_uri: redirectUri }, controller.signal);
      const tokens = this.tokensFrom(token, undefined);
      return this.locked(() => { controller.signal.throwIfAborted(); this.write({ version: 1, tokens }); return status(tokens); }, controller.signal);
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    const url = new URL(`${CODEX_ISSUER}/oauth/authorize`);
    url.search = new URLSearchParams({ response_type: "code", client_id: CODEX_CLIENT_ID, redirect_uri: redirectUri, scope: SCOPES,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256",
      id_token_add_organizations: "true", codex_cli_simplified_flow: "true", state, originator: "codex_cli_rs" }).toString();
    return { url: url.href, account, close: async () => { abort(); await server.stop(true); } };
  }

  /// A current access token, refreshed when it is about to expire.
  async accessToken(signal?: AbortSignal): Promise<string> {
    return this.locked(async () => {
      const vault = this.read(), tokens = vault.tokens;
      if (!tokens) throw new CodexAuthError("Codex is signed out. Sign in under Settings › Providers.", "signed_out");
      if (tokens.expiresAt > Date.now() + 60_000) return tokens.accessToken;
      try {
        const token = await this.token({ grant_type: "refresh_token", client_id: CODEX_CLIENT_ID, refresh_token: tokens.refreshToken, scope: "openid profile email" }, signal);
        vault.tokens = this.tokensFrom(token, tokens); this.write(vault);
      } catch (error) {
        if (error instanceof CodexAuthError && TERMINAL_REFRESH.has(error.code ?? "")) {
          this.write({ version: 1 });
          throw new CodexAuthError("Codex session expired. Sign in again to continue.", error.code);
        }
        throw error;
      }
      return vault.tokens!.accessToken;
    }, signal);
  }
  /// The account the backend bills, for the request header.
  async accountId(): Promise<string> {
    const tokens = this.read().tokens;
    if (!tokens) throw new CodexAuthError("Codex is signed out. Sign in under Settings › Providers.", "signed_out");
    return tokens.accountId;
  }
  /// Forgets the tokens. Codex's issuer offers no revocation for this client,
  /// so sign-out is local, as it is in the Codex CLI.
  async logout(): Promise<void> {
    await this.locked(() => { this.write({ version: 1 }); if (existsSync(this.legacyPath)) rmSync(this.legacyPath, { force: true }); });
  }

  private tokensFrom(token: Record<string, unknown>, previous: Tokens | undefined): Tokens {
    if (!text(token.access_token) || !text(token.refresh_token)) throw new CodexAuthError("Codex returned an invalid token response.", "invalid_token_response");
    const idToken = text(token.id_token) ? token.id_token : previous?.idToken;
    const who = identity(idToken, token.access_token);
    const accountId = who.accountId ?? previous?.accountId;
    if (!accountId) throw new CodexAuthError("Codex did not say which ChatGPT account signed in.", "account_missing");
    const exp = jwtClaims(token.access_token).exp;
    const expiresAt = typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : typeof token.expires_in === "number" ? Date.now() + token.expires_in * 1000 : Date.now() + 3600_000;
    return { accessToken: token.access_token, refreshToken: token.refresh_token, idToken, accountId, email: who.email ?? previous?.email, planType: who.planType ?? previous?.planType, expiresAt, lastRefresh: Date.now() };
  }
  private async token(body: Record<string, string>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    let response: Response;
    try { response = await this.fetcher(`${CODEX_ISSUER}/oauth/token`, { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000) }); }
    catch { throw new CodexAuthError("Could not reach Codex sign-in. Try again when connected.", "network_error"); }
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
        throw new CodexAuthError(`Codex sign-in failed (${code ?? response.status}). Try signing in again.`, code);
      }
      return parsed;
    } catch (error) { if (error instanceof CodexAuthError) throw error; throw new CodexAuthError("Codex sign-in returned an invalid response."); }
    finally { await reader?.cancel().catch(() => {}); }
  }
  private secureDirectory() {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const stat = lstatSync(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new CodexAuthError("Demesne's auth directory must be a private local directory.");
    chmodSync(this.directory, 0o700);
  }
  private read(): Vault {
    if (!existsSync(this.path)) return this.importLegacy();
    const fd = openSync(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (lstatSync(this.path).size > 1024 * 1024) throw new Error();
      const v: unknown = JSON.parse(readFileSync(fd, "utf8"));
      if (!record(v) || v.version !== 1) throw new Error();
      const t = v.tokens;
      if (t !== undefined && !(record(t) && text(t.accessToken) && text(t.refreshToken) && text(t.accountId) && typeof t.expiresAt === "number")) throw new Error();
      return { version: 1, ...(t ? { tokens: t as unknown as Tokens } : {}) };
    } catch { throw new CodexAuthError("Demesne's Codex credential file is invalid. Sign out and in again."); }
    finally { closeSync(fd); }
  }
  /// The Codex home Demesne managed through the Codex CLI before: its sign-in
  /// carries over, so the account need not sign in again.
  private importLegacy(): Vault {
    if (!existsSync(this.legacyPath)) return { version: 1 };
    try {
      const legacy: unknown = JSON.parse(readFileSync(this.legacyPath, "utf8"));
      if (!record(legacy) || legacy.auth_mode !== "chatgpt" || !record(legacy.tokens)) return { version: 1 };
      const tokens = this.tokensFrom({ access_token: legacy.tokens.access_token, refresh_token: legacy.tokens.refresh_token, id_token: legacy.tokens.id_token }, undefined);
      // Expired by now, most likely: the first use refreshes it.
      const vault: Vault = { version: 1, tokens: { ...tokens, expiresAt: Math.min(tokens.expiresAt, Date.now()) } };
      this.write(vault);
      return vault;
    } catch { return { version: 1 }; }
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
  /** A file lock serializes rotating refresh tokens across the desktop host and daemon. */
  private async locked<T>(work: () => T | Promise<T>, signal?: AbortSignal): Promise<T> {
    this.secureDirectory();
    const started = Date.now();
    let release: (() => Promise<void>) | undefined;
    while (!release) {
      signal?.throwIfAborted();
      try { release = await lock(this.directory, { lockfilePath: join(this.directory, "codex.lock"), realpath: false, stale: 60_000, update: 10_000, retries: 0 }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ELOCKED") throw error;
        if (Date.now() - started > 30_000) throw new CodexAuthError("Another Demesne process is updating Codex credentials. Try again shortly.");
        await Bun.sleep(50);
      }
    }
    try { signal?.throwIfAborted(); return await work(); }
    finally { await release(); }
  }
}
