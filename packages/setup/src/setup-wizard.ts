import type { ChatGPTAccount } from "@demesne/chatgpt-auth";
import { assertProviderUrl } from "@demesne/config";
import type { ProbeResult } from "./provider-probe.ts";

/// First-run setup as a three-step wizard: Provider → Model →
/// Review. State changes are pure so the flow is testable without a terminal;
/// the caller performs the returned effects (probing, writing, leaving).
export type WizardStep = "provider" | "custom" | "auth" | "accounts" | "plan" | "model" | "review" | "done";
export type WizardTheme = "auto" | "dark" | "light";
export interface WizardState {
  step: WizardStep;
  authProvider?: "openrouter" | "chatgpt";
  accounts?: ChatGPTAccount[];
  accountIndex?: number;
  accountId?: string;
  chatgptAccount?: ChatGPTAccount;
  /// Null while the local servers are being probed.
  probes: ProbeResult[] | null;
  providerIndex: number;
  custom: { text: string; error: string | null; checking: boolean };
  /// `expiresAt` is when the loopback callback stops listening; `copied`
  /// marks that the sign-in link was just copied.
  auth: { url: string; status: "waiting" | "loading" | "failed"; message: string; expiresAt?: number; copied?: boolean };
  provider: ProbeResult | null;
  modelIndex: number;
  modelText: string;
  review: { contextWindow: number; maxOutputTokens: number; theme: WizardTheme; detected: boolean };
  reviewIndex: number;
  editing: { text: string; error: string | null } | null;
  error: string | null;
  configPath: string;
  saved: { backup: string | null } | null;
}
export type WizardEffect = { kind: "rescan" | "login" | "cancel-login" | "write" | "cancel" | "accounts" | "chatgpt-connect" | "acknowledge-plan" | "logout-chatgpt" } | { kind: "probe"; url: string }
  | { kind: "copy" | "open"; url: string } | { kind: "finish"; open: boolean };
export interface WizardKey { name?: string; ctrl?: boolean; meta?: boolean }

const DEFAULT_CONTEXT = 32_768;
const DEFAULT_OUTPUT = 1_536;
const THEMES: WizardTheme[] = ["auto", "dark", "light"];
const REVIEW_ROWS = ["Provider", "Model", "Context window", "Max output", "Theme"] as const;

export function initialWizard(configPath: string, theme: WizardTheme = "auto"): WizardState {
  return { step: "provider", probes: null, providerIndex: 0, custom: { text: "", error: null, checking: false }, provider: null,
    auth: { url: "", status: "waiting", message: "Opening your browser…" },
    modelIndex: 0, modelText: "", review: { contextWindow: DEFAULT_CONTEXT, maxOutputTokens: DEFAULT_OUTPUT, theme, detected: false },
    reviewIndex: 2, editing: null, error: null, configPath, saved: null };
}

/// Reachable servers first, keeping the probe order within each group, then
/// OpenRouter and a custom URL (Figma 34:431).
function providerOptions(state: WizardState): Array<ProbeResult | "custom" | "openrouter" | "chatgpt"> {
  const probes = state.probes ?? [];
  return [...probes.filter((probe) => probe.reachable), ...probes.filter((probe) => !probe.reachable), "openrouter", "chatgpt", "custom"];
}

/// Models in the order the list shows them: the recommendation (the first
/// with the largest context) on top, the rest in the server's order.
function modelOrder(provider: ProbeResult | null): number[] {
  const models = provider?.models ?? [];
  if (provider?.target.id === "ChatGPT") return models.map((_, i) => i);
  const recommended = recommendedModel(provider);
  const rest = models.map((_, index) => index).filter((index) => index !== recommended);
  return recommended < 0 ? rest : [recommended, ...rest];
}

function recommendedModel(provider: ProbeResult | null): number {
  const models = provider?.models ?? [];
  if (provider?.target.id === "ChatGPT") return -1;
  const largest = models.reduce((best, model) => Math.max(best, model.contextWindow ?? 0), 0);
  return largest ? models.findIndex((model) => model.contextWindow === largest) : -1;
}

export function wizardProbed(state: WizardState, probes: ProbeResult[]): WizardState {
  return { ...state, probes, providerIndex: 0, error: null };
}

/// A custom URL that answered becomes the provider; one that did not still
/// continues, with the model typed by hand, as the earlier setup allowed.
export function wizardCustomProbed(state: WizardState, result: ProbeResult): WizardState {
  return chooseProvider({ ...state, custom: { ...state.custom, checking: false } }, result);
}

export function wizardAuthenticated(state: WizardState, result: ProbeResult): WizardState {
  return chooseProvider({ ...state, auth: { url: "", status: "waiting", message: "" } }, result);
}

export function wizardChatGPTConnected(state: WizardState, account: ChatGPTAccount, provider: ProbeResult): WizardState {
  const next = { ...state, chatgptAccount: account, accountId: account.id, provider, error: null, auth: { url: "", status: "waiting" as const, message: "" } };
  return account.acknowledged ? chooseProvider(next, provider) : { ...next, step: "plan" };
}

function chooseProvider(state: WizardState, provider: ProbeResult): WizardState {
  return { ...state, step: "model", provider, modelIndex: modelOrder(provider)[0] ?? 0, modelText: "", error: null };
}

export function selectedModel(state: WizardState): string {
  return state.provider?.models.length ? state.provider.models[state.modelIndex]?.id ?? "" : state.modelText.trim();
}

function toReview(state: WizardState): WizardState {
  const model = state.provider?.models[state.modelIndex];
  const contextWindow = state.provider?.models.length && model?.contextWindow ? model.contextWindow : DEFAULT_CONTEXT;
  return { ...state, step: "review", reviewIndex: 2, editing: null, error: null,
    review: { ...state.review, contextWindow, maxOutputTokens: state.provider?.target.id === "ChatGPT" ? Math.min(16384, Math.max(1, Math.floor(contextWindow / 4))) : model?.maxOutputTokens ?? Math.min(DEFAULT_OUTPUT, Math.max(1, Math.floor(contextWindow / 4))), detected: Boolean(state.provider?.models.length && model?.contextWindow) } };
}

const printable = (text: string, key: WizardKey) => !key.ctrl && !key.meta && text.length === 1 && text >= " " && text !== "\x7f";

export function reduceWizard(state: WizardState, key: WizardKey, text = ""): { state: WizardState; effect?: WizardEffect } {
  if (key.ctrl && key.name === "c") return { state, effect: { kind: "cancel" } };
  // The config is already written: q leaves, Enter opens demesne here.
  if (state.step === "done") {
    if (key.name === "q" || key.name === "escape") return { state, effect: { kind: "finish", open: false } };
    return { state, effect: key.name === "return" || key.name === "enter" ? { kind: "finish", open: true } : undefined };
  }

  if (state.step === "provider") {
    const options = providerOptions(state);
    if (key.name === "escape") return { state, effect: { kind: "cancel" } };
    if (key.name === "up" || key.name === "down") {
      const step = key.name === "up" ? -1 : 1;
      return { state: { ...state, providerIndex: (state.providerIndex + step + options.length) % options.length, error: null } };
    }
    if (key.name === "r") return { state: { ...state, probes: null, error: null }, effect: { kind: "rescan" } };
    if (key.name === "return" || key.name === "enter") {
      const option = options[state.providerIndex];
      if (option === "custom") return { state: { ...state, step: "custom", custom: { ...state.custom, error: null } } };
      if (option === "chatgpt") return { state: { ...state, step: "accounts", authProvider: "chatgpt", error: null, accounts: undefined, accountIndex: 0 }, effect: { kind: "accounts" } };
      if (option === "openrouter") return { state: { ...state, authProvider: "openrouter", step: "auth", error: null, auth: { url: "", status: "waiting", message: "Opening your browser…" } }, effect: { kind: "login" } };
      if (!option) return { state };
      if (!option.reachable) return { state: { ...state, error: `${option.target.label} is not reachable. Start it, then press r to rescan.` } };
      return { state: chooseProvider(state, option) };
    }
    return { state };
  }

  if (state.step === "accounts") {
    if (key.name === "escape") return { state: { ...state, step: "provider" } };
    if (!state.accounts) return { state };
    const length = state.accounts.length + 1, index = state.accountIndex ?? 0;
    if (key.name === "up" || key.name === "down") return { state: { ...state, accountIndex: (index + (key.name === "up" ? -1 : 1) + length) % length } };
    if (key.name === "s" && state.accounts[index]) return { state: { ...state, accountId: state.accounts[index]!.id }, effect: { kind: "logout-chatgpt" } };
    if (key.name === "return" || key.name === "enter") return { state: { ...state, step: "auth", accountId: state.accounts[index]?.id, auth: { url: "", status: "loading", message: "Connecting to ChatGPT…" }, error: null }, effect: { kind: "chatgpt-connect" } };
    return { state };
  }
  if (state.step === "plan") {
    if (key.name === "escape") return { state: { ...state, step: "provider" } };
    if (key.name === "o") return { state, effect: { kind: "open", url: "https://chatgpt.com/settings/usage" } };
    if (key.name === "return" || key.name === "enter") return { state, effect: { kind: "acknowledge-plan" } };
    return { state };
  }
  if (state.step === "auth") {
    if (key.name === "escape") return { state: { ...state, step: "provider", error: null }, effect: { kind: "cancel-login" } };
    // r starts a fresh sign-in at any time; Enter does too once one failed.
    if (key.name === "r" || state.auth.status === "failed" && (key.name === "return" || key.name === "enter")) {
      return { state: { ...state, auth: { url: "", status: "waiting", message: "Opening your browser…" } }, effect: { kind: "login" } };
    }
    if (state.auth.url && state.auth.status === "waiting" && key.name === "c") return { state: { ...state, auth: { ...state.auth, copied: true } }, effect: { kind: "copy", url: state.auth.url } };
    if (state.auth.url && state.auth.status === "waiting" && key.name === "o") return { state, effect: { kind: "open", url: state.auth.url } };
    return { state };
  }

  if (state.step === "custom") {
    if (state.custom.checking) return { state };
    if (key.name === "escape") return { state: { ...state, step: "provider" } };
    if (key.name === "backspace") return { state: { ...state, custom: { ...state.custom, text: state.custom.text.slice(0, -1), error: null } } };
    if (key.name === "return" || key.name === "enter") {
      const url = state.custom.text.trim();
      try { assertProviderUrl(url, "provider URL"); }
      catch (error) { return { state: { ...state, custom: { ...state.custom, error: error instanceof Error ? error.message : "Invalid URL" } } }; }
      return { state: { ...state, custom: { ...state.custom, error: null, checking: true } }, effect: { kind: "probe", url } };
    }
    if (printable(text, key)) return { state: { ...state, custom: { ...state.custom, text: state.custom.text + text, error: null } } };
    return { state };
  }

  if (state.step === "model") {
    const listed = state.provider?.models.length ?? 0;
    if (key.name === "escape" || listed && key.name === "backspace") return { state: { ...state, step: "provider", error: null } };
    if (listed && (key.name === "up" || key.name === "down")) {
      const order = modelOrder(state.provider), step = key.name === "up" ? -1 : 1;
      return { state: { ...state, modelIndex: order[(order.indexOf(state.modelIndex) + step + listed) % listed]! } };
    }
    if (key.name === "return" || key.name === "enter") {
      if (!selectedModel(state)) return { state: { ...state, error: "Enter a model id." } };
      return { state: toReview(state) };
    }
    if (!listed && key.name === "backspace") return { state: { ...state, modelText: state.modelText.slice(0, -1), error: null } };
    if (!listed && printable(text, key)) return { state: { ...state, modelText: state.modelText + text, error: null } };
    return { state };
  }

  // Review.
  const row = REVIEW_ROWS[state.reviewIndex];
  if (state.editing) {
    if (key.name === "escape") return { state: { ...state, editing: null } };
    if (key.name === "backspace") return { state: { ...state, editing: { text: state.editing.text.slice(0, -1), error: null } } };
    if (key.name === "return" || key.name === "enter") {
      const value = Number(state.editing.text.replace(/[,_\s]/g, ""));
      if (!Number.isSafeInteger(value) || value <= 0) return { state: { ...state, editing: { ...state.editing, error: "Enter a positive whole number." } } };
      const review = row === "Context window" ? { ...state.review, contextWindow: value, detected: false } : { ...state.review, maxOutputTokens: value };
      return { state: { ...state, review, editing: null, error: null } };
    }
    if (/^[0-9]$/.test(text)) return { state: { ...state, editing: { text: state.editing.text + text, error: null } } };
    return { state };
  }
  if (key.name === "escape") return { state, effect: { kind: "cancel" } };
  if (key.name === "backspace") return { state: { ...state, step: "model", error: null } };
  if (key.name === "up" || key.name === "down") {
    const step = key.name === "up" ? -1 : 1;
    return { state: { ...state, reviewIndex: (state.reviewIndex + step + REVIEW_ROWS.length) % REVIEW_ROWS.length } };
  }
  if (key.name === "e") {
    if (row === "Theme") return { state: { ...state, review: { ...state.review, theme: THEMES[(THEMES.indexOf(state.review.theme) + 1) % THEMES.length]! } } };
    if (row === "Context window") return { state: { ...state, editing: { text: String(state.review.contextWindow), error: null } } };
    if (row === "Max output") return { state: { ...state, editing: { text: String(state.review.maxOutputTokens), error: null } } };
    return { state: { ...state, error: `${row} is chosen on an earlier step; press Backspace to go back.` } };
  }
  if (key.name === "return" || key.name === "enter") {
    if (state.review.maxOutputTokens >= state.review.contextWindow) return { state: { ...state, error: "Max output must be smaller than the context window." } };
    return { state: { ...state, error: null }, effect: { kind: "write" } };
  }
  return { state };
}

export function wizardSaved(state: WizardState, backup: string | null): WizardState {
  return { ...state, step: "done", saved: { backup }, error: null };
}
