import { formatDiffPreview, formatFooterLine, renderPresence, sanitizeTerminalLine, truncateText, visibleLength, wrapDisplayText, type Painter, type PaletteColor, type PresenceState } from "@demesne/brand";
import { sliceAnsi } from "bun";
import type { AssistantEntry, ToolEntry } from "./entries.ts";
import { projectRunEvidence, toolFailed } from "./evidence.ts";
import type { SessionRun } from "./session.ts";
import { foldCells } from "./canvas.ts";
import { responseMetadata } from "./session-chrome.ts";
import { surface } from "./surface.ts";
import { clockLabel, thinkingCursor, thinkingDots, tint } from "./interaction.ts";

export type FlowAction = { kind: "toggle"; runId: number; key: string }
  | { kind: "copy" | "review" | "verification" | "failure"; runId?: number }
  | { kind: "artifact"; runId: number; target: ArtifactKind }
  | { kind: "artifact-step"; step: number } | { kind: "artifact-close" }
  | { kind: "arguments"; id: number; key?: string };
export type ArtifactKind = "changes" | "verification" | "failure";
export interface FlowArtifact { runId: number; kind: ArtifactKind; recordId: number }
export interface FlowControl { column: number; width: number; action: FlowAction; hidden?: boolean }
export interface FlowRow {
  /// Stable block identity and line within it keep inspection anchored when
  /// earlier blocks grow, collapse, or reflow at a different terminal width.
  /// A collapsed batch retains the anchors of the tools it now represents.
  key: string; line: number; text: string; background?: PaletteColor; anchors?: string[]; parents?: string[]; controls: FlowControl[]; activeThinking?: boolean; thinking?: boolean; hoverKey?: string;
}
export interface FlowExpansion { runId: number; open: boolean }
export const entryKey = (id: number): string => `entry:${id}`;

const safe = sanitizeTerminalLine;
const duration = (ms: number): string => ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
const failed = (tool: ToolEntry): boolean => toolFailed(tool) || tool.state === "denied";
export const artifactRecords = (run: SessionRun, kind: ArtifactKind): ToolEntry[] => run.tools.filter((tool) => kind === "changes" ? tool.phase === "change"
  : kind === "verification" ? tool.phase === "verify" && tool.name === "run_command" : failed(tool));
const toolName = (tool: ToolEntry): string => ({ read_file: "Read", read_files: "Read", edit_file: "Edit", write_file: "Write",
  search_files: "Search", list_files: "List", git_status: "Git status", git_diff: "Git diff", move_path: "Move", delete_path: "Delete",
  web_search: "Web search", command_logs: "Command output", command_stop: "Stop command" })[tool.name] ?? tool.name.replaceAll("_", " ");

/// The official design's chronological request bands and assistant cards.
/// Thinking and tool disclosures share its scroll position; evidence links
/// open the reserved action panel without changing the selected run.
export function renderSessionFlow(options: {
  runs: readonly SessionRun[]; width: number; compact: boolean; paint: Painter; now: number;
  activity?: { runId: number; presence: PresenceState };
  copiedRunId?: number;
  reducedMotion?: boolean;
  emphasis?: (key: string) => number;
  expansion: (runId: number) => ReadonlyMap<string, boolean>;
  argumentsOpen: ReadonlySet<number>;
  markdown: (entry: AssistantEntry, width: number) => string[];
}): { rows: FlowRow[]; expansions: Map<string, FlowExpansion> } {
  const { width, paint } = options;
  const indent = 5;
  const inner = Math.max(1, width - indent - 3);
  const margin = " ".repeat(indent);
  const gutter = (mark: string) => {
    const column = Math.max(0, indent - 4);
    return " ".repeat(column) + mark + " ".repeat(Math.max(1, indent - column - visibleLength(mark)));
  };
  const rows: FlowRow[] = [];
  const expansions = new Map<string, FlowExpansion>();
  const counts = new Map<string, number>();
  const parents: string[] = [];
  const thinkingKey = (runId: number, after: number) => `run:${runId}:thinking:${after}`;
  const thinkingAnchors = new Map<number, string>();
  let card = false;
  let cardFailed = false;
  let cardLive = false;
  const border = (text: string) => cardFailed ? tint(paint, text, "surface", "signal", 0.35) : paint.text(text, "rule");
  let hoverKey: string | undefined;
  const add = (key: string, text = "", controls: FlowControl[] = [], anchors?: string[], background?: PaletteColor) => {
    const line = counts.get(key) ?? 0;
    counts.set(key, line + 1);
    if (card) {
      const content = surface(sliceAnsi(text, 3, width - 2), width - 5, paint, background ?? "surface");
      text = `  ${border("│")}${content}${border("│")} `;
      background = "ink";
    }
    const row: FlowRow = { key, line, text, controls, anchors, background, hoverKey, parents: parents.length ? [...parents] : undefined };
    rows.push(row);
    return row;
  };
  const cardEdge = (key: string, bottom = false) => {
    card = false;
    add(key, `  ${bottom ? border("└") : paint.text("[", cardFailed ? "signal" : cardLive ? "thinking" : "electric")}${border("─".repeat(Math.max(0, width - 5)) + (bottom ? "┘" : "┐"))} `);
    card = !bottom;
  };
  const wrap = (text: string, size = inner) => text.split("\n").flatMap((line) => wrapDisplayText(safe(line), size));
  const fold = (text: string, size = inner): string[] => foldCells(text, size);
  const body = (key: string, lines: string[], tone?: PaletteColor, anchors?: string[]) => {
    for (const [index, line] of lines.flatMap((line) => fold(line)).entries()) add(key, " ".repeat(indent) + (tone ? paint.text(line, tone) : line), [], index === 0 ? anchors : undefined);
  };
  const output = (text: string): string[] => text.split("\n").map(safe);
  const errorBox = (key: string, text: string, limit?: number, tone: PaletteColor = "signal") => {
    const textWidth = Math.max(1, inner - 4);
    const lines = wrap(text, textWidth).slice(0, limit);
    const mark = tone === "signal" ? "×" : "■";
    lines.forEach((line, index) => add(key, margin + surface(paint.text(`▎ ${index === 0 ? mark : " "} ${line}`, tone), inner, paint, tone === "signal" ? "errorSurface" : "raised")));
  };
  const disclosure = (run: SessionRun, key: string, label: string, mark: string, anchors?: string[]) => {
    const text = margin + mark + " " + truncateText(label, inner - visibleLength(mark) - 1);
    return add(key, text, [{ column: indent, width: Math.min(inner, visibleLength(text) - indent), action: { kind: "toggle", runId: run.id, key } }], anchors);
  };
  const isOpen = (run: SessionRun, key: string, fallback = false): boolean => {
    const open = options.expansion(run.id).get(key) ?? fallback;
    expansions.set(key, { runId: run.id, open });
    return open;
  };
  const toolRows = (run: SessionRun, tool: ToolEntry) => {
    const key = entryKey(tool.id);
    const open = isOpen(run, key);
    const running = tool.state === "running";
    const stopped = tool.state === "stopped";
    const unsuccessful = failed(tool) || stopped;
    const unknown = tool.name === "run_command" && tool.state === "done" && tool.exitCode === undefined;
    const operation = "electric";
    const outcome = failed(tool) || tool.waiting ? "signal" : stopped || unknown ? "secondary" : running ? operation : "citron";
    const background = running || tool.waiting ? "toolActive" : "toolSurface";
    const mark = tool.waiting ? "!" : stopped ? "■" : failed(tool) ? "×" : running ? renderPresence("thinking", options.now, paint) : unknown ? "·" : "✓";
    const detail = safe(tool.detail ?? "").replace(/^\$\s*/, "");
    const verb = tool.name === "run_command" ? tool.phase === "verify" ? "Check" : "Run" : safe(toolName(tool));
    const label = `${verb}${detail && detail !== tool.name ? ` ${detail}` : ""}`;
    const styledLabel = paint.bold(verb, failed(tool) ? "signal" : operation) + (detail && detail !== tool.name ? ` ${paint.text(detail, "secondary")}` : "");
    const meta = tool.waiting ? "awaiting approval" : stopped ? "stopped" : tool.state === "denied" ? "denied"
      : tool.exitCode !== undefined ? `${tool.exitCode === 0 && !failed(tool) ? "passed" : "failed"} · exit ${tool.exitCode}` : unknown ? "exit unknown" : "";
    const timing = tool.durationMs !== undefined && !failed(tool) ? duration(tool.durationMs) : "";
    const fullSuffix = [meta, timing].filter(Boolean).join(" · ");
    const suffix = visibleLength(label) + visibleLength(fullSuffix) + 5 > inner ? meta : fullSuffix;
    const trailing = `${suffix ? ` · ${suffix}` : ""} ${open ? "▾" : "▸"}`;
    const text = `${margin}${paint.text(mark, outcome)} ${truncateText(styledLabel, Math.max(4, inner - visibleLength(trailing) - 2))}${paint.text(trailing, tool.waiting ? "signal" : "muted")}`;
    add(key, text, [{ column: indent, width: inner, action: { kind: "toggle", runId: run.id, key } }], [thinkingAnchors.get(tool.id)!], background);
    const detailRow = (key: string, line: string, color?: PaletteColor) => add(key,
      margin + surface(`${paint.text("│", "borderBright")} ${color ? paint.text(line, color) : line}`, inner, paint, "raised"));
    // A failed operation gets actual output immediately, even when collapsed.
    // When the last tool and turn share one failure, the terminal error box
    // below carries it once, together with the missing-response explanation.
    const close = run.entries.findLast((entry) => entry.type === "notice" && entry.closesTurn);
    const terminalError = run.settled && !run.answer && run.tools.at(-1)?.id === tool.id && close?.type === "notice" && close.text === tool.message;
    if (unsuccessful && tool.message && !terminalError) errorBox(`${key}:failure`, tool.message, open ? undefined : 2, stopped ? "secondary" : "signal");
    if (!open) return;
    const lines: string[] = [];
    // Long targets must remain readable in the disclosure, not just the log.
    if (visibleLength(label) + visibleLength(trailing) > inner) lines.push(...wrap(label));
    if (tool.diff) {
      lines.push(paint.text(tool.state === "done" ? "Recorded change" : "Proposed change", "secondary"),
        ...formatDiffPreview(tool.diff.oldText, tool.diff.newText, 10_000, paint));
    }
    if (tool.message && !unsuccessful) lines.push(...output(tool.message));
    if (!tool.message && !tool.diff && !running) lines.push(paint.text("No output recorded.", "secondary"));
    for (const line of lines.flatMap((line) => fold(line, Math.max(1, inner - 2)))) {
      detailRow(`${key}:detail`, line);
    }
    const args = `Arguments ${options.argumentsOpen.has(tool.id) ? "▾" : "▸"}`;
    add(`${key}:arguments`, margin + paint.text(`│ ${args}`, "muted"), [{ column: indent + 2, width: visibleLength(args), action: { kind: "arguments", id: tool.id, key } }]);
    if (options.argumentsOpen.has(tool.id)) for (const line of output(JSON.stringify(tool.input, null, 2)).flatMap((line) => fold(line, inner - 2))) detailRow(`${key}:input`, line, "secondary");
  };

  if (!options.runs.some((run) => run.request)) {
    const spacer = options.compact ? 0 : 2;
    for (let index = 0; index < spacer; index++) add("welcome:space");
    add("welcome", `${gutter(paint.text("//", "electric"))}${paint.bold("What would you like to work on?")}`);
    if (!options.compact) body("welcome:hint", ["",
      `${paint.text("/", "electricBright")} commands   ${paint.text("@", "electricBright")} files   ${paint.text("Tab", "electricBright")} settings`]);
  }
  for (const [runIndex, run] of options.runs.entries()) {
    const evidence = projectRunEvidence(run.entries);
    const copyLabel = options.copiedRunId === run.id ? "copied" : "copy";
    const emphasis = options.emphasis?.(`run:${run.id}:card`) ?? 0;
    const copyEmphasis = options.copiedRunId === run.id ? 1 : emphasis;
    const copyText = (label: string) => copyEmphasis > 0 ? tint(paint, label, "surface", options.copiedRunId === run.id ? "citron" : "secondary", copyEmphasis) : " ".repeat(label.length);
    const activity = run.entries.filter((entry) => entry.type === "reasoning" || entry.type === "assistant" || entry.type === "tool");
    let after = run.id;
    for (const entry of activity) {
      thinkingAnchors.set(entry.id, thinkingKey(run.id, after));
      after = entry.id;
    }
    const inferring = !run.settled && options.activity?.runId === run.id
      && (options.activity.presence === "thinking" || options.activity.presence === "reasoning")
      && !run.tools.some((tool) => tool.state === "running" || tool.waiting);
    const lastActivity = activity.at(-1);
    const liveReasoning = inferring && lastActivity?.type === "reasoning" && lastActivity.streaming ? lastActivity : undefined;
    if (run.request) {
      hoverKey = undefined;
      if (runIndex > 0) {
        add(`run:${run.id}:gap`);
      }
      const key = entryKey(run.request.id);
      hoverKey = key;
      const lines = wrap(run.request.text, width - 5);
      const expanded = isOpen(run, key);
      const capacity = expanded ? lines.length : options.compact ? 2 : 3;
      const clipped = lines.length > capacity;
      const toggle: FlowControl[] = [{ column: 0, width, action: { kind: "toggle", runId: run.id, key } }];
      const requestEmphasis = options.emphasis?.(key) ?? 0;
      for (const [index, line] of lines.slice(0, capacity).entries()) {
        const tail = clipped && index === capacity - 1 ? " … ▸" : "";
        const prefix = tint(paint, "▎", "secondary", "electric", 0.65 + 0.35 * requestEmphasis) + (index === 0 ? paint.text(" ▶ ", "electric") : "   ");
        add(key, `${prefix}${paint.text(truncateText(line, width - 5 - visibleLength(tail)), "paper")}${paint.text(tail, "secondary")}`, toggle, undefined, "userSurface");
      }
      if (expanded) {
        for (const line of wrap(`${safe(run.request.at)} · ${safe(run.request.model ?? "Model not recorded")}`)) add(`${key}:details`, margin + paint.text(line, "muted"), [], undefined, "userSurface");
        add(`${key}:close`, margin + paint.text("Collapse request ‹", "secondary"), toggle, undefined, "userSurface");
      }
    }
    const hasCard = activity.length > 0 || inferring || run.settled;
    hoverKey = `run:${run.id}:card`;
    cardFailed = run.status === "FAILED";
    cardLive = !run.settled;
    if (hasCard) {
      cardEdge(`run:${run.id}:card-top`);
      const first = activity[0];
      const at = first?.type === "assistant" ? first.at : first?.startedAt ?? run.request?.startedAt;
      add(`run:${run.id}:timestamp`, formatFooterLine(margin + paint.text("demesne", "muted"), paint.text(clockLabel(at), "muted"), width - 3));
    }
    let previous = "";
    for (let index = 0; index < run.entries.length; index++) {
      const entry = run.entries[index]!;
      const key = entryKey(entry.id);
      if (entry.type === "reasoning") {
        if (previous === "assistant") add(`${key}:gap`);
        const open = isOpen(run, key, entry.streaming && !run.settled);
        const timing = entry.durationMs !== null ? ` · ${(entry.durationMs / 1000).toFixed(1)}s` : "";
        const live = entry === liveReasoning;
        const label = paint.bold("THINKING", "thinking") + paint.text(timing + (live ? "" : ` ${open ? "▾" : "▸"}`), "muted");
        const header = disclosure(run, key, label,
          live ? thinkingDots(paint, options.now, options.reducedMotion) : paint.text("●", "thinking"), [thinkingAnchors.get(entry.id)!]);
        header.activeThinking = live;
        header.thinking = true;
        if (open) {
          parents.push(key);
          const lines = wrap(entry.raw.trim(), inner - (live ? 3 : 2));
          for (const [index, line] of lines.entries()) add(`${key}:body`, margin + surface(`${paint.text("▎", "thinking")} ${paint.text(line, "secondary")}${live && index === lines.length - 1 ? thinkingCursor(paint, options.now, options.reducedMotion) : ""}`, inner, paint, "thinkingSurface"));
          parents.pop();
        }
      } else if (entry.type === "assistant") {
        if (previous === "assistant") add(`${key}:gap`);
        body(key, options.markdown(entry, inner), undefined, [thinkingAnchors.get(entry.id)!]);
      } else if (entry.type === "tool") {
        if (previous === "assistant" || previous === "reasoning" && expansions.get(entryKey(run.entries[index - 1]!.id))?.open) add(`${key}:gap`);
        // Only routine, confirmed inspection collapses. Changes retain their
        // paths and commands retain their outcomes, even in a read-heavy run.
        const group: ToolEntry[] = [];
        for (let cursor = index; cursor < run.entries.length; cursor++) {
          const candidate = run.entries[cursor]!;
          if (candidate.type !== "tool" || candidate.state !== "done" || candidate.waiting || failed(candidate)
            || candidate.phase !== "inspect" || candidate.name === "run_command") break;
          group.push(candidate);
        }
        if (group.length > 1) {
          const groupKey = `tools:${entry.id}`;
          const open = isOpen(run, groupKey, group.some((tool) => options.expansion(run.id).get(entryKey(tool.id)) === true));
          const files = new Set(group.filter((tool) => tool.name === "read_file").map((tool) => tool.detail ?? tool.id));
          const label = files.size === group.length ? paint.bold("Read", "electric") + paint.text(` ${files.size} files`, "secondary")
            : paint.bold("Inspect", "electric") + paint.text(` ${group.length} operations`, "secondary");
          const totalTime = group.every((tool) => tool.durationMs !== undefined) ? group.reduce((sum, tool) => sum + tool.durationMs!, 0) : null;
          const text = `${margin}${paint.text("✓", "citron")} ${label}${totalTime === null ? "" : paint.text(` · ${duration(totalTime)}`, "muted")} ${paint.text(open ? "▾" : "▸", "muted")}`;
          add(groupKey, text, [{ column: indent, width: inner, action: { kind: "toggle", runId: run.id, key: groupKey } }], open ? undefined : group.flatMap((tool) => [entryKey(tool.id), thinkingAnchors.get(tool.id)!]));
          if (open) {
            parents.push(groupKey);
            for (const tool of group) toolRows(run, tool);
            parents.pop();
          }
          index += group.length - 1;
        } else toolRows(run, entry);
      } else if (entry.type === "notice") {
        // Session feedback after settlement belongs to the composer, rather
        // than being appended inside the already completed response card.
        if (!entry.closesTurn && run.settled && entry.id > (run.entries.findLast((entry) => entry.type === "notice" && entry.closesTurn)?.id ?? Infinity)) continue;
        if (entry.closesTurn && !run.answer) continue;
        if ((!entry.closesTurn || entry.tone === "error" || !run.answer && run.settled)
          && !(entry.closesTurn && run.tools.some((tool) => tool.message === entry.text))) {
          if (entry.tone === "error") errorBox(key, entry.text);
          else body(key, wrap(entry.text), "secondary");
        }
      } else if (entry.type === "panel" || entry.type === "block") {
        // Utility output has its own temporary view and remains in the log.
        // Closing Context, Settings, or Help restores a clean conversation.
        continue;
      }
      previous = entry.type;
    }
    if (run.settled && !run.answer) {
      const close = run.entries.findLast((entry) => entry.type === "notice" && entry.closesTurn);
      const text = [close?.type === "notice" ? close.text : "", "No final response recorded · Ctrl+B execution log"].filter(Boolean).join(" · ");
      if (run.status === "FAILED") errorBox(`run:${run.id}:unfinished`, text);
      else body(`run:${run.id}:unfinished`, wrap(text), "secondary");
    }
    if (run.settled) {
      // A terminal receipt belongs to the run even if no final answer arrived.
      const receipt = run.receipt ?? { mode: run.request?.planOnly ? "Plan" as const : "Build" as const, model: run.request?.model ?? "Model not recorded", durationMs: null, tokensPerSecond: null };
      const parts = responseMetadata(receipt, paint, options.compact, inner);
      const lines: string[] = [];
      for (const part of parts) {
        const previous = lines.at(-1);
        if (previous !== undefined && visibleLength(`${previous} · ${part}`) <= inner) lines[lines.length - 1] = previous + paint.text(" · ", "borderBright") + part;
        else lines.push(...fold(part));
      }
      const hasText = run.entries.some((entry) => entry.type === "assistant" && entry.raw.trim());
      const badge = `[ ${run.status} ]`;
      const actionsWidth = badge.length + (hasText ? 7 : 0);
      if (visibleLength(lines.at(-1) ?? "") + actionsWidth + 1 > inner) lines.push("");
      if (!options.compact) add(`run:${run.id}:receipt-gap`, "   " + paint.text("─".repeat(width - 5), "rule"));
      lines.forEach((line, index) => {
        const last = index === lines.length - 1;
        const actions = (hasText ? copyText(copyLabel.padEnd(6)) + " " : "") + paint.text(badge, run.status === "FAILED" ? "signal" : run.status === "STOPPED" ? "secondary" : "citron");
        add(`run:${run.id}:receipt`, last ? formatFooterLine(margin + line, actions, width - 3) : margin + line,
          last && hasText ? [{ column: width - 3 - actionsWidth, width: 6, action: { kind: "copy", runId: run.id }, hidden: copyEmphasis === 0 }] : []);
      });
    }
    const links: { text: string; tone: PaletteColor; action: FlowAction }[] = [];
    const files = new Set(evidence.changes.filter((change) => change.outcome === "done").map((change) => change.path)).size;
    if (run.settled) {
      if (evidence.hasChanges) links.push({ text: files ? `${files} file${files === 1 ? "" : "s"}${options.compact ? "" : " changed"} ▸` : "Review attempts ▸", tone: "electricBright", action: { kind: "artifact", target: "changes", runId: run.id } });
      const outcome = evidence.verification;
      const trouble = outcome === "failed" || outcome === "denied";
      if (evidence.verifications.length) links.push({ text: `${outcome === "passed" ? "✓" : outcome === "stopped" ? "■" : trouble ? "×" : "·"} Verification${options.compact ? "" : ":"} ${outcome === "waiting" ? "awaiting approval" : outcome} ▸`, tone: outcome === "passed" ? "citron" : trouble ? "signal" : "secondary", action: { kind: "artifact", target: "verification", runId: run.id } });
      else if (evidence.successfulChanges) links.push({ text: "Not verified", tone: "secondary", action: { kind: "artifact", target: "changes", runId: run.id } });
    }
    if (links.length) {
      if (!run.answer || !run.settled) add(`run:${run.id}:result-gap`);
      let text = " ".repeat(indent);
      let controls: FlowControl[] = [];
      for (const link of links) {
        if (visibleLength(text) + visibleLength(link.text) > width - 3 && controls.length) {
          add(`run:${run.id}:result`, text, controls);
          text = " ".repeat(indent); controls = [];
        }
        const label = truncateText(link.text, inner);
        controls.push({ column: visibleLength(text), width: visibleLength(label), action: link.action, hidden: link.action.kind === "copy" && copyEmphasis === 0 });
        text += (link.action.kind === "copy" ? copyText(label) : paint.text(label, link.tone)) + "   ";
      }
      add(`run:${run.id}:result`, text, controls);
    }
    // A transient status while waiting for the first token of a model round.
    // Its successor inherits the anchor; no empty reasoning record is invented.
    if (inferring && !liveReasoning) {
      const key = thinkingKey(run.id, after);
      if (activity.length || links.length) add(`${key}:gap`);
      add(key, `${margin}${thinkingDots(paint, options.now, options.reducedMotion)} ${paint.text("THINKING", "thinking")} ${thinkingCursor(paint, options.now, options.reducedMotion)}`).activeThinking = true;
    }
    if (hasCard) cardEdge(`run:${run.id}:card-bottom`, true);
    hoverKey = undefined;
  }
  return { rows, expansions };
}
