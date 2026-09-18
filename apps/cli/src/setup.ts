import { createInterface } from "node:readline/promises";
import { homedir } from "node:os";
import { assertProviderUrl, updateUserConfig, userConfigPath } from "@demesne/config";
import type { Painter } from "@demesne/brand";
import { DEFAULT_PROBE_TARGETS, probeProvider, probeTargets, targetForUrl } from "./provider-probe.ts";

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
  const styled = (text: string, role: Parameters<Painter["text"]>[1]) => options.painter?.text(text, role) ?? text;
  const dim = (text: string) => options.painter?.dim(text) ?? text;

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

  const rl = createInterface({ input, output });
  try {
    const ask = async (question: string, fallback?: string): Promise<string> => {
      const answer = (await rl.question(`${question}${fallback ? ` [${fallback}]` : ""}: `)).trim();
      return answer || fallback || "";
    };
    const askNumber = async (question: string, fallback: number): Promise<number> => {
      for (;;) {
        const parsed = Number(await ask(question, String(fallback)));
        if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
        output.write(`  ${styled("Please enter a positive integer.", "signal")}\n`);
      }
    };

    output.write(`\n  ${styled("PROVIDER DISCOVERY", "paper")}\n`);
    const probes = await probeTargets(DEFAULT_PROBE_TARGETS, { fetch: options.fetch });
    for (const probe of probes) {
      output.write(probe.reachable
        ? `  ${styled("✓", "citron")} ${probe.target.label} ${dim(probe.target.url)} · ${probe.models.length} model${probe.models.length === 1 ? "" : "s"}\n`
        : `  ${dim(`· ${probe.target.label} not reachable`)}\n`);
    }

    const firstReachable = probes.find((probe) => probe.reachable);
    let providerUrl = "";
    for (;;) {
      providerUrl = options.providerUrl
        ?? await ask("Provider base URL", firstReachable?.target.url ?? DEFAULT_PROBE_TARGETS[0]!.url);
      try {
        assertProviderUrl(providerUrl, "provider.url");
        break;
      } catch (error) {
        if (options.providerUrl) throw error;
        output.write(`  ${styled(error instanceof Error ? error.message : "Invalid URL", "signal")}\n`);
      }
    }

    const probe = probes.find((candidate) => candidate.target.url === providerUrl)
      ?? await probeProvider(targetForUrl(providerUrl), { fetch: options.fetch });
    let model = options.model ?? "";
    if (!model && probe.models.length > 0) {
      output.write(`\n  ${styled("AVAILABLE MODELS", "paper")}\n`);
      const listed = probe.models.slice(0, 20);
      listed.forEach((candidate, index) => {
        output.write(`  ${String(index + 1).padStart(3)}. ${candidate.id}${candidate.contextWindow ? dim(` · ${candidate.contextWindow} ctx`) : ""}\n`);
      });
      const answer = await ask("Model (number or id)", listed[0]!.id);
      const index = Number(answer);
      model = Number.isInteger(index) && index >= 1 && index <= listed.length ? listed[index - 1]!.id : answer;
    } else if (!model) {
      model = await ask("Model id");
    }
    if (!model) throw new Error("A model id is required");

    const selected = probe.models.find((candidate) => candidate.id === model);
    const contextWindow = options.contextWindow ?? await askNumber("Context window", selected?.contextWindow ?? 32_768);
    let maxOutputTokens = options.maxOutputTokens ?? await askNumber("Max output tokens", 1_536);
    while (maxOutputTokens >= contextWindow) {
      output.write(`  ${styled("Max output tokens must be smaller than the context window.", "signal")}\n`);
      maxOutputTokens = await askNumber("Max output tokens", Math.max(1, Math.floor(contextWindow / 4)));
    }

    let theme = options.theme ?? await ask("Theme (auto/dark/light)", "auto");
    while (!["auto", "dark", "light"].includes(theme)) {
      output.write(`  ${styled("Theme must be auto, dark, or light.", "signal")}\n`);
      theme = await ask("Theme (auto/dark/light)", "auto");
    }

    const providerId = options.providerId ?? targetForUrl(providerUrl).id;
    output.write(`\n  ${styled("CONFIGURATION", "paper")}\n`);
    output.write(`  ${"Provider".padEnd(18)} ${providerUrl}\n`);
    output.write(`  ${"Provider id".padEnd(18)} ${providerId}\n`);
    output.write(`  ${"Model".padEnd(18)} ${model}\n`);
    output.write(`  ${"Context window".padEnd(18)} ${contextWindow}\n`);
    output.write(`  ${"Max output tokens".padEnd(18)} ${maxOutputTokens}\n`);
    output.write(`  ${"Theme".padEnd(18)} ${theme}\n`);
    output.write(`  ${"Config file".padEnd(18)} ${configPath}\n\n`);

    const confirmation = await ask("Write this configuration? (Y/n)", "Y");
    if (!/^y/i.test(confirmation)) throw new Error("Setup cancelled; nothing was written.");

    const choices: SetupChoices = {
      providerUrl,
      providerId,
      model,
      contextWindow,
      maxOutputTokens,
      theme: theme as SetupChoices["theme"],
    };
    const { backup } = writeSetupConfig(configPath, choices);
    return { ...choices, configPath, backup, nonInteractive: false };
  } finally {
    rl.close();
  }
}
