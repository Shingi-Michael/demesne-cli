import { isRecord, type PermissionDecision } from "@demesne/protocol";
import { allowRuleMatches, type ConfigAllowlist } from "./allowlist.ts";

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
    if (rules?.some((rule) => ruleMatches(rule, toolName, input))) return true;
    return this.allowlist?.rulesFor().some((rule) => allowRuleMatches(rule, toolName, input)) ?? false;
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
      const rule = deriveRule(pending.toolName, pending.argsJson);
      if (rule) this.grant(pending.sessionId, rule);
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
    if (rules.some((existing) => existing.tool === rule.tool && existing.pathPrefix === rule.pathPrefix)) return;
    rules.push(rule);
    this.grants.set(sessionId, rules.slice(-MAX_SESSION_RULES));
  }
}

function ruleMatches(rule: SessionRule, toolName: string, input: unknown): boolean {
  if (rule.tool !== toolName) return false;
  if (!rule.pathPrefix) return true;
  const target = pathOf(input);
  if (!target) return true;
  const normalized = target.split("\\").join("/");
  return normalized === rule.pathPrefix || normalized.startsWith(`${rule.pathPrefix}/`);
}

function deriveRule(toolName: string, argsJson: string | undefined): SessionRule | null {
  // Host commands are unsandboxed; each argv requires explicit approval.
  if (toolName === "run_command") return null;
  let input: unknown;
  try {
    input = argsJson === undefined ? undefined : JSON.parse(argsJson);
  } catch {
    input = undefined;
  }
  const target = pathOf(input);
  if (!target) return { tool: toolName, pathPrefix: "" };
  const segments = target.split("\\").join("/").split("/").filter(Boolean);
  segments.pop();
  return { tool: toolName, pathPrefix: segments.join("/") };
}

function pathOf(input: unknown): string | null {
  if (!isRecord(input)) return null;
  for (const key of ["path", "from"]) {
    const candidate = input[key];
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }
  return null;
}
