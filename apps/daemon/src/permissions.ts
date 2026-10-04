import { isRecord, type PermissionDecision } from "@demesne/protocol";
import { allowRulesCover, pathsOf, type ConfigAllowlist } from "./allowlist.ts";

interface PendingPermission {
  turnId: string;
  sessionId: string;
  toolName?: string;
  argsJson?: string;
  resolve: (decision: PermissionDecision) => void;
  reject: (error: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export interface SessionRule {
  tool: string;
  /// Workspace-relative directory the grant covers; empty string = whole workspace.
  pathPrefix: string;
  /// For `run_command`: the exact argv and working directory approved. A
  /// command grant covers only that same command in that same place, never
  /// a longer or different one.
  argv?: string[];
  cwd?: string;
}

const MAX_SESSION_RULES = 16;

/// In-memory per-session approval grants ("always this session") plus the
/// persisted user allowlist, which is consulted first. Session grants never
/// outlive the daemon process and expire implicitly when a session ends.
export class PermissionBroker {
  private readonly pending = new Map<string, PendingPermission>();
  private readonly grants = new Map<string, SessionRule[]>();

  constructor(private readonly allowlist?: ConfigAllowlist) {}

  wait(
    permissionId: string,
    turnId: string,
    sessionId: string,
    toolName: string,
    argsJson: string,
    signal: AbortSignal,
  ): Promise<PermissionDecision> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(permissionId);
        resolve("deny");
      }, 5 * 60_000);
      const pending: PendingPermission = { turnId, sessionId, toolName, argsJson, resolve, reject, timeout };
      this.pending.set(permissionId, pending);
      signal.addEventListener("abort", () => {
        if (this.pending.delete(permissionId)) {
          clearTimeout(timeout);
          reject(signal.reason);
        }
      }, { once: true });
    });
  }

  preapproved(sessionId: string, toolName: string, input: unknown): boolean {
    const rules = this.grants.get(sessionId);
    if (rules && sessionRulesCover(rules, toolName, input)) return true;
    const allowRules = this.allowlist?.rulesFor();
    return allowRules ? allowRulesCover(allowRules, toolName, input) : false;
  }

  listGrants(sessionId: string): SessionRule[] {
    return [...this.grants.get(sessionId) ?? []];
  }

  resolve(permissionId: string, decision: PermissionDecision): boolean {
    const pending = this.pending.get(permissionId);
    if (!pending) return false;
    this.pending.delete(permissionId);
    clearTimeout(pending.timeout);
    if ((decision === "allow_session" || decision === "allow_always") && pending.toolName) {
      for (const rule of deriveRules(pending.toolName, pending.argsJson)) this.grant(pending.sessionId, rule);
    }
    pending.resolve(decision);
    return true;
  }

  cancelTurn(turnId: string, reason: unknown): void {
    for (const [permissionId, pending] of this.pending) {
      if (pending.turnId !== turnId) continue;
      this.pending.delete(permissionId);
      clearTimeout(pending.timeout);
      pending.reject(reason);
    }
  }

  private grant(sessionId: string, rule: SessionRule): void {
    const rules = this.grants.get(sessionId) ?? [];
    if (rules.some((existing) => existing.tool === rule.tool && existing.pathPrefix === rule.pathPrefix
      && sameArgv(existing.argv, rule.argv) && existing.cwd === rule.cwd)) return;
    rules.push(rule);
    this.grants.set(sessionId, rules.slice(-MAX_SESSION_RULES));
  }
}

/// A session grant preapproves a call only when every path the call touches is
/// covered by some stored rule for that tool. Single-path tools reduce to the
/// original single-prefix check; `move_path` must have both endpoints covered.
function sessionRulesCover(rules: SessionRule[], toolName: string, input: unknown): boolean {
  if (toolName === "run_command") {
    const command = commandOf(input);
    return command !== null && rules.some((rule) => rule.tool === "run_command" && rule.argv !== undefined
      && sameArgv(rule.argv, command.argv) && rule.cwd === command.cwd);
  }
  const toolRules = rules.filter((rule) => rule.tool === toolName);
  if (toolRules.length === 0) return false;
  const paths = pathsOf(input);
  if (paths.length === 0) return true;
  return paths.every((path) => toolRules.some((rule) => pathMatchesRule(path, rule)));
}

function pathMatchesRule(target: string, rule: SessionRule): boolean {
  if (!rule.pathPrefix) return true;
  const normalized = target.split("\\").join("/");
  return normalized === rule.pathPrefix || normalized.startsWith(`${rule.pathPrefix}/`);
}

/// Derives one scoped rule per path a tool call touches, so approving a
/// `move_path` grants both its source and destination directories.
function deriveRules(toolName: string, argsJson: string | undefined): SessionRule[] {
  let input: unknown;
  try {
    input = argsJson === undefined ? undefined : JSON.parse(argsJson);
  } catch {
    input = undefined;
  }
  // Host commands are unsandboxed: a grant is the exact argv in the same
  // working directory, and nothing when the arguments are malformed.
  if (toolName === "run_command") {
    const command = commandOf(input);
    return command ? [{ tool: toolName, pathPrefix: "", argv: command.argv, cwd: command.cwd }] : [];
  }
  const paths = pathsOf(input);
  if (paths.length === 0) return [{ tool: toolName, pathPrefix: "" }];
  return paths.map((path) => {
    const segments = path.split("\\").join("/").split("/").filter(Boolean);
    segments.pop();
    return { tool: toolName, pathPrefix: segments.join("/") };
  });
}

/// A command's argv and working directory, normalized so `./`, `.` and an
/// omitted cwd compare equal. Null unless argv is a non-empty string array.
function commandOf(input: unknown): { argv: string[]; cwd: string } | null {
  if (!isRecord(input) || !Array.isArray(input.argv) || input.argv.length === 0) return null;
  if (!input.argv.every((entry) => typeof entry === "string")) return null;
  if (input.cwd !== undefined && typeof input.cwd !== "string") return null;
  const cwd = (typeof input.cwd === "string" ? input.cwd : ".").split("\\").join("/").replace(/^(\.\/)+/, "").replace(/\/+$/, "") || ".";
  return { argv: [...input.argv as string[]], cwd };
}

function sameArgv(left: readonly string[] | undefined, right: readonly string[] | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.length === right.length && left.every((word, index) => word === right[index]);
}
