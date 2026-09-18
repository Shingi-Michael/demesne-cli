import type {
  ContextPlan,
  EventEnvelope,
  ModelDescriptor,
  ProviderCallSnapshot,
  RuntimeProfileStatus,
  TokenUsage,
} from "@demesne/protocol";
import {
  formatTokenCount,
  sanitizeTerminalLine,
  toolKindBadge,
  truncateText,
  visibleLength,
  type Painter,
} from "@demesne/brand";
import { classifyTurnPhase, isValidationCommand } from "./turn-activity.ts";

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
  state: "queued" | "running" | "passed" | "failed";
  created?: boolean;
  operation?: "A" | "M" | "R" | "D";
  exitCode?: number;
}

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
    }
    if (event.type === "model.metrics") {
      this.requestDurationMs = numericDuration(event.payload.durationMs);
      this.queueDurationMs = numericDuration(event.payload.queueDurationMs);
      this.timeToFirstTokenMs = numericDuration(event.payload.timeToFirstTokenMs);
    }
    if (event.type === "model.context_trimmed") {
      const dropped = Array.isArray(event.payload.droppedTurnIds) ? event.payload.droppedTurnIds.length : 0;
      this.activity = [...this.activity, `dropped ${dropped} older context turn${dropped === 1 ? "" : "s"}`].slice(-4);
    }
    if (event.type === "tool.call_requested") this.trackTool(event);
    if (event.type === "tool.call_started") this.settleTool(event, "running");
    if (event.type === "tool.call_completed") {
      this.settleTool(event, toolSucceeded(event) ? "passed" : "failed");
    }
    if (event.type === "tool.call_failed" || event.type === "tool.call_denied" ||
      event.type === "tool.call_cancelled" || event.type === "tool.call_interrupted") {
      this.settleTool(event, "failed");
    }
    if (event.type === "turn.completed") {
      this.status = "Complete";
      this.finish();
    }
    if (event.type === "turn.cancelled") {
      this.status = "Cancelled";
      this.finish();
    }
    if (event.type === "turn.failed") {
      this.status = "Failed";
      this.finish();
    }
    if (event.type === "turn.interrupted") {
      this.status = "Interrupted";
      this.finish();
    }
  }

  lines(width: number, height: number, painter: Painter): string[] {
    const lines: string[] = [];
    const compact = height < 20;
    const addHeading = (label: string) => {
      if (!compact && lines.length > 0) lines.push("");
      lines.push(painter.bold(label, "secondary"));
    };
    const thinking = this.thinkingEnabled === undefined ? "default" : this.thinkingEnabled ? "on" : "off";
    const reportedTokens = exactUsageTotal(this.usage);
    const contextWindow = this.plan?.capacityTokens ?? this.model.contextWindow ?? null;
    const plannedTokens = this.plan?.estimatedInputTokens ?? null;
    const percentage = plannedTokens !== null && contextWindow
      ? Math.min(999, Math.round((plannedTokens / contextWindow) * 100))
      : null;

    addHeading("CONTEXT PLAN · ESTIMATED");
    lines.push(painter.bold(truncateText(sanitizeTerminalLine(this.model.id), width), "paper"));
    lines.push(painter.dim(`${sanitizeTerminalLine(this.model.provider)} · ${workspaceName(this.workspace)}`));
    lines.push(contextWindow
      ? painter.text(`${formatTokenCount(contextWindow)} token capacity`, "secondary")
      : painter.text("capacity unknown", "signal"));
    if (!this.plan) {
      lines.push(painter.dim("plan pending · calculated before request"));
    } else {
      if (!compact && contextWindow) lines.push(formatContextMeter(plannedTokens ?? 0, contextWindow, width, painter));
      lines.push(painter.text(
        `~${formatTokenCount(this.plan.estimatedInputTokens)} input${percentage !== null ? ` · ${percentage}% of capacity` : ""}`,
        budgetColor(this.plan, percentage),
      ));
      lines.push(painter.dim(
        `messages ~${formatTokenCount(this.plan.estimatedMessageTokens)} · tool definitions ~${formatTokenCount(this.plan.estimatedToolDefinitionTokens)}`,
      ));
      if (!compact) {
        const outputReserve = this.plan.reserves.outputTokens === null
          ? "output unknown"
          : `output ${formatTokenCount(this.plan.reserves.outputTokens)}`;
        lines.push(painter.dim(
          `reserves ${outputReserve} · results ${formatTokenCount(this.plan.reserves.toolResultTokens)} · safety ${formatTokenCount(this.plan.reserves.safetyTokens)}`,
        ));
      }
      lines.push(painter.text(formatBudgetStatus(this.plan), budgetColor(this.plan, percentage)));
      if (this.plan.actions.length > 0) {
        const saved = this.plan.actions.reduce((total, action) => total + action.estimatedTokensSaved, 0);
        lines.push(painter.dim(`${this.plan.actions.length} context reduction${this.plan.actions.length === 1 ? "" : "s"} · saved ~${formatTokenCount(saved)}`));
      }
    }

    addHeading("LAST REQUEST · PROVIDER REPORTED");
    if (reportedTokens === null) {
      lines.push(painter.dim("usage pending"));
    } else {
      lines.push(painter.text(`${formatTokenCount(reportedTokens)} total`, "secondary"));
      const input = this.usage?.inputTokens === null || this.usage?.inputTokens === undefined
        ? "input unavailable"
        : `${formatTokenCount(this.usage.inputTokens)} in`;
      const output = this.usage?.outputTokens === null || this.usage?.outputTokens === undefined
        ? "output unavailable"
        : `${formatTokenCount(this.usage.outputTokens)} out`;
      lines.push(painter.dim(`${input} · ${output}`));
    }
    if (this.usage?.cachedInputTokens !== undefined) {
      lines.push(painter.dim(`${formatTokenCount(this.usage.cachedInputTokens)} cached input`));
    }
    if (this.requestDurationMs !== null) {
      const queue = this.queueDurationMs === null ? "" : `queue ${formatMetricDuration(this.queueDurationMs)} · `;
      const ttft = this.timeToFirstTokenMs === null ? "" : `TTFT ${formatMetricDuration(this.timeToFirstTokenMs)} · `;
      lines.push(painter.dim(`${queue}${ttft}request ${formatMetricDuration(this.requestDurationMs)}`));
    }

    addHeading("TURN");
    const elapsedMs = this.startedAt === null ? this.durationMs : Date.now() - this.startedAt;
    const elapsed = elapsedMs === null ? "" : ` · ${formatElapsed(elapsedMs)}`;
    lines.push(painter.text(`${statusGlyph(this.status)} ${this.status}${elapsed}`, statusColor(this.status)));
    lines.push(painter.dim(`thinking ${thinking}`));

    addHeading("RECENT CHANGES");
    if (!compact && this.changes.length === 0) lines.push(painter.dim("— none this turn"));
    for (const change of this.changes.slice(-3)) lines.push(formatResult(change, "change", width, painter));

    addHeading("RECENT VALIDATION");
    if (!compact && this.validations.length === 0) lines.push(painter.dim("— not run"));
    for (const validation of this.validations.slice(-2)) lines.push(formatResult(validation, "validation", width, painter));

    addHeading("ACTIVITY");
    if (!compact && this.activity.length === 0) lines.push(painter.dim("— waiting"));
    for (const item of this.activity.slice(-3)) lines.push(painter.dim(`· ${truncateText(item, width - 2)}`));

    return lines.map((line) => truncateText(line, Math.max(1, width))).slice(0, Math.max(0, height));
  }

  get modelId(): string {
    return this.model.id;
  }

  statusLine(width: number, painter: Painter, modelLabel?: string): string {
    const safeWidth = Math.max(16, width);
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
    const percentSuffix = percentage === null
      ? ""
      : `${painter.dim(" · ")}${compactContextMeter(percentage, painter)}${painter.text(` ${percentage}%`, color)}`;
    const usageText = painter.text(usageBase, color) + percentSuffix;
    const modelText = modelLabel ?? painter.text(sanitizeTerminalLine(this.model.id), color);
    const runtimePart = compactRuntimeStatus(this.runtime);
    const runtimeText = runtimePart
      ? painter.text(runtimePart.label, runtimePart.state === "verified" ? "citron" : runtimePart.state === "mismatch" ? "signal" : "secondary")
      : "";
    const branchText = this.branch ? painter.dim(` · ${sanitizeTerminalLine(this.branch)}`) : "";
    return truncateText(
      `${runtimeText ? `${runtimeText} · ` : ""}${modelText}${branchText}${painter.dim(" · ")}${usageText}`,
      safeWidth,
    );
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
    this.status = state === "running" ? toolKindBadge(tool.name).title : this.thinkingEnabled === false ? "Working" : "Thinking";
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

function formatContextMeter(
  tokens: number,
  capacity: number,
  width: number,
  painter: Painter,
): string {
  const meterWidth = Math.max(4, Math.min(24, width - 2));
  const ratio = capacity > 0 ? Math.max(0, Math.min(1, tokens / capacity)) : 0;
  const filled = Math.round(ratio * meterWidth);
  const color = ratio >= 0.9 ? "signal" : ratio >= 0.7 ? "citron" : "electric";
  return painter.text(`[${"■".repeat(filled)}${"·".repeat(meterWidth - filled)}]`, color);
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
  const glyph = result.state === "passed" ? "✓" : result.state === "failed" ? "×" : result.state === "running" ? "◆" : "·";
  const color = result.state === "passed" ? "citron" : result.state === "failed" ? "signal" : result.state === "running" ? "electricBright" : "secondary";
  const prefix = kind === "change" && result.state === "passed" ? `${result.operation ?? (result.created ? "A" : "M")} ` : "";
  const suffix = kind === "validation" && result.exitCode !== undefined ? ` (${result.exitCode})` : "";
  return painter.text(`${glyph} ${prefix}${truncateText(sanitizeTerminalLine(result.label), Math.max(8, width - prefix.length - suffix.length - 2))}${suffix}`, color);
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
