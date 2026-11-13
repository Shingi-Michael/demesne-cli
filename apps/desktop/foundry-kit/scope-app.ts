/// The app's own stylesheets, made safe to load inside a Foundry page
/// (pass 220 A): a mockup of Demesne is drawn with the styles the app
/// ships, not with a copy of them. scripts/prepare-ui.ts writes the result
/// to kit/app.css, served as foundry://kit/app.css; parts.js loads it when a
/// page holds a <d-demesne>.
///
/// The app's rules assume they own the document. Here they own one element,
/// <d-app> (the window <d-demesne> draws, standing in for html) with a
/// <d-body> inside it, so:
/// - every rule sits in `@scope (d-app)` and cannot touch the page around it;
/// - `html` and `:root` become the scope's root and `body` becomes `d-body`;
/// - the window's size is the element's: vh/vw become container units, and a
///   width or height media query becomes a container query on d-app;
/// - fonts, keyframes and registered properties stay global, as CSS requires.
/// - the whole of it is one cascade layer, so a mockup's own CSS wins over
///   the app's without having to out-weigh its selectors: `.sidebar-new{…}`
///   in the page is enough to change the app's New chat row.

/// Where the app's element stands in for the document.
export const APP_ROOT = "d-app", APP_BODY = "d-body";
const FONTS = /(?:node_modules\/@fontsource\/[a-z-]+\/files|vendor\/fonts)\//g;

/// The classes the app puts on html. A bare `.glass .bar-tab` means the
/// window, which inside the scope has to be said.
export const ROOT_CLASSES = ["glass", "mac-chrome", "fullscreen"];
const ROOT_CLASS = new RegExp(`(^|[\\s,>+~(])\\.(${ROOT_CLASSES.join("|")})(?![\\w-])`, "g");

interface Rule { prelude: string; block: string | null }

/// Top-level rules of a stylesheet (or of a block): prelude and body, with
/// comments dropped and strings left whole.
function rules(css: string): Rule[] {
  const out: Rule[] = [];
  let at = 0, start = 0;
  const skipString = (quote: string) => { at += 1; while (at < css.length && css[at] !== quote) at += css[at] === "\\" ? 2 : 1; };
  while (at < css.length) {
    const char = css[at]!;
    if (char === "\"" || char === "'") skipString(char);
    else if (char === ";") { const prelude = css.slice(start, at).trim(); if (prelude) out.push({ prelude, block: null }); start = at + 1; }
    else if (char === "{") {
      const prelude = css.slice(start, at).trim();
      let depth = 1; const open = at + 1; at += 1;
      while (at < css.length && depth) {
        const inner = css[at]!;
        if (inner === "\"" || inner === "'") skipString(inner);
        else if (inner === "{") depth += 1;
        else if (inner === "}") depth -= 1;
        at += 1;
      }
      out.push({ prelude, block: css.slice(open, at - 1) });
      start = at;
      continue;
    }
    at += 1;
  }
  return out;
}

/// `html` is the scope's root and `body` the element inside it, so the two
/// keep the relation the app's rules rely on (a rule on body still beats a
/// value set on html). Inside @scope a bare selector only matches below the
/// root, so the root is named; :where keeps it weightless.
function selector(prelude: string): string {
  return prelude.replace(/:root\b/g, ":scope")
    .replace(/(?<![\w#.\-])html(?![\w\-])/g, ":where(:scope)")
    .replace(/(?<![\w#.\-])body(?![\w\-])/g, APP_BODY)
    .replace(ROOT_CLASS, "$1:where(:scope).$2");
}

/// A media query on the window's width or height asks about the element.
const sized = (query: string) => /^\s*\(\s*(?:min|max)-(?:width|height)\s*:[^)]*\)(?:\s*and\s*\(\s*(?:min|max)-(?:width|height)\s*:[^)]*\))*\s*$/.test(query);

function scoped(css: string, hoisted: string[], inside = ""): string {
  let out = "";
  for (const rule of rules(css)) {
    const name = /^@([\w-]+)/.exec(rule.prelude)?.[1]?.toLowerCase();
    if (rule.block === null) { if (!name) out += `${rule.prelude};`; continue; }
    if (name === "font-face" || name === "keyframes" || name === "-webkit-keyframes" || name === "property") {
      const whole = `${rule.prelude}{${rule.block}}`;
      hoisted.push(inside ? `${inside}{${whole}}` : whole);
    } else if (name === "media") {
      const query = rule.prelude.slice(6);
      const prelude = sized(query) ? `@container app ${query.trim()}` : rule.prelude;
      out += `${prelude}{${scoped(rule.block, hoisted, sized(query) ? inside : rule.prelude)}}\n`;
    } else if (name === "supports" || name === "container" || name === "layer") {
      out += `${rule.prelude}{${scoped(rule.block, hoisted, inside)}}\n`;
    } else if (name) {
      out += `${rule.prelude}{${rule.block}}\n`;
    } else out += `${selector(rule.prelude)}{${rule.block}}\n`;
  }
  return out;
}

export function scopeAppStyles(sheets: string[]): string {
  const css = sheets.join("\n").replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(\d)(?:[dsl])?v([hw])\b/g, "$1cq$2")
    .replace(FONTS, "foundry://kit/fonts/");
  const hoisted: string[] = [];
  const body = scoped(css, hoisted);
  return `/* Demesne's own styles, scoped to <${APP_ROOT}> for Foundry (generated; see foundry-kit/scope-app.ts). */\n${hoisted.join("\n")}\n@layer demesne {\n@scope (${APP_ROOT}) {\n${body}}\n}\n`;
}
