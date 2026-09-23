import type { EventEnvelope } from "@demesne/protocol";

export type TurnPhase = "inspect" | "change" | "verify";
export type TurnActivityState = "queued" | "waiting" | "running" | "done" | "failed" | "denied" | "stopped";

export interface TurnActivity {
  id: string;
  name: string;
  phase: TurnPhase;
  state: TurnActivityState;
  detail?: string;
  startedAt?: number;
  durationMs?: number;
  exitCode?: number;
  created?: boolean;
  diff?: { oldText: string; newText: string };
}

export interface TurnChangeReceipt {
  id: string;
  operation: "A" | "M" | "R" | "D";
  path: string;
  state: TurnActivityState;
}

export interface TurnValidationReceipt {
  id: string;
  command: string;
  state: TurnActivityState;
  exitCode?: number;
}

export interface TurnActivitySnapshot {
  rounds: number;
  tools: number;
  activities: TurnActivity[];
  changes: TurnChangeReceipt[];
  validations: TurnValidationReceipt[];
}

const CHANGE_TOOLS = new Set(["edit_file", "write_file", "move_path", "delete_path"]);

export class TurnActivityLedger {
  private readonly seenEvents = new Set<number>();
  private readonly activities = new Map<string, TurnActivity>();
  private rounds = 0;

  apply(event: EventEnvelope): void {
    if (this.seenEvents.has(event.eventId)) return;
    this.seenEvents.add(event.eventId);

    if (event.type === "model.request_started") {
      this.rounds += 1;
      return;
    }
    if (event.type === "turn.cancelled" || event.type === "turn.interrupted") {
      for (const activity of this.activities.values()) {
        if (["queued", "waiting", "running"].includes(activity.state)) activity.state = "stopped";
      }
      return;
    }
    if (event.type === "permission.requested" || event.type === "permission.resolved") {
      const activity = this.activities.get(stringValue(event.payload.toolCallId) ?? "");
      if (activity) activity.state = event.type === "permission.requested" ? "waiting" : event.payload.decision === "deny" ? "denied" : "queued";
      return;
    }
    if (!event.type.startsWith("tool.call_")) return;

    const id = stringValue(event.payload.toolCallId);
    if (!id) return;
    const existing = this.activities.get(id);
    const name = stringValue(event.payload.name) ?? existing?.name ?? "tool";

    if (event.type === "tool.call_requested") {
      const input = parseArguments(event.payload.arguments);
      this.activities.set(id, {
        id,
        name,
        phase: classifyTurnPhase(name, input, this.hasChanges()),
        state: "queued",
        detail: toolActivityDetail(name, input),
        diff: editDiffFrom(name, input),
      });
      return;
    }

    const activity = existing ?? {
      id,
      name,
      phase: classifyTurnPhase(name, {}, this.hasChanges()),
      state: "queued" as const,
    };
    if (event.type === "tool.call_started") {
      this.activities.set(id, {
        ...activity,
        name,
        state: "running",
        startedAt: eventTime(event),
      });
      return;
    }

    const state: TurnActivityState = event.type === "tool.call_denied"
      ? "denied"
      : event.type === "tool.call_cancelled" || event.type === "tool.call_interrupted" ? "stopped"
      : event.type === "tool.call_completed" && toolSucceeded(event)
        ? "done"
        : "failed";
    const completedAt = eventTime(event);
    this.activities.set(id, {
      ...activity,
      name,
      state,
      ...(activity.startedAt !== undefined ? { durationMs: Math.max(0, completedAt - activity.startedAt) } : {}),
      ...(typeof event.payload.exitCode === "number" ? { exitCode: event.payload.exitCode } : {}),
      ...(typeof event.payload.created === "boolean" ? { created: event.payload.created } : {}),
    });
  }

  activity(id: string): TurnActivity | undefined {
    return this.activities.get(id);
  }

  pendingCount(phase: TurnPhase): number {
    return [...this.activities.values()].filter((activity) =>
      activity.phase === phase && (activity.state === "queued" || activity.state === "waiting" || activity.state === "running")
    ).length;
  }

  snapshot(): TurnActivitySnapshot {
    const activities = [...this.activities.values()];
    return {
      rounds: this.rounds,
      tools: activities.length,
      activities,
      changes: activities.flatMap((activity) => changeReceipt(activity)),
      validations: activities.flatMap((activity) => validationReceipt(activity)),
    };
  }

  private hasChanges(): boolean {
    return [...this.activities.values()].some((activity) => activity.phase === "change");
  }
}

export function classifyTurnPhase(
  name: string,
  input: Record<string, unknown> = {},
  hasChanges = false,
): TurnPhase {
  if (CHANGE_TOOLS.has(name)) return "change";
  if (name === "run_command" && isValidationCommand(commandFrom(input) ?? "")) return "verify";
  if (hasChanges && (name === "git_diff" || name === "git_status")) return "verify";
  return "inspect";
}

export function isValidationCommand(command: string): boolean {
  return /(^|\s)(test|typecheck|check|lint|build)(?=[:_-]|\s|$)/i.test(command) ||
    /(^|\s)(pytest|xcodebuild|tsc|eslint)(\s|$)/i.test(command);
}

function changeReceipt(activity: TurnActivity): TurnChangeReceipt[] {
  if (activity.phase !== "change" || !activity.detail) return [];
  const operation = activity.name === "move_path"
    ? "R"
    : activity.name === "delete_path"
      ? "D"
      : activity.created
        ? "A"
        : "M";
  return [{ id: activity.id, operation, path: activity.detail, state: activity.state }];
}

function validationReceipt(activity: TurnActivity): TurnValidationReceipt[] {
  if (activity.phase !== "verify" || activity.name !== "run_command" || !activity.detail) return [];
  return [{
    id: activity.id,
    command: activity.detail.replace(/^\$\s*/, ""),
    state: activity.state,
    ...(activity.exitCode !== undefined ? { exitCode: activity.exitCode } : {}),
  }];
}

function toolActivityDetail(name: string, input: Record<string, unknown>): string | undefined {
  if (name === "move_path") {
    const from = stringValue(input.from);
    const to = stringValue(input.to);
    return from && to ? `${from} → ${to}` : from ?? to;
  }
  const path = stringValue(input.path);
  if (path) return path;
  if (Array.isArray(input.paths) && input.paths.every((value) => typeof value === "string")) {
    const paths = input.paths as string[];
    return paths.length === 1 ? paths[0] : `${paths.length} files · ${paths[0] ?? ""}`;
  }
  const command = commandFrom(input);
  if (command) return `$ ${command}`;
  const query = stringValue(input.query);
  if (query) return `query: "${query}"`;
  if (Array.isArray(input.patterns) && input.patterns.every((value) => typeof value === "string")) {
    return (input.patterns as string[]).join(", ");
  }
  return undefined;
}

function commandFrom(input: Record<string, unknown>): string | undefined {
  return Array.isArray(input.argv) && input.argv.every((value) => typeof value === "string")
    ? (input.argv as string[]).map(shellWord).join(" ")
    : undefined;
}

/// Keeps only the replacement pair needed for an inline diff; full tool
/// arguments are not retained for the whole turn.
function editDiffFrom(
  name: string,
  input: Record<string, unknown>,
): { oldText: string; newText: string } | undefined {
  if (name !== "edit_file") return undefined;
  return typeof input.oldText === "string" && typeof input.newText === "string"
    ? { oldText: input.oldText, newText: input.newText }
    : undefined;
}

function shellWord(value: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

function parseArguments(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function eventTime(event: EventEnvelope): number {
  const timestamp = Date.parse(event.occurredAt);
  return Number.isFinite(timestamp) ? timestamp : Date.now();
}

function toolSucceeded(event: EventEnvelope): boolean {
  return event.payload.timedOut !== true && (typeof event.payload.exitCode !== "number" || event.payload.exitCode === 0);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
