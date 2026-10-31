/// The working line under a live turn (pass 111): the working cube and a few
/// silver words saying what the model is doing, taking turns with each other.
/// Every word is true: the heading of the model's latest thought ("Checking
/// where a chat is first named"), the step running now ("Reading live.ts"),
/// steps that land faster than they can be read summed ("Reading 5 files"),
/// and while it thinks, what it has read for this thought.
///
/// Smooth by construction. The line is one element kept across the turn's
/// repaints, so streaming never rebuilds it; a phrase stays at least
/// DWELL; phrases glide with transform and opacity only; and the shimmer is
/// a bright copy of the words seen through a soft window, the window and the
/// copy moving in opposite directions on the same clock, so the words never
/// repaint while it sweeps and a new phrase slides under a sweep already going.

/// The least time a phrase stays on the line.
export const DWELL = 2400;

/// What a turn is doing, as the line reads it.
export interface WorkSignal {
  /// The model's thinking, as it streamed (summaries are "**Heading**" sections).
  thinking: string | null;
  /// The turn's steps in order: what each does to what, and when it started.
  steps: readonly { verb: string; target: string; startedAt: number; running: boolean }[];
  /// While it waits on you or writes a command, the line says only this.
  fixed?: string;
}

const DOING: Record<string, string> = { Made: "Making", Changed: "Changing", "Looked in Foundry": "Looking in Foundry", Run: "Running", Read: "Reading", Write: "Writing", Edit: "Editing", Search: "Searching", List: "Listing", Agent: "Asking an agent", Check: "Checking" };
const PLURAL: Record<string, string> = { Read: "files", Edit: "files", Write: "files", Search: "places", List: "folders", Run: "commands" };

/// The last heading in a thought: ChatGPT's summaries open each section with
/// one ("**Checking the bound**"). A thought without headings has none.
export function thoughtHeading(raw: string | null) {
  if (!raw) return null;
  const found = [...raw.matchAll(/\*\*([^*\n]{3,80})\*\*/g)].at(-1)?.[1]?.trim();
  return found ? found.replace(/[.:]$/, "") : null;
}

/// The phrases the line takes turns with, newest thought first.
export function workingPhrases(signal: WorkSignal, now: number): string[] {
  if (signal.fixed) return [signal.fixed];
  const thought = thoughtHeading(signal.thinking);
  const current = signal.steps.findLast((step) => step.running);
  let step = "";
  if (current) {
    // Steps of one kind closer together than a phrase can stay are counted, never flashed past.
    const burst = signal.steps.filter((item) => item.verb === current.verb && item.startedAt > now - DWELL).length;
    step = burst > 2 && PLURAL[current.verb] ? `${DOING[current.verb] ?? current.verb} ${burst} ${PLURAL[current.verb]}` : `${DOING[current.verb] ?? current.verb}${current.target ? ` ${current.target}` : ""}`;
  }
  const reads = current ? 0 : signal.steps.filter((item) => item.verb === "Read").length;
  const phrases = [thought, step, reads ? `${reads} file${reads > 1 ? "s" : ""} read so far` : ""].filter((item): item is string => !!item);
  return phrases.length ? phrases.map((item) => item.length > 60 ? `${item.slice(0, 59)}…` : item) : ["Thinking"];
}

export class WorkingLine {
  readonly element = document.createElement("div");
  private readonly words: HTMLElement;
  private readonly copy: HTMLElement;
  private phrases: string[] = [];
  private shown = "";
  private shownAt = -Infinity;
  private timer = 0;
  private readonly mark: HTMLElement;

  /// `cube`: the working cube's markup. It is put in only while the line
  /// shows, since the cube's frame loop runs while any cube is on the page.
  constructor(private readonly cube: () => string) {
    this.element.className = "live-activity working-line";
    this.element.hidden = true;
    this.element.setAttribute("role", "status");
    this.element.innerHTML = `<span class="wl-mark"></span><span class="wl-line"><span class="wl-words"></span><span class="wl-glint" aria-hidden="true"><span class="wl-words wl-copy"></span></span></span>`;
    this.words = this.element.querySelector(".wl-words")!;
    this.copy = this.element.querySelector(".wl-copy")!;
    this.mark = this.element.querySelector(".wl-mark")!;
  }

  /// The turn's latest: what it could say now, or null once it's done.
  /// `now` (waiting on you, writing a command) is said at once; anything
  /// else waits until the phrase on the line has had its time.
  update(phrases: string[] | null, now = false) {
    if (!phrases) { this.stop(); return; }
    this.phrases = phrases;
    if (this.element.hidden) { this.element.hidden = false; this.mark.innerHTML = this.cube(); }
    if (!this.timer) this.timer = window.setInterval(() => this.tick(), 400);
    if (!this.shown || now) this.show(phrases[0]!);
    else this.tick();
  }

  private tick() {
    if (document.hidden || !this.phrases.length || performance.now() - this.shownAt < DWELL) return;
    const at = this.phrases.indexOf(this.shown);
    this.show(this.phrases[at < 0 ? 0 : (at + 1) % this.phrases.length]!);
  }

  private show(text: string) {
    if (text === this.shown) { this.shownAt = performance.now(); return; }
    this.shown = text;
    this.shownAt = performance.now();
    const pairs = [this.words, this.copy].map((layer) => {
      const old = layer.querySelector<HTMLElement>(".wl-word:not(.out)");
      const next = document.createElement("span");
      next.className = "wl-word in";
      next.textContent = text;
      layer.append(next);
      return { old, next };
    });
    this.words.getBoundingClientRect();
    for (const { old, next } of pairs) {
      next.classList.remove("in");
      if (old) { old.classList.add("out"); window.setTimeout(() => old.remove(), 460); }
    }
  }

  stop() {
    window.clearInterval(this.timer);
    this.timer = 0;
    this.element.hidden = true;
    this.mark.replaceChildren();
    this.phrases = [];
    this.shown = "";
    this.shownAt = -Infinity;
    this.words.replaceChildren();
    this.copy.replaceChildren();
  }

  dispose() { this.stop(); this.element.remove(); }
}
