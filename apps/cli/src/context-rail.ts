import type {
  ContextPlan,
  EventEnvelope,
  ModelDescriptor,
  ProviderCallSnapshot,
  RuntimeProfileStatus,
  TokenUsage,
} from "@demesne/protocol";
import { isRecord } from "@demesne/protocol";
import {
  formatFooterLine,
  formatSparkline,
  formatTokenCount,
  sanitizeTerminalLine,
  toolKindBadge,
  truncateText,
  visibleLength,
  wrapDisplayText,
  type Painter,
} from "@demesne/brand";
import { classifyTurnPhase, isValidationCommand } from "./turn-activity.ts";
import { contextUsageStack } from "./context-usage.ts";

interface TrackedTool {
  name: string;
  detail?: string;
  change: boolean;
  operation?: "A" | "M" | "R" | "D";
  validation: boolean;
}

interface RailResult {
  id: string;
  label: string;
  state: "queued" | "waiting" | "running" | "passed" | "failed" | "denied" | "stopped" | "unknown";
  created?: boolean;
  operation?: "A" | "M" | "R" | "D";
  exitCode?: number;
}

/// One provider round's two halves, paired by call id: the usage event carries
/// the output token count, the metrics event the duration. When both have
/// arrived, the round's rate joins the sidebar sparkline.
interface RailRound {
  outputTokens: number | null;
  durationMs: number | null;
}

const THROUGHPUT_HISTORY = 12;

export class CliContextRail {
  private model: ModelDescriptor;
  private thinkingEnabled: boolean | undefined;
  private status = "Ready";
  private startedAt: number | null = null;
  private durationMs: number | null = null;
  private plan: ContextPlan | null = null;
  private usage: TokenUsage | null = null;
  private requestDurationMs: number | null = null;
  private queueDurationMs: number | null = null;
  private timeToFirstTokenMs: number | null = null;
  private tools = new Map<string, TrackedTool>();
  private changes: RailResult[] = [];
  private validations: RailResult[] = [];
  private activity: string[] = [];
  private runtime: RuntimeProfileStatus | null = null;
  private branch: string | null = null;
  private rounds = new Map<string, RailRound>();
  /// Recent provider rounds' effective rates, oldest first, for the sparkline.
  private throughput: number[] = [];

  constructor(model: ModelDescriptor, private workspace: string) {
    this.model = model;
  }

  begin(thinkingEnabled: boolean | undefined): void {
    this.thinkingEnabled = thinkingEnabled;
    this.status = thinkingEnabled === false ? "Working" : "Thinking";
    this.startedAt = Date.now();
    this.durationMs = null;
    this.requestDurationMs = null;
    this.queueDurationMs = null;
    this.timeToFirstTokenMs = null;
    this.tools.clear();
    this.changes = [];
    this.validations = [];
    this.activity = [];
    // Unpaired rounds from a previous turn would otherwise linger forever.
    this.rounds.clear();
  }

  reset(thinkingEnabled: boolean | undefined): void {
    this.thinkingEnabled = thinkingEnabled;
    this.status = "Ready";
    this.startedAt = null;
    this.durationMs = null;
    this.plan = null;
    this.usage = null;
    this.requestDurationMs = null;
    this.queueDurationMs = null;
    this.timeToFirstTokenMs = null;
    this.tools.clear();
    this.changes = [];
    this.validations = [];
    this.activity = [];
    this.rounds.clear();
    this.throughput = [];
  }

  hydrate(snapshot: ProviderCallSnapshot | null, thinkingEnabled: boolean | undefined, workspace: string): void {
    this.reset(thinkingEnabled);
    this.workspace = workspace;
    if (!snapshot) return;
    if (snapshot.model !== this.model.id || snapshot.provider !== this.model.provider) {
      this.model = { id: snapshot.model, provider: snapshot.provider };
    }
    this.plan = snapshot.contextPlan;
    this.usage = snapshot.usage;
    this.requestDurationMs = snapshot.metrics?.durationMs ?? null;
    this.queueDurationMs = snapshot.metrics?.queueDurationMs ?? null;
    this.timeToFirstTokenMs = snapshot.metrics?.timeToFirstTokenMs ?? null;
    this.status = "Complete";
  }

  setThinking(thinkingEnabled: boolean | undefined): void {
    this.thinkingEnabled = thinkingEnabled;
  }

  setModel(model: ModelDescriptor): void {
    this.model = model;
  }

  setRuntime(runtime: RuntimeProfileStatus | null): void {
    this.runtime = runtime;
  }

  setBranch(branch: string | null): void {
    this.branch = branch;
  }

  apply(event: EventEnvelope): void {
    if (event.type === "session.compacted" && isRecord(event.payload.checkpoint)) {
      this.plan = contextPlanValue(event.payload.checkpoint.contextPlan);
      this.activity = [...this.activity, "older context summarized · recent turns retained"].slice(-4);
    }
    if (event.type === "model.request_started") {
      this.requestDurationMs = null;
      this.queueDurationMs = null;
      this.timeToFirstTokenMs = null;
      this.usage = null;
      this.status = this.thinkingEnabled === false ? "Working" : "Thinking";
      this.plan = contextPlanValue(event.payload.contextPlan);
      const modelId = typeof event.payload.model === "string" ? event.payload.model : null;
      if (modelId && modelId !== this.model.id) this.model = { ...this.model, id: modelId, contextWindow: undefined };
    }
    if (event.type === "reasoning.delta") {
      this.status = "Reasoning";
    }
    if (event.type === "message.delta") {
      this.status = "Responding";
    }
    if (event.type === "model.usage") {
      const cachedInputTokens = numericToken(event.payload.cachedInputTokens);
      this.usage = {
        inputTokens: numericToken(event.payload.inputTokens),
        outputTokens: numericToken(event.payload.outputTokens),
        totalTokens: numericToken(event.payload.totalTokens),
        ...(cachedInputTokens !== null ? { cachedInputTokens } : {}),
      };
      this.trackThroughput(event, "usage");
    }
    if (event.type === "model.metrics") {
      this.requestDurationMs = numericDuration(event.payload.durationMs);
      this.queueDurationMs = numericDuration(event.payload.queueDurationMs);
      this.timeToFirstTokenMs = numericDuration(event.payload.timeToFirstTokenMs);
      this.trackThroughput(event, "metrics");
    }
    if (event.type === "model.context_trimmed") {
      const dropped = Array.isArray(event.payload.droppedTurnIds) ? event.payload.droppedTurnIds.length : 0;
      this.activity = [...this.activity, `dropped ${dropped} older context turn${dropped === 1 ? "" : "s"}`].slice(-4);
    }
    if (event.type === "tool.call_requested") this.trackTool(event);
    if (event.type === "permission.requested") this.settleTool(event, "waiting");
    if (event.type === "permission.resolved") this.settleTool(event, event.payload.decision === "deny" ? "denied" : "queued");
    if (event.type === "tool.call_started") this.settleTool(event, "running");
    if (event.type === "tool.call_completed") {
      const tool = this.tools.get(stringValue(event.payload.toolCallId) ?? "");
      this.settleTool(event, !toolSucceeded(event) ? "failed" : tool?.validation && typeof event.payload.exitCode !== "number" ? "unknown" : "passed");
    }
    if (event.type === "tool.call_failed") this.settleTool(event, "failed");
    if (event.type === "tool.call_denied") this.settleTool(event, "denied");
    if (event.type === "tool.call_cancelled" || event.type === "tool.call_interrupted") this.settleTool(event, "stopped");
    if (event.type === "turn.completed") {
      this.status = "Complete";
      this.finish();
    }
    if (event.type === "turn.cancelled" || event.type === "turn.interrupted") {
      this.status = "Stopped";
      for (const result of [...this.changes, ...this.validations]) {
        if (["queued", "waiting", "running"].includes(result.state)) result.state = "stopped";
      }
      this.finish();
    }
    if (event.type === "turn.failed") {
      this.status = "Failed";
      this.finish();
    }
  }

  lines(width: number, height: number, painter: Painter): string[] {
    const lines: string[] = [];
    const compact = height < 20;
    const thinking = this.thinkingEnabled === undefined ? "default" : this.thinkingEnabled ? "on" : "off";
    const reportedTokens = exactUsageTotal(this.usage);
    const contextWindow = this.plan?.capacityTokens ?? this.model.contextWindow ?? null;
    const plannedTokens = this.plan?.estimatedInputTokens ?? null;
    const percentage = plannedTokens !== null && contextWindow
      ? Math.min(999, Math.round((plannedTokens / contextWindow) * 100))
      : null;

    // Figma 52:657: a quiet heading with its source on the right, one large
    // figure, the stacked bar with an inline legend, then label/value rows.
    const heading = (label: string, note: string) => {
      if (!compact && lines.length > 0) lines.push("");
      lines.push(formatFooterLine(painter.text(label, "muted"), painter.text(note, "muted"), width));
    };
    // Values wrap under their label rather than being cut off in narrow panels.
    const row = (label: string, value: string, tone: Parameters<Painter["text"]>[1] = "secondary") => {
      const room = Math.max(8, width - 12), parts: string[] = [];
      // Break between ` · ` fields first, so `6.5k cached` stays together.
      for (const field of value.split(" · ")) {
        const last = parts.at(-1);
        if (last !== undefined && visibleLength(`${last} · ${field}`) <= room) parts[parts.length - 1] = `${last} · ${field}`;
        else parts.push(...wrapDisplayText(field, room));
      }
      parts.forEach((part, index) => lines.push(painter.text((index ? "" : label).padEnd(12), "muted") + painter.text(part, tone)));
    };
    heading("CONTEXT PLAN", "estimated before request");
    if (!this.plan) {
      lines.push(contextWindow ? painter.text(`${formatTokenCount(contextWindow)} token capacity`, "secondary") : painter.text("capacity unknown", "signal"));
      lines.push(painter.dim("plan pending · calculated before request"));
    } else {
      lines.push(painter.bold(`~${formatTokenCount(this.plan.estimatedInputTokens)}`, "paper")
        + painter.text(contextWindow ? ` of ${formatTokenCount(contextWindow)}${percentage !== null ? ` · ${percentage}%` : ""}` : " · capacity unknown", budgetColor(this.plan, percentage)));
      if (!compact) {
        const [bar, ...legend] = contextUsageStack(this.plan, width, painter);
        lines.push(bar!);
        // The legend on as few lines as fit: `■ Messages ~38k  ■ Tool definitions ~8k`.
        let current = "";
        for (const item of legend) {
          if (current && visibleLength(current) + visibleLength(item) + 2 > width) { lines.push(current); current = ""; }
          current += (current ? "  " : "") + item;
        }
        if (current) lines.push(current);
      }
      // Compact panels skip the bar, so the breakdown stays as one row.
      else row("input", `messages ~${formatTokenCount(this.plan.estimatedMessageTokens)} · tool definitions ~${formatTokenCount(this.plan.estimatedToolDefinitionTokens)}`, "secondary");
      const outputReserve = this.plan.reserves.outputTokens === null ? "output unknown" : `output ${formatTokenCount(this.plan.reserves.outputTokens)}`;
      row("reserves", `${outputReserve} · results ${formatTokenCount(this.plan.reserves.toolResultTokens)} · safety ${formatTokenCount(this.plan.reserves.safetyTokens)}`, "secondary");
      row("budget", formatBudgetStatus(this.plan), budgetColor(this.plan, percentage));
      if (this.plan.actions.length > 0) {
        const saved = this.plan.actions.reduce((total, action) => total + action.estimatedTokensSaved, 0);
        row("reductions", `${this.plan.actions.length} applied · saved ~${formatTokenCount(saved)}`, "citron");
      }
    }

    heading("LAST REQUEST", "reported by provider");
    if (reportedTokens === null) {
      lines.push(painter.dim("usage pending"));
    } else {
      const input = this.usage?.inputTokens == null ? "input unavailable" : `${formatTokenCount(this.usage.inputTokens)} in`;
      const output = this.usage?.outputTokens == null ? "output unavailable" : `${formatTokenCount(this.usage.outputTokens)} out`;
      const cached = this.usage?.cachedInputTokens !== undefined ? ` · ${formatTokenCount(this.usage.cachedInputTokens)} cached` : "";
      row("tokens", `${input} · ${output}${cached} · ${formatTokenCount(reportedTokens)} total`, "secondary");
    }
    if (this.requestDurationMs !== null) {
      const queue = this.queueDurationMs === null ? "" : `queue ${formatMetricDuration(this.queueDurationMs)} · `;
      const ttft = this.timeToFirstTokenMs === null ? "" : `first token ${formatMetricDuration(this.timeToFirstTokenMs)} · `;
      row("timing", `${queue}${ttft}request ${formatMetricDuration(this.requestDurationMs)}`, "secondary");
    }
    // Recent rounds' effective throughput: the newest rate, then the shape.
    if (!compact && this.throughput.length > 0) {
      const latest = this.throughput.at(-1)!;
      lines.push(painter.text("speed".padEnd(12), "muted") + `${painter.text(`${latest.toFixed(1)} tok/s`, "secondary")} ${formatSparkline(this.throughput, painter)} ${painter.dim(`${this.throughput.length} round${this.throughput.length === 1 ? "" : "s"}`)}`);
    }

    heading("TURN", "");
    const elapsedMs = this.startedAt === null ? this.durationMs : Date.now() - this.startedAt;
    const elapsed = elapsedMs === null ? "" : ` · ${formatElapsed(elapsedMs)}`;
    row("status", `${statusGlyph(this.status)} ${this.status}${elapsed}`, statusColor(this.status));
    row("thinking", thinking, "secondary");
    // The model and where it runs, for reference.
    row("model", `${sanitizeTerminalLine(this.model.id)} · ${sanitizeTerminalLine(this.model.provider)} · ${workspaceName(this.workspace)}`, "secondary");

    heading("RECENT CHANGES", "");
    if (!compact && this.changes.length === 0) lines.push(painter.dim("— none this turn"));
    for (const change of this.changes.slice(-3)) lines.push(formatResult(change, "change", width, painter));

    heading("RECENT VALIDATION", "");
    if (!compact && this.validations.length === 0) lines.push(painter.dim("— not run"));
    for (const validation of this.validations.slice(-2)) lines.push(formatResult(validation, "validation", width, painter));

    heading("ACTIVITY", "");
    if (!compact && this.activity.length === 0) lines.push(painter.dim("— waiting"));
    for (const item of this.activity.slice(-3)) lines.push(painter.dim(`· ${truncateText(item, width - 2)}`));

    return lines.map((line) => truncateText(line, Math.max(1, width))).slice(0, Math.max(0, height));
  }

  get modelId(): string {
    return this.model.id;
  }

  get workspaceBranch(): string | null {
    return this.branch;
  }

  get workspacePath(): string { return this.workspace; }

  /// Last measured provider round, excluding first-token latency when available.
  /// Stream chunks are not tokens; wait for reported counts and timing.
  get tokensPerSecond(): number | null {
    const tokens = this.usage?.outputTokens;
    const duration = this.requestDurationMs;
    if (tokens == null || tokens <= 0 || duration === null || duration <= 0) return null;
    const firstToken = this.timeToFirstTokenMs;
    const decodeDuration = firstToken !== null && firstToken >= 0 && firstToken < duration
      ? duration - firstToken : duration;
    return tokens / (decodeDuration / 1_000);
  }

  /// Keep counts and capacity visible even when there is no room for a meter.
  get contextSnapshot(): { used: number | null; capacity: number | null; estimated: boolean } {
    return { used: this.plan?.estimatedInputTokens ?? exactUsageTotal(this.usage),
      capacity: this.plan?.capacityTokens ?? this.model.contextWindow ?? null, estimated: this.plan?.estimatedInputTokens != null };
  }

  contextSummary(painter: Painter, compact = false): string {
    const capacity = this.plan?.capacityTokens ?? this.model.contextWindow ?? null;
    const estimated = this.plan?.estimatedInputTokens ?? null;
    const reported = exactUsageTotal(this.usage);
    const used = estimated ?? reported;
    const percentage = used !== null && capacity ? Math.round(used / capacity * 100) : null;
    const usage = estimated !== null ? `~${formatTokenCount(estimated)}` : reported !== null ? `last ${formatTokenCount(reported)}` : "—";
    return painter.text(`Context ${usage}/${capacity ? formatTokenCount(capacity) : "?"}${!compact && percentage !== null ? ` · ${percentage}%` : ""}`,
      percentage !== null && percentage >= 90 ? "signal" : "secondary");
  }

  /// The runtime verification, as the short label the header renders. The footer
  /// no longer shows it, because it is identity rather than live state.
  get runtimeSummary(): { label: string; state: RuntimeProfileStatus["state"] } | null {
    return compactRuntimeStatus(this.runtime);
  }

  /// The footer's right side: the context window, and nothing else.
  ///
  /// The model and the runtime verification are identity, so they live in the
  /// header. The absolute counts are the most verbose part of the context
  /// display and go first when the footer narrows, leaving the meter, which is
  /// the part worth glancing at.
  statusLine(width: number, painter: Painter): string {
    const safeWidth = Math.max(16, width);
    const budget = Math.max(20, Math.floor(safeWidth * 0.55));
    const reportedTokens = exactUsageTotal(this.usage);
    const contextWindow = this.plan?.capacityTokens ?? this.model.contextWindow ?? null;
    const plannedTokens = this.plan?.estimatedInputTokens ?? null;
    const displayTokens = plannedTokens ?? reportedTokens;
    const percentage = displayTokens !== null && contextWindow
      ? Math.min(999, Math.round((displayTokens / contextWindow) * 100))
      : null;
    const color = (this.plan && budgetColor(this.plan, percentage) === "signal") || (percentage !== null && percentage >= 90)
      ? "signal"
      : "secondary";
    const usageBase = plannedTokens !== null
      ? `est ~${formatTokenCount(plannedTokens)}${contextWindow ? `/${formatTokenCount(contextWindow)}` : ""}`
      : reportedTokens !== null
        ? `last ${formatTokenCount(reportedTokens)}${contextWindow ? `/${formatTokenCount(contextWindow)}` : ""}`
        : contextWindow
          ? `ctx ${formatTokenCount(contextWindow)} · no request yet`
          : "context pending";
    const absoluteText = painter.text(usageBase, color);
    const meterText = percentage === null
      ? ""
      : `${compactContextMeter(percentage, painter)}${painter.text(` ${percentage}%`, color)}`;

    // Richest form first, then the meter alone: the warning outranks the
    // verbose counts when the footer has to give something up.
    const candidates: string[] = meterText
      ? [`${absoluteText}${painter.dim(" · ")}${meterText}`, meterText]
      : [absoluteText];
    for (const candidate of candidates) {
      if (visibleLength(candidate) <= budget) return candidate;
    }
    return truncateText(candidates[candidates.length - 1]!, budget);
  }

  private trackThroughput(event: EventEnvelope, part: "usage" | "metrics"): void {
    const providerCallId = typeof event.payload.providerCallId === "string" ? event.payload.providerCallId : null;
    if (!providerCallId) return;
    const round = this.rounds.get(providerCallId) ?? { outputTokens: null, durationMs: null };
    if (part === "usage") {
      if (round.outputTokens !== null) return;
      round.outputTokens = numericToken(event.payload.outputTokens);
    } else {
      if (round.durationMs !== null) return;
      round.durationMs = numericDuration(event.payload.durationMs);
    }
    if (round.outputTokens === null || round.durationMs === null) {
      this.rounds.set(providerCallId, round);
      return;
    }
    this.rounds.delete(providerCallId);
    const seconds = round.durationMs / 1_000;
    if (round.outputTokens > 0 && seconds > 0) {
      const rate = round.outputTokens / seconds;
      this.throughput = [...this.throughput, rate].slice(-THROUGHPUT_HISTORY);
    }
  }

  private trackTool(event: EventEnvelope): void {
    const id = stringValue(event.payload.toolCallId);
    const name = stringValue(event.payload.name) ?? "tool";
    if (!id) return;
    const input = parseArguments(event.payload.arguments);
    const path = stringValue(input.path);
    const from = stringValue(input.from);
    const to = stringValue(input.to);
    const argv = Array.isArray(input.argv) && input.argv.every((value) => typeof value === "string")
      ? input.argv as string[]
      : undefined;
    const command = argv?.join(" ");
    const rawDetail = path ?? (from && to ? `${from} → ${to}` : from ?? to) ?? command;
    const detail = rawDetail ? sanitizeTerminalLine(rawDetail) : undefined;
    const change = classifyTurnPhase(name, input, this.changes.length > 0) === "change";
    const operation = name === "move_path" ? "R" : name === "delete_path" ? "D" : change ? "M" : undefined;
    const validation = name === "run_command" && Boolean(command && isValidationCommand(command));
    this.tools.set(id, { name, detail, change, operation, validation });
    if (change && detail) this.changes = upsert(this.changes, { id, label: detail, state: "queued", operation }, 4);
    if (validation && command) this.validations = upsert(this.validations, { id, label: command, state: "queued" }, 3);
    this.activity = [...this.activity, `queued ${toolKindBadge(name).chip} ${detail ?? toolKindBadge(name).title}`].slice(-4);
  }

  private settleTool(event: EventEnvelope, state: RailResult["state"]): void {
    const id = stringValue(event.payload.toolCallId);
    if (!id) return;
    const tool = this.tools.get(id);
    if (!tool) return;
    this.status = state === "waiting" ? "Awaiting approval" : state === "running" ? toolKindBadge(tool.name).title : this.thinkingEnabled === false ? "Working" : "Thinking";
    if (tool.change && tool.detail) {
      const created = typeof event.payload.created === "boolean" ? event.payload.created : undefined;
      this.changes = upsert(this.changes, {
        id,
        label: stringValue(event.payload.path) ?? tool.detail,
        state,
        operation: created ? "A" : tool.operation,
        ...(created !== undefined ? { created } : {}),
      }, 4);
    }
    if (tool.validation && tool.detail) {
      this.validations = upsert(this.validations, {
        id,
        label: tool.detail,
        state,
        ...(typeof event.payload.exitCode === "number" ? { exitCode: event.payload.exitCode } : {}),
      }, 3);
    }
    this.activity = [...this.activity, `${state} ${toolKindBadge(tool.name).chip} ${tool.detail ?? toolKindBadge(tool.name).title}`].slice(-4);
  }

  private finish(): void {
    this.durationMs = this.startedAt === null ? this.durationMs : Date.now() - this.startedAt;
    this.startedAt = null;
  }
}

function compactRuntimeStatus(runtime: RuntimeProfileStatus | null): { label: string; state: RuntimeProfileStatus["state"] } | null {
  if (!runtime || runtime.state === "unconfigured") return null;
  if (runtime.state === "mismatch" || runtime.state === "unavailable") {
    return { label: "! runtime", state: runtime.state };
  }
  if (runtime.state === "pending") return { label: "… verifying", state: runtime.state };
  const speculation = runtime.observed?.speculationType ?? runtime.expected?.speculationType;
  return { label: `✓ ${speculation ? sanitizeTerminalLine(speculation) : "verified"}`, state: runtime.state };
}

function contextPlanValue(value: unknown): ContextPlan | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (![1, 2, 3].includes(Number(candidate.schemaVersion))) return null;
  if (typeof candidate.estimatedInputTokens !== "number" ||
    typeof candidate.estimatedMessageTokens !== "number" ||
    typeof candidate.estimatedToolDefinitionTokens !== "number" ||
    typeof candidate.reserves !== "object" || candidate.reserves === null ||
    !Array.isArray(candidate.actions)) return null;
  return value as ContextPlan;
}

/// A five-cell meter for the single-line footer, where the full meter would
/// crowd out the model and runtime segments.
function compactContextMeter(percentage: number, painter: Painter): string {
  const meterWidth = 5;
  const ratio = Math.max(0, Math.min(1, percentage / 100));
  const filled = Math.round(ratio * meterWidth);
  const color = ratio >= 0.9 ? "signal" : ratio >= 0.7 ? "citron" : "electric";
  return painter.text(`${"▰".repeat(filled)}${"▱".repeat(meterWidth - filled)}`, color);
}

function formatBudgetStatus(plan: ContextPlan): string {
  const label = plan.budgetStatus.replaceAll("_", " ");
  const maximum = plan.maximumPlannedInputTokens === null
    ? ""
    : ` · soft limit ${formatTokenCount(plan.maximumPlannedInputTokens)}`;
  return `${label}${maximum}`;
}

function budgetColor(
  plan: ContextPlan,
  percentage: number | null,
): "secondary" | "citron" | "signal" {
  if (["over_soft_limit", "over_hard_limit", "over_capacity"].includes(plan.budgetStatus)) return "signal";
  if (percentage !== null && percentage >= 70) return "citron";
  return "secondary";
}

function formatResult(result: RailResult, kind: "change" | "validation", width: number, painter: Painter): string {
  const attention = result.state === "failed" || result.state === "denied" || result.state === "waiting";
  const glyph = result.state === "passed" ? "✓" : result.state === "stopped" ? "■" : result.state === "failed" ? "×" : attention ? "!" : result.state === "running" ? "◆" : "·";
  const color = result.state === "passed" ? "citron" : attention ? "signal" : result.state === "running" ? "execute" : "secondary";
  const prefix = kind === "change" && result.state === "passed" ? `${result.operation ?? (result.created ? "A" : "M")} ` : "";
  const outcome = ["waiting", "stopped", "denied", "unknown"].includes(result.state) ? ` · ${result.state === "waiting" ? "awaiting approval" : result.state}` : "";
  const suffix = outcome + (kind === "validation" && result.exitCode !== undefined ? ` (${result.exitCode})` : "");
  return painter.text(`${glyph} ${prefix}${truncateText(sanitizeTerminalLine(result.label), Math.max(0, width - prefix.length - suffix.length - 2))}${suffix}`, color);
}

function parseArguments(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function upsert(results: RailResult[], result: RailResult, limit: number): RailResult[] {
  const next = results.some((candidate) => candidate.id === result.id)
    ? results.map((candidate) => candidate.id === result.id ? { ...candidate, ...result } : candidate)
    : [...results, result];
  return next.slice(-limit);
}

function numericToken(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function numericDuration(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function exactUsageTotal(usage: CliContextRail["usage"]): number | null {
  if (!usage) return null;
  if (usage.totalTokens !== null) return usage.totalTokens;
  if (usage.inputTokens === null || usage.outputTokens === null) return null;
  return usage.inputTokens + usage.outputTokens;
}

function toolSucceeded(event: EventEnvelope): boolean {
  return event.payload.timedOut !== true && (typeof event.payload.exitCode !== "number" || event.payload.exitCode === 0);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function workspaceName(path: string): string {
  const safePath = sanitizeTerminalLine(path);
  return safePath.split("/").filter(Boolean).at(-1) ?? safePath;
}

function formatElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes}:${String(seconds % 60).padStart(2, "0")}` : `${seconds}s`;
}

function formatMetricDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${milliseconds}ms`;
  if (milliseconds < 10_000) return `${(milliseconds / 1_000).toFixed(1).replace(/\.0$/, "")}s`;
  return formatElapsed(milliseconds);
}

function statusGlyph(status: string): string {
  if (status === "Complete") return "✓";
  if (["Failed", "Cancelled", "Interrupted"].includes(status)) return "×";
  return "◆";
}

function statusColor(status: string): "citron" | "signal" | "electricBright" {
  if (status === "Complete") return "citron";
  if (["Failed", "Cancelled", "Interrupted"].includes(status)) return "signal";
  return "electricBright";
}
