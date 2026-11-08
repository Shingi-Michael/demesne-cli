/// Who you asked (pass 178 B): a turn's Heartbeat sends fold into one row,
/// the mail icon, the faces of the agents asked, "Asked 3 agents" and how
/// many have answered. Click it for a line per agent, with the first line of
/// its answer once that comes back as mail.

import { parseMailTurn } from "../../../packages/protocol/src/heartbeat-mail.ts";

export interface Asked { key: string; id: string; to: string; agent: string | null; name: string; project: string; state: string }
export interface Answer { text: string; performative: string }

const h = (value: unknown) =>
  String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

const NAMES: Record<string, string> = { claude: "Claude Code", codex: "Codex", gemini: "Gemini" };

interface SendTool { id: number; name: string; state: string; drafting?: boolean; input: Record<string, unknown>; message?: string }

/// A turn's sends, each with who it went to (recorded by the daemon, else read from the address).
export function askedIn(entries: readonly { type: string }[]): Asked[] {
  const asked: Asked[] = [];
  for (const entry of entries) {
    if (entry.type !== "tool") continue;
    const tool = entry as unknown as SendTool;
    if (tool.name !== "heartbeat" || tool.input.action !== "send") continue;
    let recorded: Partial<Asked> = {};
    try { recorded = tool.message ? JSON.parse(tool.message) as Partial<Asked> : {}; } catch { recorded = {}; }
    const to = typeof recorded.to === "string" ? recorded.to : String(tool.input.to ?? "");
    const parts = /^([a-zA-Z0-9_.-]+)@[a-zA-Z0-9_.-]+\/([a-zA-Z0-9_.-]+)$/.exec(to);
    const agent = typeof recorded.agent === "string" ? recorded.agent : parts && parts[1] !== "demesne" ? parts[1]! : null;
    asked.push({
      key: String(tool.id), id: typeof recorded.id === "string" ? recorded.id : "", to, agent,
      name: typeof recorded.name === "string" ? recorded.name : agent ? NAMES[agent] ?? agent : parts?.[1] === "demesne" ? "a Demesne chat" : to || "an agent",
      project: typeof recorded.project === "string" ? recorded.project : parts ? parts[2]!.replace(/-[a-z0-9]{5}$/, "") : "",
      state: tool.drafting ? "running" : tool.state,
    });
  }
  return asked;
}

/// The first answer from each address, read from the mail turns after the asking one.
export function answersAfter(runs: readonly { content: string }[], from: number, addresses: readonly string[]): Map<string, Answer> {
  const wanted = new Set(addresses), found = new Map<string, Answer>();
  for (const run of runs.slice(from + 1)) {
    const mail = parseMailTurn(run.content);
    for (const message of mail?.messages ?? []) {
      if (wanted.has(message.from) && !found.has(message.from)) found.set(message.from, { text: message.text, performative: message.performative });
    }
    if (found.size === wanted.size) break;
  }
  return found;
}

const firstLine = (text: string) => { const line = text.replace(/\s+/g, " ").trim(); return line.length > 220 ? `${line.slice(0, 219)}…` : line; };

export interface AskRowView {
  asked: Asked[]; answers: Map<string, Answer>; open: boolean; runId: string;
  /// The agent's face, or the mail icon for someone without one.
  face: (agent: string | null, mood: string) => string;
  working: (agent: string | null) => boolean;
  mail: string;
}

/// The one row, and the per-agent lines under it when open.
export function askRowHTML(view: AskRowView): string {
  const { asked, answers } = view;
  if (!asked.length) return "";
  const sending = asked.some((item) => item.state === "running");
  const failed = asked.filter((item) => item.state === "failed").length;
  const reached = asked.filter((item) => item.state !== "failed");
  const answered = reached.filter((item) => answers.has(item.to)).length;
  const who = asked.length === 1 ? `Asked ${asked[0]!.name}` : `Asked ${asked.length} ${asked.every((item) => item.agent) ? "agents" : "chats"}`;
  const projects = [...new Set(asked.map((item) => item.project).filter(Boolean))];
  const meta = sending ? "sending…"
    : failed && failed === asked.length ? `<span class="bad">not sent</span>`
    : answered === reached.length ? `<span class="ok">${reached.length === 1 ? "answered" : "all answered"}</span>`
    : `${answered ? `${answered} of ${reached.length} answered` : reached.some((item) => view.working(item.agent)) ? "working…" : "waiting for answers"}${failed ? ` · <span class="bad">${failed} not sent</span>` : ""}`;
  const busy = sending || (answered < reached.length && reached.some((item) => view.working(item.agent)));
  const faces = `<span class="ask-faces" aria-hidden="true">${asked.slice(0, 4).map((item) => `<span class="ask-face">${view.face(item.agent, answers.has(item.to) ? "calm" : "focus")}</span>`).join("")}</span>`;
  const head = `<button type="button" class="tool-row ask-row${busy ? " running" : ""}" data-action="toggle-asked" data-args="${h(JSON.stringify({ id: `${view.runId}:${asked[0]!.key}` }))}" aria-expanded="${view.open}">`
    + `${view.mail}${faces}<span class="verb">${h(who)}</span><code class="target">${h(projects.join(", "))}</code><span class="sp"></span><small class="meta">${meta}</small><span class="ask-chev" aria-hidden="true">${view.open ? "▴" : "▾"}</span></button>`;
  if (!view.open) return head;
  const lines = asked.map((item) => {
    const answer = answers.get(item.to);
    const right = item.state === "failed" ? `<span class="bad">not sent</span>`
      : answer ? `<span class="ok">${h(answer.performative === "fail" || answer.performative === "refuse" ? answer.performative === "fail" ? "couldn't finish" : "declined" : "answered")}</span>${item.agent ? ` · <a class="ask-open" data-action="agent-open" data-args="${h(JSON.stringify({ id: item.agent }))}">open chat</a>` : ""}`
      : item.state === "running" ? "sending…" : view.working(item.agent) ? "working…" : "waiting";
    return `<div class="ask-line">${view.mail}<span class="ask-face">${view.face(item.agent, answer ? "calm" : "focus")}</span><span class="ask-name">Asked ${h(item.name)}</span><code class="target">${h(item.project)}</code><span class="sp"></span><small class="meta">${right}</small></div>`
      + (answer?.text ? `<div class="ask-said"><b>${h(item.name)}:</b> ${h(firstLine(answer.text))}</div>` : "");
  }).join("");
  return `${head}<div class="ask-lines">${lines}</div>`;
}
