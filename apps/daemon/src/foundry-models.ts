/// Piece 3 of pass 274, every model draws it. Demesne runs every model the
/// person has connected, so one design ask can go to several at once: the
/// chat's model draws its own take and hands the brief to this tool, each
/// other model answers with one variant, and they come back as tabs of one
/// mockup, each named by the model that drew it. It costs a model run per
/// model, so it is only for when the person asks ("have every model draw
/// this", "what would GPT make of it").
///
/// Each drawing is a fragment (the inside of a page and its stylesheet), so
/// several can live in one page: every stylesheet is wrapped in @scope under
/// its own tab, where it can't reach the others.
import { isRecord } from "@demesne/protocol";
import type { ProviderToolDefinition } from "@demesne/providers";
import { FOUNDRY_KIT_STYLE, FOUNDRY_PARTS_SCRIPT } from "./foundry.ts";

export const MODELS_TOOL = "foundry_models";
/// Other models asked at once; with the chat's own that is four tabs, under Foundry's five.
export const MODELS_MAX_OTHERS = 3;
const MAX_HTML = 120 * 1024, MAX_CSS = 60 * 1024;

export interface DrawModel { id: string; provider: string }
export interface Drawing { name: string; css: string; html: string; what: string; parts: { name: string; says: string }[]; why: string }
export interface DrawnBy { model: string; drawing: Drawing }

const DRAWING_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["name", "html", "css", "what", "parts", "why"],
  properties: {
    name: { type: "string", maxLength: 40, description: "Two or three words for the shape of your take (\"Days first\")." },
    html: { type: "string", description: "The inside of the page's body: no <html>, <head>, <body>, <style> or <script>. Kit parts (d-icon, d-chart, d-phone…) work." },
    css: { type: "string", description: "Its stylesheet. Write :root for page-wide values (--accent, --ink, --paper) and body for the page's background and padding." },
    what: { type: "string", maxLength: 500, description: "What it is and who it is for." },
    parts: { type: "array", minItems: 2, maxItems: 6, items: { type: "object", additionalProperties: false, required: ["name", "says"], properties: { name: { type: "string", maxLength: 80 }, says: { type: "string", maxLength: 300 } } } },
    why: { type: "string", maxLength: 500, description: "Why it is shaped this way." },
  },
} as const;

/// The tool as one turn sees it: the other models it can ask, by id.
export function modelsDefinitionFor(models: readonly DrawModel[], current: string): ProviderToolDefinition | null {
  const others = models.filter((model) => model.id !== current);
  if (!others.length) return null;
  return {
    name: MODELS_TOOL,
    description: "Every model draws it: only when the person asks for other models' takes on a design (\"have every model draw this\", \"what would another model make\"). "
      + "Draw your own take first, then call this with it and a brief: up to three other models each draw one variant from the brief alone, at the same time, and all of them become tabs of one Foundry mockup, each named by its model. "
      + "It costs a full model run for each, so never use it unasked. Afterwards say in your answer how the takes differ and which you would pick.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["title", "description", "brief", "mine"],
      properties: {
        title: { type: "string", maxLength: 200, description: "The mockup's name, two to four words." },
        description: { type: "string", maxLength: 600, description: "One or two sentences on what it is." },
        brief: { type: "string", minLength: 40, maxLength: 8000, description: "The whole ask for a designer who sees nothing of this chat: who it is for, what must be on it, the real content (names, numbers), the size, and any look to keep. Do not describe your own take." },
        mine: DRAWING_SCHEMA,
        models: { type: "array", maxItems: MODELS_MAX_OTHERS, items: { type: "string", enum: others.map((model) => model.id) },
          description: `Which other models draw it; omit for one from each other provider. Available: ${others.map((model) => `${model.id} (${model.provider})`).join(", ")}.` },
      },
    },
  };
}

export interface ModelsInput { title: string; description: string; brief: string; mine: Drawing; models?: string[] }

const text = (value: unknown, max: number) => typeof value === "string" ? value.trim().slice(0, max) : "";

/// A drawing as given (by the chat's model in the tool call, or by another model as JSON), or why it can't be used.
export function drawingOf(value: unknown): Drawing {
  if (!isRecord(value)) throw new Error("a drawing is an object: {name, html, css, what, parts, why}");
  const html = cleanHTML(typeof value.html === "string" ? value.html : "");
  if (!html.trim()) throw new Error("the drawing has no html");
  if (html.length > MAX_HTML) throw new Error("the drawing's html is over 120 KB");
  const css = typeof value.css === "string" ? value.css.slice(0, MAX_CSS) : "";
  const parts = (Array.isArray(value.parts) ? value.parts : []).flatMap((part) => isRecord(part) && text(part.name, 80) && text(part.says, 300) ? [{ name: text(part.name, 80), says: text(part.says, 300) }] : []).slice(0, 6);
  return { name: text(value.name, 40) || "Take", css, html, what: text(value.what, 500) || "One take on the brief.",
    parts: parts.length >= 2 ? parts : [{ name: "Layout", says: "How the page is arranged." }, { name: "Main action", says: "The one thing to do here." }],
    why: text(value.why, 500) || "The shape this model chose for the brief." };
}

export function parseModelsInput(input: unknown, available: readonly DrawModel[], current: string): ModelsInput & { ask: DrawModel[] } {
  if (!isRecord(input)) throw new Error("[invalid_input] foundry_models needs {title, description, brief, mine}");
  const title = text(input.title, 200), description = text(input.description, 600), brief = text(input.brief, 8000);
  if (!title) throw new Error("[invalid_input] The mockup needs a title");
  if (!description) throw new Error("[invalid_input] The mockup needs a description");
  if (brief.length < 40) throw new Error("[invalid_input] The brief is too short for a designer who sees nothing of this chat. Hint: who it is for, what must be on it, the real content, the size");
  let mine: Drawing;
  try { mine = drawingOf(input.mine); } catch (error) { throw new Error(`[invalid_input] mine: ${error instanceof Error ? error.message : "not a drawing"}. Hint: draw your own take first`); }
  const others = available.filter((model) => model.id !== current);
  const named = Array.isArray(input.models) ? input.models.filter((id): id is string => typeof id === "string") : [];
  const unknown = named.find((id) => !others.some((model) => model.id === id));
  if (unknown) throw new Error(`[invalid_input] ${unknown} is not another model here. Available: ${others.map((model) => model.id).join(", ") || "none"}`);
  // Named ones as named; otherwise the first model of each other provider.
  const currentProvider = available.find((model) => model.id === current)?.provider;
  const ask = named.length ? named.map((id) => others.find((model) => model.id === id)!)
    : others.filter((model, at) => model.provider !== currentProvider && others.findIndex((one) => one.provider === model.provider) === at);
  const picked = (ask.length ? ask : others).filter((model, at, all) => all.findIndex((one) => one.id === model.id) === at).slice(0, MODELS_MAX_OTHERS);
  if (!picked.length) throw new Error("[unavailable] No other model is connected, so there is nobody else to draw it. Hint: save your own take with foundry_save");
  return { title, description, brief, mine, ask: picked };
}

/// What another model is told: the brief is all it knows.
export function drawSystem(guide: string): string {
  return "You are a product designer taking part in a design round: several models each draw one take on the same brief, and the person compares them side by side. "
    + "Draw ONE page: your best single answer to the brief, not options. Make a real choice of layout and say why. "
    + "Reply with one JSON object and nothing else (no code fence, no prose): "
    + "{\"name\": two or three words for the shape of your take, \"html\": the inside of the page's body, \"css\": its stylesheet, \"what\": what it is and who it is for, "
    + "\"parts\": [{\"name\", \"says\"}] two to six parts and what each does, \"why\": why it is shaped this way}. "
    + "The html has no <html>, <head>, <body>, <style> or <script>; it is static (no JavaScript). In the css, write :root for page-wide values and body for the page's background and padding. "
    + "Foundry's kit is loaded: variables --ink, --paper, --accent, --muted, --hair, --tone-2, --font, --radius, the type scale var(--text-xs|sm|md|lg|xl|display) and the space scale var(--space-1…8); plain elements are styled. "
    + "Real content from the brief, never lorem ipsum.\n\n" + guide;
}

/// The drawing in a model's answer: the JSON object, with or without a code fence or words around it.
export function readDrawing(answer: string): Drawing {
  const body = answer.replace(/\n\n\(Sub-agent on [^\n]*\)\s*$/, "");
  const start = body.indexOf("{"), end = body.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("it answered without a drawing");
  let parsed: unknown;
  try { parsed = JSON.parse(body.slice(start, end + 1)); } catch { throw new Error("its drawing was not valid JSON"); }
  return drawingOf(parsed);
}

/// A fragment only: no document wrappers, no scripts, no stylesheets of its own, no handlers.
export function cleanHTML(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, "").replace(/<script\b[^>]*>/gi, "")
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, "")
    .replace(/<\/?(?:html|head|body|d-compare)\b[^>]*>/gi, "").replace(/<!doctype[^>]*>/gi, "")
    .replace(/<(?:link|meta|base|title)\b[^>]*>(?:[^<]*<\/title\s*>)?/gi, "")
    .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/\sdata-option\s*=\s*(?:"[^"]*"|'[^']*')/gi, "")
    .trim();
}

/// A stylesheet made to hold only under its own tab. Rules go inside
/// @scope (the <style> sits in the tab, so the scope is the tab); :root,
/// html and body become :scope, so page-wide values and the page's
/// background land on the tab. @keyframes and @font-face are document-wide
/// by nature and stay outside; @import is dropped.
export function scopedCSS(css: string): string {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/<\/style/gi, "");
  const outside: string[] = [];
  let inside = "", at = 0;
  while (at < source.length) {
    const next = source.slice(at).search(/@(?:-webkit-)?(?:keyframes|font-face|import|property)\b/i);
    if (next === -1) { inside += source.slice(at); break; }
    inside += source.slice(at, at + next);
    const from = at + next, brace = source.indexOf("{", from), semi = source.indexOf(";", from);
    // @import "x"; has no block.
    if (brace === -1 || (semi !== -1 && semi < brace)) { at = semi === -1 ? source.length : semi + 1; continue; }
    let depth = 0, end = brace;
    for (; end < source.length; end++) { if (source[end] === "{") depth++; else if (source[end] === "}" && --depth === 0) break; }
    const rule = source.slice(from, end + 1);
    if (!/^@import/i.test(rule)) outside.push(rule);
    at = end + 1;
  }
  const scoped = inside.replace(/(^|[{},;]\s*|\s)(?::root|html|body)(?=\s*[{,.:\[>~+]|\s+[^{}]*\{)/g, "$1:scope");
  return `${outside.join("\n")}${outside.length ? "\n" : ""}@scope{\n${scoped.trim()}\n}`;
}

/// "GPT-6.2" from "openai/gpt-6.2" or "gpt-6.2": what the tab says.
export function modelLabel(id: string): string {
  const base = id.split("/").pop() ?? id;
  return base.replace(/[-_]?\d{8}$/, "").replace(/^gpt/i, "GPT").replace(/^claude/i, "Claude").replace(/^gemini/i, "Gemini").replace(/^([a-z])/, (letter) => letter.toUpperCase()).slice(0, 28);
}

const esc = (value: string) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
/// A tab's name: the model, then the shape of its take. Names never collide.
export function tabNames(drawn: readonly DrawnBy[]): string[] {
  const names: string[] = [];
  for (const one of drawn) {
    const base = `${modelLabel(one.model)} · ${one.drawing.name}`.replace(/["<>|]/g, "").slice(0, 60);
    let name = base, count = 2;
    while (names.some((taken) => taken.toLowerCase() === name.toLowerCase())) name = `${base} ${count++}`;
    names.push(name);
  }
  return names;
}

/// One page holding every model's take as an option of one <d-compare>.
export function assembleDrawings(title: string, drawn: readonly DrawnBy[]): { source: string; walkthrough: { option: string; what: string; parts: { name: string; says: string }[]; why: string; differs: string }[] } {
  const names = tabNames(drawn);
  const options = drawn.map((one, at) => `<section data-option="${esc(names[at]!)}" data-by="${esc(one.model)}"><style>\n${scopedCSS(one.drawing.css)}\n</style>\n${one.drawing.html}\n</section>`).join("\n");
  const source = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><link rel="stylesheet" href="${FOUNDRY_KIT_STYLE}"><script src="${FOUNDRY_PARTS_SCRIPT}"></script>`
    + `<style>body{margin:0}d-compare>section{display:block;box-sizing:border-box}</style></head><body>\n<d-compare recommended="${esc(names[0]!)}">\n${options}\n</d-compare>\n</body></html>`;
  return { source, // Each model drew without seeing the others, so what sets a take apart is whose it is and the shape it chose.
    walkthrough: drawn.map((one, at) => ({ option: names[at]!, what: one.drawing.what, parts: one.drawing.parts, why: one.drawing.why,
      differs: `${modelLabel(one.model)}'s own take${at ? ", drawn from the brief alone" : ""}: ${one.drawing.name}.`.slice(0, 400) })) };
}

/// Runs the round: every asked model draws at once; a model that fails is
/// left out and named, and the mockup is saved with whoever drew.
export async function drawWithModels(input: ModelsInput & { ask: DrawModel[] }, current: string, deps: {
  draw: (model: DrawModel, prompt: string) => Promise<string>;
  save: (source: string, walkthrough: ReturnType<typeof assembleDrawings>["walkthrough"]) => Promise<string>;
}): Promise<string> {
  const prompt = `The brief:\n\n${input.brief}\n\nDraw your one take now, as the JSON object.`;
  const answers = await Promise.allSettled(input.ask.map(async (model) => ({ model: model.id, drawing: readDrawing(await deps.draw(model, prompt)) })));
  const drawn: DrawnBy[] = [{ model: current, drawing: input.mine }], missed: string[] = [];
  answers.forEach((answer, at) => {
    if (answer.status === "fulfilled") drawn.push(answer.value);
    else missed.push(`${modelLabel(input.ask[at]!.id)}: ${answer.reason instanceof Error ? answer.reason.message : "it failed"}`.slice(0, 200));
  });
  if (drawn.length === 1) throw new Error(`[unavailable] No other model could draw it (${missed.join("; ")}). Hint: save your own take with foundry_save and tell the person which models failed`);
  const { source, walkthrough } = assembleDrawings(input.title, drawn);
  const saved = JSON.parse(await deps.save(source, walkthrough)) as Record<string, unknown>;
  return JSON.stringify({ ...saved, drawn_by: tabNames(drawn), ...(missed.length ? { could_not_draw: missed } : {}),
    next: "Each take is a tab named by its model. In your answer say in a line each how they differ, which you would pick and why; the person answers in the chat." });
}
