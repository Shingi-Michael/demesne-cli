import { isRecord, ProtocolValidationError } from "./index.ts";

/// A Drive experiment: one question settled by measurement. Each variant is a
/// coder's attempt at one idea in its own git worktree; the variant with no
/// instruction is the baseline. Every variant must pass the checks before its
/// metric counts, and the winner must beat the baseline by `minImprovement`.
export interface ExperimentVariantSpec {
  label: string;
  /// One line naming the idea, e.g. "3 context lines per search hit".
  idea: string;
  /// What the coder is asked to change. Omitted for the baseline.
  instruction?: string;
}
export interface ExperimentMetricSpec {
  name: string;
  direction: "lower" | "higher";
  /// Runs in each variant's worktree. Its last stdout line is a JSON object
  /// with a numeric `value` (other fields are kept as detail), or a number.
  argv: string[];
  /// Fraction of the baseline a winner must improve by (default 0.1).
  minImprovement?: number;
  timeoutMinutes?: number;
}
export interface ExperimentSpec {
  workspace: string;
  question: string;
  hypothesis: string;
  metric: ExperimentMetricSpec;
  /// Run in each worktree before the coder starts (e.g. install dependencies).
  setup?: string[][];
  /// Every variant must pass these after the coder finishes.
  checks: string[][];
  variants: ExperimentVariantSpec[];
  /// Coder model id; the daemon's current model when omitted.
  coderModel?: string;
  /// Wall-time budget for the whole experiment.
  budgetMinutes: number;
  /// Open a draft pull request for the winner.
  pullRequest?: boolean;
}
export type ExperimentVariantStatus = "pending" | "setup" | "building" | "checking" | "measuring" | "done" | "failed" | "stopped";
export interface ExperimentCommandResult { argv: string[]; exitCode: number | null; passed: boolean; seconds: number; tail: string }
export interface ExperimentVariant extends ExperimentVariantSpec {
  status: ExperimentVariantStatus;
  branch: string;
  worktree?: string;
  /// The coder's latest session and turn, and how many attempts it took.
  sessionId?: string;
  turnId?: string;
  attempts?: number;
  changedFiles?: string[];
  checks?: ExperimentCommandResult[];
  metric?: { value: number; detail?: Record<string, unknown> };
  error?: string;
}
export interface ExperimentVerdict {
  /// Label of the winning variant, absent when no variant beat the baseline.
  winner?: string;
  /// Change against the baseline, as a fraction (−0.31 = 31% lower).
  change?: number;
  summary: string;
}
export interface Experiment {
  id: string;
  spec: ExperimentSpec;
  status: "running" | "settled" | "stopped" | "failed";
  base: string;
  createdAt: string;
  settledAt?: string;
  variants: ExperimentVariant[];
  verdict?: ExperimentVerdict;
  /// The winner's branch, and its draft PR once pushed. When committing
  /// fails, the worktree is kept so the change is not lost.
  pullRequest?: { url?: string; branch: string; error?: string; keptWorktree?: string };
  error?: string;
}

function invalid(path: string, requirement: string): never { throw new ProtocolValidationError(`Experiment ${path}: ${requirement}`); }
function text(value: unknown, limit: number, path: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > limit) invalid(path, `expected text up to ${limit} characters`);
  return value.trim();
}
function argv(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || !value.length || value.length > 64 || !value.every((word) => typeof word === "string" && word.length > 0 && word.length <= 4096 && !word.includes("\0")))
    invalid(path, "expected a non-empty argv of strings");
  return [...value] as string[];
}
function commands(value: unknown, path: string, max: number): string[][] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max) invalid(path, `expected at most ${max} commands`);
  return value.map((item, index) => argv(item, `${path}[${index}]`));
}

export function parseExperimentSpec(value: unknown): ExperimentSpec {
  if (!isRecord(value)) invalid("spec", "expected an object");
  const metric = value.metric;
  if (!isRecord(metric)) invalid("metric", "expected an object");
  if (metric.direction !== "lower" && metric.direction !== "higher") invalid("metric.direction", "expected lower or higher");
  if (metric.minImprovement !== undefined && (typeof metric.minImprovement !== "number" || !(metric.minImprovement >= 0 && metric.minImprovement < 1))) invalid("metric.minImprovement", "expected a fraction from 0 to 1");
  if (metric.timeoutMinutes !== undefined && (!Number.isInteger(metric.timeoutMinutes) || Number(metric.timeoutMinutes) < 1 || Number(metric.timeoutMinutes) > 240)) invalid("metric.timeoutMinutes", "expected 1 to 240");
  if (!Array.isArray(value.variants) || value.variants.length < 2 || value.variants.length > 4) invalid("variants", "expected 2 to 4 variants");
  const labels = new Set<string>();
  const variants = value.variants.map((item, index) => {
    const path = `variants[${index}]`;
    if (!isRecord(item)) invalid(path, "expected an object");
    const label = text(item.label, 16, `${path}.label`);
    if (!/^[A-Za-z0-9-]+$/.test(label) || labels.has(label.toLowerCase())) invalid(`${path}.label`, "expected a unique label of letters, digits and dashes");
    labels.add(label.toLowerCase());
    return { label, idea: text(item.idea, 200, `${path}.idea`), ...(item.instruction !== undefined ? { instruction: text(item.instruction, 8000, `${path}.instruction`) } : {}) };
  });
  if (variants.filter((variant) => !variant.instruction).length !== 1) invalid("variants", "expected exactly one baseline variant without an instruction");
  if (!Number.isInteger(value.budgetMinutes) || Number(value.budgetMinutes) < 5 || Number(value.budgetMinutes) > 480) invalid("budgetMinutes", "expected 5 to 480");
  return {
    workspace: text(value.workspace, 4096, "workspace"),
    question: text(value.question, 300, "question"),
    hypothesis: text(value.hypothesis, 1000, "hypothesis"),
    metric: {
      name: text(metric.name, 100, "metric.name"), direction: metric.direction, argv: argv(metric.argv, "metric.argv"),
      ...(metric.minImprovement !== undefined ? { minImprovement: metric.minImprovement as number } : {}),
      ...(metric.timeoutMinutes !== undefined ? { timeoutMinutes: metric.timeoutMinutes as number } : {}),
    },
    setup: commands(value.setup, "setup", 4),
    checks: commands(value.checks, "checks", 6),
    variants,
    ...(value.coderModel !== undefined ? { coderModel: text(value.coderModel, 200, "coderModel") } : {}),
    budgetMinutes: value.budgetMinutes as number,
    ...(typeof value.pullRequest === "boolean" ? { pullRequest: value.pullRequest } : {}),
  };
}
