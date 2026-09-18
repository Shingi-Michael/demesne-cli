import type { ModelDescriptor } from "@demesne/protocol";
import { formatTokenCount, sanitizeTerminalLine, truncateText, type Painter } from "@demesne/brand";
import { emitKeypressEvents } from "node:readline";
import { reduceSessionPicker, type SessionPickerKey } from "./session-picker.ts";

/// Model selection for `/model`.
///
/// An explicit argument accepts an exact id or an unambiguous prefix. Without
/// an argument the picker navigates the discovered models with the same keys
/// as the session picker.

export type ModelMatch = { model: ModelDescriptor } | { error: string };

export function matchModel(models: readonly ModelDescriptor[], query: string): ModelMatch {
  const trimmed = query.trim();
  const exact = models.find((model) => model.id === trimmed);
  if (exact) return { model: exact };
  const matches = models.filter((model) => model.id.startsWith(trimmed));
  if (matches.length === 1) return { model: matches[0]! };
  if (matches.length === 0) return { error: `No model matches "${trimmed}".` };
  return { error: `Ambiguous model "${trimmed}": ${matches.map((model) => model.id).join(", ")}` };
}

export async function selectModelInteractive(
  models: readonly ModelDescriptor[],
  currentId: string | undefined,
  painter: Painter,
  input: NodeJS.ReadStream = process.stdin,
  output: NodeJS.WriteStream = process.stdout,
): Promise<ModelDescriptor | null> {
  if (models.length === 0 || !input.isTTY || !output.isTTY) return null;
  const wasRaw = input.isRaw;
  let index = Math.max(0, models.findIndex((model) => model.id === currentId));
  emitKeypressEvents(input);
  input.setRawMode(true);
  input.resume();

  return new Promise((resolve) => {
    const render = () => {
      const model = models[index]!;
      const width = Math.max(20, (output.columns ?? 80) - 2);
      const label = truncateText(sanitizeTerminalLine(model.id), Math.max(10, width - 24));
      const provider = painter.dim(` · ${sanitizeTerminalLine(model.provider)}`);
      const context = model.contextWindow ? painter.dim(` · ctx ${formatTokenCount(model.contextWindow)}`) : "";
      output.write(
        `\r\x1b[2K  ${painter.bold("›", "electric")} [${index + 1}/${models.length}] ${painter.bold(label, "paper")}${provider}${context}`,
      );
    };
    const cleanup = () => {
      input.removeListener("keypress", onKeypress);
      output.removeListener("resize", render);
      input.setRawMode(Boolean(wasRaw));
      output.write("\r\x1b[2K");
    };
    const finish = (model: ModelDescriptor | null) => {
      cleanup();
      resolve(model);
    };
    const onKeypress = (text: string, key: SessionPickerKey) => {
      const next = reduceSessionPicker(index, models.length, text, key);
      index = next.index;
      if (next.decision === "select") finish(models[index]!);
      else if (next.decision === "cancel") finish(null);
      else render();
    };

    input.on("keypress", onKeypress);
    output.on("resize", render);
    render();
  });
}
