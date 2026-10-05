import { CodexClient, CodexError, type CodexClientOptions, type CodexNotification } from "./client.ts";

export type CodexAccountStatus = { signedIn: boolean; email?: string; planType?: string; authMode?: "chatgpt" | "apiKey" | "amazonBedrock"; requiresOpenaiAuth: boolean };
export type CodexModel = {
  id: string; model: string; displayName: string; reasoningEfforts: string[]; defaultReasoningEffort: string;
  inputModalities: string[]; isDefault: boolean; contextWindow?: number; maxOutputTokens?: number;
};
export type CodexLogin = { loginId: string; url: string; complete: Promise<CodexAccountStatus>; cancel: () => Promise<void> };
type LoginCompletion = { success: boolean; error?: string };

/** Auth and catalog owned by Demesne, separate from the user's Codex/OpenCode credentials. */
export class CodexAuth {
  readonly client: CodexClient;
  private readonly completed = new Map<string, LoginCompletion>();
  private readonly loginListeners = new Map<string, (result: LoginCompletion) => void>();
  private readonly unsubscribe: () => void;

  constructor(dataDir: string, options: Omit<CodexClientOptions, "dataDir"> & { client?: CodexClient } = {}) {
    this.client = options.client ?? new CodexClient({ ...options, dataDir });
    this.unsubscribe = this.client.onNotification((event) => this.notification(event));
  }

  async status(signal?: AbortSignal): Promise<CodexAccountStatus> {
    const result = await this.client.request<{ account: unknown; requiresOpenaiAuth?: boolean }>("account/read", { refreshToken: false }, { signal });
    const account = isRecord(result.account) ? result.account : undefined;
    const authMode = account?.type === "chatgpt" || account?.type === "apiKey" || account?.type === "amazonBedrock" ? account.type : undefined;
    return {
      signedIn: authMode !== undefined, authMode, requiresOpenaiAuth: result.requiresOpenaiAuth !== false,
      ...(typeof account?.email === "string" ? { email: account.email } : {}),
      ...(typeof account?.planType === "string" ? { planType: account.planType } : {}),
    };
  }

  async beginLogin(options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<CodexLogin> {
    const result = await this.client.request<{ type: string; loginId: string; authUrl: string }>("account/login/start", {
      type: "chatgpt", useHostedLoginSuccessPage: true, appBrand: "codex",
    }, { signal: options.signal });
    if (result.type !== "chatgpt" || typeof result.loginId !== "string" || typeof result.authUrl !== "string") throw new CodexError("Codex returned an invalid browser login");
    let url: URL;
    try { url = new URL(result.authUrl); } catch { throw new CodexError("Codex returned an invalid browser login URL"); }
    if (url.protocol !== "https:" || !["auth.openai.com", "chatgpt.com", "auth.chatgpt.com"].includes(url.hostname)) throw new CodexError("Codex returned an unsupported browser login URL");
    const loginId = result.loginId;
    let settled = false;
    let finish: (completion: LoginCompletion) => void = () => {};
    const cancelRemote = async () => { await this.client.request("account/login/cancel", { loginId }); };
    const complete = new Promise<CodexAccountStatus>((done, reject) => {
      const cleanup = () => { clearTimeout(timer); offError(); this.loginListeners.delete(loginId); options.signal?.removeEventListener("abort", aborted); };
      finish = (completion) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (!completion.success) { reject(new CodexError(completion.error ?? "Codex login did not complete")); return; }
        this.status(options.signal).then((status) => { if (status.authMode !== "chatgpt") throw new CodexError("Codex browser login did not establish a ChatGPT account"); return status; }).then(done, reject);
      };
      const aborted = () => { if (settled) return; settled = true; void cancelRemote().catch(() => {}); cleanup(); reject(new DOMException("Codex login cancelled", "AbortError")); };
      const timer = setTimeout(() => { if (settled) return; settled = true; void cancelRemote().catch(() => {}); cleanup(); reject(new CodexError("Codex login timed out")); }, options.timeoutMs ?? 10 * 60_000);
      const offError = this.client.onError((error) => { if (settled) return; settled = true; cleanup(); reject(error); });
      this.loginListeners.set(loginId, finish);
      options.signal?.addEventListener("abort", aborted, { once: true });
      const alreadyCompleted = this.completed.get(loginId);
      if (options.signal?.aborted) aborted();
      else if (alreadyCompleted) { this.completed.delete(loginId); finish(alreadyCompleted); }
    });
    // Callers can open the browser before awaiting; cancellation must not create an unhandled rejection.
    void complete.catch(() => {});
    return { loginId, url: result.authUrl, complete, cancel: async () => {
      if (settled) return;
      finish({ success: false, error: "Codex login cancelled" });
      await cancelRemote();
    } };
  }

  async logout(signal?: AbortSignal): Promise<void> { await this.client.request("account/logout", {}, { signal }); }

  async listModels(signal?: AbortSignal): Promise<CodexModel[]> {
    const models: CodexModel[] = [];
    const ids = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const result = await this.client.request<{ data: unknown[]; nextCursor?: string | null }>("model/list", { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) }, { signal });
      if (!Array.isArray(result.data)) throw new CodexError("Codex returned an invalid model catalog");
      for (const raw of result.data) {
        if (!isRecord(raw) || raw.hidden === true || typeof raw.model !== "string" || !raw.model || ids.has(raw.model)) continue;
        ids.add(raw.model);
        const efforts = Array.isArray(raw.supportedReasoningEfforts) ? raw.supportedReasoningEfforts.flatMap((effort) => isRecord(effort) && typeof effort.reasoningEffort === "string" ? [effort.reasoningEffort] : []) : [];
        models.push({ id: typeof raw.id === "string" ? raw.id : raw.model, model: raw.model,
          displayName: typeof raw.displayName === "string" ? raw.displayName : raw.model,
          reasoningEfforts: [...new Set(efforts)], defaultReasoningEffort: typeof raw.defaultReasoningEffort === "string" ? raw.defaultReasoningEffort : efforts[0] ?? "medium",
          inputModalities: Array.isArray(raw.inputModalities) ? raw.inputModalities.filter((modality): modality is string => typeof modality === "string") : ["text", "image"], isDefault: raw.isDefault === true,
        });
      }
      cursor = typeof result.nextCursor === "string" && result.nextCursor ? result.nextCursor : undefined;
      if (cursor && cursors.has(cursor)) throw new CodexError("Codex returned a repeated model catalog cursor");
      if (cursor) cursors.add(cursor);
      if (cursors.size > 100) throw new CodexError("Codex model catalog exceeded the pagination limit");
    } while (cursor);
    return models;
  }

  async close(): Promise<void> { this.unsubscribe(); await this.client.close(); }

  private notification(event: CodexNotification): void {
    if (event.method !== "account/login/completed" || !isRecord(event.params) || typeof event.params.loginId !== "string") return;
    const result = { success: event.params.success === true, ...(typeof event.params.error === "string" ? { error: event.params.error.slice(0, 2_048) } : {}) };
    const listener = this.loginListeners.get(event.params.loginId);
    if (listener) listener(result);
    else {
      this.completed.set(event.params.loginId, result);
      if (this.completed.size > 16) this.completed.delete(this.completed.keys().next().value!);
    }
  }
}

export function defaultModel(models: CodexModel[]): string {
  const preferred = models.find((model) => model.model === "gpt-6.1-sol") ?? models.find((model) => model.isDefault) ?? models[0];
  if (!preferred) throw new CodexError("Codex returned no available models");
  return preferred.model;
}

function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
