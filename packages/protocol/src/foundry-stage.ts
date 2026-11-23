/// Where a Foundry mockup sits and how its demo goes (pass 221 A). The model
/// says both when it saves; Foundry draws the surface and plays the demo
/// around the page, so the page itself holds only the thing being made: no
/// Replay, Next step or option switcher inside it.
import { parseSteps, type TryStep } from "./foundry-try.ts";

/// window: a Mac window. browser: a browser window. phone: a phone.
/// part: just the piece, at its own size. page: a whole page, full width.
export const FOUNDRY_FRAMES = ["window", "browser", "phone", "part", "page"] as const;
/// What the surface sits on.
export const FOUNDRY_BACKDROPS = ["desk", "paper", "dark", "white"] as const;
export type FoundryFrame = typeof FOUNDRY_FRAMES[number];
export type FoundryBackdrop = typeof FOUNDRY_BACKDROPS[number];

export interface FoundrySurface {
  frame: FoundryFrame;
  /// The design size in CSS pixels. Height 0 (or left out on part and page)
  /// means as tall as the page's content.
  width?: number;
  height?: number;
  backdrop?: FoundryBackdrop;
  /// A window's title, or a browser's address.
  title?: string;
}

/// A demo step: one of foundry_try's steps, with the line shown under the
/// stage while it plays.
export type FoundryDemoStep = TryStep & { say?: string };

export interface FoundryStage { surface?: FoundrySurface; demo?: FoundryDemoStep[] }

export const DEMO_MAX_STEPS = 12;
const SAY_MAX = 120, TITLE_MAX = 80;

/// The size a frame is drawn at when the model names none.
export const FRAME_SIZES: Record<FoundryFrame, { width: number; height: number }> = {
  window: { width: 1100, height: 700 }, browser: { width: 1280, height: 800 }, phone: { width: 390, height: 844 },
  part: { width: 360, height: 0 }, page: { width: 1280, height: 0 },
};
const DEFAULT_BACKDROP: Record<FoundryFrame, FoundryBackdrop> = { window: "desk", browser: "desk", phone: "dark", part: "paper", page: "white" };

/// A surface with every value filled in, as Foundry draws it.
export function drawnSurface(surface: FoundrySurface): Required<Omit<FoundrySurface, "title">> & { title: string } {
  const size = FRAME_SIZES[surface.frame];
  return { frame: surface.frame, width: surface.width ?? size.width, height: surface.height ?? size.height, backdrop: surface.backdrop ?? DEFAULT_BACKDROP[surface.frame], title: surface.title ?? "" };
}

const pixels = (value: unknown, what: string, zero: boolean) => {
  const n = Number(value);
  if (!Number.isFinite(n) || (n === 0 ? !zero : n < 120 || n > 2400)) throw new Error(`surface ${what} is pixels from 120 to 2400${zero ? " (0 for as tall as the content)" : ""}`);
  return Math.round(n);
};

/// The model's surface, checked: anything wrong is an error it can fix.
export function parseSurface(value: unknown): FoundrySurface {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("surface must be an object like {frame: \"phone\"}");
  const raw = value as Record<string, unknown>;
  const frame = FOUNDRY_FRAMES.find((name) => name === raw.frame);
  if (!frame) throw new Error(`surface frame must be one of ${FOUNDRY_FRAMES.join(", ")}`);
  const out: FoundrySurface = { frame };
  if (raw.width !== undefined) out.width = pixels(raw.width, "width", false);
  if (raw.height !== undefined) out.height = pixels(raw.height, "height", true);
  if (raw.backdrop !== undefined) {
    const backdrop = FOUNDRY_BACKDROPS.find((name) => name === raw.backdrop);
    if (!backdrop) throw new Error(`surface backdrop must be one of ${FOUNDRY_BACKDROPS.join(", ")}`);
    out.backdrop = backdrop;
  }
  if (raw.title !== undefined) {
    if (typeof raw.title !== "string" || raw.title.length > TITLE_MAX) throw new Error(`surface title must be text of up to ${TITLE_MAX} characters`);
    if (raw.title.trim()) out.title = raw.title.trim();
  }
  return out;
}

/// A step written the way models tend to ({action: "click", selector: "#go"})
/// is the same step: read it as {click: "#go"} rather than send the page back.
function plainStep(step: Record<string, unknown>): Record<string, unknown> {
  const action = typeof step.action === "string" ? step.action.toLowerCase() : "";
  if (!["click", "hover", "type", "key", "scroll", "wait"].includes(action) || step[action] !== undefined) return step;
  const { action: _action, selector, target, name, text, value, ...rest } = step;
  const on = selector ?? target ?? name;
  if (action === "click" || action === "hover") return { ...rest, [action]: on };
  if (action === "type") return { ...rest, type: text ?? value, ...(on !== undefined ? { into: on } : {}) };
  return { ...rest, [action]: value ?? text ?? on ?? rest.ms ?? rest.by };
}

/// The model's demo, checked: foundry_try's steps, each with an optional say.
export function parseDemo(value: unknown): FoundryDemoStep[] {
  if (!Array.isArray(value) || !value.length) throw new Error(`demo must be a list of one to ${DEMO_MAX_STEPS} steps`);
  if (value.length > DEMO_MAX_STEPS) throw new Error(`A demo has at most ${DEMO_MAX_STEPS} steps`);
  const says = value.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    const say = (raw as Record<string, unknown>).say;
    if (say === undefined) return undefined;
    if (typeof say !== "string" || say.length > SAY_MAX) throw new Error(`Step ${index + 1}: say must be text of up to ${SAY_MAX} characters`);
    return say.replace(/\s+/g, " ").trim() || undefined;
  });
  const steps = parseSteps(value.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
    const { say: _say, ...step } = raw as Record<string, unknown>;
    return plainStep(step);
  }));
  return steps.map((step, index) => (says[index] ? { ...step, say: says[index] } : step));
}

/// Both, from a tool's arguments; null when neither was given.
export function parseStage(input: { surface?: unknown; demo?: unknown }): FoundryStage | null {
  const stage: FoundryStage = {};
  if (input.surface !== undefined && input.surface !== null) stage.surface = parseSurface(input.surface);
  if (input.demo !== undefined && input.demo !== null) stage.demo = parseDemo(input.demo);
  return stage.surface || stage.demo ? stage : null;
}

/// Kept with a version as JSON; "" for none.
export function stageText(stage: FoundryStage | null | undefined): string {
  return stage && (stage.surface || stage.demo?.length) ? JSON.stringify(stage) : "";
}

/// Read back; anything that no longer parses is dropped rather than shown wrong.
export function stageFromText(text: string | null | undefined): FoundryStage | null {
  if (!text) return null;
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    const stage: FoundryStage = {};
    try { if (raw.surface) stage.surface = parseSurface(raw.surface); } catch {}
    try { if (raw.demo) stage.demo = parseDemo(raw.demo); } catch {}
    return stage.surface || stage.demo ? stage : null;
  } catch { return null; }
}

/// Buttons that only exist to run a demo, switch options or fake a state:
/// the real thing would not have them, so a page that draws one is sent
/// back (pass 221 A).
const STATE = "empty|loading|error|success|offline|hover|pressed|focus(?:ed)?|disabled|default|filled|full|done|failed";
export const DEMO_CONTROL = new RegExp([
  String.raw`^(?:[▶►⏵↻⟳⟲]\s*)?(?:replay|re-play)(?:\s*[↻⟳⟲])?$`,
  String.raw`^(?:[▶►⏵↻⟳⟲]\s*)?(?:play|run|watch|start|restart|replay|reset|rewind|skip|stop|pause)\s+(?:the\s+)?(?:demo|animation|walkthrough|sequence|tour|simulation)$`,
  String.raw`^(?:next|previous|prev)\s+step(?:\s*[→›»])?$|^(?:[←‹«]\s*)?(?:previous|prev)\s+step$`,
  String.raw`^(?:demo(?:\s+mode)?|simulate|simulation)$`,
  String.raw`^(?:show|simulate|trigger|toggle|preview|fake|force|see)\s+(?:the\s+|an?\s+)?(?:${STATE})(?:\s+state)?$`,
  String.raw`^(?:simulate|fake)\s+\S+(?:\s+\S+)?$`,
  String.raw`^(?:${STATE})\s+state$`,
  String.raw`^(?:state|states|view state|demo state)\s*:.*$`,
].join("|"), "iu");
/// Names that only a pretend state has: a row of them is a state switcher.
const STATE_WORD = /^(?:empty|loading|error|success|offline|hover|pressed|focus(?:ed)?|disabled)$/iu, ONLY_PRETEND = /^(?:empty|loading|hover|pressed|focus(?:ed)?|disabled|offline)$/iu;

/// The demo-only controls a page draws, by their text: buttons whose whole
/// visible text is "Replay", "Play demo", "Next step", "Show error state"
/// and the like, and a row of state names (Empty · Loading · Error) that
/// only switches what the page pretends.
export function demoControls(source: string): string[] {
  const found = new Set<string>(), states: string[] = [];
  const body = source.replace(/<script\b[\s\S]*?<\/script>/gi, "").replace(/<style\b[\s\S]*?<\/style>/gi, "").replace(/<!--[\s\S]*?-->/g, "");
  const words = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;/g, " ").replace(/&[a-z]+;|&#\d+;/gi, "").replace(/\s+/g, " ").trim();
  for (const match of body.matchAll(/<(button|a|label|option|(?:div|span|li)(?=[^>]*\brole\s*=\s*["']?(?:button|tab|radio)))\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const text = words(match[2]!);
    if (text && DEMO_CONTROL.test(text)) found.add(text);
    else if (text && STATE_WORD.test(text) && !states.some((seen) => seen.toLowerCase() === text.toLowerCase())) states.push(text);
    if (found.size >= 5) break;
  }
  if (states.length >= 2 && states.some((word) => ONLY_PRETEND.test(word))) found.add(states.join(" · "));
  return [...found];
}

/// Pass 223 A: a review of something that exists is one page built on
/// <d-review>: the screen as it is today with the parts that most need work
/// marked, then each part alone at its own size, as "Today" beside two or
/// three options with a pick. Foundry draws the outlines, numbers and names
/// (foundry-kit/parts.js); this reads the page's shape so a save can hold it
/// to that.
export const REVIEW_PAGE = /<d-review\b/i;
export const MAX_REVIEW_PARTS = 3, REVIEW_OPTIONS = [2, 3] as const;
/// todayShot: the part's Today is cut from a real picture (<d-shot box>).
export interface ReviewPart { name: string; why: string; options: string[]; today: boolean; recommended: boolean; todayShot: boolean }
/// shot: the screen as it is today is a real picture (<d-shot src>), pass 240 A.
export interface ReviewShape { today: boolean; shot: boolean; marks: number; parts: ReviewPart[] }

const TAG = (name: string) => new RegExp(`<${name}\\b(?:[^>"']|"[^"]*"|'[^']*')*>`, "gi");
const attribute = (tag: string, name: string) => {
  const found = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i").exec(tag);
  return found ? (found[1] ?? found[2] ?? found[3] ?? "").trim() : null;
};
const has = (tag: string, name: string) => new RegExp(`\\s${name}(?=[\\s=>/])`, "i").test(tag.replace(/"[^"]*"|'[^']*'/g, '""'));

/// The shape of a review page, or null when the page is not one.
export function reviewOf(source: string): ReviewShape | null {
  if (!REVIEW_PAGE.test(source)) return null;
  const body = source.replace(/<script\b[\s\S]*?<\/script>/gi, "").replace(/<style\b[\s\S]*?<\/style>/gi, "").replace(/<!--[\s\S]*?-->/g, "");
  const sections = [...body.matchAll(TAG("section"))].map((match) => ({ tag: match[0], at: match.index!, end: match.index! + match[0].length }));
  const now = sections.find((section) => has(section.tag, "data-today"));
  const starts = sections.filter((section) => has(section.tag, "data-part"));
  const count = (text: string | null) => (text ?? "").split("|").filter((item) => item.trim()).length;
  const nowShots = now ? [...body.slice(now.end, starts.find((start) => start.at > now.at)?.at ?? body.length).matchAll(TAG("d-shot"))].map((match) => match[0]).filter((tag) => !!attribute(tag, "src")) : [];
  const marks = (now ? count(attribute(now.tag, "marks")) : 0) + nowShots.reduce((sum, tag) => sum + count(attribute(tag, "marks")), 0) + (body.match(/\sdata-mark\s*=/gi)?.length ?? 0);
  const parts = starts.map((start, index): ReviewPart => {
    const inside = body.slice(start.end, starts[index + 1]?.at ?? body.length);
    const tags = [...inside.matchAll(TAG("[a-z][a-z0-9-]*"))];
    const options = tags.map((match) => attribute(match[0], "data-option")).filter((name): name is string => !!name);
    const todayAt = tags.findIndex((match) => /^today\b/i.test(attribute(match[0], "data-option") ?? ""));
    // The part's Today runs up to the next option.
    const rest = todayAt < 0 ? [] : tags.slice(todayAt + 1), next = rest.findIndex((match) => attribute(match[0], "data-option") !== null);
    const todayShot = (next < 0 ? rest : rest.slice(0, next)).some((match) => /^<d-shot\b/i.test(match[0]) && !!attribute(match[0], "src") && !!attribute(match[0], "box"));
    const pick = [...inside.matchAll(TAG("d-compare"))].map((match) => attribute(match[0], "recommended")).find((name) => !!name) ?? "";
    const others = options.filter((name) => !/^today\b/i.test(name));
    return { name: attribute(start.tag, "data-part") ?? "", why: attribute(start.tag, "why") ?? "", options: others,
      today: options.length > others.length, recommended: !!pick && others.some((name) => name.startsWith(pick)), todayShot };
  });
  return { today: !!now, shot: nowShots.length > 0, marks, parts };
}

/// Pass 240 A: a review's Today is the real screen. The picture is one this
/// chat has: a window capture, the browser's picture of a page, or one the
/// person attached. Foundry keeps it with the mockup.
export const SHOT_ASK = 'A review starts from a real picture of the screen as it is, and this one has none. Hint: capture it first (capture_window, with application "Demesne" for Demesne itself; the browser\'s picture for a web page; or a picture the person attached), then <section data-today><d-shot src="IMAGE_ID" marks="x,y,w,h | x,y,w,h"></d-shot></section> with the picture\'s image artifact id and one box per part in its own pixels. If nothing can be captured, ask the person for a screenshot instead of drawing the screen';

/// Every <d-shot> a page shows: the picture it names and its boxes, as written.
export interface ShotUse { src: string; marks: string[]; box: string | null }
export function shotsOf(source: string): ShotUse[] {
  const body = source.replace(/<script\b[\s\S]*?<\/script>/gi, "").replace(/<style\b[\s\S]*?<\/style>/gi, "").replace(/<!--[\s\S]*?-->/g, "");
  return [...body.matchAll(TAG("d-shot"))].map((match) => ({ src: attribute(match[0], "src") ?? "", box: attribute(match[0], "box"),
    marks: (attribute(match[0], "marks") ?? "").split("|").map((item) => item.trim()).filter(Boolean) }));
}
/// Step 6: a picture from the chat in any mockup, as picture:IMAGE_ID where
/// an address goes (<img src>, CSS url(), a Markdown image, a React prop).
/// Foundry keeps the picture with the mockup and serves it there.
export const PICTURE_REF = /\bpicture:([A-Za-z0-9_-]{1,200})/g;
/// The pictures a source names that way, once each, in order.
export function picturesOf(source: string): string[] {
  return [...new Set([...source.matchAll(PICTURE_REF)].map((match) => match[1]!))];
}
/// A box written x,y,w,h (commas or spaces), or null.
export function shotBox(text: string): { x: number; y: number; width: number; height: number } | null {
  const n = text.trim().split(/[\s,]+/).map(Number);
  return n.length === 4 && n.every(Number.isFinite) && n[2]! > 0 && n[3]! > 0 ? { x: n[0]!, y: n[1]!, width: n[2]!, height: n[3]! } : null;
}

/// What stops a review page from being one, as a refusal with its hint; null when it holds.
export function reviewProblem(source: string): string | null {
  const review = reviewOf(source);
  if (!review) return null;
  const SHAPE = 'Hint: <d-review><section data-today><d-shot src="IMAGE_ID" marks="x,y,w,h | x,y,w,h"></d-shot></section><section data-part="Name" why="what is wrong, in one line"><d-compare recommended="B"><section data-option="Today"><d-shot src="IMAGE_ID" box="x,y,w,h"></d-shot></section><section data-option="A">…</section><section data-option="B">…</section></d-compare></section></d-review>';
  // Real models built the whole sheet in a script three times in five (pass 223 runs): say that, not "has none".
  const scripted = [...source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].some((match) => /<section\b[^>]*\bdata-(today|part)\b/i.test(match[1]!) || REVIEW_PAGE.test(match[1]!));
  if (scripted && (!review.today || !review.parts.length)) return `[review] This review is built by a script, so its parts cannot be read. Hint: write <d-review> and every <section> as plain markup in the page, in the shape below; a script may still fill or change what is inside a section. ${SHAPE.replace(/^Hint: /, "")}`;
  if (!review.today) return `[review] A review starts with the screen as it is today, and this one has none. ${SHAPE}`;
  if (!review.shot) return `[review_shot] ${SHOT_ASK}`;
  if (!review.parts.length) return `[review] This review names no part that needs work. ${SHAPE}`;
  if (review.parts.length > MAX_REVIEW_PARTS) return `[too_many_parts] This review has ${review.parts.length} parts; at most ${MAX_REVIEW_PARTS}. Hint: keep the ${MAX_REVIEW_PARTS} that most need work, most important first, and name the rest in the chat`;
  if (review.marks < review.parts.length) return `[review] ${review.marks ? `Only ${review.marks} of the ${review.parts.length} parts are` : "No part is"} marked on the screen as it is. Hint: marks="x,y,w,h | x,y,w,h" on the <d-shot>, one box per part in order, in the picture's own pixels, so each part is outlined where it sits`;
  for (const part of review.parts) {
    const name = `"${part.name || "A part"}"`;
    if (!part.why) return `[review] ${name} does not say why it needs work. Hint: why="one line on what is wrong, from what you saw" on its section`;
    if (!part.today) return `[review] ${name} has no "Today". Hint: its first option is <section data-option="Today"><d-shot src="IMAGE_ID" box="x,y,w,h"></d-shot></section>, that piece cut from the picture, so each option differs from it by the change alone`;
    if (!part.todayShot) return `[review_shot] ${name}'s Today is drawn, not cut from the picture. Hint: <section data-option="Today"><d-shot src="IMAGE_ID" box="x,y,w,h"></d-shot></section>, the piece's box in the picture's own pixels; only the options are drawn`;
    if (part.options.length < REVIEW_OPTIONS[0]) return `[review] ${name} offers ${part.options.length === 1 ? "one option" : "no options"} beside Today. Hint: two or three genuinely different options for each part`;
    if (part.options.length > REVIEW_OPTIONS[1]) return `[too_many_options] ${name} has ${part.options.length} options beside Today; at most ${REVIEW_OPTIONS[1]}. Hint: keep the best ${REVIEW_OPTIONS[1]}`;
    if (!part.recommended) return `[no_recommendation] ${name} has no pick. Hint: recommended="<the option's name>" on its <d-compare>, and say why in the chat`;
  }
  return null;
}
