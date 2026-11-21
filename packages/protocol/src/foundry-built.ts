/// Built like the mockup (pass 241 A). After "build it" the chat looks at what
/// it built (a web page through its local server or file, an app through its
/// window) and compares it with the option the person picked. Each look it
/// records says what still differs, at most three things, each boxed on the
/// picture. Foundry keeps the record as a look-only page: the pick beside
/// the real result, the differences ringed and numbered, and which were fixed.
/// Demesne writes that page from the record; the model never writes it.

import { styleNames } from "./foundry-styles.ts";

/// A record page, as Demesne writes it.
export const BUILT_PAGE = /<d-built\b/i;
/// At most this many differences a look names, biggest first; the rest are counted.
export const MAX_BUILT_DIFFERENCES = 3;
/// A turn records this many looks of one build at most: the first and two after fixes.
export const BUILT_LOOKS = 3;

/// One thing that differs from the pick, boxed on the look's picture (x,y,w,h in its own pixels).
export interface BuiltDifference { box: string; what: string }
/// One look at the result: its picture and what differed in it.
export interface BuiltLook { picture: string; differences: BuiltDifference[]; more: number }
export interface BuiltRecord {
  /// The mockup it was built from, the version, and the option picked in it.
  from: { id: string; version: number; title: string };
  option: string | null;
  /// Where the result was seen: a local address, a file, or an app's window.
  where: string;
  /// The pick, drawn by Foundry at the result's width, as a picture kept with the record; null when it couldn't be drawn.
  pick: string | null;
  looks: BuiltLook[];
  /// What is left different, and why, when the last look still differs.
  left: string;
}

export const builtMatches = (record: BuiltRecord) => {
  const last = record.looks.at(-1);
  return !!last && !last.differences.length && !last.more;
};
/// The verdict in a few words: "matches", or what still differs.
export function builtVerdict(record: BuiltRecord): string {
  const last = record.looks.at(-1);
  if (!last) return "not looked at";
  const count = last.differences.length + last.more;
  return count ? `${count} still differ${count === 1 ? "s" : ""}` : "matches";
}

const h = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
const marksOf = (look: BuiltLook) => look.differences.map((difference) => difference.box).join(" | ");
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const STYLE = `
body{margin:0}
d-built{display:flex;flex-direction:column;gap:var(--space-5);padding:var(--space-5);max-width:1240px;margin:0 auto;box-sizing:border-box}
.bt-row{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--space-4);align-items:start}
.bt-row>*{min-width:0;margin:0;display:flex;flex-direction:column;gap:var(--space-2)}
.bt-cap{display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px;font-size:var(--text-sm);color:var(--muted);line-height:1.4}
.bt-cap b{color:var(--ink);font-weight:600}
.bt-cap em{font-style:normal;padding:0 7px;border-radius:6px;background:color-mix(in srgb,#f2b6c8 24%,transparent);color:color-mix(in srgb,#d9648c 72%,var(--ink));font-size:11.5px;line-height:18px}
.bt-cap .pill{font-size:11.5px}
d-built d-shot{max-width:100%!important}
.bt-pick .ds-frame{box-shadow:0 0 0 2px #f2b6c8}
.bt-none{padding:var(--space-6) var(--space-4);border-radius:10px;box-shadow:inset 0 0 0 1px var(--hair);color:var(--muted);font-size:var(--text-sm);text-align:center}
d-built .ds-spot{border-radius:8px;box-shadow:0 0 0 2px #e8799b,0 0 0 4px color-mix(in srgb,var(--ink) 18%,transparent)}
d-built .ds-spot::after{content:attr(data-mark);position:absolute;top:4px;right:4px;width:19px;height:19px;border-radius:50%;background:#e8799b;color:#2b0d17;font-size:11px;font-weight:600;line-height:19px;text-align:center}
.bt-diffs{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:var(--space-2)}
.bt-diffs li{display:flex;gap:9px;align-items:flex-start;font-size:var(--text-sm);line-height:1.45;color:var(--secondary)}
.bt-diffs li>i{flex:none;width:19px;height:19px;border-radius:50%;background:#e8799b;color:#2b0d17;font-size:11px;font-weight:600;font-style:normal;line-height:19px;text-align:center}
.bt-diffs li>span{flex:1;min-width:0}
.bt-diffs li>s{flex:none;text-decoration:none;font-size:11.5px;color:var(--muted)}
.bt-sub{margin:0;font-size:var(--text-sm);color:var(--muted);max-width:78ch}
.bt-rule{height:1px;background:var(--hair)}
`;

/// The record's page: the pick beside the latest look (rings on what still
/// differs), and when an earlier look in the same build differed, that look
/// with its rings and the list, each marked fixed or not.
export function builtPage(record: BuiltRecord): string {
  const last = record.looks.at(-1)!;
  const matches = builtMatches(record);
  const first = record.looks.find((look) => look !== last && (look.differences.length || look.more));
  const option = record.option ?? record.from.title;
  const pick = `<figure class="bt-pick"><figcaption class="bt-cap"><b>${h(option)}</b><em>your pick</em><span>${h(record.from.title)}, v${record.from.version}</span></figcaption>`
    + (record.pick ? `<d-shot src="${h(record.pick)}" alt="Your pick, as drawn on Foundry"></d-shot>` : `<div class="bt-none">Foundry could not draw the pick here.</div>`) + "</figure>";
  const verdict = matches ? `<span class="pill ok">matches your pick</span>` : `<span class="pill bad">${h(builtVerdict(record))}</span>`;
  const built = `<figure><figcaption class="bt-cap"><b>Built${first ? ", after its fix" : ""}</b><span>${h(record.where)}</span>${verdict}</figcaption>`
    + `<d-shot src="${h(last.picture)}"${last.differences.length ? ` marks="${h(marksOf(last))}"` : ""} alt="What was built"></d-shot></figure>`;
  const list = (look: BuiltLook, fixed: boolean) => `<ol class="bt-diffs">${look.differences.map((difference, index) =>
    `<li><i>${index + 1}</i><span>${h(difference.what)}</span>${fixed ? "<s>fixed</s>" : ""}</li>`).join("")}</ol>`
    + (look.more ? `<p class="bt-sub">And ${plural(look.more, "smaller difference")}${fixed ? ", fixed too" : ""}.</p>` : "");
  const still = matches ? "" : list(last, false) + (record.left ? `<p class="bt-sub">Left as it is: ${h(record.left)}</p>` : "");
  const earlier = first ? `<div class="bt-rule"></div><div class="bt-row"><figure><figcaption class="bt-cap"><b>Built, first look</b>`
    + `<span>${h(plural(first.differences.length + first.more, "thing"))} differed from your pick</span></figcaption>`
    + `<d-shot src="${h(first.picture)}"${first.differences.length ? ` marks="${h(marksOf(first))}"` : ""} alt="The first look at what was built"></d-shot></figure>`
    + `<div>${list(first, matches)}</div></div>` : "";
  const data = JSON.stringify(record).replace(/</g, "\\u003c");
  return `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="foundry://kit/base.css"><script src="foundry://kit/parts.js"></script><style>${STYLE}</style>`
    + `<script type="application/json" id="demesne-built">${data}</script></head><body><d-built>`
    + `<div class="bt-row">${pick}${built}</div>${still}${earlier}</d-built></body></html>`;
}

/// The record a page was written from, or null when it isn't one.
export function builtOf(source: string): BuiltRecord | null {
  if (!BUILT_PAGE.test(source)) return null;
  const match = /<script type="application\/json" id="demesne-built">([\s\S]*?)<\/script>/.exec(source);
  if (!match) return null;
  try {
    const value = JSON.parse(match[1]!) as BuiltRecord;
    return value && value.from && Array.isArray(value.looks) && value.looks.length ? value : null;
  } catch { return null; }
}

/// The options a mockup offers (<section data-option> in a <d-compare>), in
/// page order and with "Today", so an index is the one Foundry draws alone (?option=N).
export const isToday = (name: string) => /^today\b/i.test(name);
export function optionNames(source: string): string[] {
  const body = source.replace(/<script\b[\s\S]*?<\/script>/gi, "").replace(/<style\b[\s\S]*?<\/style>/gi, "").replace(/<!--[\s\S]*?-->/g, "");
  if (/<d-review\b/i.test(body)) return [];
  // A page of styles (pass 246 A): each style is an option, drawn alone the same way.
  const styles = styleNames(source);
  if (styles.length) return styles;
  return [...body.matchAll(/\bdata-option\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)].map((match) => (match[1] ?? match[2] ?? "").trim())
    .filter(Boolean);
}
/// The option a name picks: the one it names exactly or starts with, as "B" picks "B · Yearly first".
export function pickOption(all: readonly string[], asked: string): number {
  const said = asked.trim().toLowerCase();
  const names = all.map((name) => isToday(name) ? "\u0000" : name);
  if (!said) return -1;
  const exact = names.findIndex((name) => name.toLowerCase() === said);
  if (exact >= 0) return exact;
  const starts = names.map((name, index) => [name.toLowerCase(), index] as const).filter(([name]) => name.startsWith(said) || said.startsWith(name));
  if (starts.length === 1) return starts[0]![1];
  const within = names.map((name, index) => [name.toLowerCase(), index] as const).filter(([name]) => name.includes(said));
  return within.length === 1 ? within[0]![1] : -1;
}
