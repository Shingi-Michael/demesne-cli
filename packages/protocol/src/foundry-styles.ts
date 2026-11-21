/// A range of styles (pass 246 A). A page is written once, on variables, and
/// holds two or three styles:
///
///   <d-styles recommended="Clean counter">
///     <d-style name="Clean counter" made="Inter throughout · 8px corners · hairlines"
///       vars="--paper:#fff; --ink:#111417; --accent:#1f6f4a; --head:Inter,sans-serif; --font:Inter,sans-serif; --radius:8px"></d-style>
///     …
///   </d-styles>
///
/// A style is nothing but that short list of values. Foundry draws the same
/// page once in each (the kit sets the values on the page), so the words and
/// the layout cannot differ and only the style does. The one the person picks
/// is kept as the project's style in its design guide.

/// A page that offers styles.
export const STYLES_PAGE = /<d-styles\b/i;
/// At most three, like options.
export const MAX_STYLES = 3;
/// What every style says, so each can be named, compared and kept: the paper
/// (background), the ink (text), one accent, the heading typeface, the body
/// typeface and the corner. All but --head are the kit's own names
/// (base.css), so a page built on the kit follows a style without more work.
export const STYLE_NEEDS = ["--paper", "--ink", "--accent", "--head", "--font", "--radius"] as const;

export interface FoundryStyle {
  name: string;
  /// One line on what it is made of, in the person's words: "Georgia and Inter · round corners".
  made: string;
  /// Its values, in the order written.
  vars: [name: string, value: string][];
}

const attr = (tag: string, name: string) => {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(tag);
  return (match?.[1] ?? match?.[2] ?? "").replace(/\s+/g, " ").trim();
};
const unescape = (text: string) => text.replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, "&");

/// The values of a style: `--name: value` pairs, nothing else. A value holds
/// no braces, angle brackets or url(), so a style can only ever set values.
export function styleVars(text: string): [string, string][] {
  const vars: [string, string][] = [];
  for (const part of unescape(text).split(";")) {
    const match = /^\s*(--[a-z0-9-]{1,40})\s*:\s*([^{}<>]{1,200})$/i.exec(part);
    if (!match || /url\s*\(|expression\s*\(|@import/i.test(match[2]!)) continue;
    const name = match[1]!.toLowerCase(), value = match[2]!.replace(/\s+/g, " ").trim();
    if (value && !vars.some(([known]) => known === name)) vars.push([name, value]);
  }
  return vars.slice(0, 40);
}

/// The styles a page offers and the one it would pick, in page order (an
/// index is the one Foundry draws alone, ?option=N). Null when it offers none.
export function stylesOf(source: string): { recommended: string; styles: FoundryStyle[] } | null {
  const body = source.replace(/<script\b[\s\S]*?<\/script>/gi, "").replace(/<style\b[\s\S]*?<\/style>/gi, "").replace(/<!--[\s\S]*?-->/g, "");
  const open = /<d-styles\b[^>]*>/i.exec(body);
  if (!open) return null;
  const styles = [...body.matchAll(/<d-style\b[^>]*>/gi)].map((match) => ({ name: attr(match[0], "name").slice(0, 60), made: attr(match[0], "made").slice(0, 160), vars: styleVars(attr(match[0], "vars")) }));
  return { recommended: attr(open[0], "recommended"), styles };
}
export const styleNames = (source: string) => stylesOf(source)?.styles.map((style) => style.name).filter(Boolean) ?? [];

const valueOf = (style: FoundryStyle, name: string) => style.vars.find(([known]) => known === name)?.[1] ?? "";
const COLOUR = /^(#[0-9a-f]{3,8}|(?:rgb|hsl|oklch|oklab|lab|lch|color)a?\([^()]*\))$/i;
/// A value that is one plain colour: safe to draw as a swatch.
export const isStyleColour = (value: unknown): value is string => typeof value === "string" && value.length <= 60 && COLOUR.test(value.trim());
const alike = (a: string, b: string) => a.replace(/\s+/g, "").replace(/["']/g, "").toLowerCase() === b.replace(/\s+/g, "").replace(/["']/g, "").toLowerCase();
/// The first typeface of a font list, as a person would say it.
export const faceOf = (value: string) => (value.split(",")[0] ?? "").replace(/["']/g, "").trim();

/// A style's colours for the small swatches beside its name: paper, ink and
/// accent first, then its other colours, five at most.
export function styleColours(style: FoundryStyle): string[] {
  const first = ["--paper", "--ink", "--accent"].map((name) => valueOf(style, name)).filter((value) => COLOUR.test(value));
  const rest = style.vars.filter(([name, value]) => !["--paper", "--ink", "--accent"].includes(name) && COLOUR.test(value)).map(([, value]) => value);
  return [...first, ...rest].filter((value, index, all) => all.findIndex((other) => alike(other, value)) === index).slice(0, 5);
}

/// What is wrong with a page's styles, as the hint the model gets back; null
/// when they are fine. Two or three, each named and saying what it is made
/// of, each with the same values set, a pick among them, and no two that
/// share their paper and their heading typeface: those are one style twice.
export function stylesProblem(source: string): string | null {
  const found = stylesOf(source);
  if (!found) return null;
  const { styles, recommended } = found;
  const how = `Hint: <d-styles recommended="Name"><d-style name="Name" made="what it is made of, one line" vars="${STYLE_NEEDS.map((name) => `${name}:…`).join("; ")}"></d-style>…</d-styles>, and write the page once on those variables`;
  if (!/foundry:\/\/kit\/parts\.js/i.test(source)) return `[styles] A page of styles needs the parts script, which draws it in each style. Hint: <script src="foundry://kit/parts.js"></script> in its head`;
  if (styles.length < 2 || styles.length > MAX_STYLES) return `[styles] This page has ${styles.length} ${styles.length === 1 ? "style" : "styles"}; a range is two or three. ${how}`;
  if (/\bdata-option\s*=/i.test(source.replace(/<script\b[\s\S]*?<\/script>/gi, ""))) return "[styles] This page has styles and options. Hint: a page of styles is one design drawn in each style; drop the <d-compare>, or drop the styles and offer options";
  const names = styles.map((style) => style.name.toLowerCase());
  if (names.some((name) => !name) || new Set(names).size !== names.length) return `[styles] Every style needs its own name. ${how}`;
  const unmade = styles.find((style) => !style.made);
  if (unmade) return `[styles] “${unmade.name}” does not say what it is made of. Hint: made="Georgia and Inter · round corners · roomy", one plain line the person reads under its name`;
  for (const style of styles) {
    const missing = STYLE_NEEDS.filter((name) => !valueOf(style, name));
    if (missing.length) return `[styles] “${style.name}” is missing ${missing.join(", ")}. ${how}`;
    if (!COLOUR.test(valueOf(style, "--paper")) || !COLOUR.test(valueOf(style, "--ink")) || !COLOUR.test(valueOf(style, "--accent"))) return `[styles] In “${style.name}”, --paper, --ink and --accent are each one colour (a hex value). Hint: --paper is the background, --ink the text, --accent the one thing to press`;
    const unset = styles[0]!.vars.map(([name]) => name).filter((name) => !valueOf(style, name));
    if (unset.length) return `[styles] “${style.name}” does not set ${unset.slice(0, 6).join(", ")}, which “${styles[0]!.name}” sets. Hint: every style sets the same variables, so the page is whole in each`;
  }
  if (!recommended || !names.some((name) => name === recommended.toLowerCase() || name.startsWith(recommended.toLowerCase()))) return `[no_recommendation] These styles have no pick. Hint: set recommended="<style name>" on <d-styles>, and say why in the chat`;
  for (let a = 0; a < styles.length; a++) for (let b = a + 1; b < styles.length; b++) {
    if (alike(valueOf(styles[a]!, "--paper"), valueOf(styles[b]!, "--paper")) && alike(faceOf(valueOf(styles[a]!, "--head")), faceOf(valueOf(styles[b]!, "--head"))))
      return `[styles] “${styles[a]!.name}” and “${styles[b]!.name}” share their paper and their heading typeface: that is one style twice. Hint: a range is styles a person tells apart at a glance; change the paper, the type and the corners of one of them`;
  }
  // The kit's stylesheet is written on these values already; a page without it has to use them itself.
  const used = new Set([...source.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)].map((match) => match[1]!.toLowerCase()));
  const unused = STYLE_NEEDS.filter((name) => !used.has(name));
  if (!/foundry:\/\/kit\/base\.css/i.test(source) && unused.length > 2) return `[styles] The page does not use ${unused.join(", ")}, so it would look the same in every style. Hint: write the page's CSS on the style's variables: background: var(--paper), color: var(--ink), font-family: var(--font), border-radius: var(--radius)`;
  return null;
}

/// A picked style as the lines of a design guide's "Style" section.
export function styleLines(style: FoundryStyle): string[] {
  const colours = style.vars.filter(([, value]) => COLOUR.test(value)).map(([name, value]) => `${name.slice(2)} ${value}`);
  const head = faceOf(valueOf(style, "--head")), body = faceOf(valueOf(style, "--font"));
  return [
    ...(style.made ? [`- Made of: ${style.made}`] : []),
    ...(colours.length ? [`- Colours: ${colours.join(", ")}`] : []),
    ...(head || body ? [`- Type: ${head && body && !alike(head, body) ? `${head} for headings, ${body} for the rest` : `${head || body} throughout`}`] : []),
    ...(valueOf(style, "--radius") ? [`- Corners: ${valueOf(style, "--radius")}`] : []),
    `- Values: \`${style.vars.map(([name, value]) => `${name}: ${value}`).join("; ")}\``,
  ];
}
