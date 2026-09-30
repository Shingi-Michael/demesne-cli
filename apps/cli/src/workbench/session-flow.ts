import { formatDiffPreview, formatFooterLine, renderPresence, sanitizeTerminalLine, truncateText, visibleLength, wrapDisplayText, type Painter, type PaletteColor, type PresenceState } from "@demesne/brand";
import { sliceAnsi } from "bun";
import type { AssistantEntry, ReasoningEntry, ToolEntry } from "./entries.ts";
import { projectRunEvidence, toolFailed } from "./evidence.ts";
import type { SessionRun } from "./session.ts";
import { foldCells } from "./canvas.ts";
import { responseMetadata } from "./session-chrome.ts";
import { surface } from "./surface.ts";
import { clockLabel, thinkingCursor, thinkingDots, tint } from "./interaction.ts";
import { changeState, changeTotals, type DiffAction } from "./diff-panel.ts";
import type { DrivePanelAction } from "./drive-panel.ts";

export type FlowAction = DrivePanelAction | DiffAction | { kind: "toggle"; runId: number; key: string }
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
/// The verb a tool row leads with: Read, Search, Edit, Run, Check…
export const toolVerb = (tool: ToolEntry): string => tool.name === "run_command" ? tool.phase === "verify" ? "Check" : "Run" : safe(toolName(tool));
const duration = (ms: number): string => ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
const failed = (tool: ToolEntry): boolean => toolFailed(tool) || tool.state === "denied";
export const artifactRecords = (run: SessionRun, kind: ArtifactKind): ToolEntry[] => run.tools.filter((tool) => kind === "changes" ? tool.phase === "change"
  : kind === "verification" ? tool.phase === "verify" && tool.name === "run_command" : failed(tool));
export const toolName = (tool: ToolEntry): string => ({ read_file: "Read", read_files: "Read", edit_file: "Edit", write_file: "Write",
  search_files: "Search", list_files: "List", git_status: "Git status", git_diff: "Git diff", move_path: "Move", delete_path: "Delete",
  web_search: "Web search", command_logs: "Command output", command_stop: "Stop command", ask_user: "Ask" })[tool.name] ?? tool.name.replaceAll("_", " ");

/// The official design's chronological request bands and assistant cards.
/// Thinking and tool disclosures share its scroll position; evidence links
/// open the reserved action panel without changing the selected run.
/// `19m 28s`, `42s`, `1h 03m`: turn length at a glance for folded rows.
function foldDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

export function renderSessionFlow(options: {
  runs: readonly SessionRun[]; width: number; compact: boolean; paint: Painter; now: number;
  activity?: { runId: number; presence: PresenceState };
  copiedRunId?: number;
  reducedMotion?: boolean;
  emphasis?: (key: string) => number;
  expansion: (runId: number) => ReadonlyMap<string, boolean>;
  argumentsOpen: ReadonlySet<number>;
  /// Runs that must stay open even when finished; `null` disables folding.
  keepOpen?: ReadonlySet<number> | null;
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
  // The redesign draws a response as a left rail rather than a box: amber
  // while live, red when failed, a quiet rule once complete.
  const railTone = (): PaletteColor => cardFailed ? "signal" : cardLive ? "thinking" : "borderBright";
  const border = (text: string) => paint.text(text, railTone());
  let hoverKey: string | undefined;
  const add = (key: string, text = "", controls: FlowControl[] = [], anchors?: string[], background?: PaletteColor) => {
    const line = counts.get(key) ?? 0;
    counts.set(key, line + 1);
    if (card) {
      const content = surface(sliceAnsi(text, 3, width - 2), width - 5, paint, background ?? "ink");
      text = `  ${border("▎")}${content}  `;
      background = "ink";
    }
    const row: FlowRow = { key, line, text, controls, anchors, background, hoverKey, parents: parents.length ? [...parents] : undefined };
    rows.push(row);
    return row;
  };
  const cardEdge = (key: string, bottom = false) => {
    card = false;
    if (bottom) add(key);
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
    const text = margin + (mark ? mark + " " : "") + truncateText(label, inner - (mark ? visibleLength(mark) + 1 : 0));
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
    const target = detail && detail !== tool.name ? detail : "";
    const label = `${verb}${target ? ` ${target}` : ""}`;
    // Figma rows: a verb column (Search, Read, Edit, Run) in blue, the target
    // in the main text color, the outcome after it, and timing flush right.
    // Rows inside an expanded Explored group trade the ✓ for a guide line.
    const grouped = parents.some((parent) => parent.startsWith("tools:"));
    const verbCell = verb.padEnd(Math.max(6, verb.length));
    const styledLabel = paint.text(verbCell, failed(tool) ? "signal" : operation) + (target ? ` ${paint.text(target, failed(tool) ? "signal" : "paper")}` : "");
    const state = tool.phase === "change" ? changeState(tool).toLowerCase() : "";
    const stateTone: PaletteColor = state === "applied" ? "citron" : state === "failed" || state === "denied" || state === "approval" ? "signal" : state === "drafting" ? "thinking" : "muted";
    const totals = tool.phase === "change" ? changeTotals(tool) : "";
    const styledTotals = totals ? totals.split(" ").map((part) => paint.text(part, part.startsWith("+") ? "citron" : "signal")).join(" ") : "";
    const meta = tool.phase === "change" ? [paint.text(state, stateTone), styledTotals].filter(Boolean).join(" ")
      : paint.text(tool.waiting ? tool.name === "ask_user" ? "awaiting your answer" : "awaiting approval" : stopped ? "stopped" : tool.state === "denied" ? "denied"
        : tool.exitCode !== undefined ? `${tool.exitCode === 0 && !failed(tool) ? "passed" : "failed"} · exit ${tool.exitCode}` : unknown ? "exit unknown" : "", tool.waiting ? "signal" : "muted");
    const timing = tool.durationMs !== undefined && !failed(tool) ? duration(tool.durationMs) : "";
    // Figma 39:533: an edit row opens its diff, and says so on hover or focus.
    // `open` keeps its cells at rest so the row never shifts.
    const rowHover = tool.phase === "change" && hoverKey ? `${hoverKey}>${key}` : hoverKey;
    const openEmphasis = tool.phase === "change" && rowHover ? options.emphasis?.(rowHover) ?? 0 : 0;
    const openLabel = tool.phase !== "change" ? "" : openEmphasis > 0 ? `${tint(paint, "open", background, "electric", openEmphasis)} ` : "     ";
    const right = `${paint.text(`${timing}${timing ? " " : ""}`, "muted")}${openLabel}${paint.text(open ? "▾" : "▸", "muted")}`;
    const lead = grouped ? paint.text("│", "rule") : paint.text(mark, outcome);
    const leftRoom = Math.max(4, inner - visibleLength(right) - 2);
    const left = `${lead} ${styledLabel}${visibleLength(meta) ? `  ${meta}` : ""}`;
    const text = margin + formatFooterLine(truncateText(left, leftRoom), right, inner);
    const cardHover = hoverKey;
    hoverKey = rowHover;
    add(key, text, [{ column: indent, width: inner, action: tool.phase === "change" ? { kind: "diff-open", runId: run.id, recordId: tool.id } : { kind: "toggle", runId: run.id, key } }], [thinkingAnchors.get(tool.id)!], background);
    hoverKey = cardHover;
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
    if (visibleLength(label) + visibleLength(right) + 4 > inner) lines.push(...wrap(label));
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
    // Finished turns before the newest fold into one summary row, as in Figma
    // 1:44: `▸ Turn 12 · request · cancelled at 23:32 · 19m 28s · no diff`.
    // Clicking or Enter opens the full turn; opening it again folds it.
    const foldKey = `run:${run.id}:fold`;
    // A reader's own choice sticks. Otherwise a finished turn folds once it is
    // safe to (see `keepOpen`), and the caller remembers that decision.
    const eligible = Boolean(run.request && run.settled && runIndex < options.runs.length - 1);
    const chosen = options.expansion(run.id).get(foldKey);
    const turnOpen = chosen ?? !(options.keepOpen !== null && !options.keepOpen?.has(run.id));
    if (eligible) expansions.set(foldKey, { runId: run.id, open: turnOpen });
    if (eligible && run.request && !turnOpen) {
      hoverKey = foldKey;
      if (runIndex > 0) add(`run:${run.id}:gap`);
      const status = run.status === "COMPLETE" ? "completed" : run.status === "FAILED" ? "failed" : run.status === "STOPPED" ? "stopped" : run.status.toLowerCase();
      const tone: PaletteColor = run.status === "FAILED" ? "signal" : run.status === "STOPPED" ? "thinking" : "secondary";
      const files = new Set(evidence.changes.filter((change) => change.outcome === "done").map((change) => change.path)).size;
      const time = run.receipt?.durationMs != null ? foldDuration(run.receipt.durationMs) : "";
      const request = truncateText(safe(run.request.text.split("\n")[0] ?? ""), Math.max(12, Math.floor(inner / 2)));
      const parts = [paint.text(status, tone) + paint.text(` at ${safe(run.request.at)}`, "muted"), time && paint.text(time, "muted"),
        paint.text(files ? `${files} file${files === 1 ? "" : "s"} changed` : "no diff", "muted"), paint.text("Ctrl+B log", "muted")].filter(Boolean);
      const text = `${paint.text("▸", "muted")} ${paint.text(`Turn ${run.number}`, "secondary")}${paint.text(" · ", "borderBright")}${paint.text(request, "paper")}${paint.text(" · ", "borderBright")}${parts.join(paint.text(" · ", "borderBright"))}`;
      add(foldKey, "  " + truncateText(text, width - 3), [{ column: 0, width, action: { kind: "toggle", runId: run.id, key: foldKey } }],
        run.entries.map((entry) => entryKey(entry.id)).concat(entryKey(run.request.id)));
      hoverKey = undefined;
      continue;
    }
    const unfolded = eligible;
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
      // An opened earlier turn can fold again from the end of its request row,
      // so opening or folding never adds rows above the reader.
      const foldLabel = unfolded ? `Turn ${run.number} ▴` : "";
      for (const [index, line] of lines.slice(0, capacity).entries()) {
        const tail = clipped && index === capacity - 1 ? " … ▸" : "";
        const prefix = tint(paint, "▎", "secondary", "electric", 0.65 + 0.35 * requestEmphasis) + (index === 0 ? paint.text(" ▶ ", "electric") : "   ");
        const room = width - 5 - visibleLength(tail) - (index === 0 && foldLabel ? foldLabel.length + 2 : 0);
        const text = `${prefix}${paint.text(truncateText(line, room), "paper")}${paint.text(tail, "secondary")}`;
        if (index === 0 && foldLabel) {
          add(key, formatFooterLine(text, paint.text(foldLabel, "muted"), width - 2), [{ column: width - 2 - foldLabel.length, width: foldLabel.length, action: { kind: "toggle", runId: run.id, key: foldKey } }, ...toggle], undefined, "userSurface");
        } else add(key, text, toggle, undefined, "userSurface");
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
      add(`run:${run.id}:timestamp`, formatFooterLine(margin + paint.bold("demesne", cardFailed ? "signal" : cardLive ? "thinking" : "electric"), paint.text(clockLabel(at), "muted"), width - 3));
    }
    const reasoningRows = (entry: ReasoningEntry) => {
      const key = entryKey(entry.id);
      const open = isOpen(run, key, entry.streaming && !run.settled);
      const timing = entry.durationMs !== null ? ` ${(entry.durationMs / 1000).toFixed(1)}s` : "";
      const live = entry === liveReasoning;
      const label = live
        ? paint.text("◇ Thinking", "thinking") + " " + thinkingDots(paint, options.now, options.reducedMotion) + paint.text(timing, "muted")
        : paint.text("◇ ", "muted") + paint.text("Thought", "secondary") + paint.text(timing, "muted");
      const header = disclosure(run, key, label, live ? "" : paint.text(open ? "▾" : "▸", "muted"), [thinkingAnchors.get(entry.id)!]);
      header.activeThinking = live;
      header.thinking = true;
      if (open) {
        parents.push(key);
        const lines = wrap(entry.raw.trim(), inner - (live ? 3 : 2));
        for (const [index, line] of lines.entries()) add(`${key}:body`, margin + surface(`${paint.text("▎", "thinking")} ${paint.text(line, "secondary")}${live && index === lines.length - 1 ? thinkingCursor(paint, options.now, options.reducedMotion) : ""}`, inner, paint, "thinkingSurface"));
        parents.pop();
      }
    };
    let previous = "";
    for (let index = 0; index < run.entries.length; index++) {
      const entry = run.entries[index]!;
      const key = entryKey(entry.id);
      if (entry.type === "reasoning") {
        if (previous === "assistant") add(`${key}:gap`);
        reasoningRows(entry);
      } else if (entry.type === "assistant") {
        if (previous === "assistant") add(`${key}:gap`);
        body(key, options.markdown(entry, inner), undefined, [thinkingAnchors.get(entry.id)!]);
      } else if (entry.type === "tool") {
        if (previous === "assistant" || previous === "reasoning" && expansions.get(entryKey(run.entries[index - 1]!.id))?.open) add(`${key}:gap`);
        // Only routine, confirmed inspection collapses. Changes retain their
        // paths and commands retain their outcomes, even in a read-heavy run.
        // Settled thinking between them joins the group ("Explored"), so a
        // read-heavy run no longer alternates Thought and Read rows.
        const group: ToolEntry[] = [];
        const thoughts: ReasoningEntry[] = [];
        let pending: ReasoningEntry[] = [];
        let span = 1;
        for (let cursor = index; cursor < run.entries.length; cursor++) {
          const candidate = run.entries[cursor]!;
          if (candidate.type === "reasoning" && group.length && !candidate.streaming && candidate !== liveReasoning) { pending.push(candidate); continue; }
          if (candidate.type !== "tool" || candidate.state !== "done" || candidate.waiting || failed(candidate)
            || candidate.phase !== "inspect" || candidate.name === "run_command") break;
          group.push(candidate);
          thoughts.push(...pending); pending = [];
          span = cursor - index + 1;
        }
        if (group.length > 1) {
          const groupKey = `tools:${entry.id}`;
          const members = run.entries.slice(index, index + span).filter((item): item is ToolEntry | ReasoningEntry => item.type === "tool" || item.type === "reasoning");
          const open = isOpen(run, groupKey, members.some((item) => options.expansion(run.id).get(entryKey(item.id)) === true));
          const kinds = new Map<string, number>();
          for (const tool of group) {
            const kind = /read/.test(tool.name) ? "read" : /search|grep|find/.test(tool.name) ? "search" : /list/.test(tool.name) ? "listing" : /git/.test(tool.name) ? "git check" : "inspection";
            kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
          }
          const counts = [...kinds].map(([kind, count]) => `${count} ${kind}${count === 1 ? "" : kind === "search" ? "es" : "s"}`).join(", ");
          const totalTime = group.every((tool) => tool.durationMs !== undefined) ? group.reduce((sum, tool) => sum + tool.durationMs!, 0) : null;
          const thought = thoughts.reduce((sum, item) => sum + (item.durationMs ?? 0), 0);
          const meta = [counts, totalTime === null ? "" : duration(totalTime), thoughts.length ? `thought ${(thought / 1000).toFixed(1)}s` : ""].filter(Boolean).join(" · ");
          const text = `${margin}${paint.text(open ? "▾" : "▸", "muted")} ${paint.text("Explored", "secondary")}${paint.text(` · ${meta}`, "muted")}`;
          add(groupKey, truncateText(text, width - 3), [{ column: indent, width: inner, action: { kind: "toggle", runId: run.id, key: groupKey } }], open ? undefined : members.flatMap((item) => [entryKey(item.id), thinkingAnchors.get(item.id)!]));
          if (open) {
            parents.push(groupKey);
            for (const item of members) item.type === "tool" ? toolRows(run, item) : reasoningRows(item);
            parents.pop();
          }
          index += span - 1;
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
    const links: { text: string; tone: PaletteColor; action: FlowAction }[] = [];
    const files = new Set(evidence.changes.filter((change) => change.outcome === "done").map((change) => change.path)).size;
    if (run.settled) {
      if (evidence.hasChanges) links.push({ text: files ? `${files} file${files === 1 ? "" : "s"}${options.compact ? "" : " changed"} ▸` : "Review attempts ▸", tone: "secondary", action: { kind: "artifact", target: "changes", runId: run.id } });
      const outcome = evidence.verification;
      const trouble = outcome === "failed" || outcome === "denied";
      if (evidence.verifications.length) links.push({ text: `${outcome === "passed" ? "✓" : outcome === "stopped" ? "■" : trouble ? "×" : "·"} checks ${outcome === "waiting" ? "awaiting approval" : outcome} ▸`, tone: outcome === "passed" ? "citron" : trouble ? "signal" : "secondary", action: { kind: "artifact", target: "verification", runId: run.id } });
      else if (evidence.successfulChanges) links.push({ text: "Not verified", tone: "secondary", action: { kind: "artifact", target: "changes", runId: run.id } });
    }
    if (run.settled) {
      // Figma 28:306: one receipt line under a hairline. Mode, model, time,
      // speed and context on the left; evidence, copy and any failure badge on
      // the right. Narrow cards move the right side to its own line.
      const receipt = run.receipt ?? { mode: run.request?.compaction ? "Compact" as const : run.request?.planOnly ? "Plan" as const : "Build" as const, model: run.request?.model ?? "Model not recorded", durationMs: null, tokensPerSecond: null };
      const parts = responseMetadata(receipt, paint, options.compact, inner);
      const hasText = run.entries.some((entry) => entry.type === "assistant" && entry.raw.trim());
      // Success needs no badge; only failed and stopped turns are labelled.
      const badge = run.status === "FAILED" ? "× failed" : run.status === "STOPPED" ? "■ stopped" : "";
      // Copy fades in on hover, so it sits before the links, which stay flush right.
      const items: { text: string; width: number; action?: FlowAction; hidden?: boolean }[] = hasText
        ? [{ text: copyText(copyLabel.padEnd(6)), width: 6, action: { kind: "copy", runId: run.id }, hidden: copyEmphasis === 0 }] : [];
      for (const link of links) {
        const label = truncateText(link.text, inner);
        items.push({ text: paint.text(label, link.tone), width: visibleLength(label), action: link.action });
      }
      if (badge) items.push({ text: paint.text(badge, run.status === "FAILED" ? "signal" : "secondary"), width: badge.length });
      const rightWidth = items.reduce((sum, item) => sum + item.width, 0) + Math.max(0, items.length - 1) * 2;
      const separator = paint.text(" · ", "borderBright");
      const meta = parts.join(separator);
      if (!options.compact) add(`run:${run.id}:receipt-gap`, "   " + paint.text("─".repeat(width - 5), "rule"));
      const place = (key: string, start: number, lead: string, end?: number) => {
        let text = "", column = start;
        let controls: FlowControl[] = [];
        for (const item of items) {
          // Wrapped evidence starts a new line rather than clipping a control.
          if (end === undefined && text && column + item.width > width - 3) {
            add(key, lead + text, controls);
            text = ""; column = start; controls = [];
          }
          if (item.action) controls.push({ column, width: item.width, action: item.action, hidden: item.hidden });
          text += (text ? "  " : "") + item.text;
          column += item.width + 2;
        }
        add(key, end === undefined ? lead + text : formatFooterLine(lead, text, end), controls);
      };
      if (visibleLength(meta) + rightWidth + 2 <= inner) place(`run:${run.id}:receipt`, width - 3 - rightWidth, margin + meta, width - 3);
      else {
        const lines: string[] = [];
        for (const part of parts) {
          const previous = lines.at(-1);
          if (previous !== undefined && visibleLength(`${previous} · ${part}`) <= inner) lines[lines.length - 1] = previous + separator + part;
          else lines.push(...fold(part));
        }
        lines.forEach((line) => add(`run:${run.id}:receipt`, margin + line));
        // On its own line the evidence leads; the hover-only copy follows it.
        if (hasText) items.push(items.shift()!);
        if (items.length) place(`run:${run.id}:result`, indent, margin);
      }
    }
    // Figma's live line: what the agent is doing right now, in amber, under
    // the latest output. Approval waits name the command being asked about.
    const liveTool = run.settled ? undefined : run.tools.findLast((tool) => tool.waiting || tool.state === "running");
    if (liveTool) {
      const target = safe(liveTool.detail ?? "").replace(/^\$\s*/, "");
      const doing = liveTool.waiting ? liveTool.name === "ask_user" ? "Waiting for your answer ·" : "Waiting for your approval ·"
        : liveTool.name === "run_command" ? liveTool.phase === "verify" ? "Checking" : "Running"
        : liveTool.phase === "change" ? "Drafting" : /search|grep|find/.test(liveTool.name) ? "Searching"
        : /list/.test(liveTool.name) ? "Listing" : /read/.test(liveTool.name) ? "Reading" : "Working on";
      add(`run:${run.id}:live-gap`);
      add(`run:${run.id}:live`, margin + paint.text(truncateText(`● ${doing} ${target}${liveTool.waiting ? "" : "…"}`, inner), "thinking"));
    }
    // A transient status while waiting for the first token of a model round.
    // Its successor inherits the anchor; no empty reasoning record is invented.
    if (inferring && !liveReasoning) {
      const key = thinkingKey(run.id, after);
      if (activity.length || links.length) add(`${key}:gap`);
      add(key, `${margin}${paint.text("◇ Thinking", "thinking")} ${thinkingDots(paint, options.now, options.reducedMotion)} ${thinkingCursor(paint, options.now, options.reducedMotion)}`).activeThinking = true;
    }
    if (hasCard) cardEdge(`run:${run.id}:card-bottom`, true);
    hoverKey = undefined;
  }
  return { rows, expansions };
}
