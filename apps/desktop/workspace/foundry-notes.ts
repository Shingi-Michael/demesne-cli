/// Notes on a mockup (pass 233 A). On Foundry's long page, resting the
/// pointer on a part of a mockup outlines it and shows a small tag with its
/// name. The tag opens a one-line note. Enter keeps the note as a numbered
/// pin on the part; the send key sends every waiting note as one message to
/// the chat that made the mockup, so one new version holds every correction.
///
/// The mockup's own frame only says which part is under the pointer and
/// where the noted parts are (foundry-kit/note.js). Everything drawn here
/// sits outside the frame, in the page, at real size: nothing is added to
/// the mockup, and at rest the page shows nothing new.

import { fenced } from "./pastes.ts";

export interface NoteRect { x: number; y: number; w: number; h: number }
/// What the frame says about a part: what it is and where it is in the markup.
export interface NotePart { tag: string; role: string; type: string; cls: string; label: string; text: string; heading: string; kids: number; selector: string; html: string }
/// `picture` is the part as the person saw it: a PNG in base64, cropped from the window.
/// `picturing` ends when the picture has been taken (or could not be).
export interface FoundryNote { part: NotePart; name: string; text: string; option?: { index: number; name: string }; picture?: string; picturing?: Promise<void> }
/// A note being typed when the page was redrawn, so it comes back.
export interface NoteDraft { key: string; part: NotePart; name: string; text: string; index: number; option?: { index: number; name: string }; picture?: Promise<string | null> }
/// Notes by mockup version ("id:version"): waiting to be sent, being worked on, and a quiet word when sending failed.
export interface NoteStore { waiting: Map<string, FoundryNote[]>; working: Map<string, number>; said: Map<string, string>; draft: NoteDraft | null }
export const newNoteStore = (): NoteStore => ({ waiting: new Map(), working: new Map(), said: new Map(), draft: null });

const h = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
const cut = (text: string, most: number) => { const clean = text.replace(/\s+/g, " ").trim(); return clean.length > most ? `${clean.slice(0, most - 1).trimEnd()}…` : clean; };

const TAGS: Record<string, string> = { button: "button", a: "link", textarea: "field", select: "menu", img: "image", svg: "icon", canvas: "chart", label: "label", form: "form", nav: "bar", header: "bar", footer: "footer",
  table: "table", ul: "list", ol: "list", tr: "row", li: "row", p: "text", span: "text", summary: "button", h1: "heading", h2: "heading", h3: "heading", h4: "heading", h5: "heading", h6: "heading",
  "d-row": "row", "d-card": "card", "d-stat": "card", "d-toggle": "switch", "d-seg": "choice", "d-tabs": "tabs", "d-chart": "chart", "d-avatar": "avatar", "d-message": "message", "d-composer": "composer", "d-icon": "icon", "d-mark": "mark" };
const ROLES: Record<string, string> = { button: "button", tab: "tab", switch: "switch", checkbox: "tick box", radio: "option", menuitem: "item", option: "option", link: "link", tablist: "tabs", toolbar: "bar", navigation: "bar" };
const CLASSES: [RegExp, string][] = [[/(^|[-_ ])tabs?([-_ ]|$)/i, "tabs"], [/(^|[-_ ])(tool)?bar([-_ ]|$)|(^|[-_ ])(nav|header|topbar|toolbar)([-_ ]|$)/i, "bar"], [/(^|[-_ ])(card|stat|tile|panel)s?([-_ ]|$)/i, "card"],
  [/(^|[-_ ])(row|item)([-_ ]|$)/i, "row"], [/(^|[-_ ])(list|table|rows)([-_ ]|$)/i, "list"], [/(^|[-_ ])(btn|button)([-_ ]|$)/i, "button"], [/(^|[-_ ])(chip|pill|badge|tag)([-_ ]|$)/i, "chip"]];
/// Pieces that hold several things: named by what they are, never by all the words inside.
const HOLDS = new Set(["tabs", "bar", "list", "table", "form", "footer"]);

/// What kind of piece a part is, in a word a person would use.
export function partWord(part: Pick<NotePart, "tag" | "role" | "type" | "cls">): string {
  if (ROLES[part.role]) return ROLES[part.role]!;
  if (part.tag === "input") return ({ checkbox: "tick box", radio: "option", range: "slider", button: "button", submit: "button", reset: "button" } as Record<string, string>)[part.type] ?? "field";
  if (TAGS[part.tag]) return TAGS[part.tag]!;
  for (const [test, word] of CLASSES) if (test.test(part.cls)) return word;
  return "part";
}
/// The tag's name for a part: its own short words, then what it is
/// ("Save button", "Overdue card", "Tabs").
export function partName(part: NotePart): string {
  const word = partWord(part);
  const capital = `${word[0]!.toUpperCase()}${word.slice(1)}`;
  const holds = HOLDS.has(word) || (part.kids >= 2 && word !== "button" && word !== "link" && word !== "tab");
  const said = cut(part.label || (holds ? part.heading : part.text) || "", 24);
  if (!said) return capital;
  if (word === "text") return `“${said}”`;
  if (word === "part") return said;
  // "Tabs tabs" says nothing.
  return said.toLowerCase() === word ? capital : `${said} ${word}`;
}
const where = (note: FoundryNote) => note.option ? `${note.name} in ${note.option.name}` : note.name;

/// The notes as one message. Its first lines are what the person said, part
/// by part; the folded block under them is for the model: which mockup, and
/// each part's place and markup, so it changes those parts and nothing else.
export function notesMessage(mockup: { id: string; title: string; version: number }, notes: readonly FoundryNote[], pictured: readonly number[] = []): string {
  if (!notes.length) return "";
  const said = notes.map((note, index) => `${index + 1} · ${where(note)}: ${note.text}`).join("\n");
  const many = notes.length > 1;
  const detail = [`Notes on ${many ? "parts" : "one part"} of the Foundry mockup "${mockup.title}" (id ${mockup.id}, v${mockup.version}). Change only ${many ? "these parts, each" : "this part,"} as its note says, and leave everything else exactly as it is: foundry_read it, then one foundry_edit.${pictured.length ? ` The attached picture${pictured.length > 1 ? "s show parts" : " shows part"} ${pictured.map((index) => index + 1).join(", ")} as the person saw ${pictured.length > 1 ? "them" : "it"}, in that order.` : ""}`,
    ...notes.map((note, index) => `${index + 1}. ${where(note)}: ${note.text}\n   selector \`${note.part.selector}\`\n   ${note.part.html}`)].join("\n");
  return `On “${mockup.title}”:\n${said}\n\n${fenced(detail, "parts")}`;
}

const count = (n: number) => `${n} note${n === 1 ? "" : "s"}`;
const MAC = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);
export const SEND_KEY = MAC ? "⌘↵" : "Ctrl ↵";
const BUBBLE = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M1.5 2.5h9v6h-5l-2.5 2v-2h-1.5z"/></svg>';

/// The quiet line under a mockup: how many notes wait and the key that sends
/// them, or that they are being worked on. Empty when there is nothing to say.
export function notesLine(waiting: number, working: number, said = ""): string {
  const send = waiting ? `<button type="button" class="fd-notes-send" data-notes-send>${count(waiting)} waiting · send <kbd>${SEND_KEY}</kbd></button>` : "";
  if (working) return `<i class="fd-notes-work" aria-hidden="true"></i><span>Working on ${count(working)}…</span>${send}`;
  return send || (said ? `<span class="fd-quiet">${h(said)}</span>` : "");
}

const text = (value: unknown, most: number) => typeof value === "string" ? value.slice(0, most) : "";
const rectOf = (value: unknown): NoteRect | null => {
  const r = value as Partial<NoteRect> | null;
  return r && [r.x, r.y, r.w, r.h].every((n) => typeof n === "number" && Number.isFinite(n)) ? { x: r.x!, y: r.y!, w: r.w!, h: r.h! } : null;
};
/// A part as the frame described it. The frame holds a page the model wrote, so nothing in it is taken on trust.
export function readPart(value: unknown): (NotePart & { rect: NoteRect }) | null {
  const part = value as Record<string, unknown> | null, rect = rectOf(part?.rect);
  if (!part || typeof part !== "object" || !rect || typeof part.selector !== "string" || !part.selector) return null;
  return { tag: text(part.tag, 40).toLowerCase(), role: text(part.role, 40), type: text(part.type, 40), cls: text(part.cls, 120), label: text(part.label, 80), text: text(part.text, 120), heading: text(part.heading, 60),
    kids: typeof part.kids === "number" && part.kids > 0 ? Math.min(999, Math.floor(part.kids)) : 0, selector: text(part.selector, 400), html: text(part.html, 700), rect };
}

interface Seen { vw: number; vh: number; part: (NotePart & { rect: NoteRect }) | null; pins: Map<number, NoteRect> }
interface Open { section: HTMLElement; stage: HTMLElement; part: NotePart; name: string; index: number; rect: NoteRect; form: HTMLFormElement; picture?: Promise<string | null> }
/// A place in the window, in its own pixels.
export interface ShotRect { x: number; y: number; width: number; height: number }
/// REST: how long the pointer stays on a part before anything is drawn. AWAY: how long the tag waits for the pointer to reach it.
const DRAFT = -1, AWAY = 220, REST = 130;
const frames = (count: number) => new Promise<void>((done) => { const next = (left: number) => left ? requestAnimationFrame(() => next(left - 1)) : done(); next(count); });

export function watchFoundryNotes(root: HTMLElement, store: NoteStore, send: (key: string) => void, shot?: (rect: ShotRect) => Promise<string | null>): { stop(): void; paint(): void } {
  const seen = new WeakMap<HTMLElement, Seen>();
  let hover: { section: HTMLElement; stage: HTMLElement; part: NotePart & { rect: NoteRect } } | null = null, open: Open | null = null, away = 0;
  let resting: { stage: HTMLElement; selector: string; timer: number } | null = null;
  const unrest = () => { if (resting) { clearTimeout(resting.timer); resting = null; } };
  const sections = () => [...root.querySelectorAll<HTMLElement>(".fd-item")].filter((section) => section.querySelector(":scope > .fd-notes"));
  const keyOf = (section: HTMLElement) => section.dataset.fd ?? "";
  const stagesOf = (section: HTMLElement) => [...section.querySelectorAll<HTMLElement>(".fd-stage")];
  const frameOf = (stage: HTMLElement) => stage.querySelector<HTMLIFrameElement>("iframe.fd-frame");
  const sectionOf = (stage: HTMLElement) => { const section = stage.closest<HTMLElement>(".fd-item"); return section?.querySelector(":scope > .fd-notes") ? section : null; };
  /// A mockup with options has a stage per option, each named on the line above it.
  const optionOf = (stage: HTMLElement) => {
    if (stage.dataset.split === undefined) return undefined;
    const head = stage.previousElementSibling;
    return { index: Number(stage.dataset.split) || 0, name: cut(head?.classList.contains("fd-opt") ? head.querySelector("b")?.textContent ?? "" : "", 60) || `option ${(Number(stage.dataset.split) || 0) + 1}` };
  };
  const onStage = (stage: HTMLElement, option: { index: number } | undefined) => (option?.index ?? -1) === (stage.dataset.split === undefined ? -1 : Number(stage.dataset.split) || 0);
  const layerOf = (section: HTMLElement) => {
    let layer = section.querySelector<HTMLElement>(":scope > .fn-layer");
    if (!layer) {
      layer = document.createElement("div");
      layer.className = "fn-layer";
      layer.innerHTML = '<div class="fn-out" hidden></div><button type="button" class="fn-tag" hidden></button>';
      section.append(layer);
    }
    return layer;
  };
  /// A place in the frame as a place in the section: the frame is drawn smaller than real size when it has to fit.
  function place(stage: HTMLElement, rect: NoteRect) {
    const frame = frameOf(stage), section = sectionOf(stage), at = seen.get(stage);
    if (!frame || !section || !at) return null;
    const left = Math.max(rect.x, 0), top = Math.max(rect.y, 0), right = Math.min(rect.x + rect.w, at.vw), bottom = Math.min(rect.y + rect.h, at.vh);
    if (right - left < 2 || bottom - top < 2) return null;
    const f = frame.getBoundingClientRect(), s = section.getBoundingClientRect(), k = at.vw > 0 ? f.width / at.vw : 1;
    return { left: f.left - s.left + left * k, top: f.top - s.top + top * k, width: (right - left) * k, height: (bottom - top) * k };
  }
  const put = (el: HTMLElement, box: { left: number; top: number; width?: number; height?: number }) => {
    el.style.left = `${Math.round(box.left)}px`; el.style.top = `${Math.round(box.top)}px`;
    if (box.width !== undefined) el.style.width = `${Math.round(box.width)}px`;
    if (box.height !== undefined) el.style.height = `${Math.round(box.height)}px`;
  };

  function hideHover() {
    clearTimeout(away);
    if (!hover) return;
    const layer = layerOf(hover.section);
    layer.querySelector<HTMLElement>(".fn-out")!.hidden = true;
    layer.querySelector<HTMLElement>(".fn-tag")!.hidden = true;
    hover = null;
  }
  function showHover(stage: HTMLElement, part: NotePart & { rect: NoteRect }) {
    const section = sectionOf(stage), box = place(stage, part.rect);
    if (!section || !box) return hideHover();
    if (hover && hover.section !== section) hideHover();
    clearTimeout(away);
    const layer = layerOf(section), out = layer.querySelector<HTMLElement>(".fn-out")!, tag = layer.querySelector<HTMLElement>(".fn-tag")!;
    put(out, { left: box.left - 3, top: box.top - 3, width: box.width + 6, height: box.height + 6 });
    tag.innerHTML = `${BUBBLE}<span>${h(partName(part))} · Comment</span>`;
    out.hidden = tag.hidden = false;
    // Above the part; inside its top edge when there is no room above.
    put(tag, { left: Math.max(0, Math.min(box.left - 3, section.clientWidth - tag.offsetWidth)), top: box.top - 3 - tag.offsetHeight - 2 < 0 ? box.top + 3 : box.top - 3 - tag.offsetHeight - 2 });
    hover = { section, stage, part };
  }
  const leaveSoon = () => { clearTimeout(away); away = window.setTimeout(() => { if (!open && !root.querySelector(".fn-tag:hover")) hideHover(); }, AWAY); };

  /// The numbered pins of a mockup's waiting notes, each on its part.
  function placePins(section: HTMLElement) {
    // Nothing is added to a mockup that has no notes and no pointer on it.
    const notes = store.waiting.get(keyOf(section)) ?? [], layer = notes.length ? layerOf(section) : section.querySelector<HTMLElement>(":scope > .fn-layer");
    if (!layer) return;
    layer.querySelectorAll(".fn-pin").forEach((pin) => pin.remove());
    for (const stage of stagesOf(section)) {
      const at = seen.get(stage);
      if (!at) continue;
      notes.forEach((note, index) => {
        const rect = onStage(stage, note.option) ? at.pins.get(index) : undefined, box = rect ? place(stage, rect) : null;
        if (!box) return;
        const pin = document.createElement("button");
        pin.type = "button"; pin.className = "fn-pin"; pin.dataset.n = String(index); pin.textContent = String(index + 1);
        pin.title = note.text; pin.setAttribute("aria-label", `Note ${index + 1} on ${note.name}: ${note.text}`);
        put(pin, { left: box.left + box.width - 7, top: box.top - 12 });
        layer.append(pin);
      });
    }
  }
  /// Tell a stage's frame which parts carry notes, so it says where they are as the page moves.
  function watch(stage: HTMLElement) {
    const section = sectionOf(stage);
    if (!section) return;
    const key = keyOf(section), notes = store.waiting.get(key) ?? [];
    const pins = notes.map((note, index) => ({ n: index, selector: note.part.selector, option: note.option })).filter((pin) => onStage(stage, pin.option)).map(({ n, selector }) => ({ n, selector }));
    // The note being written (or one that waits to come back after a redraw) is followed too.
    const draft = store.draft;
    if (open && open.stage === stage && open.index < 0) pins.push({ n: DRAFT, selector: open.part.selector });
    else if (draft && draft.key === key && onStage(stage, draft.option)) pins.push({ n: DRAFT, selector: draft.part.selector });
    try { frameOf(stage)?.contentWindow?.postMessage({ demesne: "note", action: "watch", pins }, "*"); } catch { /* the frame is gone */ }
  }
  function paintSection(section: HTMLElement) {
    const key = keyOf(section), line = section.querySelector<HTMLElement>(":scope > .fd-notes");
    if (line) { const html = notesLine(store.waiting.get(key)?.length ?? 0, store.working.get(key) ?? 0, store.said.get(key)); if (line.innerHTML !== html) line.innerHTML = html; line.hidden = !html; }
    placePins(section);
  }

  function placeOpen() {
    if (!open) return;
    const box = place(open.stage, open.rect);
    if (!box) return;
    const form = open.form, wide = Math.min(340, open.section.clientWidth);
    form.style.width = `${wide}px`;
    const left = Math.max(0, Math.min(box.left - 3, open.section.clientWidth - wide));
    // Under the part; above it when the window has no room below.
    const under = box.top + box.height + 9, room = window.innerHeight - (open.section.getBoundingClientRect().top + under);
    put(form, { left, top: room < form.offsetHeight + 8 && box.top - form.offsetHeight - 9 > 0 ? box.top - form.offsetHeight - 9 : under });
    const out = layerOf(open.section).querySelector<HTMLElement>(".fn-out")!;
    put(out, { left: box.left - 3, top: box.top - 3, width: box.width + 6, height: box.height + 6 });
    out.hidden = false;
  }
  function closeBox() {
    if (!open) return;
    const { form, stage, section } = open;
    open = null;
    form.remove();
    section.classList.remove("fn-noting");
    layerOf(section).querySelector<HTMLElement>(".fn-out")!.hidden = true;
    watch(stage);
    // The note is done: the stage may play its demo again once the pointer is elsewhere.
    if (!stage.matches(":hover")) stage.dispatchEvent(new PointerEvent("pointerleave"));
  }
  /// The part as it looks now, cut out of the window, with nothing of ours over it.
  async function pictureOf(section: HTMLElement, stage: HTMLElement, rect: NoteRect): Promise<string | null> {
    const box = place(stage, rect);
    if (!shot || !box || box.width < 8 || box.height < 8) return null;
    const layer = layerOf(section);
    layer.classList.add("fn-shot");
    try {
      await frames(2);
      const at = place(stage, rect), s = section.getBoundingClientRect();
      return at ? await shot({ x: s.left + at.left, y: s.top + at.top, width: at.width, height: at.height }) : null;
    } catch { return null; }
    finally { layer.classList.remove("fn-shot"); }
  }
  function openBox(section: HTMLElement, stage: HTMLElement, part: NotePart, rect: NoteRect, name: string, index: number, typed?: string, picture?: Promise<string | null>) {
    closeBox();
    hideHover();
    unrest();
    const note = index >= 0 ? store.waiting.get(keyOf(section))?.[index] : undefined;
    const form = document.createElement("form");
    form.className = "fn-box";
    form.noValidate = true;
    form.innerHTML = `<label for="fn-input">${h(name)}</label><input id="fn-input" name="note" autocomplete="off" spellcheck="true" maxlength="600" placeholder="Say what to change" value="${h(typed ?? note?.text ?? "")}">`
      + `<div class="fn-keys"><span><kbd>↵</kbd> keep</span><span><kbd>${SEND_KEY}</kbd> send</span><span><kbd>esc</kbd></span></div>`;
    layerOf(section).append(form);
    section.classList.add("fn-noting");
    open = { section, stage, part, name, index, rect, form, picture: picture ?? (index < 0 ? pictureOf(section, stage, rect) : undefined) };
    placeOpen();
    watch(stage);
    form.querySelector("input")!.focus({ preventScroll: true });
  }
  /// Enter keeps the note on its part; with the send key it goes at once, with every other waiting note.
  function keep(now: boolean) {
    if (!open) return;
    const { section, stage, part, name, index, form, picture } = open, key = keyOf(section);
    const said = form.querySelector("input")!.value.replace(/\s+/g, " ").trim();
    const notes = [...(store.waiting.get(key) ?? [])], option = optionOf(stage);
    if (index >= 0 && notes[index]) { if (said) notes[index]!.text = said; else notes.splice(index, 1); }
    else if (said) {
      const note: FoundryNote = { part, name, text: said, ...(option ? { option } : {}) };
      notes.push(note);
      note.picturing = picture?.then((data) => { if (data) note.picture = data; });
    }
    if (notes.length) store.waiting.set(key, notes); else store.waiting.delete(key);
    store.said.delete(key);
    closeBox();
    stagesOf(section).forEach(watch);
    paintSection(section);
    if (now && notes.length) send(key);
  }

  const stageFor = (source: MessageEventSource | null) => {
    for (const section of sections()) for (const stage of stagesOf(section)) if (frameOf(stage)?.contentWindow === source) return stage;
    return null;
  };
  const heard = (event: MessageEvent) => {
    const data = event.data as Record<string, unknown> | null;
    if (!data || typeof data !== "object" || data.demesne !== "note") return;
    const stage = stageFor(event.source), section = stage && sectionOf(stage);
    if (!stage || !section) return;
    if (data.state === "ready") return watch(stage);
    if (data.state !== "at") return;
    const pins = new Map<number, NoteRect>();
    for (const pin of Array.isArray(data.pins) ? data.pins.slice(0, 60) as { n?: unknown; rect?: unknown }[] : []) { const rect = rectOf(pin?.rect); if (typeof pin?.n === "number" && rect) pins.set(pin.n, rect); }
    const part = readPart(data.part);
    seen.set(stage, { vw: Number(data.vw) || 0, vh: Number(data.vh) || 0, part, pins });
    placePins(section);
    // A note that was being typed when the page was redrawn comes back on its part.
    const draft = store.draft, back = pins.get(DRAFT);
    if (draft && !open && back && draft.key === keyOf(section) && onStage(stage, draft.option)) { store.draft = null; openBox(section, stage, draft.part, back, draft.name, draft.index, draft.text, draft.picture ?? Promise.resolve(null)); return; }
    if (open) { if (open.stage === stage) { const moved = pins.get(open.index >= 0 ? open.index : DRAFT); if (moved) open.rect = moved; placeOpen(); } return; }
    if (!part) { if (resting?.stage === stage) unrest(); if (hover?.stage === stage) leaveSoon(); return; }
    // The part already outlined follows the page at once. A new one waits until the pointer rests on it.
    if (hover?.stage === stage && hover.part.selector === part.selector) { unrest(); showHover(stage, part); return; }
    if (resting?.stage === stage && resting.selector === part.selector) return;
    unrest();
    resting = { stage, selector: part.selector, timer: window.setTimeout(() => {
      resting = null;
      const now = seen.get(stage)?.part;
      if (!open && now && now.selector === part.selector && stage.isConnected) showHover(stage, now);
    }, REST) };
  };

  const clicked = (event: MouseEvent) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    const sender = target.closest<HTMLElement>("[data-notes-send]");
    if (sender) { const section = sender.closest<HTMLElement>(".fd-item"); if (section) send(keyOf(section)); return; }
    if (target.closest(".fn-tag") && hover) { openBox(hover.section, hover.stage, hover.part, hover.part.rect, partName(hover.part), -1); return; }
    const pin = target.closest<HTMLElement>(".fn-pin");
    if (pin) {
      const section = pin.closest<HTMLElement>(".fd-item"), index = Number(pin.dataset.n), note = section && store.waiting.get(keyOf(section))?.[index];
      const stage = section && note ? stagesOf(section).find((item) => onStage(item, note.option) && seen.get(item)?.pins.has(index)) : undefined, rect = stage && seen.get(stage)?.pins.get(index);
      if (section && note && stage && rect) openBox(section, stage, note.part, rect, note.name, index);
      return;
    }
    // A click anywhere else puts an untouched note away.
    if (open && !target.closest(".fn-box") && !open.form.querySelector("input")!.value.trim()) closeBox();
  };
  const typed = (event: KeyboardEvent) => {
    if (event.isComposing || root.offsetParent === null) return;
    const sendKey = event.key === "Enter" && (event.metaKey || event.ctrlKey);
    if (open && event.target instanceof Node && open.form.contains(event.target)) {
      if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); keep(sendKey); }
      else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeBox(); }
      return;
    }
    if (!sendKey || open) return;
    // The send key with no note open: the mockup under the pointer, or the only one with notes waiting.
    const waiting = sections().filter((section) => store.waiting.get(keyOf(section))?.length);
    const section = waiting.find((item) => item.matches(":hover")) ?? (waiting.length === 1 ? waiting[0] : undefined);
    if (section) { event.preventDefault(); send(keyOf(section)); }
  };
  const submitted = (event: Event) => { if (event.target instanceof Element && event.target.closest(".fn-box")) event.preventDefault(); };
  const left = (event: PointerEvent) => {
    const tag = event.target instanceof Element ? event.target.closest(".fn-tag") : null;
    if (!tag || !hover || open || (event.relatedTarget instanceof Node && tag.contains(event.relatedTarget))) return;
    // Off the tag and not back onto the mockup: the stage is left too.
    if (!(event.relatedTarget instanceof Node && hover.stage.contains(event.relatedTarget))) hover.stage.dispatchEvent(new PointerEvent("pointerleave"));
    leaveSoon();
  };
  /// The pointer on anything of the page's (the tag, a pin, the note, the page around the mockup) is on no part:
  /// a frame is not always told that the pointer left it for something drawn over it.
  const elsewhere = (event: PointerEvent) => {
    for (const section of sections()) for (const stage of stagesOf(section)) {
      const frame = frameOf(stage), at = seen.get(stage);
      if (!frame || frame === event.target || !at?.part) continue;
      at.part = null;
      try { frame.contentWindow?.postMessage({ demesne: "note", action: "away" }, "*"); } catch { /* the frame is gone */ }
      if (resting?.stage === stage) unrest();
      if (hover?.stage === stage) leaveSoon();
    }
  };
  const resized = new ResizeObserver(() => { hideHover(); sections().forEach(placePins); placeOpen(); });

  window.addEventListener("message", heard);
  root.addEventListener("click", clicked);
  root.addEventListener("submit", submitted);
  root.addEventListener("pointerout", left);
  document.addEventListener("keydown", typed, true);
  document.addEventListener("pointerover", elsewhere, true);
  resized.observe(root);
  sections().forEach(paintSection);
  return {
    stop() {
      // A note being typed survives the redraw.
      if (open) { const input = open.form.querySelector("input")!, option = optionOf(open.stage); store.draft = { key: keyOf(open.section), part: open.part, name: open.name, text: input.value, index: open.index, ...(option ? { option } : {}), ...(open.picture ? { picture: open.picture } : {}) }; }
      clearTimeout(away);
      unrest();
      window.removeEventListener("message", heard);
      root.removeEventListener("click", clicked);
      root.removeEventListener("submit", submitted);
      root.removeEventListener("pointerout", left);
      document.removeEventListener("keydown", typed, true);
      document.removeEventListener("pointerover", elsewhere, true);
      resized.disconnect();
    },
    paint() { sections().forEach((section) => { stagesOf(section).forEach(watch); paintSection(section); }); },
  };
}
