/// Piece 5 of pass 274, knobs: a page can name two to four of its own values
/// (room, corners, a hue) as knobs. Over the opened mockup on Foundry each
/// is a slider that changes the page at once, with no model run; one line
/// sends the settings to the chat, and they become the next version.
///
/// A knob is one line in the page's head, bound to a custom property the
/// page declares in :root and uses:
///   <meta name="knob" content="Room | --pad | 8 | 24 | px">
///   :root{ --pad: 14px }   …   padding: var(--pad)

export interface FoundryKnob { label: string; name: string; min: number; max: number; unit: string; value: number }
export const KNOBS_MAX = 4;
export const KNOB_UNITS = ["", "px", "%", "rem", "em", "deg", "ms", "s", "vw", "vh"] as const;
const HINT = 'Hint: <meta name="knob" content="Room | --pad | 8 | 24 | px"> in the head, with :root{--pad:14px} and var(--pad) where it applies; two to four knobs, for the values a person is likeliest to nudge';
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/// The knob lines as written, in order: label | --property | least | most | unit.
export function knobLines(source: string): string[] {
  const lines: string[] = [];
  for (const tag of source.match(/<meta\b[^>]*>/gi) ?? []) {
    if (!/\bname\s*=\s*["']knob["']/i.test(tag)) continue;
    const content = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
    lines.push((content?.[1] ?? content?.[2] ?? "").trim());
  }
  return lines;
}

/// One knob line read, without its value; null when it isn't a knob.
export function readKnobLine(line: string): Omit<FoundryKnob, "value"> | null {
  const parts = line.split("|").map((part) => part.trim());
  if (parts.length < 4 || parts.length > 5) return null;
  const [label, name, least, most, unit = ""] = parts as [string, string, string, string, string?];
  const min = Number(least), max = Number(most);
  if (!label || label.length > 24 || /[<>"&]/.test(label)) return null;
  if (!/^--[A-Za-z][\w-]{0,40}$/.test(name)) return null;
  if (!least || !most || !Number.isFinite(min) || !Number.isFinite(max) || min >= max) return null;
  if (!(KNOB_UNITS as readonly string[]).includes(unit)) return null;
  return { label, name, min, max, unit };
}

/// The value a page declares for a property, in :root or anywhere it is first set.
export function declaredValue(source: string, name: string): number | null {
  const found = new RegExp(`(?:^|[\\s;{])${escape(name)}\\s*:\\s*(-?\\d*\\.?\\d+)`, "m").exec(source);
  return found ? Number(found[1]) : null;
}

/// The page's knobs, as far as they are sound (what Foundry draws).
export function readKnobs(source: string): FoundryKnob[] {
  const knobs: FoundryKnob[] = [];
  for (const line of knobLines(source).slice(0, KNOBS_MAX)) {
    const knob = readKnobLine(line), value = knob ? declaredValue(source, knob.name) : null;
    if (knob && value !== null && !knobs.some((one) => one.name === knob.name)) knobs.push({ ...knob, value: Math.min(knob.max, Math.max(knob.min, value)) });
  }
  return knobs;
}

/// What is wrong with a page's knobs, for the model to fix at save; null when they are sound or it has none.
export function knobProblem(source: string): string | null {
  const lines = knobLines(source);
  if (!lines.length) return null;
  if (lines.length > KNOBS_MAX) return `[invalid_input] ${lines.length} knobs; a page takes at most ${KNOBS_MAX}. ${HINT}`;
  const seen = new Set<string>();
  for (const line of lines) {
    const knob = readKnobLine(line);
    if (!knob) return `[invalid_input] This knob can't be read: "${line.slice(0, 80)}". Write label | --property | least | most | unit, the least under the most, the unit one of px % rem em deg ms s vw vh or none. ${HINT}`;
    if (seen.has(knob.name)) return `[invalid_input] Two knobs turn ${knob.name}. One knob per property. ${HINT}`;
    seen.add(knob.name);
    const value = declaredValue(source, knob.name);
    if (value === null) return `[invalid_input] The knob "${knob.label}" turns ${knob.name}, but the page never sets it to a number. Declare it in :root, like ${knob.name}: ${knob.min}${knob.unit}. ${HINT}`;
    if (!new RegExp(`var\\(\\s*${escape(knob.name)}\\b`).test(source)) return `[invalid_input] The knob "${knob.label}" turns ${knob.name}, but nothing on the page uses var(${knob.name}), so moving it would change nothing. ${HINT}`;
    if (value < knob.min || value > knob.max) return `[invalid_input] The knob "${knob.label}" runs ${knob.min} to ${knob.max}, but the page sets ${knob.name} to ${value}. Start it inside its range. ${HINT}`;
  }
  return null;
}

/// A value as the page writes it: "18px", "175".
export const knobValue = (knob: Pick<FoundryKnob, "unit">, value: number) => `${Math.round(value * 100) / 100}${knob.unit}`;
/// A slider's step: whole numbers on a wide range, finer on a narrow one.
export const knobStep = (knob: Pick<FoundryKnob, "min" | "max">) => { const span = knob.max - knob.min; return span >= 20 ? 1 : span >= 4 ? 0.5 : span >= 1 ? 0.05 : 0.01; };

/// The settings a person left the knobs on, as the message that makes them the next version.
export function knobsMessage(mockup: { id: string; title: string; version: number }, knobs: readonly FoundryKnob[], set: Readonly<Record<string, number>>): string {
  const moved = knobs.filter((knob) => typeof set[knob.name] === "number" && set[knob.name] !== knob.value);
  if (!moved.length) return "";
  const lines = moved.map((knob) => `- ${knob.label}: ${knob.name} ${knobValue(knob, set[knob.name]!)} (was ${knobValue(knob, knob.value)})`);
  return `On the Foundry page "${mockup.title}" (id ${mockup.id}, v${mockup.version}) I moved its knobs to where I like it:\n${lines.join("\n")}\n`
    + "Make that the next version: foundry_read it, then foundry_edit only those values where the page declares them. Keep the knobs and change nothing else.";
}
