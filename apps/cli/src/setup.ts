import { emitKeypressEvents } from "node:readline";
import { homedir } from "node:os";
import { assertProviderUrl, updateUserConfig, userConfigPath } from "@demesne/config";
import { createPainter, type Painter } from "@demesne/brand";
import { DEFAULT_PROBE_TARGETS, probeProvider, probeTargets, targetForUrl } from "./provider-probe.ts";
import { initialWizard, reduceWizard, renderWizard, selectedModel, wizardCustomProbed, wizardProbed, wizardSaved, type WizardState } from "./setup-wizard.ts";

/// `demesne setup` turns the environment-variable and config-file surface into
/// a guided first run: probe common local endpoints, pick a model, verify the
/// context window, and write a user config. Non-interactive use is supported
/// for automation via `--provider-url` and `--model`.

export interface SetupChoices {
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
}

export interface SetupResult extends SetupChoices {
  configPath: string;
  backup: string | null;
  nonInteractive: boolean;
}

export function writeSetupConfig(configPath: string, choices: SetupChoices): { backup: string | null } {
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
  const { backup } = updateUserConfig(configPath, {
    ...(choices.theme ? { theme: choices.theme } : {}),
    provider: {
      url: choices.providerUrl,
      id: choices.providerId,
      model: choices.model,
      context_window: choices.contextWindow,
      max_output_tokens: choices.maxOutputTokens,
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
    providerId: options.providerId, theme: options.theme });
}

/// Runs the full-screen wizard on the alternate screen and restores the
/// terminal however it ends. Cancelling writes nothing.
async function runWizard(options: {
  configPath: string; input: NodeJS.ReadStream; output: NodeJS.WriteStream; fetch?: typeof fetch; painter: Painter;
  providerId?: string; theme?: SetupChoices["theme"];
}): Promise<SetupResult> {
  const { input, output, painter } = options;
  let state: WizardState = initialWizard(options.configPath, options.theme ?? "auto");
  const draw = () => {
    // Some terminals report a size of 0; treat that as unknown, not as empty.
    const rows = renderWizard(state, output.columns || 80, Math.max(12, output.rows || 24), painter);
    output.write("\x1b[H" + rows.map((row) => row + "\x1b[K").join("\r\n"));
  };
  const scan = async () => {
    const probes = await probeTargets(DEFAULT_PROBE_TARGETS, { fetch: options.fetch });
    state = wizardProbed(state, probes); draw();
  };
  const wasRaw = input.isRaw;
  output.write("\x1b[?1049h\x1b[?25l\x1b[2J");
  emitKeypressEvents(input);
  input.setRawMode?.(true);
  input.resume();
  output.on("resize", draw);
  try {
    return await new Promise<SetupResult>((resolve, reject) => {
      const onKeypress = (text: string | undefined, key: { name?: string; ctrl?: boolean; meta?: boolean } = {}) => {
        const next = reduceWizard(state, key, text ?? "");
        state = next.state;
        const effect = next.effect;
        if (effect?.kind === "cancel") { input.off("keypress", onKeypress); reject(new Error("Setup cancelled; nothing was written.")); return; }
        if (effect?.kind === "finish") {
          input.off("keypress", onKeypress);
          const providerUrl = state.provider!.target.url;
          resolve({ providerUrl, providerId: options.providerId ?? targetForUrl(providerUrl).id, model: selectedModel(state),
            contextWindow: state.review.contextWindow, maxOutputTokens: state.review.maxOutputTokens, theme: state.review.theme,
            configPath: options.configPath, backup: state.saved?.backup ?? null, nonInteractive: false });
          return;
        }
        if (effect?.kind === "rescan") void scan();
        if (effect?.kind === "probe") {
          void probeProvider(targetForUrl(effect.url), { fetch: options.fetch }).then((result) => { state = wizardCustomProbed(state, result); draw(); });
        }
        if (effect?.kind === "write") {
          try {
            const providerUrl = state.provider!.target.url;
            const { backup } = writeSetupConfig(options.configPath, { providerUrl, providerId: options.providerId ?? targetForUrl(providerUrl).id,
              model: selectedModel(state), contextWindow: state.review.contextWindow, maxOutputTokens: state.review.maxOutputTokens, theme: state.review.theme });
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
    output.off("resize", draw);
    input.setRawMode?.(wasRaw);
    input.pause();
    output.write("\x1b[?25h\x1b[?1049l");
  }
}
