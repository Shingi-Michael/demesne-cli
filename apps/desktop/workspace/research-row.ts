/// Deep research, quietly (pass 182 A): one line in the turn with the faces
/// of whoever is researching, "Researching", and a page count that ticks
/// up. A face greys out when that researcher is done; the judge's part reads
/// "Putting it together". Click it for who took which question.
import type { ResearchState } from "../../../packages/protocol/src/index.ts";

const h = (value: unknown) =>
  String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

const NAMES: Record<string, string> = { claude: "Claude Code", codex: "Codex", gemini: "Gemini" };
export const researcherName = (agent: string | null) => agent ? NAMES[agent] ?? agent : "Demesne";

export interface ResearchRowView {
  research: ResearchState | undefined;
  /// The tool call's own state and input, for before the first update and after a failure.
  tool: { state: string; drafting?: boolean; input: Record<string, unknown>; durationMs?: number };
  open: boolean; key: string;
  /// A researcher's face; null is the chat's own model.
  face: (agent: string | null, mood: "focus" | "calm") => string;
  icon: string;
}

const duration = (ms: number | undefined) => {
  if (!ms || ms < 1000) return "";
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
};

/// The one line, and the lanes under it when open.
export function researchRowHTML(view: ResearchRowView): string {
  const { research, tool } = view;
  const topic = research?.topic ?? (typeof tool.input.topic === "string" ? tool.input.topic : "");
  const running = tool.drafting || tool.state === "running";
  const failed = !running && (tool.state === "failed" || tool.state === "stopped" || tool.state === "denied");
  const phase = research?.phase ?? "researching";
  const done = !running && !failed;
  const verb = failed ? "Research stopped" : done ? "Researched" : phase === "judging" || phase === "checking" ? "Putting it together" : "Researching";
  // Each researcher once, in the order they took their questions.
  const lanes = research?.lanes ?? [];
  const who = [...new Map(lanes.map((lane) => [lane.agent ?? "", lane])).values()];
  const faces = who.length ? `<span class="ask-faces" aria-hidden="true">${who.slice(0, 4).map((lane) => {
    const finished = lanes.filter((one) => (one.agent ?? "") === (lane.agent ?? "")).every((one) => one.state !== "running");
    return `<span class="ask-face${running && finished ? " rs-done" : ""}">${view.face(lane.agent, finished ? "calm" : "focus")}</span>`;
  }).join("")}</span>` : view.icon;
  const pages = research?.pages ?? 0;
  const meta = [pages ? `${pages} page${pages === 1 ? "" : "s"}` : running ? "starting…" : "", done ? duration(tool.durationMs) : ""].filter(Boolean).join(" · ");
  const head = `<button type="button" class="tool-row ask-row research-row${running ? " running" : ""}${failed ? " failed" : ""}" data-action="toggle-research" data-args="${h(JSON.stringify({ id: view.key }))}" aria-expanded="${view.open}">`
    + `${faces}<span class="verb">${h(verb)}</span><span class="rs-topic">${h(topic)}</span><span class="sp"></span><small class="meta">${h(meta)}</small><span class="ask-chev" aria-hidden="true">${view.open ? "▴" : "▾"}</span></button>`;
  if (!view.open || !lanes.length) return head;
  const lines = lanes.map((lane) => {
    const right = lane.state === "failed" ? `<span class="bad">didn't finish</span>` : lane.state === "running" ? (running ? "reading…" : "") : `${lane.pages} page${lane.pages === 1 ? "" : "s"}`;
    return `<div class="ask-line"><span class="rs-mark${lane.state === "done" ? " ok" : ""}" aria-hidden="true">${lane.state === "done" ? "✓" : lane.state === "failed" ? "✕" : "◦"}</span><span class="ask-face">${view.face(lane.agent, lane.state === "running" ? "focus" : "calm")}</span>`
      + `<span class="rs-who">${h(researcherName(lane.agent))}</span><span class="rs-q">${h(lane.question)}</span><span class="sp"></span><small class="meta">${right}</small></div>`;
  });
  const judged = research && (research.phase === "checking" || research.phase === "done") && research.agree !== undefined
    ? [`<div class="ask-line rs-judge"><span class="rs-mark" aria-hidden="true">⚖</span><span class="rs-who">Judge</span><span class="rs-q">${h([`${research.agree} claim${research.agree === 1 ? "" : "s"} agree`, research.disagree ? `${research.disagree} disagree` : "", ...research.checks.map((check) => `${check.verdict === "running" ? "checking" : check.verdict === "unclear" ? "unclear after a check" : check.verdict} by ${researcherName(check.agent)}`)].filter(Boolean).join(" · "))}</span></div>`]
    : [];
  return `${head}<div class="ask-lines research-lines">${[...lines, ...judged].join("")}</div>`;
}
