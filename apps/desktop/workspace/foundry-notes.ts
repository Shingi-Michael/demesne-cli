/// Notes on a mockup (pass 233 A, pass 242 A). On Foundry's long page,
/// nothing is outlined: when the pointer rests on a mockup a small + sits
/// beside it, and a click drops a pin exactly there with a one-line note, like
/// a comment (on a control, which keeps working, the + itself pins). A note says what to change, or what you like and want kept.
/// Enter adds it; the send key sends every waiting note as one message to the
/// chat that made the mockup, so one new version holds every correction.
///
/// The mockup's own frame only says where the pointer is, where a click
/// landed and where the noted parts are now (foundry-kit/note.js). Everything
/// drawn here sits outside the frame, in the page, at real size: nothing is
/// added to the mockup, and at rest the page shows nothing new.

import { fenced } from "./pastes.ts";

export interface NoteRect { x: number; y: number; w: number; h: number }
/// What the frame says about a part: what it is and where it is in the markup.
export interface NotePart { tag: string; role: string; type: string; cls: string; label: string; text: string; heading: string; kids: number; selector: string; html: string }
/// Where on its part a pin sits, from its top left corner, 0 to 1 across and down.
export interface NoteSpot { fx: number; fy: number }
/// `keep` is a note on what the person likes: it stays as it is. `spot` is where on the part the pin is.
/// `picture` is the place around the pin as the person saw it: a PNG in base64, cropped from the window,
/// with the pin `around` this far across and down it, in percent. `picturing` ends when the picture has been taken (or could not be).
/// `given` (step 6): the picture is one the person dropped at the pin, to use in the mockup, not the place around it.
export interface FoundryNote { part: NotePart; name: string; text: string; keep?: boolean; spot?: NoteSpot; option?: { index: number; name: string }; picture?: string; around?: { x: number; y: number }; given?: NoteGiven; picturing?: Promise<void> }
/// A picture the person dropped on a mockup: its file's name and the type it is kept as.
export interface NoteGiven { name: string; type: string }
/// A picture around a pin, and where the pin is in it (or, `type`, a dropped picture's type).
export interface NotePicture { data: string; around: { x: number; y: number }; type?: string }
/// A note being typed when the page was redrawn, so it comes back.
export interface NoteDraft { key: string; part: NotePart; name: string; text: string; index: number; spot: NoteSpot; keep: boolean | null; option?: { index: number; name: string }; picture?: Promise<NotePicture | null>; given?: NoteGiven }
/// Where sent notes went: the chat's name, and whether they wait behind a turn still running there.
export interface NotesSentTo { session: string; chat: string; queued: boolean }
/// Notes by mockup version ("id:version"): waiting to be sent, being worked on (and where), and a quiet word when sending failed.
/// `changed` is told whenever the waiting notes change, so they are kept outside the window.
export interface NoteStore { waiting: Map<string, FoundryNote[]>; working: Map<string, number>; to: Map<string, NotesSentTo>; said: Map<string, string>; draft: NoteDraft | null; changed?: () => void }
export const newNoteStore = (): NoteStore => ({ waiting: new Map(), working: new Map(), to: new Map(), said: new Map(), draft: null });

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
/// A pin on no part is held by the page itself.
export const PAGE_SELECTOR = "html";

/// What kind of piece a part is, in a word a person would use.
export function partWord(part: Pick<NotePart, "tag" | "role" | "type" | "cls">): string {
  if (ROLES[part.role]) return ROLES[part.role]!;
  if (part.tag === "input") return ({ checkbox: "tick box", radio: "option", range: "slider", button: "button", submit: "button", reset: "button" } as Record<string, string>)[part.type] ?? "field";
  if (TAGS[part.tag]) return TAGS[part.tag]!;
  for (const [test, word] of CLASSES) if (test.test(part.cls)) return word;
  return "part";
}
/// The note's name for a part: its own short words, then what it is
/// ("Save button", "Overdue card", "Tabs"). A pin on no part is on the page.
export function partName(part: NotePart): string {
  if (part.selector === PAGE_SELECTOR) return "The page";
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

/// Words that say a note is about what the person likes. Tab flips it while the note is typed.
const LIKES = /\b(keep|kept|love|loved|like|likes|liked|nice|good|great|perfect|lovely|beautiful|works|working|spot on)\b/i;
const CHANGES = /\b(but|instead|change|make|less|more|smaller|bigger|remove|drop|move|don'?t|doesn'?t|not)\b/i;
export const likes = (text: string) => LIKES.test(text) && !CHANGES.test(text);
/// What a keep says in the message: the line starts with a heart, so it can be found again (storage foundryLikes).
export const KEEP_MARK = "♥";
const percent = (n: number) => `${Math.round(Math.min(1, Math.max(0, n)) * 100)}%`;

/// The notes as one message. Its first lines are what the person said, note
/// by note: a change is numbered, a keep starts with a heart. The folded block
/// under them is for the model: which mockup, and each pin's part, place on the
/// part and markup, so it changes those parts, keeps the liked ones, and
/// leaves everything else alone.
export function notesMessage(mockup: { id: string; title: string; version: number }, notes: readonly FoundryNote[], pictured: readonly number[] = []): string {
  if (!notes.length) return "";
  let changes = 0;
  const marks = notes.map((note) => note.keep ? KEEP_MARK : String(++changes));
  const said = notes.map((note, index) => `${marks[index]} · ${where(note)}: ${note.text}`).join("\n");
  const kept = notes.length - changes, many = changes > 1;
  const asked = changes
    ? `Change only ${many ? "the parts with numbered notes, each" : "the part with the numbered note,"} as its note says${kept ? `; the ${KEEP_MARK} ${kept > 1 ? "notes are" : "note is"} what the person likes, so keep ${kept > 1 ? "those" : "that"} exactly as ${kept > 1 ? "they are" : "it is"}` : ""}, and leave everything else exactly as it is: foundry_read it, then one foundry_edit.`
    : `Nothing to change: the person marked what they like. Keep ${kept > 1 ? "these" : "this"} as ${kept > 1 ? "they are" : "it is"} in every later version, make no new version now, and say so in one line.`;
  // Pass 245 A: what they like is taste that carries over to later mockups of the project.
  const taste = kept ? ` What they like is their taste too: when a ${KEEP_MARK} note says something general, keep it as one short rule with remember {design: true, learned_from: "${KEEP_MARK} on ${mockup.title}"}, unless their design guide already says it.` : "";
  const around = pictured.filter((index) => !notes[index]?.given), given = pictured.filter((index) => notes[index]?.given);
  const pictures = (around.length ? ` The attached picture${around.length > 1 ? "s" : ""}${given.length ? " named note-…" : ""} ${around.length > 1 ? "show" : "shows"} the place around ${around.length > 1 ? "pins" : "pin"} ${around.map((index) => marks[index]).join(", ")} as the person saw ${around.length > 1 ? "them" : "it"}, in that order.` : "")
    // Step 6: a picture dropped on the mockup is one to use there, by its id.
    + (given.length ? ` The person dropped ${given.length > 1 ? "pictures" : "a picture"} on the mockup at ${given.length > 1 ? "pins" : "pin"} ${given.map((index) => marks[index]).join(", ")} to use there, attached under ${given.length > 1 ? "their own file names" : "its own file name"}: put ${given.length > 1 ? "each" : "it"} in at ${given.length > 1 ? "its" : "the"} pin as picture:IMAGE_ID, with the image artifact id of that attachment.` : "");
  const detail = [`Notes pinned on the Foundry mockup "${mockup.title}" (id ${mockup.id}, v${mockup.version}). ${asked}${taste}${pictures}`,
    ...notes.map((note, index) => {
      const spot = note.spot ? `, pinned ${percent(note.spot.fx)} across and ${percent(note.spot.fy)} down ${note.part.selector === PAGE_SELECTOR ? "the page" : "it"}` : "";
      const around = note.given && pictured.includes(index) ? `\n   dropped picture: attached as ${notePictureFile(note, index).name}`
        : note.around && pictured.includes(index) ? `\n   in its picture the pin is ${Math.round(note.around.x)}% across and ${Math.round(note.around.y)}% down` : "";
      return `${marks[index]}. ${note.keep ? "keep" : "change"}, ${where(note)}: ${note.text}\n   selector \`${note.part.selector}\`${spot}${around}${note.part.html ? `\n   ${note.part.html}` : ""}`;
    })].join("\n");
  return `On “${mockup.title}”:\n${said}\n\n${fenced(detail, "parts")}`;
}

/// The file a note's picture goes to the chat as: the place around pin N as
/// note-N.png, a dropped picture under its own name (its extension as kept).
export function notePictureFile(note: FoundryNote, index: number): { name: string; mimeType: string } {
  if (!note.given) return { name: `note-${index + 1}.png`, mimeType: "image/png" };
  const extension = ({ "image/jpeg": "jpg", "image/webp": "webp" } as Record<string, string>)[note.given.type] ?? "png";
  return { name: `${note.given.name.replace(/\.[A-Za-z0-9]{1,5}$/, "") || "picture"}.${extension}`, mimeType: note.given.type };
}
/// A note as it is kept outside the window (the daemon): everything but the picture still being taken.
export function keptNote(note: FoundryNote): Record<string, unknown> {
  const { picturing: _, ...kept } = note;
  return kept;
}
/// A kept note read back. It was ours, but it went through the daemon, so it is checked like anything else.
export function readKeptNote(value: unknown): FoundryNote | null {
  const note = value as Record<string, unknown> | null;
  if (!note || typeof note !== "object" || typeof note.text !== "string" || !note.text.trim() || !note.part || typeof note.part !== "object") return null;
  const raw = note.part as Record<string, unknown>;
  const part = readPart({ ...raw, rect: { x: 0, y: 0, w: 1, h: 1 } });
  if (!part) return null;
  const { rect: _, ...plain } = part;
  const spot = note.spot as { fx?: unknown; fy?: unknown } | undefined, option = note.option as { index?: unknown; name?: unknown } | undefined, around = note.around as { x?: unknown; y?: unknown } | undefined;
  return { part: plain, name: text(note.name, 80) || partName(plain), text: note.text.slice(0, 600), ...(note.keep === true ? { keep: true } : {}),
    ...(spot && typeof spot.fx === "number" && typeof spot.fy === "number" ? { spot: { fx: unit(spot.fx), fy: unit(spot.fy) } } : {}),
    ...(option && typeof option.index === "number" && typeof option.name === "string" ? { option: { index: Math.max(0, Math.floor(option.index)), name: option.name.slice(0, 60) } } : {}),
    ...(typeof note.picture === "string" && /^[A-Za-z0-9+/=]+$/.test(note.picture.slice(0, 200)) ? { picture: note.picture } : {}),
    ...(around && typeof around.x === "number" && typeof around.y === "number" ? { around: { x: around.x, y: around.y } } : {}),
    ...(readGiven(note.given) ? { given: readGiven(note.given)! } : {}) };
}
/// A dropped picture's name and type, read back: a file name with no path, a picture type.
export function readGiven(value: unknown): NoteGiven | null {
  const given = value as { name?: unknown; type?: unknown } | null;
  if (!given || typeof given !== "object" || typeof given.name !== "string" || typeof given.type !== "string" || !/^image\/(png|jpeg|webp)$/.test(given.type)) return null;
  const name = given.name.replace(/^.*[\\/]/, "").replace(/[\u0000-\u001f]/g, "").trim().slice(0, 120);
  return name ? { name, type: given.type } : null;
}

const count = (n: number) => `${n} note${n === 1 ? "" : "s"}`;
const MAC = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);
export const SEND_KEY = MAC ? "⌘↵" : "Ctrl ↵";
/// What a dropped picture's note says until the person says more.
export const DROPPED_SAYS = "Use this picture here";
const HEART = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M6 10.2 1.9 6.3a2.3 2.3 0 0 1 3.3-3.2L6 3.9l.8-.8a2.3 2.3 0 0 1 3.3 3.2z"/></svg>';

/// The quiet line under a mockup: what waits (changes and keeps) and the key
/// that sends it, or that notes are being worked on. Empty when there is nothing to say.
export function notesLine(waiting: number, working: number, said = "", kept = 0, to?: NotesSentTo): string {
  const changes = waiting - kept;
  const what = [changes > 0 ? `${changes} to change` : "", kept > 0 ? `${kept} to keep` : ""].filter(Boolean).join(", ");
  const send = waiting ? `<button type="button" class="fd-notes-send" data-notes-send>${what} · send <kbd>${SEND_KEY}</kbd></button>` : "";
  // Where they went, and whether they wait in line behind a turn that is running there.
  if (working && to?.queued) return `<i class="fd-notes-work" aria-hidden="true"></i><span>${count(working)} in line in “${h(cut(to.chat, 40))}”, behind the turn running there</span>${send}`;
  if (working) return `<i class="fd-notes-work" aria-hidden="true"></i><span>Working on ${count(working)}${to ? ` in “${h(cut(to.chat, 40))}”` : ""}…</span>${send}`;
  return send || (said ? `<span class="fd-quiet">${h(said)}</span>` : "");
}

const text = (value: unknown, most: number) => typeof value === "string" ? value.slice(0, most) : "";
const rectOf = (value: unknown): NoteRect | null => {
  const r = value as Partial<NoteRect> | null;
  return r && [r.x, r.y, r.w, r.h].every((n) => typeof n === "number" && Number.isFinite(n)) ? { x: r.x!, y: r.y!, w: r.w!, h: r.h! } : null;
};
const pointOf = (value: unknown): { x: number; y: number } | null => {
  const p = value as { x?: unknown; y?: unknown } | null;
  return p && typeof p.x === "number" && typeof p.y === "number" && Number.isFinite(p.x) && Number.isFinite(p.y) ? { x: p.x, y: p.y } : null;
};
const unit = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
/// A part as the frame described it. The frame holds a page the model wrote, so nothing in it is taken on trust.
export function readPart(value: unknown): (NotePart & { rect: NoteRect }) | null {
  const part = value as Record<string, unknown> | null, rect = rectOf(part?.rect);
  if (!part || typeof part !== "object" || !rect || typeof part.selector !== "string" || !part.selector) return null;
  return { tag: text(part.tag, 40).toLowerCase(), role: text(part.role, 40), type: text(part.type, 40), cls: text(part.cls, 120), label: text(part.label, 80), text: text(part.text, 120), heading: text(part.heading, 60),
    kids: typeof part.kids === "number" && part.kids > 0 ? Math.min(999, Math.floor(part.kids)) : 0, selector: text(part.selector, 400), html: text(part.html, 700), rect };
}

interface Seen { vw: number; vh: number; point: { x: number; y: number } | null; pins: Map<number, NoteRect> }
interface Open { section: HTMLElement; stage: HTMLElement; part: NotePart; name: string; index: number; spot: NoteSpot; rect: NoteRect; form: HTMLFormElement; flip: boolean | null; picture?: Promise<NotePicture | null>; given?: NoteGiven }
/// A place in the window, in its own pixels.
export interface ShotRect { x: number; y: number; width: number; height: number }
/// REST: how long the pointer stays still before the + shows. The picture around a pin, in the frame's pixels.
const DRAFT = -1, REST = 420, AROUND = { w: 360, h: 220 };
const frames = (count: number) => new Promise<void>((done) => { const next = (left: number) => left ? requestAnimationFrame(() => next(left - 1)) : done(); next(count); });
const spotIn = (rect: NoteRect, spot: NoteSpot) => ({ x: rect.x + spot.fx * rect.w, y: rect.y + spot.fy * rect.h });

/// `fit` (step 6) makes a dropped picture (a data URL) one the chat can take: its base64 and type, or null.
export function watchFoundryNotes(root: HTMLElement, store: NoteStore, send: (key: string) => void, shot?: (rect: ShotRect) => Promise<string | null>, fit?: (dataURL: string) => Promise<{ data: string; type: string } | null>): { stop(): void; paint(): void } {
  const seen = new WeakMap<HTMLElement, Seen>();
  let open: Open | null = null, rest: { stage: HTMLElement; timer: number; at?: { x: number; y: number } } | null = null;
  const sections = () => [...root.querySelectorAll<HTMLElement>(".fd-item")].filter((section) => section.querySelector(":scope > .fd-notes"));
  const keyOf = (section: HTMLElement) => section.dataset.fd ?? "";
  const stagesOf = (section: HTMLElement) => [...section.querySelectorAll<HTMLElement>(".fd-stage")];
  const frameOf = (stage: HTMLElement) => stage.querySelector<HTMLIFrameElement>("iframe.fd-frame");
  const sectionOf = (stage: HTMLElement) => { const section = stage.closest<HTMLElement>(".fd-item"); return section?.querySelector(":scope > .fd-notes") ? section : null; };
  /// A mockup with options shows the one its tab names (pass 263 A); a style has a stage of its own, named on the line above it.
  const optionOf = (stage: HTMLElement) => {
    if (stage.dataset.split === undefined) return undefined;
    const head = stage.previousElementSibling, index = Number(stage.dataset.split) || 0;
    const named = head?.classList.contains("fd-tabs") ? head.querySelector(`[data-variant="${index}"]`)?.firstChild?.textContent ?? ""
      : head?.classList.contains("fd-opt") ? head.querySelector("b")?.textContent ?? "" : "";
    return { index, name: cut(named, 60) || `option ${index + 1}` };
  };
  const onStage = (stage: HTMLElement, option: { index: number } | undefined) => (option?.index ?? -1) === (stage.dataset.split === undefined ? -1 : Number(stage.dataset.split) || 0);
  const layerOf = (section: HTMLElement) => {
    let layer = section.querySelector<HTMLElement>(":scope > .fn-layer");
    if (!layer) {
      layer = document.createElement("div");
      layer.className = "fn-layer";
      layer.innerHTML = '<button type="button" class="fn-plus" aria-label="Pin a note here" hidden></button>';
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
  /// A point in the frame as a point in the section, or nothing when it is out of sight.
  function placePoint(stage: HTMLElement, point: { x: number; y: number }) {
    const frame = frameOf(stage), section = sectionOf(stage), at = seen.get(stage);
    if (!frame || !section || !at || point.x < 0 || point.y < 0 || point.x > at.vw || point.y > at.vh) return null;
    const f = frame.getBoundingClientRect(), s = section.getBoundingClientRect(), k = at.vw > 0 ? f.width / at.vw : 1;
    return { left: f.left - s.left + point.x * k, top: f.top - s.top + point.y * k };
  }
  const put = (el: HTMLElement, box: { left: number; top: number }) => { el.style.left = `${Math.round(box.left)}px`; el.style.top = `${Math.round(box.top)}px`; };

  /// The small + beside a resting pointer: the only thing drawn before a click.
  /// Clicking it pins where the pointer rested, which is how a note goes on a control the mockup keeps working.
  function hidePlus() {
    if (rest) { clearTimeout(rest.timer); const layer = sectionOf(rest.stage)?.querySelector<HTMLElement>(":scope > .fn-layer .fn-plus"); if (layer) layer.hidden = true; rest = null; }
  }
  function restOn(stage: HTMLElement) {
    hidePlus();
    rest = { stage, timer: window.setTimeout(() => {
      const point = seen.get(stage)?.point, section = sectionOf(stage), at = point && placePoint(stage, point);
      if (open || !section || !at || !stage.isConnected) return;
      const plus = layerOf(section).querySelector<HTMLElement>(".fn-plus")!;
      put(plus, { left: at.left + 12, top: at.top - 26 });
      plus.hidden = false;
      if (rest) rest.at = { ...point };
    }, REST) };
  }

  /// The pins of a mockup's waiting notes, each exactly where it was dropped: a number for a change, a heart for a keep.
  function placePins(section: HTMLElement) {
    // Nothing is added to a mockup that has no notes and no pointer on it.
    const notes = store.waiting.get(keyOf(section)) ?? [], layer = notes.length || open?.section === section ? layerOf(section) : section.querySelector<HTMLElement>(":scope > .fn-layer");
    if (!layer) return;
    // Pins are moved, not made again, so one under the pointer can still be clicked as the page tells where things are.
    const had = new Map([...layer.querySelectorAll<HTMLButtonElement>(".fn-pin")].map((pin) => [pin.dataset.n ?? "new", pin]));
    let changes = 0;
    const marks = notes.map((note) => note.keep ? "" : String(++changes));
    const drop = (stage: HTMLElement, key: string, rect: NoteRect | undefined, spot: NoteSpot | undefined, make: (pin: HTMLButtonElement) => void) => {
      const at = rect ? placePoint(stage, spotIn(rect, spot ?? { fx: 1, fy: 0 })) : null;
      if (!at) return;
      let pin = had.get(key);
      had.delete(key);
      if (!pin) { pin = document.createElement("button"); pin.type = "button"; layer.append(pin); }
      pin.className = "fn-pin";
      make(pin);
      put(pin, at);
    };
    for (const stage of stagesOf(section)) {
      const seenHere = seen.get(stage);
      if (!seenHere) continue;
      notes.forEach((note, index) => {
        if (!onStage(stage, note.option)) return;
        drop(stage, String(index), seenHere.pins.get(index), note.spot, (pin) => {
          pin.dataset.n = String(index);
          const label = note.keep ? HEART : marks[index]!;
          if (note.keep) pin.classList.add("fn-keep");
          if (pin.innerHTML !== label) pin.innerHTML = label;
          if (open?.section === section && open.index === index) pin.classList.add("fn-open");
          pin.title = note.text; pin.setAttribute("aria-label", `${note.keep ? "Keep" : `Note ${marks[index]}`} on ${note.name}: ${note.text}`);
        });
      });
      // The note being written has its pin already, where the click landed.
      if (open && open.index < 0 && open.stage === stage) drop(stage, "new", open.rect, open.spot, (pin) => { pin.classList.add("fn-open", "fn-new"); pin.tabIndex = -1; pin.setAttribute("aria-hidden", "true"); });
    }
    for (const pin of had.values()) pin.remove();
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
    const key = keyOf(section), line = section.querySelector<HTMLElement>(":scope > .fd-notes"), waiting = store.waiting.get(key) ?? [];
    if (line) { const html = notesLine(waiting.length, store.working.get(key) ?? 0, store.said.get(key), waiting.filter((note) => note.keep).length, store.to.get(key)); if (line.innerHTML !== html) line.innerHTML = html; line.hidden = !html; }
    placePins(section);
  }

  const keeps = (form: HTMLFormElement, flip: boolean | null) => flip ?? likes(form.querySelector("input")!.value);
  function showKind() {
    if (!open) return;
    const keep = keeps(open.form, open.flip), kind = open.form.querySelector<HTMLElement>(".fn-kind")!;
    kind.innerHTML = keep ? `${HEART}Keep` : "Change";
    kind.classList.toggle("fn-keep", keep);
  }
  function placeOpen() {
    if (!open) return;
    const at = placePoint(open.stage, spotIn(open.rect, open.spot));
    if (!at) return;
    const form = open.form, wide = Math.min(300, open.section.clientWidth);
    form.style.width = `${wide}px`;
    // Beside the pin, on its right; on its left when there is no room.
    const right = at.left + 18, left = right + wide > open.section.clientWidth ? Math.max(0, at.left - 8 - wide) : right;
    const room = window.innerHeight - (open.section.getBoundingClientRect().top + at.top - 12);
    put(form, { left, top: Math.max(0, room < form.offsetHeight + 8 ? at.top - form.offsetHeight : at.top - 12) });
  }
  function closeBox() {
    if (!open) return;
    const { form, stage, section } = open;
    open = null;
    form.remove();
    section.classList.remove("fn-noting");
    watch(stage);
    placePins(section);
    // The note is done: the stage may play its demo again once the pointer is elsewhere.
    if (!stage.matches(":hover")) stage.dispatchEvent(new PointerEvent("pointerleave"));
  }
  /// The place around the pin as it looks now, cut out of the window, with nothing of ours over it.
  async function pictureOf(section: HTMLElement, stage: HTMLElement, point: { x: number; y: number }): Promise<NotePicture | null> {
    const at = seen.get(stage);
    if (!shot || !at) return null;
    const w = Math.min(AROUND.w, at.vw), hgt = Math.min(AROUND.h, at.vh);
    const rect = { x: Math.min(Math.max(0, point.x - w / 2), at.vw - w), y: Math.min(Math.max(0, point.y - hgt / 2), at.vh - hgt), w, h: hgt };
    const box = place(stage, rect);
    if (!box || box.width < 8 || box.height < 8) return null;
    const layer = layerOf(section);
    layer.classList.add("fn-shot");
    try {
      await frames(2);
      const now = place(stage, rect), s = section.getBoundingClientRect();
      const data = now ? await shot({ x: s.left + now.left, y: s.top + now.top, width: now.width, height: now.height }) : null;
      return data ? { data, around: { x: (point.x - rect.x) / rect.w * 100, y: (point.y - rect.y) / rect.h * 100 } } : null;
    } catch { return null; }
    finally { layer.classList.remove("fn-shot"); }
  }
  function openBox(section: HTMLElement, stage: HTMLElement, part: NotePart, rect: NoteRect, spot: NoteSpot, name: string, index: number, typed?: string, picture?: Promise<NotePicture | null>, flip: boolean | null = null, given?: NoteGiven) {
    closeBox();
    hidePlus();
    const note = index >= 0 ? store.waiting.get(keyOf(section))?.[index] : undefined;
    const form = document.createElement("form");
    form.className = "fn-box";
    form.noValidate = true;
    form.innerHTML = `<label for="fn-input"><span class="fn-kind"></span><span class="fn-on">${h(name)}</span>${given ? `<span class="fn-on">· ${h(cut(given.name, 40))}</span>` : ""}</label><input id="fn-input" name="note" autocomplete="off" spellcheck="true" maxlength="600" placeholder="What you like, or what to change" value="${h(typed ?? note?.text ?? "")}">`
      + `<div class="fn-keys"><span><kbd>↵</kbd> add</span><span><kbd>tab</kbd> flips</span><span><kbd>${SEND_KEY}</kbd> send</span><span><kbd>esc</kbd></span></div>`;
    layerOf(section).append(form);
    section.classList.add("fn-noting");
    open = { section, stage, part, name, index, spot, rect, form, flip: flip ?? (note ? !!note.keep : null), picture: picture ?? (index < 0 ? pictureOf(section, stage, spotIn(rect, spot)) : undefined), ...(given ? { given } : {}) };
    showKind();
    placeOpen();
    watch(stage);
    placePins(section);
    form.querySelector("input")!.focus({ preventScroll: true });
  }
  /// Enter adds the note at its pin; with the send key it goes at once, with every other waiting note.
  function keep(now: boolean) {
    if (!open) return;
    const { section, stage, part, name, index, form, picture, spot, flip, given } = open, key = keyOf(section);
    const said = form.querySelector("input")!.value.replace(/\s+/g, " ").trim(), liked = keeps(form, flip);
    const notes = [...(store.waiting.get(key) ?? [])], option = optionOf(stage);
    if (index >= 0 && notes[index]) { if (said) { notes[index]!.text = said; notes[index]!.keep = liked; } else notes.splice(index, 1); }
    else if (said) {
      const note: FoundryNote = { part, name, text: said, keep: liked, spot, ...(option ? { option } : {}) };
      notes.push(note);
      // Kept again once its picture is taken (or, dropped, made one the chat can take).
      note.picturing = picture?.then((taken) => {
        if (!taken) return;
        note.picture = taken.data;
        if (given) note.given = { name: given.name, type: taken.type ?? given.type }; else note.around = taken.around;
        store.changed?.();
      });
    }
    if (notes.length) store.waiting.set(key, notes); else store.waiting.delete(key);
    store.said.delete(key);
    store.changed?.();
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
    if (data.state === "pin") {
      // A click on the mockup: a pin exactly there. A note already typed is added first.
      const part = readPart(data.part), point = pointOf(data.point);
      if (!part || !point) return;
      const before = seen.get(stage);
      seen.set(stage, { vw: Number(data.vw) || before?.vw || 0, vh: Number(data.vh) || before?.vh || 0, point, pins: before?.pins ?? new Map() });
      if (open && open.form.querySelector("input")!.value.trim()) keep(false);
      openBox(section, stage, part, part.rect, { fx: unit(data.fx), fy: unit(data.fy) }, partName(part), -1);
      return;
    }
    if (data.state === "drop") {
      // Step 6: a picture dropped on the mockup is a pin there that carries it.
      const key = keyOf(section);
      if (typeof data.refused === "string") { store.said.set(key, cut(data.refused, 120)); paintSection(section); return; }
      const part = readPart(data.part), point = pointOf(data.point), dropped = typeof data.data === "string" && /^data:image\/[\w.+-]+;base64,/.test(data.data) ? data.data : null;
      if (!part || !point || !dropped || !fit) return;
      const before = seen.get(stage);
      seen.set(stage, { vw: Number(data.vw) || before?.vw || 0, vh: Number(data.vh) || before?.vh || 0, point, pins: before?.pins ?? new Map() });
      if (open && open.form.querySelector("input")!.value.trim()) keep(false);
      const name = (typeof data.name === "string" ? data.name : "").replace(/^.*[\\/]/, "").trim().slice(0, 120) || "picture";
      const picture = fit(dropped).catch(() => null).then((fitted) => {
        if (fitted) return { data: fitted.data, around: { x: 50, y: 50 }, type: fitted.type };
        store.said.set(key, `${name} couldn't be read as a picture`);
        paintSection(section);
        return null;
      });
      store.said.delete(key);
      openBox(section, stage, part, part.rect, { fx: unit(data.fx), fy: unit(data.fy) }, partName(part), -1, DROPPED_SAYS, picture, false, { name, type: "image/png" });
      return;
    }
    if (data.state !== "at") return;
    const pins = new Map<number, NoteRect>();
    for (const pin of Array.isArray(data.pins) ? data.pins.slice(0, 60) as { n?: unknown; rect?: unknown }[] : []) { const rect = rectOf(pin?.rect); if (typeof pin?.n === "number" && rect) pins.set(pin.n, rect); }
    const point = pointOf(data.point), before = seen.get(stage)?.point;
    seen.set(stage, { vw: Number(data.vw) || 0, vh: Number(data.vh) || 0, point, pins });
    // A note that was being typed when the page was redrawn comes back at its pin.
    const draft = store.draft, back = pins.get(DRAFT);
    if (draft && !open && back && draft.key === keyOf(section) && onStage(stage, draft.option)) {
      store.draft = null;
      openBox(section, stage, draft.part, back, draft.spot, draft.name, draft.index, draft.text, draft.picture ?? Promise.resolve(null), draft.keep, draft.given);
      return;
    }
    if (open && open.stage === stage) { const moved = pins.get(open.index >= 0 ? open.index : DRAFT); if (moved) open.rect = moved; placeOpen(); }
    placePins(section);
    if (open) return;
    // The + waits until the pointer rests; any move puts it away again. Leaving the mockup for the + keeps it.
    if (!point) { if (rest?.stage === stage && !section.querySelector(".fn-plus:hover")) hidePlus(); return; }
    if (!before || before.x !== point.x || before.y !== point.y || rest?.stage !== stage) restOn(stage);
  };

  const clicked = (event: MouseEvent) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    if (target.closest(".fn-plus") && rest?.at) {
      const { stage, at } = rest;
      hidePlus();
      try { frameOf(stage)?.contentWindow?.postMessage({ demesne: "note", action: "pin-at", x: at.x, y: at.y }, "*"); } catch { /* the frame is gone */ }
      return;
    }
    const sender = target.closest<HTMLElement>("[data-notes-send]");
    if (sender) { const section = sender.closest<HTMLElement>(".fd-item"); if (section) send(keyOf(section)); return; }
    const pin = target.closest<HTMLElement>(".fn-pin[data-n]");
    if (pin) {
      const section = pin.closest<HTMLElement>(".fd-item"), index = Number(pin.dataset.n), note = section && store.waiting.get(keyOf(section))?.[index];
      const stage = section && note ? stagesOf(section).find((item) => onStage(item, note.option) && seen.get(item)?.pins.has(index)) : undefined, rect = stage && seen.get(stage)?.pins.get(index);
      if (section && note && stage && rect) openBox(section, stage, note.part, rect, note.spot ?? { fx: 1, fy: 0 }, note.name, index);
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
      else if (event.key === "Tab" && !event.shiftKey) { event.preventDefault(); event.stopPropagation(); open.flip = !keeps(open.form, open.flip); showKind(); }
      return;
    }
    if (!sendKey || open) return;
    // The send key with no note open: the mockup under the pointer, or the only one with notes waiting.
    const waiting = sections().filter((section) => store.waiting.get(keyOf(section))?.length);
    const section = waiting.find((item) => item.matches(":hover")) ?? (waiting.length === 1 ? waiting[0] : undefined);
    if (section) { event.preventDefault(); send(keyOf(section)); }
  };
  const input = (event: Event) => { if (open && event.target instanceof Node && open.form.contains(event.target)) showKind(); };
  const submitted = (event: Event) => { if (event.target instanceof Element && event.target.closest(".fn-box")) event.preventDefault(); };
  /// The pointer on anything of the page's (a pin, the note, the page around the mockup) is not on the mockup:
  /// a frame is not always told that the pointer left it for something drawn over it.
  const elsewhere = (event: PointerEvent) => {
    // Onto the + itself: still about to pin there.
    if (event.target instanceof Element && event.target.closest(".fn-plus")) return;
    if (rest && !(event.target instanceof Element && frameOf(rest.stage) === event.target)) hidePlus();
    for (const section of sections()) for (const stage of stagesOf(section)) {
      const frame = frameOf(stage), at = seen.get(stage);
      if (!frame || frame === event.target || !at?.point) continue;
      at.point = null;
      try { frame.contentWindow?.postMessage({ demesne: "note", action: "away" }, "*"); } catch { /* the frame is gone */ }
    }
  };
  const resized = new ResizeObserver(() => { hidePlus(); sections().forEach(placePins); placeOpen(); });

  window.addEventListener("message", heard);
  root.addEventListener("click", clicked);
  root.addEventListener("submit", submitted);
  root.addEventListener("input", input);
  document.addEventListener("keydown", typed, true);
  document.addEventListener("pointerover", elsewhere, true);
  resized.observe(root);
  sections().forEach(paintSection);
  return {
    stop() {
      // A note being typed survives the redraw.
      if (open) {
        const option = optionOf(open.stage);
        store.draft = { key: keyOf(open.section), part: open.part, name: open.name, text: open.form.querySelector("input")!.value, index: open.index, spot: open.spot, keep: open.flip, ...(option ? { option } : {}), ...(open.picture ? { picture: open.picture } : {}), ...(open.given ? { given: open.given } : {}) };
      }
      hidePlus();
      window.removeEventListener("message", heard);
      root.removeEventListener("click", clicked);
      root.removeEventListener("submit", submitted);
      root.removeEventListener("input", input);
      document.removeEventListener("keydown", typed, true);
      document.removeEventListener("pointerover", elsewhere, true);
      resized.disconnect();
    },
    paint() { sections().forEach((section) => { stagesOf(section).forEach(watch); paintSection(section); }); },
  };
}
