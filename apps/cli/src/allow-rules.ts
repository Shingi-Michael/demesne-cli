import { isRecord } from "@demesne/protocol";

/// Builds the persisted `[permissions] allow` entry for a pending approval.
///
/// Host commands persist the exact argv, and every argument must be a single
/// whitespace-free word so the rule can be expressed as a TOML string. Path
/// tools persist the containing directory, matching the "always this session"
/// scope; a root-level file persists as its own exact path.
export function derivePersistedRule(toolName: string | undefined, rawArguments: unknown): string | null {
  if (!toolName) return null;
  if (toolName.startsWith("mcp__")) return toolName;
  const input = parseArguments(rawArguments);
  if (toolName === "run_command") {
    const argv = input.argv;
    if (!Array.isArray(argv) || argv.length === 0) return null;
    if (!argv.every((entry) => typeof entry === "string" && entry.length > 0 && !/\s/.test(entry))) return null;
    return `run_command:${argv.join(" ")}`;
  }
  const target = pathFrom(input, toolName === "move_path" ? "from" : "path");
  if (!target) return null;
  const normalized = target.split("\\").join("/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (!normalized) return null;
  const segments = normalized.split("/").filter(Boolean);
  segments.pop();
  return `${toolName}:${segments.join("/") || normalized}`;
}

function pathFrom(input: Record<string, unknown>, key: string): string | null {
  const candidate = input[key];
  return typeof candidate === "string" && candidate.trim() ? candidate.trim() : null;
}

function parseArguments(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value;
  if (typeof value !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
