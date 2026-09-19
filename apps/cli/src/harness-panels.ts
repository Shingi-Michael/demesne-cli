import {
  formatCommandOpener,
  formatGridHeading,
  formatGridRows,
  formatToolRow,
  sanitizeTerminalLine,
  slashCommandUsage,
  HARNESS,
  type GridRow,
  type Painter,
  type SlashCommand,
} from "@demesne/brand";
import type { RuntimeProfileStatus, TurnChange } from "@demesne/protocol";

/// Harness-native panels for command output.
///
/// The scrollback renderer uses boxed cards; the harness does not, so `/help`
/// and `/status` are drawn on the same grid as the transcript. Command output
/// opens with a turn-style rule so it reads as a bounded unit rather than as
/// loose text dropped into the conversation.

const KEY_BINDINGS: Array<[string, string]> = [
  ["ctrl+t", "toggle telemetry"],
  ["ctrl+x", "expand last thought"],
  ["ctrl+o", "compose in $EDITOR"],
  ["ctrl+g", "back to bottom"],
  ["ctrl+r", "search history"],
  ["pgup/pgdn", "scroll transcript"],
  ["esc esc", "interrupt the turn"],
  ["@", "reference a workspace file"],
];

export function renderHarnessHelp(
  commands: readonly SlashCommand[],
  width: number,
  painter: Painter,
): string[] {
  const lines: string[] = [formatCommandOpener("help", width, painter)];
  const sections = new Map<string, SlashCommand[]>();
  for (const command of commands) {
    if (command.id === "help") continue;
    const bucket = sections.get(command.section) ?? [];
    bucket.push(command);
    sections.set(command.section, bucket);
  }
  for (const [section, entries] of sections) {
    lines.push(formatGridHeading(section, painter));
    lines.push(...formatGridRows(
      entries.map((command): GridRow => ({
        label: slashCommandUsage(command),
        value: command.description,
        labelColor: "electric",
        dimValue: true,
      })),
      width,
      painter,
      { labelWidth: 18 },
    ));
    lines.push("");
  }
  lines.push(formatGridHeading("keys", painter));
  lines.push(...formatGridRows(
    KEY_BINDINGS.map(([key, action]): GridRow => ({ label: key, value: action, labelColor: "electric", dimValue: true })),
    width,
    painter,
    { labelWidth: 18 },
  ));
  return lines;
}

/// `/diff` on the harness grid.
///
/// Each file reuses the tool-row geometry — operation in the verb column, path
/// in the target column, state in the meta column — so a reviewed change lines
/// up exactly with the tool row that produced it earlier in the transcript.
export function renderHarnessDiff(
  changes: readonly TurnChange[],
  turnId: string,
  width: number,
  painter: Painter,
): string[] {
  const lines: string[] = [formatCommandOpener("changes", width, painter)];
  if (turnId) {
    lines.push(`${" ".repeat(HARNESS.content)}${painter.dim(`turn ${turnId.slice(0, 8)}`)}`);
  }
  for (const change of changes) {
    const verb = change.operation === "A" ? "added" : change.operation === "D" ? "deleted" : "edited";
    const meta = change.reverted ? "reverted" : change.binary ? "binary" : undefined;
    lines.push(formatToolRow(
      change.reverted ? "denied" : "done",
      verb,
      change.path,
      meta,
      width,
      painter,
      { phase: "change", ...(change.reverted ? { mark: painter.text("↩", "secondary") } : {}) },
    ));
    if (change.binary) continue;
    for (const row of change.diff) {
      const safe = sanitizeTerminalLine(row);
      const styled = row.startsWith("+")
        ? painter.text(safe, "citron")
        : row.startsWith("-")
          ? painter.text(safe, "signal")
          : painter.dim(safe);
      lines.push(`${" ".repeat(HARNESS.toolTarget)}${styled}`);
    }
  }
  return lines;
}

export interface HarnessStatusInput {
  title: string;
  sessionId: string;
  turnCount: number;
  model: string;
  provider: string;
  contextWindow?: number;
  workspace: string;
  branch: string | null;
  runtime: RuntimeProfileStatus | null;
  width: number;
  paint: Painter;
}

export function renderHarnessStatus(input: HarnessStatusInput): string[] {
  const { paint } = input;
  const runtimeLabel = runtimeSummary(input.runtime);
  const rows: GridRow[] = [
    { label: "session", value: input.title },
    { label: "id", value: input.sessionId.slice(0, 8), dimValue: true },
    { label: "turns", value: String(input.turnCount), dimValue: true },
    { label: "model", value: `${input.model} · ${input.provider}` },
    {
      label: "context",
      value: input.contextWindow ? `${input.contextWindow.toLocaleString("en-US")} token window` : "window unknown",
      dimValue: true,
    },
    { label: "workspace", value: input.workspace },
    ...(input.branch ? [{ label: "branch", value: input.branch, dimValue: true } as GridRow] : []),
    ...(runtimeLabel
      ? [{ label: "runtime", value: runtimeLabel, dimValue: true } as GridRow]
      : []),
  ];
  return [
    formatCommandOpener("status", input.width, paint),
    ...formatGridRows(rows, input.width, paint, { labelWidth: 12 }),
  ];
}

function runtimeSummary(runtime: RuntimeProfileStatus | null): string | null {
  if (!runtime || runtime.state === "unconfigured") return null;
  if (runtime.state === "verified") {
    const speculation = runtime.observed?.speculationType ?? runtime.expected?.speculationType;
    return `✓ ${runtime.profile ?? "profile"}${speculation ? ` · ${speculation}` : ""}`;
  }
  if (runtime.state === "mismatch") return `× ${runtime.profile ?? "profile"} · ${runtime.mismatches.length} mismatch`;
  if (runtime.state === "unavailable") return `× ${runtime.profile ?? "profile"} · unavailable`;
  return `… ${runtime.profile ?? "profile"} · verifying`;
}
