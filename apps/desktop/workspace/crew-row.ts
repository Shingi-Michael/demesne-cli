/// Sub-agents at work (pass 183 A): a round of sub-agents is one line. The
/// faces of whoever is working (the d. for one on your own model, no light
/// bulb), "3 agents working" with a saying, and the newest step any of them
/// took. A face greys out when it's done. Click for a line each: face, task,
/// steps, and the first line of what it found; a line opens its own steps.
/// One the chat started in the background (pass 190 A) stays on the line
/// while the chat's own steps go on under it: "reported · still here" once it
/// has answered, a pink "→ asked: …" for each follow-up, Stop on hover.

const h = (value: unknown) =>
  String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

const NAMES: Record<string, string> = { claude: "Claude Code", codex: "Codex", gemini: "Gemini" };

export interface CrewMember {
  runId: string; id: number;
  /// claude, codex or gemini; null is a sub-agent on the chat's own model.
  agent: string | null;
  task: string; state: string; drafting?: boolean; steps: number; durationMs?: number;
  /// A background one: its row's tool call, how it stands, and follow-ups.
  toolCallId?: string; crew?: "working" | "reported" | "stopped"; asked?: string[];
  /// What it found (its report) or why it stopped.
  found?: string;
  /// Its own steps, when its line is open.
  fold?: string; open?: boolean;
}

export interface CrewView {
  members: CrewMember[]; key: string; open: boolean;
  /// The newest step any running member took, as words ("Read live.ts").
  newest?: string;
  /// The working saying, kept by the window's ticker.
  phrase?: { slot: number; model: string; text: string };
  face: (agent: string | null, mood: "focus" | "calm") => string;
}

const running = (member: CrewMember) => Boolean(member.drafting) || (member.state === "running" && member.crew !== "reported" && member.crew !== "stopped");
const stopped = (member: CrewMember) => ["failed", "denied", "stopped"].includes(member.state) || member.crew === "stopped";
/// Answered, and still there for a follow-up until the turn ends.
const standing = (member: CrewMember) => member.state === "running" && member.crew === "reported";
const name = (member: CrewMember) => member.agent ? NAMES[member.agent] ?? member.agent : "Agent";
const firstLine = (text: string) => { const line = text.replace(/\s+/g, " ").trim(); return line.length > 200 ? `${line.slice(0, 199)}…` : line; };
const duration = (ms: number | undefined) => {
  if (!ms || ms < 1000) return "";
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
};
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/// The one line, and a line per sub-agent under it when open.
export function crewRowHTML(view: CrewView): string {
  const { members } = view;
  if (!members.length) return "";
  const busy = members.filter(running), failed = members.filter(stopped), one = members.length === 1;
  const who = one ? name(members[0]!) : `${members.length} agents`;
  const background = members.some((member) => member.crew);
  // Done: only the ones that found something are counted as finding it.
  const finders = members.filter((member) => !stopped(member));
  const found = finders.length === 1 && !one ? name(finders[0]!) : finders.length === members.length ? who : `${finders.length} agents`;
  const verb = busy.length ? `${who} working` : failed.length === members.length ? `${who} stopped` : background && members.some(standing) ? `${found} reported` : `${found} found it`;
  // Each face once per sub-agent, greyed once that one is done.
  const faces = `<span class="ask-faces" aria-hidden="true">${members.slice(0, 4).map((member) =>
    `<span class="ask-face${busy.length && !running(member) ? " rs-done" : ""}">${view.face(member.agent, running(member) ? "focus" : "calm")}</span>`).join("")}</span>`;
  const phrase = busy.length && view.phrase ? `<span class="crew-phrase"><span class="muted"> · </span><span class="phrase" data-subagent-phrase data-slot="${view.phrase.slot}" data-model="${h(view.phrase.model)}">${h(view.phrase.text)}</span></span>` : "";
  const after = busy.length ? (view.newest ? `<span class="crew-now">${h(view.newest)}</span>` : background ? `<span class="crew-now">the chat keeps going</span>` : "")
    : `<span class="crew-now">${h([plural(members.reduce((sum, member) => sum + member.steps, 0), "step"), duration(Math.max(...members.map((member) => member.durationMs ?? 0)))].filter(Boolean).join(" · "))}</span>`;
  const meta = busy.length && !one ? `${members.length - busy.length} of ${members.length} done`
    : failed.length && failed.length < members.length ? `<span class="${failed.every((member) => member.crew === "stopped") ? "crew-stopped-n" : "bad"}">${failed.length} stopped</span>` : "";
  const head = `<button type="button" class="tool-row ask-row crew-row${busy.length ? " running" : ""}${failed.length === members.length ? " failed" : ""}" data-action="toggle-crew" data-args="${h(JSON.stringify({ id: view.key }))}" aria-expanded="${view.open}">`
    + `${faces}<span class="verb">${h(verb)}</span>${phrase}${after}<span class="sp"></span><small class="meta">${meta}</small><span class="ask-chev" aria-hidden="true">${view.open ? "▴" : "▾"}</span></button>`;
  if (!view.open) return `<div class="crew" data-crew="${h(view.key)}">${head}</div>`;
  const lines = members.map((member) => {
    const mark = running(member) ? "◦" : stopped(member) ? "✕" : "✓";
    const stop = running(member) && member.crew && member.toolCallId ? `<span class="crew-stop" role="button" tabindex="0" data-action="stop-agent" data-args="${h(JSON.stringify({ toolCallId: member.toolCallId }))}">Stop</span>` : "";
    const right = stopped(member) ? `<span class="${member.crew === "stopped" ? "crew-stopped" : "bad"}">${h(member.crew === "stopped" || member.state === "stopped" ? "stopped" : "failed")}</span>`
      : standing(member) ? "reported · still here"
      : member.steps ? plural(member.steps, "step") : running(member) ? "starting…" : "";
    const line = `<button type="button" class="ask-line crew-line" data-action="step" data-args="${h(JSON.stringify({ runId: member.runId, id: member.id }))}" aria-expanded="${Boolean(member.open)}">`
      + `<span class="rs-mark${mark === "✓" ? " ok" : ""}" aria-hidden="true">${mark}</span><span class="ask-face">${view.face(member.agent, running(member) ? "focus" : "calm")}</span>`
      + `<span class="crew-task${member.crew === "stopped" ? " struck" : ""}">${h(member.task)}</span><span class="sp"></span><small class="meta">${right}</small>${stop}</button>`;
    const quote = member.found && (!running(member) || member.asked?.length) ? `<div class="ask-said crew-said">${h(firstLine(member.found))}</div>` : "";
    const asked = (member.asked ?? []).slice(-2).map((text) => `<div class="crew-asked"><b>→ asked:</b> ${h(firstLine(text))}</div>`).join("");
    // Working on a follow-up: what it said, then what it was asked. Answered: the other way round.
    const said = member.open ? member.fold ?? "" : running(member) ? quote + asked : asked + quote;
    return line + said;
  }).join("");
  return `<div class="crew" data-crew="${h(view.key)}">${head}<div class="ask-lines crew-lines">${lines}</div></div>`;
}
