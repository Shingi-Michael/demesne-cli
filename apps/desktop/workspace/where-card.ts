/// The Where card (pass 121 E): the first card beside a chat says where it
/// runs. A monogram tile for the project, its name and folder, the model
/// with its effort as three dots, then the lines that change: the branch
/// with what this chat changed, the context used, and the machine it runs
/// on. The daemon only speaks up when it isn't fine: a coloured edge and a
/// one-line note with Start. The rest (provider, address) sits in a hover.

export interface WhereView {
  /// The project folder, "" for a plain chat.
  root: string;
  branch?: string | null;
  model: { id: string; displayName?: string | null; provider?: string | null };
  reasoning?: string | null;
  connection: "connecting" | "online" | "offline";
  /// The daemon's address, as the window dials it.
  server: string;
  /// Files this chat changed and hasn't committed.
  changed: number;
  /// The context used, when known and not already shown by the Context card.
  context?: { percentage: number; used: number; capacity: number } | null;
}

export interface WhereCard {
  /// What the folded head says: "demesne-cli · main".
  summary: string;
  /// The head's monogram, name, folder and model.
  head: string;
  body: string;
  /// A class for the card: "" when the daemon is fine, else "wait" or "off".
  state: "" | "wait" | "off";
  /// The hover: path, provider, address.
  title: string;
}

const h = (value: unknown) =>
  String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

/// A soft tint for the project, picked from its name so a project keeps its
/// face across chats. The first is the sakura pink.
export const TINTS = ["pink", "blue", "green", "amber", "lilac"] as const;
export function tint(name: string): (typeof TINTS)[number] {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  return TINTS[hash % TINTS.length]!;
}

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

export function whereCard(view: WhereView): WhereCard {
  const name = view.root ? view.root.replace(/[\\/]$/, "").split(/[\\/]/).at(-1) || view.root : "Just a chat";
  const folder = view.root ? home(view.root.replace(/[\\/]$/, "")) : "";
  const parent = folder.slice(0, folder.length - name.length);
  const model = view.model.id ? words(view.model) : "No model";
  const dots = effortDots(view.reasoning);
  const state: WhereCard["state"] = view.connection === "online" ? "" : view.connection === "connecting" ? "wait" : "off";
  const head = `<span class="wh-tile wh-${tint(name)}" aria-hidden="true">${h(name[0]!.toUpperCase())}</span>` +
    `<span class="wh-who"><span class="wh-name">${h(name)}</span><span class="wh-sub">${view.root ? `<em>${h(parent)}</em>${h(name)}` : "No project folder"}</span></span>` +
    `<span class="wh-model"><span class="wh-name">${h(model)}${dots ? `<span class="wh-eff" title="${h(view.reasoning)}">${[1, 2, 3].map((i) => `<i${i <= dots ? ' class="on"' : ""}></i>`).join("")}</span>` : ""}</span><span class="wh-sub">${h(view.model.provider ?? "")}</span></span>`;
  const note = state === "wait"
    ? `<div class="wh-note wait"><i class="wh-pulse"></i>Connecting to the daemon…</div>`
    : state === "off"
      ? `<div class="wh-note off"><i class="wh-pulse"></i>Daemon is offline<button type="button" class="card-btn" data-action="start-daemon">Start</button></div>`
      : "";
  const lines: string[] = [];
  if (view.root) lines.push(`<span class="wh-k">Branch</span><span class="wh-v">${view.branch ? `<span class="wh-chip">${h(view.branch)}</span>` : "<em>not a git checkout</em>"}</span><span class="wh-r">${view.changed ? `${view.changed} changed` : ""}</span>`);
  if (view.context) lines.push(`<span class="wh-k">Context</span><span class="wh-v">${view.context.percentage}%<span class="card-meter"><i style="width:${Math.min(100, view.context.percentage)}%"></i></span></span><span class="wh-r">${short(view.context.used)} of ${short(view.context.capacity)}</span>`);
  lines.push(`<span class="wh-k">Runs on</span><span class="wh-v">${h(runsOn(view.server))}</span><span class="wh-r">${view.connection}</span>`);
  const title = [folder, view.model.provider ? `Provider ${view.model.provider}` : "", view.server ? `Daemon ${view.server}` : ""].filter(Boolean).join("\n");
  return { summary: h([name, view.branch].filter(Boolean).join(" · ")), head, body: `${note}<div class="wh-lines">${lines.join("")}</div>`, state, title };
}
