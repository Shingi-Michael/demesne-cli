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

export function approvalOptions(allowSession: boolean): {
  options: PermissionDecision[];
  selectedIndex: number;
} {
  const options: PermissionDecision[] = allowSession
    ? ["allow_once", "allow_session", "deny"]
    : ["allow_once", "deny"];
  return {
    options,
    // Host execution is explicitly not sandboxed, so Enter must fail safe.
    selectedIndex: allowSession ? 0 : options.indexOf("deny"),
  };
}

export function reduceApprovalSelection(
  selectedIndex: number,
  allowSession: boolean,
  key: ApprovalKey,
): ApprovalSelectionState {
  const { options } = approvalOptions(allowSession);
  if (key.ctrl && key.name === "c") return { selectedIndex, decision: "deny", cancelledTurn: true };
  if (key.name === "escape" || key.name === "n") return { selectedIndex, decision: "deny", cancelledTurn: false };
  if (key.name === "y") return { selectedIndex, decision: "allow_once", cancelledTurn: false };
  if (key.name === "a" && allowSession) return { selectedIndex, decision: "allow_session", cancelledTurn: false };
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
): string {
  const { options } = approvalOptions(allowSession);
  const labels: Record<PermissionDecision, string> = {
    allow_once: "Allow once",
    allow_session: "Always this session",
    deny: "Deny",
  };
  const colors = allowSession ? ["citron", "electric", "signal"] as const : ["citron", "signal"] as const;
  const choices = options.map((option, index) => index === selectedIndex
    ? painter.bold(`› ${labels[option]}`, colors[index]!)
    : painter.dim(labels[option])).join("   ");
  const full = `  ${painter.bold("Allow this action?", "paper")}  ${choices}${painter.dim("   (←/→ · y/a/n · enter · esc denies)")}`;
  if (visibleLength(full) <= width) return full;
  const selected = options[selectedIndex]!;
  const keys = allowSession ? "y/a/n" : "y/n";
  const compact = `  ${painter.bold("APPROVAL", "paper")} ${selectedIndex + 1}/${options.length} ${painter.bold(`› ${labels[selected]}`, colors[selectedIndex]!)} ${painter.dim(`· ←/→ · ${keys} · enter`)}`;
  return truncateText(compact, Math.max(1, width));
}
