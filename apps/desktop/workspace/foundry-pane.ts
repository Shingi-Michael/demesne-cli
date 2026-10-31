/// The pane: one Foundry artifact open beside the conversation, the way
/// Claude shows an artifact. The window splits, the page fills the right
/// side edge to edge, and one line above it carries everything: the title
/// (it opens the page in Foundry), the version arrows, and icons for code,
/// phone width, export and ×. Copy is there only in code view, and "Make
/// this the latest" only on an older version; revising is the composer's
/// job. The pane is per chat and remembers whether it was open. A page that named
/// its motions (demesne.motion, the kit's runtime) gets one more thin line
/// under the page: play or pause, a scrubber, the motions by name, half
/// speed and Replay; the frame and the pane talk by postMessage.
import type { FoundryArtifactDetail } from "@demesne/protocol";
import { frameURL, KIND_WORD } from "./foundry-page.ts";
import { dayWord } from "./chats-page.ts";

export interface PaneState { id: string; version: number; view: "preview" | "code"; phone: boolean }

export interface PaneOptions {
  read(id: string, version?: number): Promise<FoundryArtifactDetail>;
  markdown(source: string): string;
  copy(text: string): Promise<unknown>;
  export(id: string, version: number): Promise<unknown>;
  /// Make this the latest: an older version saved again as the newest.
  restore(detail: FoundryArtifactDetail): Promise<FoundryArtifactDetail>;
  openFoundry(id: string, version: number): void;
  notice(text: string): void;
  /// The pane opened, closed or moved to another version.
  changed(): void;
  /// A document drawn in the pane assembles on its first show (assemble.ts);
  /// `previousHTML` is the version before it, for a revision.
  assembleDocument?(root: HTMLElement, previousHTML: string | null): void;
}

/** The frame's address; the first show of a version asks for the assembly. */
export const frameSource = (id: string, version: number, assemble: boolean) => `${frameURL(id, version)}${assemble ? "&assemble=1" : ""}`;

const h = (value: unknown) =>
  String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
const icon = (paths: string) => `<svg viewBox="0 0 24 24" class="ico" aria-hidden="true">${paths}</svg>`;
const button = (action: string, label: string, extra = "") => `<button type="button" data-pane="${action}"${extra}>${label}</button>`;

/// The versions just before and after the one shown, by number.
export function neighbours(versions: readonly { version: number }[], current: number) {
  const numbers = versions.map((item) => item.version).sort((a, b) => a - b);
  const at = numbers.indexOf(current);
  return { earlier: at > 0 ? numbers[at - 1] : null, later: at >= 0 && at < numbers.length - 1 ? numbers[at + 1] : null, latest: numbers.at(-1) ?? current };
}

/// The one line above the page while Foundry is still writing it: the title
/// alone, and ×.
export function paneMakingHead(title: string) {
  return `<b class="pane-title" title="${h(title)}">${h(title)}</b><span class="pane-making">making…</span><span class="sp"></span>`
    + button("close", icon('<path d="M6 6l12 12M18 6 6 18"/>'), ' aria-label="Close" title="Close (Esc)" class="pane-ico"');
}

/// The one line above the page: the title, the version and its arrows (the
/// version's note on hover), and the icons. An error takes the middle.
export function paneHead(detail: FoundryArtifactDetail | null, state: PaneState, error = "") {
  const title = detail?.title ?? (error ? "Couldn't open it" : "Loading…");
  const near = detail ? neighbours(detail.versions, state.version) : { earlier: null, later: null, latest: state.version };
  const version = detail?.versions.find((item) => item.version === state.version);
  const words = version ? [version.note || (state.version === 1 ? "first version" : ""), dayWord(version.createdAt)].filter(Boolean).join(" · ") : "";
  const arrow = (action: string, to: number | null, label: string, path: string) =>
    button(action, icon(path), ` aria-label="${label}"${to === null ? " disabled" : ` title="v${to}"`}`);
  const tool = (action: string, label: string, path: string, extra = "") => button(action, icon(path), ` aria-label="${label}" title="${label}"${extra} class="pane-ico"`);
  const code = state.view === "code";
  return (detail ? button("foundry", h(title), ` class="pane-title" title="Open in Foundry"`) : `<b class="pane-title">${h(title)}</b>`)
    + `<span class="pane-vers">${arrow("earlier", near.earlier, "Earlier version", '<path d="m15 6-6 6 6 6"/>')}<span class="pane-v"${words ? ` title="${h(words)}"` : ""}>v${state.version}</span>${arrow("later", near.later, "Later version", '<path d="m9 6 6 6-6 6"/>')}</span>`
    + (error ? `<span class="bad" role="alert" title="${h(error)}">${h(error)}</span>` : "")
    + `<span class="sp"></span>`
    + (detail && state.version !== near.latest ? button("restore", "Make this the latest", ' class="pane-word"') : "")
    + (detail && code ? tool("copy", "Copy the source", '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a1 1 0 0 1 1-1h9"/>') : "")
    + (detail ? tool("code", "Code", '<path d="m8 8-4 4 4 4M16 8l4 4-4 4"/>', ` aria-pressed="${code}"`) : "")
    + (detail?.kind === "html" ? tool("phone", "Phone width", '<rect x="7" y="3" width="10" height="18" rx="2"/><path d="M11 18h2"/>', ` aria-pressed="${state.phone}"`) : "")
    + (detail ? tool("export", "Export the file", '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>') : "")
    + button("close", icon('<path d="M6 6l12 12M18 6 6 18"/>'), ' aria-label="Close" title="Close (Esc)" class="pane-ico"');
}

/// A motion the page named with demesne.motion(name, timeline) (the kit's
/// runtime), and where it is.
export interface PaneMotion { name: string; duration: number }
export interface MotionState { name: string; duration: number; currentTime: number; progress: number; paused: boolean }

/// What the frame's runtime posts: its motions, or one motion's progress.
/// Anything else from the frame is ignored.
export function motionMessage(data: unknown): { motions: PaneMotion[]; current: string | null } | { state: MotionState } | null {
  if (!data || typeof data !== "object") return null;
  const message = data as Record<string, unknown>;
  const name = (value: unknown) => typeof value === "string" && value.length > 0 && value.length <= 60;
  const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0;
  if (message.demesne === "motions" && Array.isArray(message.motions)) {
    const motions = message.motions.filter((item): item is PaneMotion => !!item && typeof item === "object" && name((item as PaneMotion).name) && number((item as PaneMotion).duration))
      .map((item) => ({ name: item.name, duration: item.duration })).slice(0, 12);
    return { motions, current: name(message.current) ? message.current as string : null };
  }
  if (message.demesne === "motion" && message.state && typeof message.state === "object") {
    const state = message.state as Record<string, unknown>;
    if (!name(state.name) || !number(state.duration) || !number(state.currentTime) || !number(state.progress)) return null;
    return { state: { name: state.name as string, duration: state.duration as number, currentTime: state.currentTime as number, progress: Math.min(1, state.progress as number), paused: state.paused === true } };
  }
  return null;
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(2)}s`;

/// The thin line under a page that named its motions: play or pause, the
/// scrubber, where it is, the motions by name, half speed and Replay.
export function motionLine(motions: readonly PaneMotion[], state: MotionState | null, current: string | null, slow: boolean) {
  if (!motions.length) return "";
  const shown = state ?? { name: current ?? motions[0]!.name, duration: motions.find((item) => item.name === current)?.duration ?? motions[0]!.duration, currentTime: 0, progress: 0, paused: true };
  return button("mo-play", icon(shown.paused ? '<path d="M8 5v14l11-7z"/>' : '<path d="M7 5h4v14H7zM13 5h4v14h-4z"/>'), ` class="mo-play" aria-label="${shown.paused ? "Play" : "Pause"}" title="${shown.paused ? "Play" : "Pause"}"`)
    + `<input type="range" class="mo-scrub" data-pane="mo-seek" min="0" max="1000" value="${Math.round(shown.progress * 1000)}" aria-label="Scrub ${h(shown.name)}">`
    + `<span class="mo-time">${seconds(shown.currentTime)} / ${seconds(shown.duration)}</span>`
    + `<span class="mo-names" role="group" aria-label="Motions">${motions.map((item) => button("mo-pick", h(item.name), ` data-name="${h(item.name)}" aria-pressed="${item.name === shown.name}"`)).join("")}</span>`
    + button("mo-speed", "½×", ` aria-pressed="${slow}" title="Half speed"`)
    + button("mo-replay", "Replay", ' title="Play it again from the start"');
}

export class FoundryPane {
  state: PaneState | null = null;
  detail: FoundryArtifactDetail | null = null;
  error = "";
  private session = "";
  private frameKey = "";
  private loading = 0;
  /// The version whose first show assembles the page, until its frame is made.
  private assembleKey = "";
  /// A document's last rendered HTML, so a revision can settle only what changed.
  private lastDocument: { id: string; html: string } | null = null;
  /// What Foundry is writing right now, shown while the pane has nothing open.
  private makingTitle: string | null = null;
  /// Artifacts this chat has shown chips for; a new one opens the pane,
  /// the way Claude opens an artifact as it is made. History never does.
  private readonly seen = new Set<string>();
  private primed = false;
  /// The motions the open page named, the last one that moved, and whether
  /// the line runs them at half speed.
  private motions: PaneMotion[] = [];
  private motionState: MotionState | null = null;
  private motionCurrent: string | null = null;
  private slow = false;
  private readonly head: HTMLElement;
  private readonly stage: HTMLElement;
  private readonly code: HTMLPreElement;
  private readonly motion: HTMLElement;

  constructor(readonly root: HTMLElement, private readonly options: PaneOptions) {
    root.innerHTML = '<div class="pane-head"></div><div class="pane-body"><div class="pane-stage"></div><pre class="pane-code" tabindex="0" aria-label="Source" hidden></pre></div><div class="pane-motion" hidden></div>';
    this.head = root.querySelector(".pane-head")!;
    this.stage = root.querySelector(".pane-stage")!;
    this.code = root.querySelector(".pane-code")!;
    this.motion = root.querySelector(".pane-motion")!;
    root.addEventListener("click", (event) => {
      const target = (event.target as HTMLElement).closest<HTMLElement>("[data-pane]");
      if (target && !(target as HTMLButtonElement).disabled && target.dataset.pane !== "mo-seek") void this.act(target.dataset.pane!, target.dataset.name);
    });
    // The scrubber: dragging it moves the page's motion to that point and holds it there.
    root.addEventListener("input", (event) => {
      const target = event.target as HTMLInputElement;
      if (target.dataset.pane === "mo-seek") this.tell({ action: "seek", value: Number(target.value) / 1000 });
    });
    // The page's runtime reports its motions and their progress; only the open frame is heard.
    window.addEventListener("message", (event) => {
      const frame = this.stage.querySelector<HTMLIFrameElement>("iframe.pane-frame");
      if (!frame || event.source !== frame.contentWindow) return;
      const message = motionMessage(event.data);
      if (!message) return;
      if ("motions" in message) { this.motions = message.motions; this.motionCurrent = message.current ?? this.motionCurrent; if (this.motionState && !this.motions.some((item) => item.name === this.motionState!.name)) this.motionState = null; }
      else { this.motionState = message.state; this.motionCurrent = message.state.name; }
      this.renderMotion();
    });
    // Esc closes the pane, unless something that handles its own Esc has focus.
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || !this.state || event.defaultPrevented || event.isComposing) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target && (target.matches("input, textarea, select, [contenteditable]") || target.closest("#overlay, .popover, [role=dialog]"))) return;
      event.preventDefault();
      this.close();
    });
  }

  get open() { return this.state !== null || this.makingTitle !== null; }
  isOpen(id: string, version?: number) { return !!this.state && this.state.id === id && (version === undefined || this.state.version === version); }

  /// Foundry is writing a page: the pane opens on its title while the words
  /// arrive, so the page can assemble in front of you when they're done. With
  /// nothing being written, a pane that was only waiting closes again. A pane
  /// already showing an artifact keeps it.
  making(title: string | null) {
    if (this.state) { this.makingTitle = null; return; }
    if (title === this.makingTitle) return;
    this.makingTitle = title;
    this.render();
    this.options.changed();
  }

  /// Each chat keeps its own pane; switching chats puts the other one back.
  switchSession(id: string) {
    if (id === this.session) return;
    this.session = id;
    this.state = null; this.detail = null; this.error = ""; this.frameKey = ""; this.assembleKey = ""; this.lastDocument = null; this.makingTitle = null;
    this.seen.clear(); this.primed = false;
    let saved: PaneState | null = null;
    try { saved = id ? JSON.parse(localStorage.getItem(`demesne-pane:${id}`) ?? "null") : null; } catch {}
    if (saved && typeof saved.id === "string" && Number.isSafeInteger(saved.version)) void this.show(saved.id, saved.version, saved);
    else this.render();
  }

  /// `assemble`: this is the version's first show, so the page puts itself together.
  async show(id: string, version?: number, keep?: Partial<PaneState>, assemble = false) {
    const same = this.state?.id === id;
    this.state = { id, version: version ?? this.state?.version ?? 0, view: keep?.view ?? (same ? this.state!.view : "preview"), phone: keep?.phone ?? (same ? this.state!.phone : false) };
    if (!same) { this.detail = null; this.error = ""; }
    this.makingTitle = null;
    if (assemble && version !== undefined) this.assembleKey = `${id}:${version}`;
    this.render();
    const turn = ++this.loading;
    try {
      const found = await this.options.read(id, version);
      if (turn !== this.loading || this.state?.id !== id) return;
      this.detail = found;
      this.state.version = found.version;
      this.error = "";
    } catch (reason) {
      if (turn !== this.loading) return;
      this.error = reason instanceof Error ? reason.message : String(reason);
    }
    this.remember();
    this.render();
    this.options.changed();
  }

  close() {
    if (!this.state && this.makingTitle === null) return;
    this.state = null; this.detail = null; this.error = ""; this.frameKey = ""; this.assembleKey = ""; this.makingTitle = null;
    this.remember();
    this.render();
    this.options.changed();
  }

  /// Something new made in this chat opens the pane on it; a newer version of
  /// the open artifact moves the pane onto it, as long as it was on the latest.
  refresh(artifacts: readonly { id: string; version: number }[]) {
    const fresh = artifacts.filter((item) => this.primed && !this.seen.has(`${item.id}:${item.version}`));
    for (const item of artifacts) this.seen.add(`${item.id}:${item.version}`);
    this.primed = true;
    const open = this.state, made = fresh.at(-1);
    if (!open) { if (made) void this.show(made.id, made.version, undefined, true); return; }
    if (!this.detail) return;
    const latest = neighbours(this.detail.versions, open.version).latest;
    const newer = artifacts.find((item) => item.id === open.id && item.version > latest);
    if (newer && open.version === latest) void this.show(open.id, newer.version, undefined, true);
    else if (made && made.id !== open.id) void this.show(made.id, made.version, undefined, true);
  }

  /// The pane after a delete elsewhere: gone with the artifact.
  forget(id: string) { if (this.state?.id === id) this.close(); }

  private remember() {
    if (!this.session) return;
    try {
      if (this.state) localStorage.setItem(`demesne-pane:${this.session}`, JSON.stringify(this.state));
      else localStorage.removeItem(`demesne-pane:${this.session}`);
    } catch {}
  }

  /// A word to the page's runtime: play, pause, seek, speed or restart.
  private tell(message: { action: string; name?: string; value?: number }) {
    const frame = this.stage.querySelector<HTMLIFrameElement>("iframe.pane-frame");
    frame?.contentWindow?.postMessage({ demesne: "motion", name: this.motionCurrent ?? undefined, ...message }, "*");
  }

  private async act(action: string, name?: string) {
    const state = this.state, detail = this.detail;
    if (!state) return;
    if (action === "close") return this.close();
    if (action === "mo-play") return this.tell({ action: this.motionState && !this.motionState.paused ? "pause" : "play" });
    if (action === "mo-replay") return this.tell({ action: "restart" });
    if (action === "mo-pick" && name) { this.motionCurrent = name; return this.tell({ action: "restart", name }); }
    if (action === "mo-speed") { this.slow = !this.slow; this.renderMotion(); return this.tell({ action: "speed", value: this.slow ? 0.5 : 1 }); }
    if (action === "code") { state.view = state.view === "code" ? "preview" : "code"; this.remember(); return this.render(); }
    if (action === "phone") { state.phone = !state.phone; this.remember(); return this.render(); }
    if (!detail) return;
    const near = neighbours(detail.versions, state.version);
    if (action === "earlier" && near.earlier !== null) return this.show(state.id, near.earlier);
    if (action === "later" && near.later !== null) return this.show(state.id, near.later);
    try {
      if (action === "copy") { await this.options.copy(detail.source); this.options.notice("Copied the source"); }
      else if (action === "export") await this.options.export(state.id, state.version);
      else if (action === "foundry") this.options.openFoundry(state.id, state.version);
      else if (action === "restore") { const saved = await this.options.restore(detail); await this.show(saved.id, saved.version); }
    } catch (reason) {
      this.error = reason instanceof Error ? reason.message : String(reason);
      this.render();
    }
  }

  /// The motion line as last built, with its time and scrubber at zero.
  private motionShape = "";
  private renderMotion() {
    const line = this.state && this.state.view === "preview" ? motionLine(this.motions, this.motionState, this.motionCurrent, this.slow) : "";
    // The scrubber is redrawn only when it isn't being held, so a drag isn't fought.
    const held = this.motion.querySelector<HTMLInputElement>(".mo-scrub:active");
    if (held && line) { const time = this.motion.querySelector(".mo-time"); if (time && this.motionState) time.textContent = `${seconds(this.motionState.currentTime)} / ${seconds(this.motionState.duration)}`; return; }
    this.motion.hidden = !line;
    // A tick only moves the scrubber and the time: the buttons are rebuilt
    // only when what they say changes, so a click that lands mid-motion
    // isn't lost to a button replaced between press and release.
    const state = this.motionState;
    const shape = state ? motionLine(this.motions, { ...state, currentTime: 0, progress: 0 }, this.motionCurrent, this.slow) : line;
    if (line && shape === this.motionShape && state) {
      const scrub = this.motion.querySelector<HTMLInputElement>(".mo-scrub"), time = this.motion.querySelector(".mo-time");
      if (scrub) scrub.value = String(Math.round(state.progress * 1000));
      if (time) time.textContent = `${seconds(state.currentTime)} / ${seconds(state.duration)}`;
      return;
    }
    this.motionShape = line ? shape : "";
    if (this.motion.innerHTML !== line) this.motion.innerHTML = line;
  }

  /// A new page in the frame starts with no motions; its runtime announces them.
  private forgetMotions() { this.motions = []; this.motionState = null; this.motionCurrent = null; this.renderMotion(); }

  private render() {
    const state = this.state, detail = this.detail;
    this.root.hidden = !state && this.makingTitle === null;
    if (!state) {
      this.stage.replaceChildren(); this.frameKey = ""; this.forgetMotions();
      if (this.makingTitle !== null) {
        this.head.innerHTML = paneMakingHead(this.makingTitle);
        this.code.hidden = true; this.stage.hidden = false; this.stage.className = "pane-stage";
      }
      return;
    }
    this.head.innerHTML = paneHead(detail, state, this.error);
    const code = state.view === "code";
    this.code.hidden = !code;
    this.stage.hidden = code;
    this.stage.className = `pane-stage${detail?.kind === "svg" ? " graphic" : ""}${detail?.kind === "html" && state.phone ? " phone" : ""}`;
    if (code) this.code.textContent = detail?.source ?? "";
    this.renderMotion();
    if (!detail) { this.stage.replaceChildren(); this.frameKey = ""; this.forgetMotions(); return; }
    const key = `${detail.kind}:${detail.id}:${state.version}`;
    if (key === this.frameKey) return;
    this.frameKey = key;
    this.forgetMotions();
    const assemble = this.assembleKey === `${detail.id}:${state.version}`;
    this.assembleKey = "";
    if (detail.kind === "markdown") {
      const article = document.createElement("article");
      article.className = "pane-doc markdown";
      article.innerHTML = this.options.markdown(detail.source);
      this.stage.replaceChildren(article);
      const previous = this.lastDocument?.id === detail.id ? this.lastDocument.html : null;
      this.lastDocument = { id: detail.id, html: article.innerHTML };
      if (assemble) this.options.assembleDocument?.(article, previous);
      return;
    }
    // The frame is made once per version: remaking it would reset the page.
    const frame = document.createElement("iframe");
    frame.className = "pane-frame";
    frame.src = frameSource(detail.id, state.version, assemble);
    frame.title = `${detail.title} ${KIND_WORD[detail.kind].toLowerCase()}`;
    frame.setAttribute("sandbox", "allow-scripts allow-forms allow-modals");
    frame.referrerPolicy = "no-referrer";
    this.stage.replaceChildren(frame);
  }
}
