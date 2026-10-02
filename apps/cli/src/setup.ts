import { chatGPTAuthForConfig, chatGPTProfile, connectChatGPT } from "./chatgpt-auth.ts";
import { emitKeypressEvents } from "node:readline";
import { homedir } from "node:os";
import { assertProviderUrl, loadConfig, updateUserConfig, userConfigPath } from "@demesne/config";
import { createPainter, type Painter } from "@demesne/brand";
import { DEFAULT_PROBE_TARGETS, probeProvider, probeTargets, targetForUrl } from "./provider-probe.ts";
import { initialWizard, reduceWizard, renderWizard, selectedModel, wizardAuthenticated, wizardChatGPTConnected, wizardCustomProbed, wizardProbed, wizardSaved, type WizardState } from "./setup-wizard.ts";
import { beginOpenRouterLogin, discoverOpenRouter, OPENROUTER_URL } from "./openrouter-auth.ts";

/// `demesne setup` turns the environment-variable and config-file surface into
/// a guided first run: probe common local endpoints, pick a model, verify the
/// context window, and write a user config. Non-interactive use is supported
/// for automation via `--provider-url` and `--model`.

export interface SetupChoices {
  authProfile?: string;
  providerUrl: string;
  providerId: string;
  model: string;
  contextWindow: number;
  maxOutputTokens: number;
  theme?: "dark" | "light" | "auto";
}

export interface SetupOptions {
  home?: string;
  fetch?: typeof fetch;
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
  painter?: Painter;
  providerUrl?: string;
  providerId?: string;
  model?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  theme?: "dark" | "light" | "auto";
  yes?: boolean;
  openBrowser?: (url: string) => Promise<boolean>;
  /// Where OPENROUTER_API_KEY is read from; defaults to the process environment.
  env?: Record<string, string | undefined>;
}

export interface SetupResult extends SetupChoices {
  configPath: string;
  backup: string | null;
  nonInteractive: boolean;
  /// The wizard ended with "Open demesne here" rather than quit.
  open?: boolean;
}

/// How long the OpenRouter loopback callback listens (the login's default).
const LOGIN_TIMEOUT_MS = 600_000;

export function writeSetupConfig(configPath: string, choices: SetupChoices, apiKey?: string): { backup: string | null } {
  if (!Number.isSafeInteger(choices.contextWindow) || choices.contextWindow <= 0) {
    throw new Error("context window must be a positive integer");
  }
  if (!Number.isSafeInteger(choices.maxOutputTokens) || choices.maxOutputTokens <= 0) {
    throw new Error("max output tokens must be a positive integer");
  }
  if (choices.maxOutputTokens >= choices.contextWindow) {
    throw new Error("max output tokens must be smaller than the context window");
  }
  assertProviderUrl(choices.providerUrl, "provider.url");
  const current = loadConfig({ userConfigPath: configPath, includeProject: false, env: {} }).config;
  // Setup makes ChatGPT primary. Remove an earlier CLI-added ChatGPT route so
  // one model slug never resolves to two registrations after the restart.
  const redundant = choices.authProfile ? Object.fromEntries(Object.entries(current.additionalProviders ?? {}).filter(([, p]) => p.auth === "chatgpt").map(([id]) => [id, null])) : {};
  const { backup } = updateUserConfig(configPath, {
    ...(Object.keys(redundant).length ? { additional_providers: redundant } : {}),
    ...(choices.theme ? { theme: choices.theme } : {}),
    provider: choices.authProfile ? chatGPTProfile(choices.authProfile, choices.model, choices.contextWindow, choices.maxOutputTokens) : {
      auth: "api-key",
      auth_profile: null,
      url: choices.providerUrl,
      id: choices.providerId,
      model: choices.model,
      context_window: choices.contextWindow,
      max_output_tokens: choices.maxOutputTokens,
      ...(apiKey ? { api_key: apiKey } : {}),
    },
  });
  return { backup };
}

export async function runSetup(options: SetupOptions = {}): Promise<SetupResult> {
  const home = options.home ?? homedir();
  const configPath = userConfigPath(home);
  const output = options.output ?? process.stdout;
  const input = options.input ?? process.stdin;
  const interactive = Boolean((input as NodeJS.ReadStream).isTTY && (output as NodeJS.WriteStream).isTTY) && !options.yes;
  if (!interactive) {
    if (!options.providerUrl || !options.model) {
      throw new Error("setup needs an interactive terminal, or pass --provider-url and --model for non-interactive use");
    }
    const choices: SetupChoices = {
      providerUrl: options.providerUrl,
      providerId: options.providerId ?? targetForUrl(options.providerUrl).id,
      model: options.model,
      contextWindow: options.contextWindow ?? 32_768,
      maxOutputTokens: options.maxOutputTokens ?? 1_536,
      theme: options.theme,
    };
    const { backup } = writeSetupConfig(configPath, choices);
    return { ...choices, configPath, backup, nonInteractive: true };
  }

  return runWizard({ configPath, input, output, fetch: options.fetch, painter: options.painter ?? createPainter(false),
    home, providerId: options.providerId, theme: options.theme, openBrowser: options.openBrowser ?? openSetupBrowser, env: options.env ?? process.env });
}

async function openSetupBrowser(url: string): Promise<boolean> {
  const command = process.platform === "darwin" ? ["open", url]
    : process.platform === "win32" ? ["rundll32.exe", "url.dll,FileProtocolHandler", url] : ["xdg-open", url];
  try { return await Bun.spawn(command, { stdout: "ignore", stderr: "ignore" }).exited === 0; }
  catch { return false; }
}

/// Runs the full-screen wizard on the alternate screen and restores the
/// terminal however it ends. Review is the only provider-config write; a
/// completed ChatGPT login retains its protected registration independently.
async function runWizard(options: {
  home: string; configPath: string; input: NodeJS.ReadStream; output: NodeJS.WriteStream; fetch?: typeof fetch; painter: Painter;
  providerId?: string; theme?: SetupChoices["theme"]; openBrowser: (url: string) => Promise<boolean>; env: Record<string, string | undefined>;
}): Promise<SetupResult> {
  const { input, output, painter } = options;
  let state: WizardState = initialWizard(options.configPath, options.theme ?? "auto");
  const chatgpt = chatGPTAuthForConfig(options.configPath, { fetch: options.fetch, env: options.env, home: options.home });
  let active = true, scanId = 0;
  let loginController: AbortController | undefined, login: ReturnType<typeof beginOpenRouterLogin> | undefined;
  // Credentials never enter reducer state, rendered frames, or SetupResult.
  let credential: string | undefined;
  const draw = () => {
    if (!active) return;
    // Some terminals report a size of 0; treat that as unknown, not as empty.
    const rows = renderWizard(state, output.columns || 80, Math.max(12, output.rows || 24), painter);
    output.write("\x1b[H" + rows.map((row) => row + "\x1b[K").join("\r\n"));
  };
  const scan = async () => {
    const id = ++scanId;
    const probes = await probeTargets(DEFAULT_PROBE_TARGETS, { fetch: options.fetch });
    if (!active || id !== scanId) return;
    state = wizardProbed(state, probes); draw();
  };
  const cancelLogin = () => {
    loginController?.abort(); loginController = undefined;
    const previous = login; login = undefined; credential = undefined;
    if (previous) void previous.close();
  };
  const openBrowser = (url: string) => {
    const failed = () => {
      if (!active || state.step !== "auth" || state.auth.status !== "waiting" || state.auth.url !== url) return;
      state = { ...state, auth: { ...state.auth, message: "Could not open the browser. Open the link below to continue." } }; draw();
    };
    void options.openBrowser(url).then((opened) => { if (!opened) failed(); }).catch(failed);
  };
  const authenticateChatGPT = async (reauthorize = false) => {
    cancelLogin();
    const controller = loginController = new AbortController();
    const current = () => active && controller === loginController && !controller.signal.aborted && state.step === "auth";
    try {
      const result = await connectChatGPT({ auth: chatgpt, accountId: state.accountId, reauthorize, signal: controller.signal, fetch: options.fetch,
        onAccount: account => { if (current()) state = { ...state, accountId: account.id }; },
        onLogin: async url => { if (!current()) return; state = { ...state, auth: { url, status: "waiting", expiresAt: Date.now() + LOGIN_TIMEOUT_MS, message: "Finish signing in with ChatGPT, then return here." } }; draw(); openBrowser(url); } });
      if (current()) { state = wizardChatGPTConnected(state, result.account, result.provider); draw(); }
    } catch (error) { if (current()) { state = { ...state, auth: { url: "", status: "failed", message: error instanceof Error ? error.message : "ChatGPT connection failed." } }; draw(); } }
  };
  const chatGPTEffect = async (kind: string) => {
    try {
      if (kind === "logout-chatgpt" && state.accountId) {
        const result = await chatgpt.logout(state.accountId);
        state = { ...state, error: result.revoked ? null : "Signed out locally. Remote revocation could not be confirmed; remove Demesne in ChatGPT settings." };
      }
      if (kind === "accounts" || kind === "logout-chatgpt") { const accounts = await chatgpt.accounts(); if (active && state.step === "accounts") state = { ...state, accounts }; }
      if (kind === "acknowledge-plan" && state.chatgptAccount && state.provider) { await chatgpt.acknowledge(state.chatgptAccount.id); if (active && state.step === "plan") state = wizardChatGPTConnected(state, { ...state.chatgptAccount, acknowledged: true }, state.provider); }
    } catch (error) { state = { ...state, error: error instanceof Error ? error.message : "ChatGPT account update failed." }; }
    draw();
  };
  const authenticate = async () => {
    if (state.authProvider === "chatgpt") return authenticateChatGPT(true);
    cancelLogin();
    const controller = loginController = new AbortController();
    const current = () => active && controller === loginController && !controller.signal.aborted && state.step === "auth";
    let attempt: ReturnType<typeof beginOpenRouterLogin> | undefined;
    try {
      // A key already in the environment skips the browser entirely.
      const envKey = options.env.OPENROUTER_API_KEY?.trim();
      let apiKey: string;
      if (envKey) apiKey = envKey;
      else {
        attempt = login = beginOpenRouterLogin({ fetch: options.fetch, signal: controller.signal, timeoutMs: LOGIN_TIMEOUT_MS });
        state = { ...state, auth: { url: attempt.url, status: "waiting", expiresAt: Date.now() + LOGIN_TIMEOUT_MS,
          message: "We opened openrouter.ai in your browser. Approve the \"Demesne\" key, then come back here." } }; draw();
        openBrowser(attempt.url);
        apiKey = await attempt.key;
      }
      if (!current()) return;
      state = { ...state, auth: { url: "", status: "loading", message: "Authorization received. Checking your credential and model catalog…" } }; draw();
      const models = await discoverOpenRouter({ apiKey, fetch: options.fetch, signal: controller.signal });
      if (!current()) return;
      if (!models.length) throw new Error("OpenRouter returned no models. Retry sign-in.");
      credential = apiKey;
      state = wizardAuthenticated(state, { target: { id: "OpenRouter", label: "OpenRouter", url: OPENROUTER_URL }, reachable: true, models }); draw();
    } catch (error) {
      if (current()) {
        state = { ...state, auth: { url: "", status: "failed", message: error instanceof Error ? error.message : "Sign-in failed. Retry to connect." } }; draw();
      }
    } finally { await attempt?.close(); if (login === attempt) login = undefined; }
  };
  const wasRaw = input.isRaw;
  output.write("\x1b[?1049h\x1b[?25l\x1b[2J");
  emitKeypressEvents(input);
  input.setRawMode?.(true);
  input.resume();
  output.on("resize", draw);
  // The sign-in card animates and counts down while it waits.
  const ticker = setInterval(() => { if (state.step === "auth" && state.auth.status === "waiting" && state.auth.url) draw(); }, 400);
  try {
    return await new Promise<SetupResult>((resolve, reject) => {
      const onKeypress = (text: string | undefined, key: { name?: string; ctrl?: boolean; meta?: boolean } = {}) => {
        const next = reduceWizard(state, key, text ?? "");
        state = next.state;
        const effect = next.effect;
        if (effect?.kind === "cancel") { active = false; input.off("keypress", onKeypress); reject(new Error(state.saved ? "Setup closed; configuration was saved." : "Setup cancelled; provider configuration was not changed.")); return; }
        if (effect?.kind === "finish") {
          active = false; input.off("keypress", onKeypress);
          const providerUrl = state.provider!.target.url;
          resolve({ providerUrl, providerId: options.providerId ?? state.provider!.target.id, model: selectedModel(state),
            contextWindow: state.review.contextWindow, maxOutputTokens: state.review.maxOutputTokens, theme: state.review.theme,
            configPath: options.configPath, backup: state.saved?.backup ?? null, nonInteractive: false, open: effect.open });
          return;
        }
        if (effect?.kind === "rescan") void scan();
        if (effect?.kind === "login") void authenticate();
        if (effect?.kind === "chatgpt-connect") void authenticateChatGPT();
        if (effect && ["accounts", "logout-chatgpt", "acknowledge-plan"].includes(effect.kind)) void chatGPTEffect(effect.kind);
        if (effect?.kind === "cancel-login") cancelLogin();
        // OSC 52 puts the link on the clipboard, over SSH too.
        if (effect?.kind === "copy") output.write(`\x1b]52;c;${Buffer.from(effect.url).toString("base64")}\x07`);
        if (effect?.kind === "open") openBrowser(effect.url);
        if (effect?.kind === "probe") {
          void probeProvider(targetForUrl(effect.url), { fetch: options.fetch }).then((result) => { if (active && state.step === "custom") { state = wizardCustomProbed(state, result); draw(); } });
        }
        if (effect?.kind === "write") {
          try {
            const providerUrl = state.provider!.target.url;
            const { backup } = writeSetupConfig(options.configPath, { providerUrl, providerId: options.providerId ?? state.provider!.target.id,
              model: selectedModel(state), contextWindow: state.review.contextWindow, maxOutputTokens: state.review.maxOutputTokens, theme: state.review.theme,
              ...(state.provider?.target.id === "ChatGPT" ? { authProfile: state.chatgptAccount!.id } : {}) },
              providerUrl === OPENROUTER_URL ? credential : undefined);
            state = wizardSaved(state, backup);
          } catch (error) { state = { ...state, error: error instanceof Error ? error.message : "Could not write the config." }; }
        }
        draw();
      };
      input.on("keypress", onKeypress);
      draw();
      void scan();
    });
  } finally {
    active = false; cancelLogin(); clearInterval(ticker);
    output.off("resize", draw);
    input.setRawMode?.(wasRaw);
    input.pause();
    output.write("\x1b[?25h\x1b[?1049l");
  }
}
