/// Pills, each in its place (pass 260 A). Every passing notice is the memory
/// pill's silver glass (pass 255), and it arrives beside what it is about, so
/// the place already says the subject:
///
///   middle  this conversation: centred on the composer, 10px above it
///   left    the app (an update, the daemon): the foot of the sidebar, as
///           wide as its rows, above the release line
///   right   the project (your files, the branch): the foot of the cards, as
///           wide as the cards, on the same line as the left seat
///   at      the button you pressed ("Copied"): centred over it
///
/// One pill per seat; a newer one takes the seat. It leaves by itself, and
/// resting on it holds it. A seat that isn't on screen (sidebar folded, no
/// cards) hands its pill to the middle.
///
/// Read more: https://lawsofux.com/law-of-proximity/ (a message sits next to
/// what it is about), https://m3.material.io/components/snackbar/overview
/// (the pattern: short, one action at most, leaves by itself) and
/// https://www.w3.org/WAI/WCAG22/Understanding/timing-adjustable.html (why
/// resting on it holds it).

export type Seat = "middle" | "left" | "right" | "at";
export type PillMark = "note" | "bang" | "tick" | "copy" | "tray" | "up" | "rule";
export interface PillSpec {
  seat: Seat;
  mark: PillMark;
  words: string;
  /// A small amber dot on the mark: something needs you.
  need?: boolean;
  /// At most one word to act on.
  action?: { label: string; run: () => void };
  seconds?: number;
  /// The button an "at" pill sits over.
  anchor?: Element | null;
}
export interface Box { left: number; top: number; width: number; height: number }
/// What is on screen to sit beside, in window pixels.
export interface Stage { width: number; height: number; composer: Box | null; main: Box | null; release: Box | null; cards: Box | null; anchor: Box | null }
export interface Place { seat: Seat; left: number; top?: number; bottom?: number; width?: number }

export const PILL_HEIGHT = 36;
const GAP = 10, SEAT_GAP = 6;
/// Past this many letters the words wrap instead of running off the pill.
const LONG = 64;

const MARKS: Record<PillMark, string> = {
  note: '<path d="M9 8.2v5"/><circle cx="9" cy="5" r="1.1"/>',
  bang: '<path d="M9 4v6"/><circle cx="9" cy="13.2" r="1.1"/>',
  tick: '<path d="M4 9.5 7.5 13 14 5.5"/>',
  copy: '<path d="M8 6h4.5a2 2 0 0 1 2 2v4.5a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z"/><path d="M11.5 4V3.5a1 1 0 0 0-1-1h-7a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1H4"/>',
  tray: '<path d="M2.5 10.5h3.5l1 2h4l1-2h3.5v3.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z"/><path d="M9 2.5v6.5M6.5 6.5 9 9l2.5-2.5"/>',
  up: '<path d="M9 3v8.5M5.5 8l3.5 3.5L12.5 8"/><path d="M4 14.5h10"/>',
  rule: '<path d="M9 2.5 14 4.5v4c0 3-2.2 5.2-5 6.5-2.8-1.3-5-3.5-5-6.5v-4z"/><path d="M6.5 8.8 8.3 10.5 11.5 7"/>',
};

const esc = (text: string) => text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/// How long a pill stays: a quick word is quick, a long one gets time to be read.
export function pillSeconds(spec: Pick<PillSpec, "words" | "seconds" | "seat" | "action">): number {
  if (spec.seconds) return spec.seconds;
  if (spec.seat === "at") return 2.5;
  return Math.min(12, (spec.action ? 6 : 4) + Math.max(0, Math.ceil((spec.words.length - 40) / 30)));
}

/// Where a pill goes. A seat with nothing to sit beside hands over to the
/// middle; the middle sits on the composer, or the foot of the page when
/// there is no composer on screen.
export function placePill(spec: Pick<PillSpec, "seat">, stage: Stage): Place {
  const seatTop = stage.release ? stage.release.top - SEAT_GAP - PILL_HEIGHT : stage.composer ? stage.composer.top + 1 : stage.height - 80;
  if (spec.seat === "at" && stage.anchor) return { seat: "at", left: stage.anchor.left + stage.anchor.width / 2, top: Math.max(4, stage.anchor.top - 32) };
  if (spec.seat === "left" && stage.release) return { seat: "left", left: stage.release.left, width: stage.release.width, top: seatTop };
  if (spec.seat === "right" && stage.cards) return { seat: "right", left: stage.cards.left, width: stage.cards.width, top: seatTop };
  if (stage.composer) return { seat: "middle", left: stage.composer.left + stage.composer.width / 2, bottom: stage.height - stage.composer.top + GAP };
  const page = stage.main ?? { left: 0, top: 0, width: stage.width, height: stage.height };
  return { seat: "middle", left: page.left + page.width / 2, bottom: stage.height - (page.top + page.height) + 24 };
}

export function pillHTML(spec: PillSpec, seconds = pillSeconds(spec)): string {
  const ring = seconds > 3 ? '<span class="mp-ring" aria-hidden="true"><svg viewBox="0 0 16 16"><circle class="mp-ring-bg" cx="8" cy="8" r="7"/><circle class="mp-ring-fg" cx="8" cy="8" r="7"/></svg></span>' : "";
  return `<div class="mp-pill">`
    + `<span class="mp-knot" aria-hidden="true"><svg viewBox="0 0 18 18">${MARKS[spec.mark]}</svg>${spec.need ? '<b class="pill-need"></b>' : ""}</span>`
    + `<span class="mp-words" title="${esc(spec.words)}">${esc(spec.words)}</span>`
    + (spec.action ? `<button type="button" class="pill-act">${esc(spec.action.label)}</button>` : "")
    + ring + `</div>`;
}

const box = (element: Element | null): Box | null => {
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height } : null;
};

/// The window as it stands, for placePill.
export function stageNow(anchor?: Element | null): Stage {
  const cards = box(document.getElementById("cards"));
  // The cards column pads its right edge; the seat is as wide as the cards themselves.
  const card = cards ? box(document.querySelector("#cards .card")) : null;
  return {
    width: window.innerWidth, height: window.innerHeight,
    composer: box(document.getElementById("composer")),
    main: box(document.getElementById("main")),
    release: box(document.querySelector(".sidebar-release")),
    cards: cards ? { ...cards, width: card?.width ?? cards.width - 14 } : null,
    anchor: box(anchor ?? null),
  };
}

interface Live { host: HTMLElement; spec: PillSpec; timer: ReturnType<typeof setInterval>; left: number; held: boolean }

/// The pills on screen, one per seat.
export class Pills {
  private readonly live = new Map<Seat, Live>();
  private layer: HTMLElement | null = null;

  constructor() {
    if (typeof window !== "undefined") window.addEventListener("resize", () => this.settle());
  }

  show(spec: PillSpec): void {
    if (typeof document === "undefined" || !spec.words.trim()) return;
    const place = placePill(spec, stageNow(spec.anchor));
    this.close(place.seat);
    const seconds = pillSeconds(spec);
    const host = document.createElement("div");
    host.className = `seat-pill ${place.seat}${spec.words.length > LONG ? " long" : ""}`;
    host.setAttribute("role", "status");
    host.style.setProperty("--mp-seconds", `${seconds}s`);
    host.innerHTML = pillHTML(spec, seconds);
    const entry: Live = { host, spec, left: seconds * 1000, held: false, timer: setInterval(() => { if (entry.held) return; entry.left -= 100; if (entry.left <= 0) this.leave(place.seat); }, 100) };
    const hold = (on: boolean) => { entry.held = on; host.classList.toggle("held", on); };
    host.addEventListener("pointerenter", () => hold(true));
    host.addEventListener("pointerleave", () => hold(false));
    host.addEventListener("focusin", () => hold(true));
    host.addEventListener("focusout", () => hold(false));
    host.addEventListener("keydown", (event) => { if (event.key === "Escape") this.leave(place.seat); });
    host.querySelector(".pill-act")?.addEventListener("click", () => { this.leave(place.seat); spec.action?.run(); });
    this.put(host, place);
    this.ground().append(host);
    this.live.set(place.seat, entry);
  }

  /// The words of the pills on screen (for checks).
  words(): string[] { return [...this.live.values()].map((entry) => entry.spec.words); }

  private ground(): HTMLElement {
    if (!this.layer?.isConnected) {
      this.layer = document.createElement("div");
      this.layer.id = "pill-layer";
      document.body.append(this.layer);
    }
    return this.layer;
  }

  private put(host: HTMLElement, place: Place): void {
    const style = host.style;
    style.left = `${place.left}px`;
    style.top = place.top == null ? "" : `${place.top}px`;
    // The memory pill has the middle seat first: a notice sits just above it.
    const taken = place.seat === "middle" && document.querySelector(".memory-pill") ? PILL_HEIGHT + 8 : 0;
    style.bottom = place.bottom == null ? "" : `${place.bottom + taken}px`;
    style.width = place.width == null ? "" : `${place.width}px`;
  }

  /// The window changed size: every pill goes back beside its thing.
  private settle(): void {
    for (const entry of this.live.values()) {
      const place = placePill(entry.spec, stageNow(entry.spec.anchor));
      this.put(entry.host, place);
    }
  }

  private leave(seat: Seat): void {
    const entry = this.live.get(seat);
    if (!entry) return;
    clearInterval(entry.timer);
    this.live.delete(seat);
    entry.host.classList.add("leaving");
    setTimeout(() => entry.host.remove(), 450);
  }

  close(seat: Seat): void {
    const entry = this.live.get(seat);
    if (!entry) return;
    clearInterval(entry.timer);
    this.live.delete(seat);
    entry.host.remove();
  }
}

/// The window's pills: the shell and the workspace share them.
export const pills = new Pills();
