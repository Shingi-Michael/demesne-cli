import { assertProviderUrl } from "@demesne/config";
import { formatTokenCount, sanitizeTerminalLine, truncateText, visibleLength, wrapDisplayText, type Painter, type PaletteColor } from "@demesne/brand";
import type { ProbeResult } from "./provider-probe.ts";

/// `demesne setup` as the redesign's three-step wizard: Provider → Model →
/// Review. State changes are pure so the flow is testable without a terminal;
/// the caller performs the returned effects (probing, writing, leaving).
export type WizardStep = "provider" | "custom" | "auth" | "model" | "review" | "done";
export type WizardTheme = "auto" | "dark" | "light";
export interface WizardState {
  step: WizardStep;
  /// Null while the local servers are being probed.
  probes: ProbeResult[] | null;
  providerIndex: number;
  custom: { text: string; error: string | null; checking: boolean };
  auth: { url: string; status: "waiting" | "loading" | "failed"; message: string };
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
export type WizardEffect = { kind: "rescan" | "login" | "cancel-login" | "write" | "cancel" | "finish" } | { kind: "probe"; url: string };
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

/// Reachable servers first, keeping the probe order within each group.
export function providerOptions(state: WizardState): Array<ProbeResult | "custom" | "openrouter"> {
  const probes = state.probes ?? [];
  return [...probes.filter((probe) => probe.reachable), ...probes.filter((probe) => !probe.reachable), "custom", "openrouter"];
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

function chooseProvider(state: WizardState, provider: ProbeResult): WizardState {
  const largest = provider.models.reduce((best, model, index) =>
    (model.contextWindow ?? 0) > (provider.models[best]?.contextWindow ?? 0) ? index : best, 0);
  return { ...state, step: "model", provider, modelIndex: provider.models.length ? largest : 0, modelText: "", error: null };
}

export function selectedModel(state: WizardState): string {
  return state.provider?.models.length ? state.provider.models[state.modelIndex]?.id ?? "" : state.modelText.trim();
}

function toReview(state: WizardState): WizardState {
  const model = state.provider?.models[state.modelIndex];
  const contextWindow = state.provider?.models.length && model?.contextWindow ? model.contextWindow : DEFAULT_CONTEXT;
  return { ...state, step: "review", reviewIndex: 2, editing: null, error: null,
    review: { ...state.review, contextWindow, maxOutputTokens: model?.maxOutputTokens ?? Math.min(DEFAULT_OUTPUT, Math.max(1, Math.floor(contextWindow / 4))), detected: Boolean(state.provider?.models.length && model?.contextWindow) } };
}

const printable = (text: string, key: WizardKey) => !key.ctrl && !key.meta && text.length === 1 && text >= " " && text !== "\x7f";

export function reduceWizard(state: WizardState, key: WizardKey, text = ""): { state: WizardState; effect?: WizardEffect } {
  if (key.ctrl && key.name === "c") return { state, effect: { kind: "cancel" } };
  if (state.step === "done") return { state, effect: key.name === "q" || key.name === "escape" ? { kind: "cancel" } : { kind: "finish" } };

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
      if (option === "openrouter") return { state: { ...state, step: "auth", error: null, auth: { url: "", status: "waiting", message: "Opening your browser…" } }, effect: { kind: "login" } };
      if (!option) return { state };
      if (!option.reachable) return { state: { ...state, error: `${option.target.label} is not reachable. Start it, then press r to rescan.` } };
      return { state: chooseProvider(state, option) };
    }
    return { state };
  }

  if (state.step === "auth") {
    if (key.name === "escape") return { state: { ...state, step: "provider", error: null }, effect: { kind: "cancel-login" } };
    if (state.auth.status === "failed" && (key.name === "r" || key.name === "return" || key.name === "enter")) {
      return { state: { ...state, auth: { url: "", status: "waiting", message: "Opening your browser…" } }, effect: { kind: "login" } };
    }
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
      const step = key.name === "up" ? -1 : 1;
      return { state: { ...state, modelIndex: (state.modelIndex + step + listed) % listed } };
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

/// Renders the wizard for the terminal size. The painter decides color; the
/// layout reads the same without it.
export function renderWizard(state: WizardState, width: number, height: number, paint: Painter): string[] {
  const rows: string[] = Array.from({ length: height }, () => "");
  const column = Math.max(2, Math.floor((width - Math.min(72, width - 4)) / 2));
  const inner = Math.min(72, width - column - 2);
  const pad = (text: string) => " ".repeat(column) + text;
  const safe = (text: string) => sanitizeTerminalLine(text);
  let row = 0;
  const line = (text = "") => { if (row < height - 2) rows[row++] = text; };

  // Top bar with the stepper.
  const steps: Array<[string, boolean, boolean]> = [
    ["Provider", ["provider", "custom", "auth"].includes(state.step), !["provider", "custom", "auth"].includes(state.step)],
    ["Model", state.step === "model", state.step === "review" || state.step === "done"],
    ["Review", state.step === "review", state.step === "done"],
  ];
  const stepper = steps.map(([label, current, done], index) => done ? paint.text("✓ ", "citron") + paint.text(label, "secondary")
    : paint.text(`${index + 1} ${label}`, current ? "electric" : "muted")).join(paint.text(" ── ", "rule"));
  const brand = `  ${paint.bold("demesne", "electric")} ${paint.text("setup", "secondary")}`;
  rows[row++] = brand + " ".repeat(Math.max(1, width - visibleLength(brand) - visibleLength(stepper) - 2)) + stepper;
  rows[row++] = paint.text("─".repeat(width), "rule");
  line();

  const option = (selected: boolean, mark: [string, PaletteColor], title: string, detail: string, right = "", dim = false) => {
    const edge = selected ? paint.text("▎", "electric") : " ";
    const name = paint.text(truncateText(title, inner - 20), dim ? "muted" : selected ? "electric" : "paper");
    const body = `${edge} ${paint.text(mark[0], mark[1])}  ${name}`;
    const tail = right ? paint.text(right, selected ? "citron" : "muted") : "";
    line(pad(selected ? paint.wash(body + " ".repeat(Math.max(1, inner - visibleLength(body) - visibleLength(tail))) + tail, "menuSelection") : body + (tail ? " ".repeat(Math.max(1, inner - visibleLength(body) - visibleLength(tail))) + tail : "")));
    if (detail) line(pad(`     ${paint.text(truncateText(detail, inner - 6), dim ? "muted" : "secondary")}`));
  };
  const hint = (text: string, tone: PaletteColor = "muted") => line(pad(paint.text(truncateText(text, inner), tone)));

  if (state.step === "provider") {
    const found = state.probes?.filter((probe) => probe.reachable).length ?? 0;
    line(pad(paint.bold("Where should demesne run its model?", "paper")));
    hint(state.probes === null ? "Looking for local servers…" : `Found ${found} local server${found === 1 ? "" : "s"}. You can change this later with demesne setup.`);
    line();
    const options = providerOptions(state);
    const visible = Math.max(1, Math.floor((height - row - 3) / 2));
    const start = Math.max(0, Math.min(state.providerIndex - Math.floor(visible / 2), options.length - visible));
    options.slice(start, start + visible).forEach((item, offset) => {
      const index = start + offset;
      const selected = index === state.providerIndex;
      if (item === "custom") option(selected, ["+", "secondary"], "Custom URL", "Any OpenAI-compatible endpoint");
      else if (item === "openrouter") option(selected, ["↗", "electric"], "OpenRouter", "Sign in with your browser · hosted models");
      else option(selected, item.reachable ? ["✓", "citron"] : ["·", "muted"], item.target.label,
        `${item.target.url} · ${item.reachable ? `${item.models.length} model${item.models.length === 1 ? "" : "s"}` : "not reachable"}`,
        item.reachable && index === 0 ? "detected" : "", !item.reachable);
    });
    line();
  } else if (state.step === "auth") {
    line(pad(paint.bold("Connect OpenRouter", "paper")));
    hint(state.auth.status === "failed" ? "× Sign-in did not complete" : state.auth.status === "loading" ? "◌ Loading your models…" : "↗ Finish signing in in your browser", state.auth.status === "failed" ? "signal" : "electric");
    line();
    for (const text of wrapDisplayText(safe(state.auth.message), inner)) hint(text, "secondary");
    if (state.auth.url) {
      line(); hint("Or open this authorization URL:");
      for (const text of wrapDisplayText(state.auth.url, inner)) hint(text, "electric");
    }
    line(); hint("Your credential is saved only when you confirm Review.");
  } else if (state.step === "custom") {
    line(pad(paint.bold("Enter your server address", "paper")));
    hint("Any OpenAI-compatible endpoint: vLLM, llama.cpp, LM Studio, Ollama, or a hosted gateway.");
    line();
    hint("Base URL");
    line(pad(`${paint.text("▎", "electric")} ${paint.text(safe(state.custom.text) || "http://127.0.0.1:8000/v1", state.custom.text ? "paper" : "muted")}${paint.text("▏", "electric")}`));
    if (state.custom.checking) hint("◌ Checking…", "thinking");
    else if (state.custom.error) hint(`× ${state.custom.error}`, "signal");
    line();
    hint("Remote servers need https://. Plain http:// works only for localhost.");
  } else if (state.step === "model") {
    const provider = state.provider!;
    line(pad(paint.bold("Which model should it use?", "paper")));
    hint(provider.reachable ? `${provider.models.length} model${provider.models.length === 1 ? "" : "s"} on ${provider.target.label} · ${provider.target.url}` : `${provider.target.url} did not answer; enter the model id to use.`,
      provider.reachable ? "muted" : "thinking");
    line();
    if (provider.models.length) {
      // One recommendation: the first model with the largest context.
      const largest = provider.models.reduce((best, model) => Math.max(best, model.contextWindow ?? 0), 0);
      const recommended = largest ? provider.models.findIndex((model) => model.contextWindow === largest) : -1;
      const visible = Math.max(1, height - row - 6);
      const start = Math.max(0, Math.min(state.modelIndex - Math.floor(visible / 2), provider.models.length - visible));
      provider.models.slice(start, start + visible).forEach((model, offset) => {
        const index = start + offset;
        const context = model.contextWindow ? `${formatTokenCount(model.contextWindow)} ctx` : "context unknown";
        option(index === state.modelIndex, [" ", "muted"], safe(model.id), "", `${context}${index === recommended ? " · recommended" : ""}`);
      });
    } else {
      hint("Model id");
      line(pad(`${paint.text("▎", "electric")} ${paint.text(safe(state.modelText) || "model-name", state.modelText ? "paper" : "muted")}${paint.text("▏", "electric")}`));
    }
    line();
    hint("Context size is read from the server when it reports one. You can adjust it on the next step.");
  } else if (state.step === "review") {
    line(pad(paint.bold("Ready to write your config", "paper")));
    hint("Detected values are filled in. Select a line and press e to change it.");
    line();
    const values: Record<(typeof REVIEW_ROWS)[number], [string, string]> = {
      Provider: [state.provider?.target.label ?? "", state.provider?.target.url ?? ""],
      Model: [selectedModel(state), ""],
      "Context window": [state.review.contextWindow.toLocaleString("en-US"), state.review.detected ? "detected" : "default"],
      "Max output": [state.review.maxOutputTokens.toLocaleString("en-US"), state.provider?.models[state.modelIndex]?.maxOutputTokens ? "detected" : "default"],
      Theme: [state.review.theme, state.review.theme === "auto" ? "follows your terminal" : ""],
    };
    REVIEW_ROWS.forEach((name, index) => {
      const selected = index === state.reviewIndex;
      const [value, note] = values[name];
      const shown = selected && state.editing ? `${state.editing.text}▏` : value;
      const label = paint.text(name.padEnd(16), "muted");
      const body = `${selected ? paint.text("▎", "electric") : " "} ${label}${paint.text(safe(shown), selected ? "electric" : "paper")}  ${paint.text(note, "muted")}`;
      const tail = selected && !state.editing && index >= 2 ? paint.text("e edit", "secondary") : "";
      const text = body + " ".repeat(Math.max(1, inner - visibleLength(body) - visibleLength(tail))) + tail;
      line(pad(selected ? paint.wash(text, "menuSelection") : text));
    });
    if (state.editing?.error) hint(`× ${state.editing.error}`, "signal");
    line();
    hint(`Writes ${state.configPath} · an existing file is backed up first.`);
  } else {
    line(pad(paint.text("✓ ", "citron") + paint.bold("demesne is ready", "paper")));
    hint(`Connected to ${state.provider?.target.label ?? "your provider"} · ${selectedModel(state)} · ${formatTokenCount(state.review.contextWindow)} context`);
    line();
    line(pad(paint.wash(` ${paint.text("Saved", "citron")} ${state.configPath}${state.saved?.backup ? paint.text(`  previous file → ${state.saved.backup}`, "muted") : ""} `, "diffAddedSurface")));
    line();
    hint("NEXT");
    for (const [command, description] of [["demesne", "start a session in the current folder"], ["demesne doctor", "check the connection any time"], ["demesne setup", "change provider or model later"]]) {
      line(pad(`${paint.text(command.padEnd(18), "electric")}${paint.text(description, "secondary")}`));
    }
  }
  if (state.error) { line(); hint(`× ${state.error}`, "signal"); }

  const footer = state.step === "provider" ? "↑↓ choose · r rescan · Esc quit · Enter continue"
    : state.step === "auth" ? state.auth.status === "failed" ? "r retry · Esc back · Ctrl+C quit" : "Esc back · Ctrl+C quit"
    : state.step === "custom" ? (state.custom.checking ? "Checking the server…" : "Esc back · Enter check and continue")
      : state.step === "model" ? `${state.provider?.models.length ? "↑↓ choose · Backspace back" : "Esc back"} · Enter continue`
        : state.step === "review" ? state.editing ? "Enter save · Esc cancel edit" : "↑↓ select · e edit · Backspace back · Esc quit · Enter write config"
          : "Enter finish · q quit";
  rows[height - 2] = paint.text("─".repeat(width), "rule");
  rows[height - 1] = `  ${paint.text(truncateText(footer, width - 4), "muted")}`;
  return rows.map((text) => truncateText(text, width));
}
