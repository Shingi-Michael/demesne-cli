/// The environment card (pass 173 A): the top of the cards says where this
/// chat runs, in three dim facts and no greeting (no tile, no big name). The
/// machine with a dot while the daemon is up, the branch with how far it is
/// from its upstream and what's uncommitted in the whole folder, and the model
/// with its effort as dots and its context window. Hover (or click to keep it
/// open) for the folder, the provider and the daemon's address. The daemon
/// only speaks up when it isn't fine: the first row turns pink, with Start.

export interface WhereView {
  /// The project folder, "" for a plain chat.
  root: string;
  branch?: string | null;
  /// Commits ahead of and behind the branch's upstream, when it has one.
  ahead?: number | null;
  behind?: number | null;
  /// Uncommitted files in the whole folder, not just this chat's.
  uncommitted: number;
  model: { id: string; displayName?: string | null; provider?: string | null };
  reasoning?: string | null;
  /// The model's context window, when known.
  capacity?: number | null;
  connection: "connecting" | "online" | "offline";
  /// The daemon's address, as the window dials it.
  server: string;
}

export interface WhereCard {
  /// The three rows, always shown.
  rows: string;
  /// What hover unfolds: folder, provider, daemon.
  more: string;
  /// "" when the daemon is fine, else "wait" or "off".
  state: "" | "wait" | "off";
}

const h = (value: unknown) =>
  String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

/// Effort as a count of dots out of three; words the model doesn't use get none.
export function effortDots(reasoning: string | null | undefined): 0 | 1 | 2 | 3 {
  switch ((reasoning ?? "").toLowerCase()) {
    case "minimal": case "low": return 1;
    case "medium": return 2;
    case "high": case "xhigh": case "max": return 3;
    default: return 0;
  }
}

/// "This computer" for a daemon on localhost, else the host it runs on.
export function runsOn(server: string): string {
  try {
    const host = new URL(server).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]" ? "This computer" : host;
  } catch {
    return server || "This computer";
  }
}

const words = (model: WhereView["model"]) => model.displayName?.trim() || model.id.split("/").at(-1)!.split(/[-_]/).filter(Boolean)
  .map((word) => /^\d+(\.\d+)?[bkm]$/i.test(word) ? word.toUpperCase() : /^(gpt|glm|llm|vl|it)$/i.test(word) ? word.toUpperCase() : word.replace(/^./, (c) => c.toUpperCase())).join(" ");
const short = (value: number) => value >= 1e6 ? `${+(value / 1e6).toFixed(1)}m` : value >= 1000 ? `${Math.round(value / 1000)}k` : String(value);
const home = (path: string) => path.replace(/^\/Users\/[^/]+|^\/home\/[^/]+|^[A-Za-z]:\\Users\\[^\\]+/, "~");

const ICON = {
  machine: '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>',
  branch: '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="8" r="2.5"/><path d="M6 8.5v7M18 10.5a7 7 0 0 1-7 7H8.5"/></svg>',
  model: '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5"/></svg>',
};
const row = (icon: string, value: string, right = "", title = "") => `<span class="env-row"${title ? ` title="${h(title)}"` : ""}>${icon}<span class="env-v">${value}</span>${right ? `<span class="env-r">${right}</span>` : ""}</span>`;

export function whereCard(view: WhereView): WhereCard {
  const folder = view.root ? home(view.root.replace(/[\\/]$/, "")) : "";
  const model = view.model.id ? words(view.model) : "No model";
  const dots = effortDots(view.reasoning);
  const state: WhereCard["state"] = view.connection === "online" ? "" : view.connection === "connecting" ? "wait" : "off";
  const rows: string[] = [];
  rows.push(state === "off" ? row('<i class="env-dot off" aria-hidden="true"></i>', "Daemon is offline")
    : state === "wait" ? row('<i class="env-dot wait" aria-hidden="true"></i>', "Connecting to the daemon…")
    : row(ICON.machine, h(runsOn(view.server)), '<i class="env-dot on" title="Daemon online"></i>'));
  if (view.root) {
    const sync = [view.ahead ? `↑${view.ahead}` : "", view.behind ? `↓${view.behind}` : ""].filter(Boolean).join(" ");
    const right = [sync, view.uncommitted ? `${view.uncommitted} uncommitted` : ""].filter(Boolean).join(" · ");
    const title = [view.ahead ? `${view.ahead} commit${view.ahead === 1 ? "" : "s"} to push` : "", view.behind ? `${view.behind} to pull` : ""].filter(Boolean).join(", ");
    rows.push(row(ICON.branch, view.branch ? h(view.branch) : "<em>Not a git checkout</em>", h(right), title));
  }
  const effort = dots ? `<span class="env-eff" title="${h(view.reasoning)} effort">${[1, 2, 3].map((i) => `<i${i <= dots ? ' class="on"' : ""}></i>`).join("")}</span>` : "";
  rows.push(row(ICON.model, h(model), `${effort}${view.capacity ? h(short(view.capacity)) : ""}`));
  const more = [
    folder ? `<span class="env-k">Folder</span><span class="env-m" title="${h(folder)}">${h(folder)}</span>` : "",
    view.model.provider ? `<span class="env-k">Provider</span><span class="env-m">${h(view.model.provider)}</span>` : "",
    view.server ? `<span class="env-k">Daemon</span><span class="env-m">${h(view.server.replace(/^https?:\/\//, "").replace(/\/$/, ""))}</span>` : "",
  ].join("");
  return { rows: rows.join(""), more: `<div class="env-more">${more}</div>`, state };
}
