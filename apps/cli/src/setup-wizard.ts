import { assertProviderUrl } from "@demesne/config";
import { formatFooterLine, formatTokenCount, sanitizeTerminalLine, truncateText, visibleLength, wrapDisplayText, type Painter, type PaletteColor } from "@demesne/brand";
import { keycap, keyHints } from "./workbench/session-chrome.ts";
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
export type WizardEffect = { kind: "rescan" | "login" | "cancel-login" | "write" | "cancel" } | { kind: "probe"; url: string }
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
export function providerOptions(state: WizardState): Array<ProbeResult | "custom" | "openrouter"> {
  const probes = state.probes ?? [];
  return [...probes.filter((probe) => probe.reachable), ...probes.filter((probe) => !probe.reachable), "openrouter", "custom"];
}

/// Models in the order the list shows them: the recommendation (the first
/// with the largest context) on top, the rest in the server's order.
export function modelOrder(provider: ProbeResult | null): number[] {
  const models = provider?.models ?? [];
  const recommended = recommendedModel(provider);
  const rest = models.map((_, index) => index).filter((index) => index !== recommended);
  return recommended < 0 ? rest : [recommended, ...rest];
}

function recommendedModel(provider: ProbeResult | null): number {
  const models = provider?.models ?? [];
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
    review: { ...state.review, contextWindow, maxOutputTokens: model?.maxOutputTokens ?? Math.min(DEFAULT_OUTPUT, Math.max(1, Math.floor(contextWindow / 4))), detected: Boolean(state.provider?.models.length && model?.contextWindow) } };
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
      if (option === "openrouter") return { state: { ...state, step: "auth", error: null, auth: { url: "", status: "waiting", message: "Opening your browser…" } }, effect: { kind: "login" } };
      if (!option) return { state };
      if (!option.reachable) return { state: { ...state, error: `${option.target.label} is not reachable. Start it, then press r to rescan.` } };
      return { state: chooseProvider(state, option) };
    }
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

/// Renders the wizard for the terminal size. The painter decides color; the
/// layout reads the same without it. `now` drives the sign-in countdown.
export function renderWizard(state: WizardState, width: number, height: number, paint: Painter, now = Date.now()): string[] {
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

  const hint = (text: string, tone: PaletteColor = "muted") => line(pad(paint.text(truncateText(text, inner), tone)));
  const wrapped = (text: string, tone: PaletteColor = "muted") => { for (const part of wrapDisplayText(text, inner)) hint(part, tone); };

  // Bordered boxes (Figma 34:431): rounded corners, hairline dividers, and
  // the selected row washed with a blue left edge.
  const content = inner - 4;
  const edge = (left: string, right: string, tone: PaletteColor = "rule") => line(pad(paint.text(`${left}${"─".repeat(Math.max(0, inner - 2))}${right}`, tone)));
  const boxRow = (left: string, right = "", selected = false, tone: PaletteColor = "rule") => {
    const body = ` ${formatFooterLine(left, right, content)} `;
    line(pad(`${selected ? paint.text("▎", "electric") : paint.text("│", tone)}${selected ? paint.wash(body, "menuSelection") : body}${paint.text("│", tone)}`));
  };
  const box = (rows: Array<[string, string?]>, tone: PaletteColor = "rule") => {
    edge("╭", "╮", tone);
    for (const [left, right] of rows) boxRow(left, right ?? "", false, tone);
    edge("╰", "╯", tone);
  };
  /// A bordered list scrolled to keep `selected` in view. Dividers separate
  /// items when every item fits with them; otherwise they are dropped first.
  const list = (count: number, selected: number, rowsEach: number, reserve: number, draw: (index: number) => Array<[string, string?]>) => {
    const space = height - 2 - row - reserve;
    const dividers = count * (rowsEach + 1) + 1 <= space;
    const visible = Math.max(1, Math.min(count, dividers ? count : Math.floor((space - 2) / rowsEach)));
    const start = Math.max(0, Math.min(selected - Math.floor(visible / 2), count - visible));
    edge("╭", "╮");
    for (let index = start; index < start + visible; index++) {
      if (dividers && index > start) edge("├", "┤");
      for (const [left, right] of draw(index)) boxRow(left, right ?? "", index === selected);
    }
    edge("╰", "╯");
  };
  const input = (text: string, placeholder: string) => {
    edge("╭", "╮", "electric");
    boxRow(`${paint.text(truncateText(safe(text) || placeholder, content - 1), text ? "paper" : "muted")}${paint.text("▏", "electric")}`, "", false, "electric");
    edge("╰", "╯", "electric");
  };

  if (state.step === "provider") {
    const found = state.probes?.filter((probe) => probe.reachable).length ?? 0;
    line(pad(paint.bold("Where should demesne run its model?", "paper")));
    hint(state.probes === null ? "Looking for local servers…" : `Found ${found} local server${found === 1 ? "" : "s"}. You can change this later with demesne setup.`);
    line();
    const options = providerOptions(state);
    const unreachable = state.probes?.some((probe) => !probe.reachable) ?? false;
    list(options.length, state.providerIndex, 2, unreachable ? 2 : 0, (index) => {
      const item = options[index]!, selected = index === state.providerIndex;
      const title = (mark: string, markTone: PaletteColor, name: string, dim = false) =>
        `${paint.text(mark, markTone)}  ${paint.text(safe(name), dim ? "muted" : selected ? "electric" : "paper")}`;
      const detail = (text: string) => `   ${paint.text(safe(text), "muted")}`;
      if (item === "openrouter") return [[title("↗", "electric", "OpenRouter")], [detail("Hosted models · sign in with your browser")]];
      if (item === "custom") return [[title("+", "secondary", "Custom URL")], [detail("Any OpenAI-compatible endpoint")]];
      const models = `${item.models.length} model${item.models.length === 1 ? "" : "s"}`;
      return [[title(item.reachable ? "✓" : "·", item.reachable ? "citron" : "muted", item.target.label, !item.reachable),
        item.reachable && index === 0 ? paint.text("detected", "secondary") : ""], [detail(`${item.target.url} · ${item.reachable ? models : "not reachable"}`)]];
    });
    if (unreachable) { line(); wrapped("Unreachable servers stay listed so you can start them and press r to rescan."); }
  } else if (state.step === "auth") {
    // Figma 36:543: the callback card, the link as a fallback, and where the key goes.
    const { status, url } = state.auth;
    line(pad(paint.bold(status === "failed" ? "Connect OpenRouter" : "Finish signing in to OpenRouter", "paper")));
    wrapped(safe(state.auth.message));
    line();
    if (status === "waiting") {
      const dots = url ? [0, 1, 2].map((dot) => paint.text("●", dot === Math.floor(now / 400) % 3 ? "thinking" : "rule")).join("") : "";
      const left = Math.max(0, (state.auth.expiresAt ?? 0) - now);
      const countdown = state.auth.expiresAt ? `times out in ${Math.floor(left / 60_000)}:${String(Math.floor(left / 1000) % 60).padStart(2, "0")}` : "";
      box([[`${paint.bold("Waiting for approval", "thinking")} ${dots}`, paint.text(countdown, "muted")],
        [paint.text(url ? "Listening on localhost for a one-time callback." : "Starting the one-time callback…", "secondary")]], "thinking");
    } else if (status === "loading") box([[paint.bold("◌ Authorization received", "electric")], [paint.text("Checking your key and loading the model catalog…", "secondary")]], "electric");
    else box([[paint.bold("× Sign-in did not complete", "signal")], [paint.text("Press r or Enter to try again.", "secondary")]], "signal");
    if (url && status === "waiting") {
      line();
      hint("Browser didn't open?", "secondary");
      const action = state.auth.copied ? paint.text("copied", "citron") : `${keycap(paint, "c")} ${paint.text("copy", "muted")}`;
      box([[paint.text(truncateText(url, content - 8), "paper"), action]]);
    }
    line();
    wrapped(`Your API key goes from OpenRouter straight to this machine and is saved only in ${safe(state.configPath)} when you confirm Review. It is never shown on screen.`);
    wrapped("Already have a key? Set OPENROUTER_API_KEY and run demesne setup again.");
  } else if (state.step === "custom") {
    line(pad(paint.bold("Enter your server address", "paper")));
    wrapped("Any OpenAI-compatible endpoint: vLLM, llama.cpp, LM Studio, Ollama, or a hosted gateway.");
    line();
    hint("Base URL");
    input(state.custom.text, "http://127.0.0.1:8000/v1");
    if (state.custom.checking) hint("◌ Checking…", "thinking");
    else if (state.custom.error) hint(`× ${state.custom.error}`, "signal");
    else hint("Enter checks the address and lists its models.");
    line();
    hint("Remote servers need https://. Plain http:// works only for localhost.");
    wrapped(`Needs an API key? Add it in ${safe(state.configPath)} after setup; it is never typed here.`);
  } else if (state.step === "model") {
    const provider = state.provider!;
    line(pad(paint.bold("Which model should it use?", "paper")));
    hint(provider.reachable ? `${provider.models.length} model${provider.models.length === 1 ? "" : "s"} on ${provider.target.label} · ${provider.target.url}` : `${provider.target.url} did not answer; enter the model id to use.`,
      provider.reachable ? "muted" : "thinking");
    line();
    if (provider.models.length) {
      // One recommendation, listed first: the first model with the largest context.
      const order = modelOrder(provider), recommended = recommendedModel(provider);
      list(order.length, order.indexOf(state.modelIndex), 2, 2, (position) => {
        const index = order[position]!, model = provider.models[index]!, selected = index === state.modelIndex;
        const facts = [model.contextWindow ? `${model.contextWindow.toLocaleString("en-US")} ctx` : "context unknown",
          model.maxOutputTokens ? `${formatTokenCount(model.maxOutputTokens)} output` : "", index === recommended ? "largest context on this server" : ""].filter(Boolean);
        return [[paint.text(safe(model.id), selected ? "electric" : "paper"), index === recommended ? paint.text("recommended", "citron") : ""],
          [paint.text(facts.join(" · "), "muted")]];
      });
    } else {
      hint("Model id");
      input(state.modelText, "model-name");
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
    // Figma 34:570: a bordered table; the selected value is blue.
    const labelWidth = 16;
    list(REVIEW_ROWS.length, state.reviewIndex, 1, state.editing?.error ? 3 : 2, (index) => {
      const name = REVIEW_ROWS[index]!, selected = index === state.reviewIndex;
      const [value, note] = values[name];
      const shown = selected && state.editing ? `${state.editing.text}▏` : value;
      const left = `${paint.text(name.padEnd(labelWidth), "muted")}${paint.text(safe(shown), selected ? "electric" : "paper")}  ${paint.text(safe(note), "muted")}`;
      return [[left, selected && !state.editing && index >= 2 ? paint.text("e edit", "secondary") : ""]];
    });
    if (state.editing?.error) hint(`× ${state.editing.error}`, "signal");
    line();
    hint(`Writes ${state.configPath} · an existing file is backed up first.`);
  } else {
    line(pad(paint.text("✓ ", "citron") + paint.bold("demesne is ready", "paper")));
    hint(`Connected to ${state.provider?.target.label ?? "your provider"} · ${selectedModel(state)} · ${formatTokenCount(state.review.contextWindow)} context`);
    line();
    // The backup sits beside the config, so its name alone says where it is.
    const backup = state.saved?.backup ?? null, folder = state.configPath.slice(0, state.configPath.lastIndexOf("/") + 1);
    const previous = backup ? `previous file → ${safe(folder && backup.startsWith(folder) ? backup.slice(folder.length) : backup)}` : "";
    const saved = `${paint.text("Saved", "citron")}  ${paint.text(safe(state.configPath), "paper")}`;
    box(visibleLength(saved) + previous.length + 2 <= content ? [[saved, paint.text(previous, "muted")]]
      : [[saved], ...(previous ? [[paint.text(previous, "muted")] as [string]] : [])], "citron");
    line();
    hint("NEXT");
    for (const [command, description] of [["demesne", "start a session in the current folder"], ["demesne doctor", "check the connection any time"], ["demesne setup", "change provider or model later"]]) {
      line(pad(`${paint.text(command.padEnd(18), "electric")}${paint.text(description, "secondary")}`));
    }
  }
  if (state.error) { line(); hint(`× ${state.error}`, "signal"); }

  // Keycap footer: the keys on the left, the step's main action on the right.
  const action = (label: string) => `${paint.text(label, "secondary")} ${keycap(paint, "Enter")}`;
  const listed = Boolean(state.provider?.models.length);
  const [keys, right]: [Array<[string, string]>, string] = state.step === "provider" ? [[["↑↓", "choose"], ["r", "rescan"], ["Esc", "quit"]], action("Continue")]
    : state.step === "auth" ? [[...(state.auth.url && state.auth.status === "waiting" ? [["c", "copy link"], ["o", "reopen browser"]] as Array<[string, string]> : []), ["r", "retry"], ["Esc", "back"]],
      state.auth.status === "failed" ? action("Retry") : ""]
    : state.step === "custom" ? state.custom.checking ? [[], paint.text("Checking the server…", "thinking")] : [[["Esc", "back"]], action("Continue")]
    : state.step === "model" ? [listed ? [["↑↓", "choose"], ["Esc", "back"]] : [["Esc", "back"]], action("Continue")]
    : state.step === "review" ? state.editing ? [[["Esc", "cancel edit"]], action("Save")] : [[["↑↓", "select"], ["e", "edit"], ["Backspace", "back"], ["Esc", "quit"]], action("Write config")]
    : [[["q", "quit"]], action("Open demesne here")];
  rows[height - 2] = paint.text("─".repeat(width), "rule");
  rows[height - 1] = `  ${formatFooterLine(keyHints(paint, keys), right, width - 4)}`;
  return rows.map((text) => truncateText(text, width));
}
