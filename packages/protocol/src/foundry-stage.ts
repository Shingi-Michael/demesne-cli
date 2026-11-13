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
    return step;
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

/// Buttons that only exist to run a demo or switch options: the real thing
/// would not have them, so a page that draws one is sent back (pass 221 A).
export const DEMO_CONTROL = /^(?:[▶►⏵↻⟳⟲]\s*)?(?:replay|re-play)(?:\s*[↻⟳⟲])?$|^(?:[▶►⏵↻⟳⟲]\s*)?(?:play|run|watch|start|restart|replay|reset|rewind|skip)\s+(?:the\s+)?(?:demo|animation|walkthrough|sequence|tour)$|^(?:next|previous|prev)\s+step(?:\s*[→›»])?$|^(?:[←‹«]\s*)?(?:previous|prev)\s+step$/iu;

/// The demo-only controls a page draws, by their text: buttons whose whole
/// visible text is "Replay", "Play demo", "Next step" and the like.
export function demoControls(source: string): string[] {
  const found = new Set<string>();
  const body = source.replace(/<script\b[\s\S]*?<\/script>/gi, "").replace(/<style\b[\s\S]*?<\/style>/gi, "").replace(/<!--[\s\S]*?-->/g, "");
  for (const match of body.matchAll(/<(button|a)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const text = match[2]!.replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;/g, " ").replace(/&[a-z]+;|&#\d+;/gi, "").replace(/\s+/g, " ").trim();
    if (text && DEMO_CONTROL.test(text)) found.add(text);
    if (found.size >= 5) break;
  }
  return [...found];
}
