import type { SessionStateResponse, TurnChange } from "@demesne/protocol";
import { waitingAsk } from "./away.ts";

/// Rest on a chat to see where it stands (pass 76 C): the sidebar row's card
/// says what the row can't. Its wait in words, its branch and folder, what
/// its last turn changed, the model and how full its context is, and the
/// last thing it said. Built from the chat's own state; nothing to click.

export interface Glance {
  /// What it waits on, in words: "approve run npm publish", or its question.
  asks: string | null;
  branch: string | null;
  folder: string | null;
  /// The last turn's edits.
  changes: { files: number; additions: number; deletions: number } | null;
  model: string | null;
  /// Percent of the context the last call used.
  context: number | null;
  /// The first sentence of its last answer.
  last: string | null;
}

const clip = (text: string, max: number) => text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;

/// The first sentence of an answer, without its Markdown.
export function firstSentence(text: string): string | null {
  const plain = text
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, "")
    .replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  if (!plain) return null;
  const end = plain.search(/[.!?](\s|$)/);
  return clip(end >= 0 ? plain.slice(0, end + 1) : plain, 140);
}

export function changeCounts(changes: readonly TurnChange[]): Glance["changes"] {
  const live = changes.filter((change) => !change.reverted);
  if (!live.length) return null;
  let additions = 0, deletions = 0;
  for (const change of live) for (const line of change.diff) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions++;
    else if (line.startsWith("-") && !line.startsWith("---")) deletions++;
  }
  return { files: live.length, additions, deletions };
}

export function glanceOf(state: SessionStateResponse, changes: readonly TurnChange[] | null): Glance {
  const ask = waitingAsk(state.pendingPermissions, state.pendingQuestions);
  const call = state.latestProviderCall, plan = call?.contextPlan;
  const answer = [...state.session.turns].reverse().find((turn) => !turn.kind && turn.responseText.trim());
  return {
    asks: !ask ? null : ask.kind === "permission" ? clip(`approve ${ask.verb}${ask.target ? ` ${ask.target}` : ""}`, 80) : ask.text,
    branch: state.session.workspace?.gitBranch ?? null,
    folder: state.session.workspace?.root ?? null,
    changes: changes ? changeCounts(changes) : null,
    model: call?.model ?? null,
    context: plan?.capacityTokens ? Math.min(100, Math.round(plan.estimatedInputTokens / plan.capacityTokens * 100)) : null,
    last: answer ? firstSentence(answer.responseText) : null,
  };
}

const esc = (value: string) => value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const home = (path: string) => path.replace(/^\/(Users|home)\/[^/]+/, "~");

/// The card. `about` is the row's state in words ("needs you", "working"…),
/// `when` its last activity; `model` maps a model id to its words.
export function glanceHTML(title: string, about: string, when: string, glance: Glance, model: (id: string) => string = (id) => id): string {
  const state = glance.asks ? `Waiting on you · ${esc(glance.asks)}` : esc(about ? `${about[0]!.toUpperCase()}${about.slice(1)}` : when);
  const rows: [string, string][] = [];
  if (glance.branch) rows.push(["Branch", esc(glance.branch)]);
  if (glance.folder) rows.push(["Folder", esc(home(glance.folder))]);
  if (glance.changes) rows.push(["Last turn", `<span class="gl-add">+${glance.changes.additions}</span> <span class="gl-del">−${glance.changes.deletions}</span> · ${glance.changes.files} file${glance.changes.files === 1 ? "" : "s"}`]);
  if (glance.model) rows.push(["Model", `${esc(model(glance.model))}${glance.context !== null ? ` · ${glance.context}% context` : ""}`]);
  return `<div class="gl-state${glance.asks || about === "needs you" ? " warn" : ""}">${state}</div><div class="gl-title">${esc(title)}</div>`
    + (rows.length ? `<dl>${rows.map(([key, value]) => `<dt>${key}</dt><dd>${value}</dd>`).join("")}</dl>` : "")
    + (glance.last ? `<div class="gl-last">Last: “${esc(glance.last)}”</div>` : "");
}
