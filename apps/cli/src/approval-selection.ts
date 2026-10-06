import type { PermissionDecision } from "@demesne/protocol";
import { truncateText, visibleLength, type Painter } from "@demesne/brand";

export interface ApprovalKey {
  name?: string;
  ctrl?: boolean;
}

export interface ApprovalSelectionState {
  selectedIndex: number;
  decision: PermissionDecision | null;
  cancelledTurn: boolean;
}

/// `failSafe` makes Deny the default so Enter never runs something by
/// accident; host commands always pass it, even when they offer a session grant.
export function approvalOptions(allowSession: boolean, allowPersist = false, failSafe = !allowSession): {
  options: PermissionDecision[];
  selectedIndex: number;
} {
  const options: PermissionDecision[] = allowSession
    ? allowPersist
      ? ["allow_once", "allow_session", "allow_always", "deny"]
      : ["allow_once", "allow_session", "deny"]
    : allowPersist
      ? ["allow_once", "allow_always", "deny"]
      : ["allow_once", "deny"];
  return {
    options,
    // Host execution is explicitly not sandboxed, so Enter must fail safe.
    selectedIndex: failSafe ? options.indexOf("deny") : 0,
  };
}

export function reduceApprovalSelection(
  selectedIndex: number,
  allowSession: boolean,
  key: ApprovalKey,
  allowPersist = false,
): ApprovalSelectionState {
  const { options } = approvalOptions(allowSession, allowPersist);
  if (key.ctrl && key.name === "c") return { selectedIndex, decision: "deny", cancelledTurn: true };
  if (key.name === "escape" || key.name === "n") return { selectedIndex, decision: "deny", cancelledTurn: false };
  if (key.name === "y") return { selectedIndex, decision: "allow_once", cancelledTurn: false };
  if (key.name === "a" && allowSession) return { selectedIndex, decision: "allow_session", cancelledTurn: false };
  if (key.name === "s" && allowPersist) return { selectedIndex, decision: "allow_always", cancelledTurn: false };
  if (key.name === "left" || key.name === "up") {
    return { selectedIndex: (selectedIndex - 1 + options.length) % options.length, decision: null, cancelledTurn: false };
  }
  if (key.name === "right" || key.name === "down" || key.name === "tab") {
    return { selectedIndex: (selectedIndex + 1) % options.length, decision: null, cancelledTurn: false };
  }
  if (key.name === "return" || key.name === "enter" || key.name === "space") {
    return { selectedIndex, decision: options[selectedIndex]!, cancelledTurn: false };
  }
  return { selectedIndex, decision: null, cancelledTurn: false };
}

export function formatApprovalSelection(
  selectedIndex: number,
  allowSession: boolean,
  width: number,
  painter: Painter,
  allowPersist = false,
  subject: "action" | "command" = "action",
): string {
  const { options } = approvalOptions(allowSession, allowPersist);
  const labels: Record<PermissionDecision, string> = {
    allow_once: "Allow once",
    allow_session: "Always this session",
    allow_always: "Always allow (save)",
    deny: "Deny",
  };
  const colors = allowSession
    ? allowPersist
      ? ["citron", "electric", "electricBright", "signal"] as const
      : ["citron", "electric", "signal"] as const
    : allowPersist
      ? ["citron", "electricBright", "signal"] as const
      : ["citron", "signal"] as const;
  const choices = options.map((option, index) => index === selectedIndex
    ? painter.wash(`› ${labels[option]}`, colors[index]!)
    : painter.dim(labels[option])).join("   ");
  const keys = allowPersist ? (allowSession ? "y/a/s/n" : "y/s/n") : (allowSession ? "y/a/n" : "y/n");
  const full = `  ${painter.bold(`Allow this ${subject}?`, "paper")}  ${choices}${painter.dim(`   (←/→ · ${keys} · enter · esc denies)`)}`;
  if (visibleLength(full) <= width) return full;
  const selected = options[selectedIndex]!;
  const compact = `  ${painter.bold(subject === "command" ? "Allow command?" : "APPROVAL", "paper")} ${selectedIndex + 1}/${options.length} ${painter.wash(`› ${labels[selected]}`, colors[selectedIndex]!)} ${painter.dim(`· ←/→ · ${keys} · enter`)}`;
  return truncateText(compact, Math.max(1, width));
}
