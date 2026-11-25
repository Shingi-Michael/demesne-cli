/// Piece 1 of pass 274, your project's look: Foundry reads the project's own
/// colours, type, corners and components from its code (a Tailwind config,
/// the custom properties of its stylesheets, its components folder), so a
/// mockup for the project is drawn in the project's values and checked
/// against them before it is shown (foundry.ts, checkLook). Nothing is
/// written anywhere: the look is read from the code each time, so it is
/// never out of date.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import type { ProjectLook, ProjectLookColor } from "@demesne/protocol";

export const LOOK_MAX_COLORS = 16;
export const LOOK_MAX_COMPONENTS = 40;
const MAX_FILE_BYTES = 256 * 1024;

const TAILWIND_FILES = ["tailwind.config.ts", "tailwind.config.js", "tailwind.config.mjs", "tailwind.config.cjs"];
const CSS_DIRS = ["", "src", "app", "src/app", "styles", "src/styles", "css", "src/css", "assets", "src/assets", "src/assets/css", "public", "public/css", "static", "static/css"];
const CSS_NAMES = ["globals.css", "global.css", "tokens.css", "variables.css", "theme.css", "index.css", "app.css", "main.css", "styles.css", "style.css"];
const COMPONENT_DIRS = ["components", "src/components", "app/components", "src/lib/components", "lib/components", "src/ui", "ui"];
const COMPONENT_EXTENSIONS = new Set([".tsx", ".jsx", ".vue", ".svelte", ".astro"]);
const KITS: readonly [string, string][] = [["@mui/material", "MUI"], ["@chakra-ui/react", "Chakra UI"], ["antd", "Ant Design"], ["@mantine/core", "Mantine"], ["bootstrap", "Bootstrap"], ["daisyui", "daisyUI"], ["@headlessui/react", "Headless UI"], ["@radix-ui/themes", "Radix Themes"], ["vuetify", "Vuetify"], ["bulma", "Bulma"]];

const COLOR = String.raw`#[0-9a-fA-F]{3,8}\b|(?:rgba?|hsla?|oklch)\([^()]*\)`;
const GENERIC_FONTS = new Set(["serif", "sans-serif", "monospace", "system-ui", "ui-sans-serif", "ui-serif", "ui-monospace", "ui-rounded", "cursive", "fantasy", "inherit", "initial", "unset", "-apple-system", "blinkmacsystemfont", "emoji", "math"]);

/// "Inter", from `"Inter", system-ui, sans-serif` or `var(--font-inter), Georgia`; "" when only generic names.
export function firstFont(value: string): string {
  for (const part of value.split(",")) {
    const name = part.trim().replace(/^['"]|['"]$/g, "").trim();
    if (!name || /^var\(/.test(name) || GENERIC_FONTS.has(name.toLowerCase())) continue;
    if (!/^[\w][\w .-]{0,40}$/.test(name)) continue;
    return name;
  }
  return "";
}

/// A colour as hue (degrees), saturation and lightness (0 to 1), or null when it isn't one we read.
export function colorHSL(value: string): { h: number; s: number; l: number } | null {
  const text = value.trim().toLowerCase();
  let rgb: [number, number, number] | null = null;
  const hex = /^#([0-9a-f]{3,8})$/.exec(text)?.[1];
  if (hex) {
    const full = hex.length <= 4 ? [...hex.slice(0, 3)].map((c) => c + c).join("") : hex.slice(0, 6);
    if (full.length === 6) rgb = [0, 2, 4].map((at) => parseInt(full.slice(at, at + 2), 16) / 255) as [number, number, number];
  }
  const numbers = (inside: string) => inside.split(/[\s,/]+/).filter(Boolean);
  const rgbIn = /^rgba?\(([^()]*)\)$/.exec(text)?.[1];
  if (rgbIn) {
    const parts = numbers(rgbIn);
    if (parts.length >= 3) rgb = parts.slice(0, 3).map((part) => part.endsWith("%") ? parseFloat(part) / 100 : parseFloat(part) / 255) as [number, number, number];
  }
  const hslIn = /^hsla?\(([^()]*)\)$/.exec(text)?.[1] ?? (/^-?[\d.]+(deg)?\s+[\d.]+%\s+[\d.]+%$/.test(text) ? text : undefined);
  if (hslIn) {
    const parts = numbers(hslIn);
    if (parts.length >= 3) {
      const out = { h: ((parseFloat(parts[0]!) % 360) + 360) % 360, s: parseFloat(parts[1]!) / 100, l: parseFloat(parts[2]!) / 100 };
      return [out.h, out.s, out.l].every(Number.isFinite) ? out : null;
    }
  }
  const okIn = /^oklch\(([^()]*)\)$/.exec(text)?.[1];
  if (okIn) {
    // Close enough for "is this near the palette": chroma stands in for saturation.
    const parts = numbers(okIn);
    if (parts.length >= 3) {
      const l = parts[0]!.endsWith("%") ? parseFloat(parts[0]!) / 100 : parseFloat(parts[0]!), c = parseFloat(parts[1]!), hue = parseFloat(parts[2]!);
      // OKLCH hues sit about 30 degrees past HSL's for the same colour.
      const out = { h: (((hue - 30) % 360) + 360) % 360, s: Math.min(1, c / 0.3), l };
      return [out.h, out.s, out.l].every(Number.isFinite) ? out : null;
    }
  }
  if (!rgb || !rgb.every(Number.isFinite)) return null;
  const [r, g, b] = rgb, max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  if (!d) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: h * 60, s: Math.min(1, s), l };
}

/// A colour with a hue of its own: not a grey, a white or a black.
/// Judged by chroma (how far its channels spread), so a warm off-white or a
/// tinted near-black counts as a neutral.
export const chromatic = (value: string) => { const hsl = colorHSL(value); return !!hsl && hsl.s * (1 - Math.abs(2 * hsl.l - 1)) >= 0.15; };

interface Found { colors: ProjectLookColor[]; fonts: string[]; corners: string[] }
const empty = (): Found => ({ colors: [], fonts: [], corners: [] });

/// What a Tailwind config names: colours (nested keys joined, "primary-500"),
/// the first family of each fontFamily entry, and its borderRadius values.
export function readTailwind(source: string): Found {
  const found = empty();
  const text = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const token = new RegExp(String.raw`(?:['"]?([\w-]+)['"]?\s*:\s*)?(\{|\[)|(\}|\])|['"]?([\w-]+)['"]?\s*:\s*(['"\`])((?:(?!\5).)*)\5`, "g");
  const stack: string[] = [];
  for (const match of text.matchAll(token)) {
    if (match[2]) { stack.push(match[1] ?? ""); continue; }
    if (match[3]) { stack.pop(); continue; }
    const key = match[4]!, value = match[6]!.trim();
    const under = (name: string) => stack.includes(name);
    if (under("fontFamily") || under("fontfamily")) continue;
    if (under("borderRadius")) { if (/^[\d.]+(px|rem|em)$/.test(value) && !found.corners.includes(value)) found.corners.push(value); continue; }
    if (under("colors") && new RegExp(`^(?:${COLOR})$`).test(value) && colorHSL(value)) {
      const path = stack.slice(stack.lastIndexOf("colors") + 1).filter(Boolean);
      const name = [...path, ...(key === "DEFAULT" ? [] : [key])].join("-") || key;
      if (!found.colors.some((one) => one.name === name)) found.colors.push({ name, value });
    }
  }
  // fontFamily: { sans: ["Inter", …], display: "Fraunces, serif" }
  const fonts = /fontFamily\s*:\s*\{([\s\S]*?)\}/.exec(text)?.[1] ?? "";
  for (const entry of fonts.matchAll(/['"]?[\w-]+['"]?\s*:\s*(\[[^\]]*\]|['"`][^'"`]*['"`])/g)) {
    const first = firstFont(entry[1]!.replace(/^\[|\]$/g, ""));
    if (first && !found.fonts.includes(first)) found.fonts.push(first);
  }
  return found;
}

/// What a stylesheet names: custom properties that hold a colour, a font or a
/// radius (the first time each is set, so a dark block after :root doesn't
/// win), and the families of plain font-family declarations.
export function readStylesheet(source: string): Found {
  const found = empty();
  const text = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const seen = new Set<string>();
  for (const match of text.matchAll(/(--[\w-]+)\s*:\s*([^;{}]+)[;}]/g)) {
    const name = match[1]!.slice(2), value = match[2]!.trim();
    if (seen.has(name)) continue;
    seen.add(name);
    if (/font/i.test(name) && !/size|weight|feature|height|spacing/i.test(name)) { const first = firstFont(value); if (first && !found.fonts.includes(first)) found.fonts.push(first); continue; }
    if (/radius|rounded/i.test(name)) { if (/^[\d.]+(px|rem|em)$/.test(value) && !found.corners.includes(value)) found.corners.push(value); continue; }
    // shadcn writes hsl triplets without the function: "222.2 84% 4.9%".
    const color = /^-?[\d.]+(deg)?\s+[\d.]+%\s+[\d.]+%$/.test(value) ? `hsl(${value})` : value;
    if (new RegExp(`^(?:${COLOR})$`).test(color) && colorHSL(color)) found.colors.push({ name: name.replace(/^color-/, ""), value: color });
  }
  for (const match of text.matchAll(/font-family\s*:\s*([^;{}]+)[;}]/g)) {
    const first = firstFont(match[1]!);
    if (first && !found.fonts.includes(first)) found.fonts.push(first);
  }
  return found;
}

const readSmall = (path: string): string | null => {
  try { const stat = statSync(path); return stat.isFile() && stat.size <= MAX_FILE_BYTES ? readFileSync(path, "utf8") : null; } catch { return null; }
};
const pascal = (name: string) => name.replace(/(^|[-_.\s])(\w)/g, (_, __, letter: string) => letter.toUpperCase());

function componentsIn(root: string): string[] {
  const names: string[] = [];
  const visit = (dir: string, depth: number) => {
    let entries: import("node:fs").Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (names.length >= LOOK_MAX_COMPONENTS * 3) return;
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      if (entry.isDirectory()) { if (depth < 2) visit(join(dir, entry.name), depth + 1); continue; }
      const extension = extname(entry.name);
      if (!COMPONENT_EXTENSIONS.has(extension) || /\.(test|spec|stories)\./.test(entry.name)) continue;
      const base = basename(entry.name, extension);
      const name = pascal(base === "index" ? basename(dir) : base);
      if (name && /^[A-Z]/.test(name) && !names.includes(name)) names.push(name);
    }
  };
  for (const dir of COMPONENT_DIRS) if (existsSync(join(root, dir))) visit(join(root, dir), 0);
  return names;
}

function scan(root: string): { look: ProjectLook | null; stamp: string } {
  const found = empty(), from: string[] = [], stamps: string[] = [];
  const take = (file: string, read: (source: string) => Found) => {
    const source = readSmall(join(root, file));
    if (source === null) return;
    const part = read(source);
    try { stamps.push(`${file}:${statSync(join(root, file)).mtimeMs}`); } catch {}
    if (!part.colors.length && !part.fonts.length && !part.corners.length) return;
    from.push(file);
    for (const color of part.colors) if (!found.colors.some((one) => one.name === color.name || one.value.toLowerCase() === color.value.toLowerCase())) found.colors.push(color);
    for (const font of part.fonts) if (!found.fonts.includes(font)) found.fonts.push(font);
    for (const corner of part.corners) if (!found.corners.includes(corner)) found.corners.push(corner);
  };
  for (const file of TAILWIND_FILES) take(file, readTailwind);
  for (const dir of CSS_DIRS) for (const name of CSS_NAMES) { if (from.length >= 4) break; take(dir ? `${dir}/${name}` : name, readStylesheet); }
  const components = componentsIn(root);
  let kit = existsSync(join(root, "components.json")) ? "shadcn/ui" : "";
  const manifest = readSmall(join(root, "package.json"));
  if (!kit && manifest) {
    try {
      const parsed = JSON.parse(manifest) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      const has = { ...parsed.dependencies, ...parsed.devDependencies };
      kit = KITS.find(([name]) => name in has)?.[1] ?? "";
    } catch {}
  }
  const stamp = `${stamps.join("|")}|${components.length}|${kit}`;
  // A look needs something to draw with: a palette, or type.
  if (!found.colors.length && !found.fonts.length) return { look: null, stamp };
  // Colours with a hue first (they are what a page is judged on), then the neutrals.
  const colors = [...found.colors.filter((one) => chromatic(one.value)), ...found.colors.filter((one) => !chromatic(one.value))].slice(0, LOOK_MAX_COLORS);
  return { look: { from, colors, fonts: found.fonts.slice(0, 4), corners: found.corners.slice(0, 4), components: components.slice(0, LOOK_MAX_COMPONENTS), componentCount: components.length, ...(kit ? { kit } : {}) }, stamp };
}

const cache = new Map<string, { at: number; look: ProjectLook | null }>();
/// The project's look, or null when its code names no colours and no type.
/// Read again at most every few seconds, since a chat asks on every turn.
export function loadProjectLook(workspaceRoot: string | undefined | null, now = Date.now()): ProjectLook | null {
  if (!workspaceRoot || resolve(workspaceRoot) === resolve(homedir())) return null;
  const cached = cache.get(workspaceRoot);
  if (cached && now - cached.at < 5000) return cached.look;
  let look: ProjectLook | null = null;
  try { look = existsSync(workspaceRoot) ? scan(workspaceRoot).look : null; } catch { look = null; }
  cache.set(workspaceRoot, { at: now, look });
  if (cache.size > 50) cache.delete(cache.keys().next().value!);
  return look;
}

/// The look as the model reads it, after the design guide's rules.
export function projectLookBlock(look: ProjectLook): string {
  const lines = [
    `This project's own look, read from its code (${look.from.join(", ") || "its components"}). A mockup for this project is drawn in these values, not the kit's defaults: set --accent, --ink and --paper on :root from its colours, use its fonts and corners, and call parts by its components' names. Only an ask for a new look sets it aside.`,
    look.colors.length ? `Colours: ${look.colors.map((one) => `${one.name} ${one.value}`).join(", ")}` : "",
    look.fonts.length ? `Fonts: ${look.fonts.join(", ")}` : "",
    look.corners.length ? `Corners: ${look.corners.join(", ")}` : "",
    look.kit ? `Built on ${look.kit}.` : "",
    look.components.length ? `Components (${look.componentCount}): ${look.components.join(", ")}${look.componentCount > look.components.length ? ", …" : ""}` : "",
    "Asked to write the look down or share it with another tool, write these values to DESIGN.md at the project's root.",
  ];
  return lines.filter(Boolean).join("\n");
}

export interface LookProblem { what: "colour" | "font"; value: string }

const hueGap = (a: number, b: number) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

/// What in a page's source is off the project's look: colours with a hue far
/// from every hue in its palette, and font families it doesn't name. Greys,
/// whites and blacks always pass, and so does a palette with no hue of its own.
export function offLook(source: string, look: ProjectLook): LookProblem[] {
  const problems: LookProblem[] = [];
  // Pictures and scripts aren't the page's own styling.
  const text = source.replace(/<script\b[\s\S]*?<\/script>/gi, "").replace(/url\([^)]*\)/gi, "").replace(/data:[^"')\s]+/gi, "");
  const hues = look.colors.filter((one) => chromatic(one.value)).map((one) => colorHSL(one.value)!.h);
  if (hues.length) {
    const seen = new Set<string>();
    for (const match of text.matchAll(new RegExp(COLOR, "g"))) {
      const value = match[0].toLowerCase();
      if (seen.has(value)) continue;
      seen.add(value);
      if (!chromatic(value)) continue;
      const hue = colorHSL(value)!.h;
      if (hues.every((known) => hueGap(known, hue) > 28)) problems.push({ what: "colour", value: match[0] });
      if (problems.length >= 4) break;
    }
  }
  if (look.fonts.length) {
    const known = new Set(look.fonts.map((font) => font.toLowerCase()));
    const seen = new Set<string>();
    for (const match of text.matchAll(/\bfont(-family)?\s*:\s*([^;{}<>]+)/gi)) {
      // The shorthand leads with weight and size ("600 16px/1.2 Georgia, serif"): the families follow the size.
      const families = match[1] ? match[2]! : match[2]!.replace(/^.*?\d[\w.%]*(?:\s*\/\s*[\w.%]+)?\s+(?=\S)/, "");
      const first = firstFont(families);
      if (!first || known.has(first.toLowerCase()) || seen.has(first.toLowerCase())) continue;
      // A monospace face for code is not the look's business.
      if (/mono|menlo|consolas|courier/i.test(first)) continue;
      seen.add(first.toLowerCase());
      problems.push({ what: "font", value: first });
    }
  }
  return problems.slice(0, 6);
}

/// The colour of the palette nearest a given one, by hue: what to use instead.
export function nearest(value: string, look: ProjectLook): ProjectLookColor | null {
  const hsl = colorHSL(value);
  const palette = look.colors.filter((one) => chromatic(one.value));
  if (!hsl || !palette.length) return null;
  // The palette is in the project's own order: a later colour wins only when it is clearly nearer.
  return palette.reduce((best, one) => hueGap(colorHSL(one.value)!.h, hsl.h) < hueGap(colorHSL(best.value)!.h, hsl.h) - 8 ? one : best);
}
