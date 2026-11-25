/// Piece 7 of pass 274, a measured hand-off. "Build it" used to start from a
/// picture and the mockup's source; now foundry_read {id, spec: true} draws
/// the mockup off screen (foundry-look.ts) and reads what it measures
/// (apps/desktop/electron/foundry-spec-measure.ts): the page, its colours and
/// what each is for, its type styles, the spacing and corners it keeps to,
/// every part the walkthrough names with its place, size, type and colours,
/// the words in reading order, and how things move. Each colour is named by
/// the project's own token when the project has one that matches
/// (project-look.ts), and the project's components are listed, so the build
/// is written in the project's values and parts, not the mockup's.
import type { DemesneStore } from "@demesne/storage";
import { isRecord, optionNames, pickOption, walkFor, withFoundryFiles, type ProjectLook } from "@demesne/protocol";
import type { FoundryLook } from "./foundry-look.ts";
import { chromatic, colorHSL, loadProjectLook } from "./project-look.ts";

/// The kinds a spec is measured from: the ones drawn as a page of someone's product.
const SPEC_KINDS = new Set(["html", "react", "dashboard"]);

type Artifact = NonNullable<ReturnType<DemesneStore["getFoundryArtifact"]>>;

const hueGap = (a: number, b: number) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

/// The project's token for a measured colour: "= name" when it is the same
/// colour, "≈ name" when it is within a shade; "" when the project has none near.
export function tokenFor(value: string, look: ProjectLook | null): string {
  if (!look) return "";
  const hex = /^#[0-9a-f]{6}/i.exec(value)?.[0];
  const hsl = hex ? colorHSL(hex) : null;
  if (!hex || !hsl) return "";
  let best = "", bestGap = Infinity, same = false;
  for (const one of look.colors) {
    const other = colorHSL(one.value);
    if (!other) continue;
    if (one.value.toLowerCase() === hex.toLowerCase()) return `= ${one.name}`;
    const coloured = chromatic(hex) || chromatic(one.value);
    const gap = Math.abs(other.l - hsl.l) * 2 + Math.abs(other.s - hsl.s) * (coloured ? 1 : 0.2) + (coloured ? hueGap(other.h, hsl.h) / 180 : 0);
    if (gap < bestGap) { bestGap = gap; best = one.name; same = gap < 0.012; }
  }
  return bestGap <= 0.12 ? `${same ? "=" : "≈"} ${best}` : "";
}

const strings = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
const text = (value: unknown) => typeof value === "string" ? value : "";
const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : 0;

/// A colour as the hand-off writes it: its value, and the project's token when one matches.
const named = (value: string, look: ProjectLook | null) => { const token = tokenFor(value, look); return token ? `${value} (${token})` : value; };

/// The measured page as the model reads it: short lines, numbers first.
export function specReport(measured: unknown, look: ProjectLook | null): Record<string, unknown> | null {
  if (!isRecord(measured) || !isRecord(measured.page)) return null;
  const page = measured.page;
  const colours = (Array.isArray(measured.colours) ? measured.colours : []).filter(isRecord).map((one) => `${named(text(one.value), look)}: ${strings(one.uses).join(", ")}`);
  const type = (Array.isArray(measured.type) ? measured.type : []).filter(isRecord).map((one) =>
    `${text(one.font)} ${text(one.size)}, weight ${text(one.weight)}${text(one.line) && one.line !== "normal" ? `, line ${text(one.line)}` : ""}: “${text(one.sample)}”`);
  const parts = (Array.isArray(measured.parts) ? measured.parts : []).filter(isRecord).map((part) => {
    if (part.missing) return { name: text(part.name), missing: "its selector matched nothing drawn; read it from the source" };
    const line: Record<string, string> = { name: text(part.name), is: `<${text(part.tag)}> ${number(part.width)}×${number(part.height)} at ${number(part.x)},${number(part.y)}` };
    if (text(part.text)) line.words = text(part.text);
    if (text(part.font)) line.type = text(part.font);
    if (text(part.color)) line.colour = named(text(part.color), look);
    if (text(part.background)) line.ground = text(part.background).startsWith("none, on ") ? `none, on ${named(text(part.background).slice(9), look)}` : named(text(part.background), look);
    for (const [key, word] of [["padding", "padding"], ["radius", "corners"], ["border", "line"], ["gap", "gap"], ["layout", "layout"]] as const) if (text(part[key])) line[word] = text(part[key]);
    return line;
  });
  const motion = (Array.isArray(measured.motion) ? measured.motion : []).filter(isRecord).map((one) =>
    `${text(one.on)}: ${one.what === "animation" ? `animation ${text(one.name)}${text(one.frames) ? ` (${text(one.frames)})` : ""}` : text(one.what)}, ${text(one.duration)}, ${text(one.easing)}${text(one.delay) && one.delay !== "0ms" ? `, after ${text(one.delay)}` : ""}${text(one.when) ? `, ${text(one.when)}` : ""}`);
  const places = (Array.isArray(measured.places) ? measured.places : []).filter(isRecord).map((one) => ({ name: text(one.name), words: strings(one.words) })).filter((one) => one.name && one.words.length);
  const spacing = (Array.isArray(measured.spacing) ? measured.spacing : []).filter((n): n is number => typeof n === "number");
  return {
    page: `${number(page.width)}×${number(page.height)}, ground ${named(text(page.background), look)}, text ${named(text(page.color), look)}, ${text(page.font)}`,
    ...(colours.length ? { colours } : {}),
    ...(type.length ? { type } : {}),
    ...(spacing.length ? { spacing: `${spacing.join(", ")} px` } : {}),
    ...(strings(measured.radii).length ? { corners: strings(measured.radii).join(", ") } : {}),
    ...(parts.length ? { parts } : {}),
    ...(strings(measured.words).length ? { words: strings(measured.words) } : {}),
    ...(motion.length ? { motion } : {}),
    ...(places.length ? { other_places: places, other_places_rule: "Measured with its first place showing. These places show later (a next screen, a sheet): the same type, colours and spacing apply; their words are here and their layout is in the source." } : {}),
  };
}

export const SPEC_HOW = "Measured from the mockup as drawn at this width. Build to these numbers; where a colour names a project token, use the token, never the hex. Then look at the result and compare with foundry_built.";
const SPEC_PROJECT = "Build with the project's own components and files where one fits a part; write a new one only where none does.";

/// foundry_read {id, spec: true}: the measured hand-off of a mockup, or of one of its options.
export async function readSpec(look: FoundryLook | undefined, found: Artifact, asked: unknown, context: { workspaceRoot: string; signal: AbortSignal }, shots?: Parameters<FoundryLook>[0]["shots"]): Promise<string> {
  if (!SPEC_KINDS.has(found.kind) || found.built) throw new Error(`[no_spec] A spec is measured from a mockup of a screen (html, react, dashboard); this is ${found.built ? "the record of a build" : `a ${found.kind}`}. Hint: read it without spec`);
  if (!look) throw new Error("[no_spec] The mockup can't be drawn here (the desktop app is not installed), so nothing can be measured. Hint: read it without spec and build from its source");
  const all = found.kind === "html" ? optionNames(found.source) : [];
  const said = typeof asked === "string" ? asked.trim() : "";
  let option: string | undefined, index: number | undefined;
  if (all.length) {
    const at = said ? pickOption(all, said) : all.length === 1 ? 0 : -1;
    if (at < 0) throw new Error(`[spec_option] ${said ? `"${said}" is not an option of ${found.title}` : `${found.title} has ${all.length} options`}. Hint: option is the one to build: ${all.map((name) => `"${name}"`).join(", ")}`);
    option = all[at]; index = at;
  }
  const stage = found.versions.find((item) => item.version === found.version);
  const walk = walkFor(stage?.why?.walk, option);
  const parts = (walk?.parts ?? []).map((part) => ({ name: part.name, ...(part.at ? { at: part.at } : {}) }));
  const phone = stage?.stage?.surface?.frame === "phone";
  const result = await look({ kind: found.kind, source: withFoundryFiles(found.source, found.files), title: found.title, spec: { parts }, ...(phone ? { phone } : {}), ...(index !== undefined ? { option: index } : {}), ...(shots ? { shots } : {}) }, context.signal).catch(() => null);
  const project = loadProjectLook(context.workspaceRoot);
  const spec = specReport(result?.pages[0]?.spec, project);
  if (!spec) throw new Error("[no_spec] The mockup could not be drawn just now, so nothing was measured. Hint: try once more, or build from its source");
  return JSON.stringify({
    id: found.id, title: found.title, version: found.version, ...(option ? { option } : {}),
    spec,
    ...(project ? { project: { read_from: project.from, ...(project.kit ? { kit: project.kit } : {}), ...(project.components.length ? { components: project.components } : {}), rule: SPEC_PROJECT } } : {}),
    how: SPEC_HOW,
  });
}
