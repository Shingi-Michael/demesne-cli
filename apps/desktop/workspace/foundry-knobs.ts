/// Piece 5 of pass 274, knobs: the sliders over an opened mockup, one per
/// value the page named as a knob (foundry-kit/knobs.js reads them off the
/// page). Moving one changes the page at once, with no model run. Once any
/// has moved, one quiet line offers to send the settings to the chat, where
/// they become the next version.
import { KNOBS_MAX, KNOB_UNITS, knobStep, knobValue, type FoundryKnob } from "@demesne/protocol";

const h = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

/// The knobs a page reported, kept only as far as they are sound: the page is the model's, so nothing is trusted.
export function cleanKnobs(value: unknown): FoundryKnob[] {
  const knobs: FoundryKnob[] = [];
  for (const item of Array.isArray(value) ? value : []) {
    if (!item || typeof item !== "object" || knobs.length >= KNOBS_MAX) continue;
    const { label, name, min, max, unit, value: at } = item as Record<string, unknown>;
    if (typeof label !== "string" || !label.trim() || label.length > 24) continue;
    if (typeof name !== "string" || !/^--[A-Za-z][\w-]{0,40}$/.test(name) || knobs.some((one) => one.name === name)) continue;
    if (typeof min !== "number" || typeof max !== "number" || typeof at !== "number" || ![min, max, at].every(Number.isFinite) || min >= max) continue;
    if (typeof unit !== "string" || !(KNOB_UNITS as readonly string[]).includes(unit)) continue;
    knobs.push({ label: label.trim(), name, min, max, unit, value: Math.min(max, Math.max(min, at)) });
  }
  return knobs;
}

export const KNOBS_SEND = "Send these to the chat";

/// The row over the opened mockup: a slider per knob, and the line that sends them (hidden until one moves).
export function knobsHTML(knobs: readonly FoundryKnob[]) {
  if (!knobs.length) return "";
  return `<div class="fd-knobs" role="group" aria-label="Knobs for this page" data-knobs="${h(JSON.stringify(knobs))}">`
    + knobs.map((knob) => `<label class="fd-knob"><span>${h(knob.label)}</span><input type="range" min="${knob.min}" max="${knob.max}" step="${knobStep(knob)}" value="${knob.value}" data-knob="${h(knob.name)}" aria-label="${h(knob.label)}"><output>${h(knobValue(knob, knob.value))}</output></label>`).join("")
    + `<span class="fd-knobs-say" role="status"><button type="button" class="fd-said-b fd-knobs-send" data-action="foundry-knobs-send" hidden>${KNOBS_SEND}</button></span></div>`;
}

/// What the sliders stand on now, by property; and whether any has left where the page set it.
export function knobsSet(row: Element): { knobs: FoundryKnob[]; set: Record<string, number>; moved: boolean } {
  let knobs: FoundryKnob[] = [];
  try { knobs = cleanKnobs(JSON.parse((row as HTMLElement).dataset.knobs ?? "[]")); } catch { /* none */ }
  const set: Record<string, number> = {};
  for (const input of row.querySelectorAll<HTMLInputElement>("input[data-knob]")) {
    const knob = knobs.find((one) => one.name === input.dataset.knob), value = Number(input.value);
    if (knob && Number.isFinite(value)) set[knob.name] = Math.min(knob.max, Math.max(knob.min, value));
  }
  return { knobs, set, moved: knobs.some((knob) => set[knob.name] !== undefined && set[knob.name] !== knob.value) };
}
