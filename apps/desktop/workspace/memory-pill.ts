/// The memory pill (passes 249 A, 254 1, 255): when a turn ends having kept
/// something in Demesne's memory, a small silver pill above the composer says
/// "Demesne will remember 3 things". A silver light runs around its edge for
/// as long as it is up; it leaves by itself after six seconds, and resting on
/// it (or opening its list) keeps it there. Clicking it lists what was kept,
/// with × to drop one line and Undo all. The chat already shows each kept line
/// as a "Remembered" step, so nothing else is left behind.
///
/// Read more: https://www.nngroup.com/articles/progressive-disclosure/ (say
/// that it remembered, show what only when asked) and
/// https://www.w3.org/WAI/WCAG22/Understanding/timing-adjustable.html (why
/// a pop-up that leaves by itself stops while you rest on it).
import type { ToolEntry } from "@demesne/workbench/entries.ts";

export type MemoryScope = "you" | "project";
export interface KeptLine { scope: MemoryScope; text: string }
/// The few facts about a turn the pill needs.
export interface PillRun { id: string; status: string; completedAt: string | null; entries: readonly { type: string }[] }

export const PILL_SECONDS = 6;
/// A turn that ended longer ago than this (an old chat opened again) gets no pill.
const FRESH_MS = 90_000;

/// What a finished turn kept in Demesne's memory, in the order it kept them.
export function keptLines(run: PillRun): KeptLine[] {
  const out: KeptLine[] = [];
  for (const entry of run.entries) {
    if (entry.type !== "tool") continue;
    const tool = entry as ToolEntry;
    if (tool.name !== "remember" || tool.state !== "done") continue;
    const scope = tool.input.learned;
    if ((scope !== "you" && scope !== "project") || tool.input.forget === true || tool.input.design === true) continue;
    const text = typeof tool.input.rule === "string" ? tool.input.rule.replace(/\s+/g, " ").trim() : "";
    if (text && !out.some((line) => line.text.toLowerCase() === text.toLowerCase())) out.push({ scope, text });
  }
  return out;
}

export const pillWords = (count: number) => count === 1 ? "Demesne will remember this" : `Demesne will remember ${count} things`;

/// Which turn's pill to show now, if any: the chat's newest turn, when it
/// finished just now, kept something, and hasn't had its pill yet. A chat seen
/// for the first time marks its finished turns as shown, so opening an old
/// chat never brings one up.
export function pillTurn(sessionId: string, runs: readonly PillRun[], seen: Map<string, Set<string>>, now: number): { run: PillRun; lines: KeptLine[] } | null {
  let shown = seen.get(sessionId);
  if (!shown) {
    shown = new Set(runs.filter((run) => run.status !== "running" && run.status !== "queued").map((run) => run.id));
    seen.set(sessionId, shown);
    return null;
  }
  const run = runs.at(-1);
  if (!run || shown.has(run.id) || run.status !== "completed") return null;
  shown.add(run.id);
  if (run.completedAt && now - Date.parse(run.completedAt) > FRESH_MS) return null;
  const lines = keptLines(run);
  return lines.length ? { run, lines } : null;
}

const esc = (text: string) => text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const KNOT = '<span class="mp-knot" aria-hidden="true"><svg viewBox="0 0 18 18"><path d="M4 12.5c0-4 2.4-7.5 5-7.5s5 3.5 5 7.5"/><path d="M6.5 13c.6-2.6 1.4-4.5 2.5-4.5s1.9 1.9 2.5 4.5"/><circle cx="9" cy="14.2" r="1.2"/></svg></span>';
const FOLDER = '<svg viewBox="0 0 20 16" aria-hidden="true"><path d="M1.5 3.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/></svg>';

export function pillHTML(lines: readonly KeptLine[]): string {
  return `<button type="button" class="mp-pill" aria-expanded="false" aria-label="${esc(pillWords(lines.length))}. Show what">${KNOT}<span class="mp-words">${esc(pillWords(lines.length))}</span>`
    + `<span class="mp-ring" aria-hidden="true"><svg viewBox="0 0 16 16"><circle class="mp-ring-bg" cx="8" cy="8" r="7"/><circle class="mp-ring-fg" cx="8" cy="8" r="7"/></svg></span></button>`;
}

export function listHTML(lines: readonly KeptLine[]): string {
  return `<div class="mp-list" role="group" aria-label="What Demesne will remember">${lines.map((line, index) => `<div class="mp-line" data-index="${index}">`
    + `<span class="mp-who${line.scope === "you" ? "" : " project"}" title="${line.scope === "you" ? "About you, every project" : "This project"}">${line.scope === "you" ? "You" : FOLDER}</span>`
    + `<span class="mp-text">${esc(line.text)}</span><button type="button" class="mp-drop" data-drop="${index}" aria-label="Don't keep this">×</button></div>`).join("")}`
    + `<div class="mp-foot"><button type="button" class="mp-undo" data-undo>${lines.length > 1 ? "Undo all" : "Undo"}</button><span>About you goes to every project</span></div></div>`;
}

/// The one pill on screen. `forget` drops a line from the memory (the daemon's Undo).
export class MemoryPill {
  private host: HTMLElement | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private left = 0;
  private held = false;
  private lines: KeptLine[] = [];
  private readonly dropped = new Set<number>();
  private sessionId = "";
  private readonly seen = new Map<string, Set<string>>();

  constructor(private readonly slot: () => HTMLElement | null, private readonly forget: (session: string, line: KeptLine) => Promise<unknown>) {}

  /// Called on every redraw with the chat on screen (null: no chat, or a page is open).
  sync(sessionId: string | null, runs: readonly PillRun[], now = Date.now()): void {
    if (this.host && sessionId !== this.sessionId) this.close();
    if (!sessionId) return;
    const next = pillTurn(sessionId, runs, this.seen, now);
    if (next) this.show(sessionId, next.lines);
  }

  private show(sessionId: string, lines: KeptLine[]): void {
    const slot = this.slot();
    if (!slot) return;
    this.close();
    this.sessionId = sessionId;
    this.lines = lines;
    this.dropped.clear();
    const host = document.createElement("div");
    host.className = "memory-pill";
    host.setAttribute("role", "status");
    host.innerHTML = pillHTML(lines);
    host.style.setProperty("--mp-seconds", `${PILL_SECONDS}s`);
    host.addEventListener("pointerenter", () => this.hold(true));
    host.addEventListener("pointerleave", () => { if (!host.querySelector(".mp-list")) this.hold(false); });
    host.addEventListener("focusin", () => this.hold(true));
    host.addEventListener("click", (event) => this.click(event));
    host.addEventListener("keydown", (event) => { if (event.key === "Escape") this.close(); });
    slot.append(host);
    this.host = host;
    this.left = PILL_SECONDS * 1000;
    this.held = false;
    this.timer = setInterval(() => {
      if (this.held) return;
      this.left -= 100;
      if (this.left <= 0) this.leave();
    }, 100);
  }

  private hold(on: boolean): void {
    this.held = on;
    this.host?.classList.toggle("held", on);
  }

  private click(event: MouseEvent): void {
    const target = event.target as HTMLElement;
    const host = this.host;
    if (!host) return;
    if (target.closest(".mp-pill")) {
      const open = host.querySelector(".mp-list");
      if (open) { open.remove(); host.querySelector(".mp-pill")?.setAttribute("aria-expanded", "false"); return; }
      host.insertAdjacentHTML("afterbegin", listHTML(this.lines));
      host.querySelector(".mp-pill")?.setAttribute("aria-expanded", "true");
      this.hold(true);
      return;
    }
    const drop = target.closest<HTMLElement>("[data-drop]");
    if (drop) {
      const line = this.lines[Number(drop.dataset.drop)];
      if (!line || this.dropped.has(Number(drop.dataset.drop))) return;
      this.dropped.add(Number(drop.dataset.drop));
      void this.forget(this.sessionId, line).catch(() => {});
      drop.closest(".mp-line")?.classList.add("gone");
      drop.remove();
      return;
    }
    if (target.closest("[data-undo]")) {
      this.lines.forEach((line, index) => { if (!this.dropped.has(index)) void this.forget(this.sessionId, line).catch(() => {}); });
      const words = host.querySelector(".mp-words");
      if (words) words.textContent = "Forgotten";
      host.querySelector(".mp-list")?.remove();
      this.held = false;
      this.left = 900;
    }
  }

  private leave(): void {
    const host = this.host;
    this.stop();
    if (!host) return;
    host.classList.add("leaving");
    setTimeout(() => host.remove(), 450);
    this.host = null;
  }

  private stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  close(): void {
    this.stop();
    this.host?.remove();
    this.host = null;
  }
}
