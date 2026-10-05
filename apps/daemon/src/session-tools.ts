import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProviderToolDefinition } from "@demesne/providers";

/// Session tools: the model adapts the built-in tools to the job without
/// changing them. A preset is a tool with saved default arguments; a
/// composition is a few read-only steps run as one call, each able to use
/// the call's parameters and earlier steps' results. Variants belong to one
/// session (saved with it, gone with it) and can never do more than the tools
/// they're built from: presets go through the base tool's normal approval,
/// and compositions may only use read-only tools.
///
/// One tool, `session_tools`, carries every variant as arguments, so the tool
/// list never changes mid-session and the provider's prompt cache stays warm.

export const SESSION_TOOLS = "session_tools";
/// Tools a composition may use: read-only, never needing approval.
export const COMPOSABLE_TOOLS = new Set(["list_files", "read_file", "read_files", "search_files", "git_status", "git_diff", "git_history"]);
const MAX_VARIANTS = 20, MAX_STEPS = 6, MAX_OUTPUT = 64 * 1024;

export type ParamType = "string" | "integer";
export interface Preset { kind: "preset"; name: string; description: string; base: string; defaults: Record<string, unknown> }
export interface Composition { kind: "composition"; name: string; description: string; params: Record<string, { type: ParamType; description?: string }>; steps: Array<{ tool: string; args: Record<string, unknown> }> }
export type Variant = Preset | Composition;

export const sessionToolsDefinition: ProviderToolDefinition = {
  name: SESSION_TOOLS,
  description: "Your own tools for this session, built from the existing ones; they never change the real tools and end with the session. action define: a preset (base tool + defaults, e.g. search_files with include \"*.ts\") or a composition (up to 6 read-only steps run as one call; step args may use {{param}} and earlier results like {{steps[0].first.path}} or {{steps[0].first.line - 20}}). run: by name with args. list, remove. Define one when you'd otherwise repeat the same calls.",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["define", "run", "list", "remove"] },
      name: { type: "string" },
      description: { type: "string" },
      base: { type: "string", description: "preset: the tool it wraps" },
      defaults: { type: "object", description: "preset: default arguments" },
      params: { type: "object", description: "composition: {name: {type: string|integer, description}}" },
      steps: { type: "array", items: { type: "object", properties: { tool: { type: "string" }, args: { type: "object" } }, required: ["tool", "args"] } },
      args: { type: "object", description: "run: arguments" },
    },
    required: ["action"],
    additionalProperties: false,
  },
};

export class SessionToolStore {
  constructor(private readonly directory: string) {}
  private path(sessionId: string) {
    if (!/^[A-Za-z0-9-]{1,100}$/.test(sessionId)) throw new Error("Invalid session id");
    return join(this.directory, `${sessionId}.json`);
  }
  list(sessionId: string): Variant[] {
    const path = this.path(sessionId);
    if (!existsSync(path)) return [];
    try { return JSON.parse(readFileSync(path, "utf8")) as Variant[]; } catch { return []; }
  }
  get(sessionId: string, name: string) { return this.list(sessionId).find((item) => item.name === name); }
  private write(sessionId: string, variants: Variant[]) {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const path = this.path(sessionId), temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(variants), { mode: 0o600 });
    renameSync(temp, path);
  }
  define(sessionId: string, variant: Variant) {
    const others = this.list(sessionId).filter((item) => item.name !== variant.name);
    if (others.length >= MAX_VARIANTS) throw new Error(`A session holds at most ${MAX_VARIANTS} tools; remove one first.`);
    this.write(sessionId, [...others, variant]);
  }
  remove(sessionId: string, name: string) {
    const variants = this.list(sessionId);
    if (!variants.some((item) => item.name === name)) return false;
    this.write(sessionId, variants.filter((item) => item.name !== name));
    return true;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/// Validates a define request against the real tools. Throws a message the
/// model can act on.
export function parseVariant(input: Record<string, unknown>, builtIn: Set<string>): Variant {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!/^[a-z][a-z0-9_]{1,39}$/.test(name)) throw new Error("name must be 2-40 lowercase letters, digits or underscores, starting with a letter");
  if (builtIn.has(name) || name === SESSION_TOOLS) throw new Error(`${name} is a built-in tool; choose another name`);
  const description = typeof input.description === "string" ? input.description.trim().slice(0, 300) : "";
  if (input.base !== undefined) {
    const base = String(input.base);
    if (!builtIn.has(base) || base === "subagent") throw new Error(`base must be a built-in tool (not ${base})`);
    if (!isRecord(input.defaults) || JSON.stringify(input.defaults).length > 4096) throw new Error("defaults must be an object of the base tool's arguments (at most 4 KB)");
    return { kind: "preset", name, description, base, defaults: input.defaults };
  }
  if (!Array.isArray(input.steps) || !input.steps.length || input.steps.length > MAX_STEPS) throw new Error(`a composition needs 1-${MAX_STEPS} steps (or give base and defaults for a preset)`);
  const steps = input.steps.map((step, index) => {
    if (!isRecord(step) || typeof step.tool !== "string" || !isRecord(step.args)) throw new Error(`step ${index}: needs tool and args`);
    if (!COMPOSABLE_TOOLS.has(step.tool)) throw new Error(`step ${index}: ${step.tool} can't be composed; steps may use ${[...COMPOSABLE_TOOLS].join(", ")}`);
    return { tool: step.tool, args: step.args };
  });
  if (JSON.stringify(steps).length > 8192) throw new Error("steps are too large (at most 8 KB)");
  const params: Composition["params"] = {};
  for (const [key, spec] of Object.entries(isRecord(input.params) ? input.params : {})) {
    if (!/^[a-z][a-z0-9_]{0,31}$/.test(key) || key === "steps") throw new Error(`param ${key}: use lowercase letters, digits and underscores`);
    const type = isRecord(spec) && spec.type === "integer" ? "integer" : "string";
    params[key] = { type, ...(isRecord(spec) && typeof spec.description === "string" ? { description: spec.description.slice(0, 200) } : {}) };
  }
  return { kind: "composition", name, description, params, steps };
}

/// A step's output as data for later steps: parsed JSON, and for searches the
/// hits as {path, line, text} with `first` the first one.
export function stepData(output: string): unknown {
  let parsed: unknown;
  try { parsed = JSON.parse(output); } catch { return { text: output }; }
  if (isRecord(parsed) && Array.isArray(parsed.matches)) {
    const hits = parsed.matches.slice(0, 200).flatMap((entry) => {
      const match = typeof entry === "string" ? /^(.+?):(\d+):(.*)$/.exec(entry) : null;
      return match ? [{ path: match[1]!, line: Number(match[2]), text: match[3]! }] : [];
    });
    return { ...parsed, hits, first: hits[0] ?? null };
  }
  return parsed;
}

/// Fills {{param}}, {{steps[0].first.path}} and {{steps[0].first.line - 20}}
/// in step arguments. A string that is only a template keeps its value's type.
export function fill(value: unknown, scope: Record<string, unknown>): unknown {
  if (typeof value === "string") {
    const whole = /^\{\{([^{}]+)\}\}$/.exec(value);
    if (whole) return evaluate(whole[1]!, scope);
    return value.replace(/\{\{([^{}]+)\}\}/g, (_, expression: string) => String(evaluate(expression, scope)));
  }
  if (Array.isArray(value)) return value.map((item) => fill(item, scope));
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fill(item, scope)]));
  return value;
}
function evaluate(expression: string, scope: Record<string, unknown>): unknown {
  const match = /^\s*([a-z][a-z0-9_]*(?:\[\d+\]|\.[A-Za-z_][A-Za-z0-9_]*)*)\s*(?:([+-])\s*(\d+))?\s*$/.exec(expression);
  if (!match) throw new Error(`can't read {{${expression.trim()}}}: use a param, steps[N].field, or field ± a number`);
  let current: unknown = scope;
  for (const part of match[1]!.match(/[A-Za-z_][A-Za-z0-9_]*|\[\d+\]/g)!) {
    const key = part.startsWith("[") ? Number(part.slice(1, -1)) : part;
    current = isRecord(current) || Array.isArray(current) ? (current as Record<string | number, unknown>)[key] : undefined;
    if (current === undefined || current === null) throw new Error(`{{${expression.trim()}}} has no value`);
  }
  if (match[2]) {
    if (typeof current !== "number") throw new Error(`{{${expression.trim()}}}: only numbers take + or -`);
    return match[2] === "+" ? current + Number(match[3]) : current - Number(match[3]);
  }
  return current;
}

/// Checks run args against a composition's params.
export function checkArgs(variant: Composition, args: Record<string, unknown>) {
  for (const [name, spec] of Object.entries(variant.params)) {
    const value = args[name];
    if (value === undefined) throw new Error(`${variant.name} needs ${name}`);
    if (spec.type === "integer" ? !Number.isInteger(value) : typeof value !== "string") throw new Error(`${name} must be ${spec.type === "integer" ? "an integer" : "text"}`);
  }
}

export function describe(variant: Variant) {
  return variant.kind === "preset"
    ? `${variant.name}: preset of ${variant.base} with ${JSON.stringify(variant.defaults)}${variant.description ? ` — ${variant.description}` : ""}`
    : `${variant.name}(${Object.keys(variant.params).join(", ")}): ${variant.steps.map((step) => step.tool).join(" → ")}${variant.description ? ` — ${variant.description}` : ""}`;
}

export function clip(text: string) { return text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n…(output capped at 64 KB)` : text; }
