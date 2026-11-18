/** The ruler for Foundry's pages (eval-foundry-quality.ts): the fixed asks,
 * how a rendered page's numbers become a score, and the contact sheet.
 *
 * A page's score is the mean of six checks, each 0 to 1:
 *   faults   nothing broken: no sideways scroll, clipped, spilling, faint or
 *            overlapping text, console errors
 *   sizes    a type scale, not a pile of sizes: 3 to 6 sizes
 *   lead     one thing leads: the biggest text at least 2.8x the body
 *   rhythm   spacing from a few steps: the six most used spacings cover
 *            90% of margins, paddings and gaps
 *   aligned  text blocks share left edges
 *   colours  a palette, not a rainbow: 3 to 8 colours
 *   surface  more than text on blank paper: a third of the first screen
 *            painted (fills, pictures, SVG)
 * The numbers are measured in the page (foundry-look-measure.ts
 * DESIGN_MEASURE), so the ruler is the same for every model and every
 * change. It says nothing about taste beyond these; the contact sheet is
 * for the eye. */

import { REVIEW_PAGE, reviewProblem } from "../packages/protocol/src/foundry-stage.ts";

export type Where = "project" | "chat";
/// What the ask itself fixes, where it does: the frame, how many versions,
/// and how much the page may hold. A page is "as asked" by how many of
/// these it keeps; looks are scored apart (the checks below).
export interface Fit {
  /// The surface the ask names ("a phone app screen", or a small thing: part).
  surface?: string[];
  /// Versions asked for by number ("two calmer versions"); a "Today" beside them is not counted.
  /// An ask that names no number leaves this out: up to three options with a pick are always welcome.
  options?: number;
  /// More than this many is more than was asked (controls and bytes leave room for three options).
  dialogs?: number; forms?: number; controls?: number; bytes?: number;
  /// Things the ask names, each to be found in the page's words.
  has?: RegExp[];
  /// An open design question: two or three options and a pick are owed (pass 223 A).
  offers?: true;
  /// "Look at this and show me what needs work": one review sheet (<d-review>) that holds.
  review?: true;
}
/// picture: a real picture of the screen sent with the ask, as a person attaches one
/// (scripts/shoot-desktop.ts makes it; pass 240 A reviews start from one).
export interface QualityCase { id: string; where: Where; prompt: string; fit?: Fit; picture?: string }

/// Twelve asks for whole pages (four mockups of Demesne itself, the rest the
/// kinds of page people ask Foundry for), then small asks, which the first
/// twelve never had: a ruler of whole pages only rewards whatever makes a
/// page bigger. Last, reviews of something that exists (pass 223 A). Kept fixed so scores compare across changes; compare a run
/// with an older one over the same ids (--only).
export const QUALITY_CASES: QualityCase[] = [
  { id: "demesne-settings", where: "project", prompt: "show me what a calmer, more organised Settings page for Demesne could look like", fit: { offers: true } },
  { id: "demesne-empty", where: "project", prompt: "what could Demesne's home look like for someone who has no chats yet? mock it", fit: { offers: true } },
  { id: "demesne-topbar", where: "project", prompt: "the top bar feels busy. show me two calmer versions side by side", fit: { options: 2, dialogs: 0, forms: 0 } },
  { id: "demesne-drive", where: "project", prompt: "mock how Drive could show the work it finished overnight when I open the app in the morning" },
  { id: "landing", where: "chat", prompt: "put together a landing page for a coffee subscription called Slow Pour" },
  { id: "pricing", where: "chat", prompt: "make a pricing page for a notes app with three plans and a monthly/yearly switch", fit: { dialogs: 0, forms: 0, has: [/month/i, /year/i] } },
  { id: "dashboard", where: "chat", prompt: "i want a little dashboard for my running: weekly km, a chart, and my next race", fit: { dialogs: 0, forms: 0, controls: 9, has: [/km/i, /race/i] } },
  { id: "phone-app", where: "chat", prompt: "mock a phone app screen for booking a haircut at a small barber shop", fit: { surface: ["phone"], dialogs: 0 } },
  { id: "onboarding", where: "chat", prompt: "show me the onboarding of a budgeting app as screens, from first launch to the first budget" },
  { id: "admin", where: "chat", prompt: "mock an admin page for a small online shop: orders with filters, and one order open" },
  { id: "chart", where: "chat", prompt: "visualize how my savings grow at 5% a year over 20 years starting with 1000" },
  { id: "announce", where: "chat", prompt: "make a one-page launch announcement for a calendar app called Fold" },
  { id: "small-pin", where: "chat", prompt: "show me a pin button for a chat row in a sidebar list", fit: { surface: ["part"], offers: true, dialogs: 0, forms: 0, controls: 9, bytes: 12000, has: [/pin/i] } },
  { id: "small-toast", where: "chat", prompt: "mock a small toast that says a file was saved, with an undo", fit: { surface: ["part"], dialogs: 0, forms: 0, controls: 6, bytes: 12000, has: [/saved/i, /undo/i] } },
  { id: "small-toggle", where: "chat", prompt: "what would a settings row with a dark mode toggle look like", fit: { surface: ["part"], offers: true, dialogs: 0, forms: 0, controls: 6, bytes: 12000, has: [/dark/i] } },
  { id: "review-settings", where: "project", prompt: "look at Demesne's Settings page and show me what most needs a redesign", fit: { review: true }, picture: "demesne-settings.png" },
  { id: "review-sidebar", where: "project", prompt: "what in Demesne's sidebar most needs work? show me", fit: { review: true }, picture: "02-turn.png" },
];

/// What a page holds, counted from its source (scripts and styles left out).
export function holds(source: string) {
  const picked = /<d-compare\b[^>]*\brecommended\s*=\s*["']?[^\s"'>]/i.test(source) || /<[^>]*\bdata-recommended\b[^>]*>/i.test(source);
  const body = source.replace(/<script\b[\s\S]*?<\/script>/gi, "").replace(/<style\b[\s\S]*?<\/style>/gi, "").replace(/<!--[\s\S]*?-->/g, "");
  const count = (pattern: RegExp) => (body.match(pattern) ?? []).length;
  const options = [...body.matchAll(/\bdata-option\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)].map((match) => match[1] ?? match[2] ?? "");
  return {
    options: options.filter((name) => !/^\s*today\b/i.test(name)).length,
    dialogs: count(/<dialog\b|\brole\s*=\s*["']?(?:dialog|alertdialog)\b/gi),
    forms: count(/<form\b/gi),
    controls: count(/<(?:button|a|input|select|textarea|summary)\b|\brole\s*=\s*["']?(?:button|tab|switch|checkbox|radio)\b|<d-(?:toggle|seg|tabs)\b/gi),
    bytes: Buffer.byteLength(source), picked,
    words: body.replace(/<[^>]+>/g, " "),
  };
}

/// How far a page is what was asked: the share of the ask's fixed points it
/// keeps, and the ones it misses, in words.
export function fitOf(fit: Fit, page: { source: string; surface?: string | null }): { score: number; misses: string[] } {
  const held = holds(page.source), misses: string[] = [];
  let points = 0;
  const point = (ok: boolean, miss: string) => { points++; if (!ok) misses.push(miss); };
  if (fit.surface) point(fit.surface.includes(page.surface ?? ""), `asked for ${fit.surface.join(" or ")}, saved as ${page.surface ?? "no surface"}`);
  if (fit.options !== undefined) point(held.options === fit.options, `${held.options} versions, ${fit.options} asked for`);
  for (const key of ["dialogs", "forms", "controls", "bytes"] as const) {
    const most = fit[key];
    if (most !== undefined) point(held[key] <= most, `${held[key]} ${key}, at most ${most} asked for`);
  }
  // A review sheet offers its options part by part (two parts of two options are not "four options").
  if (fit.offers && REVIEW_PAGE.test(page.source)) { const problem = reviewProblem(page.source); point(!problem, problem ? problem.split(" Hint:")[0]!.replace(/^\[[a-z_]+\]\s*/, "") : ""); }
  else if (fit.offers) point(held.options >= 2 && held.options <= 3 && held.picked, held.options < 2 ? `${held.options === 1 ? "one direction" : "no options"}, two or three with a pick are owed` : !held.picked ? "options with no pick" : `${held.options} options, at most three`);
  if (fit.review) {
    const problem = reviewProblem(page.source);
    point(REVIEW_PAGE.test(page.source), "not a review sheet (no <d-review>)");
    point(REVIEW_PAGE.test(page.source) && !problem, problem ? problem.split(" Hint:")[0]!.replace(/^\[[a-z_]+\]\s*/, "") : "no parts with Today, options and a pick");
  }
  for (const named of fit.has ?? []) point(named.test(held.words), `nothing for ${named.source}`);
  return { score: points ? (points - misses.length) / points : 1, misses };
}

export interface DesignNumbers { sizes: number; body: number; lead: number; rhythm: number; aligned: number; colours: number; surface: number }
export const CHECKS = ["faults", "sizes", "lead", "rhythm", "aligned", "colours", "surface"] as const;
export type Check = typeof CHECKS[number];
export const CHECK_WORDS: Record<Check, string> = {
  faults: "Nothing broken", sizes: "A type scale (3–6 sizes)", lead: "One thing leads (≥2.8× body)",
  rhythm: "Spacing from a few steps", aligned: "Shared left edges", colours: "A palette (3–8 colours)",
  surface: "More than text on paper",
};

const clamp = (value: number) => Math.max(0, Math.min(1, value));
const ramp = (value: number, zero: number, full: number) => clamp((value - zero) / (full - zero));

/// Each check 0..1 from the page's numbers and the faults found, at the one width it is drawn for.
/// What a page is decides which checks judge it. app: a mockup of the app
/// itself, which no headline leads and whose surfaces are the app's own.
/// part: a small thing at its own size (a button, a row, a card), which is
/// not a poster either. Both may hold one text size and two colours: the
/// app's own look is quiet, and a mockup of it is not marked down for that.
export type Judged = "page" | "app" | "part";
export function checks(design: DesignNumbers, faults: number, judged: Judged | boolean = "page"): Record<Check, number> {
  const as: Judged = judged === true ? "app" : judged === false ? "page" : judged, appWindow = as !== "page";
  return {
    faults: clamp(1 - faults / 6),
    sizes: design.sizes <= 2 ? (appWindow ? 1 : 0.5) : design.sizes <= 6 ? 1 : ramp(design.sizes, 12, 6),
    lead: appWindow ? 1 : ramp(design.lead, 1.4, 2.8),
    rhythm: ramp(design.rhythm, 0.6, 0.9),
    aligned: ramp(design.aligned, 0.4, 0.85),
    colours: design.colours <= 2 ? (appWindow ? 1 : 0.4) : design.colours <= 8 ? 1 : ramp(design.colours, 18, 8),
    surface: appWindow ? 1 : ramp(design.surface ?? 0, 0.05, 0.35),
  };
}

export const score = (parts: Record<Check, number>) => Math.round(100 * CHECKS.reduce((sum, check) => sum + parts[check], 0) / CHECKS.length);

export interface PageResult {
  id: string; prompt: string;
  /// Null when no page was made (or it was Markdown, which has no layout to score).
  title: string | null; kind: string | null; bytes: number; versions: number;
  score: number | null; checks: Record<Check, number> | null; design: DesignNumbers | null;
  issues: string[]; shots: string[];
  seconds: number; rounds: number; outputTokens: number; calls: string[]; error: string | null;
  /// The frame it chose, its demo's steps, demo-only controls left in the page, and how often one was sent back.
  surface?: string | null; demoSteps?: number; controls?: string[]; refused?: number;
  /// How far it is what was asked (0 to 1) and what it misses; absent when the ask fixes nothing.
  fit?: { score: number; misses: string[] };
}
export interface Report { model: string; when: string; label: string; results: PageResult[] }

/// The mean over pages that were made; a page that wasn't made counts 0.
export function summary(report: Report) {
  const made = report.results.filter((item) => item.score !== null);
  const mean = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
  return {
    score: Math.round(mean(report.results.map((item) => item.score ?? 0))),
    made: made.length, of: report.results.length,
    checks: Object.fromEntries(CHECKS.map((check) => [check, Math.round(100 * mean(made.map((item) => item.checks![check])))])) as Record<Check, number>,
    /// As asked, over the asks that fix something; a page not made keeps none of it.
    fit: report.results.some((item) => item.fit) ? Math.round(100 * mean(report.results.filter((item) => item.fit).map((item) => item.score === null ? 0 : item.fit!.score))) : null,
    bytes: Math.round(mean(made.map((item) => item.bytes))),
    seconds: Math.round(mean(report.results.map((item) => item.seconds))),
    outputTokens: Math.round(mean(report.results.map((item) => item.outputTokens))),
  };
}

/// Lines for the terminal: the totals, then before → after when there is a before.
export function compareLines(after: Report, before?: Report): string[] {
  const now = summary(after), then = before ? summary(before) : null;
  const pair = (a: number | undefined, b: number) => a === undefined ? String(b) : `${a} → ${b}`;
  const lines = [
    `Score ${pair(then?.score, now.score)}   pages made ${pair(then?.made, now.made)} of ${now.of}`,
    ...(now.fit === null ? [] : [`As asked ${pair(then?.fit ?? undefined, now.fit)}   (the frame, the count and the size the ask fixes)`]),
    ...CHECKS.map((check) => `  ${CHECK_WORDS[check].padEnd(32)} ${pair(then?.checks[check], now.checks[check])}`),
    `  ${"Source per page (bytes)".padEnd(32)} ${pair(then?.bytes, now.bytes)}`,
    `  ${"Seconds per ask".padEnd(32)} ${pair(then?.seconds, now.seconds)}`,
    `  ${"Output tokens per ask".padEnd(32)} ${pair(then?.outputTokens, now.outputTokens)}`,
  ];
  if (before) {
    for (const item of after.results) {
      const old = before.results.find((entry) => entry.id === item.id);
      if (old) lines.push(`  ${item.id.padEnd(20)} ${old.score ?? "-"} → ${item.score ?? "-"}`);
    }
  }
  for (const item of after.results) if (item.fit?.misses.length) lines.push(`  not as asked: ${item.id}: ${item.fit.misses.join("; ")}`);
  return lines;
}

const h = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

/// One HTML page with every ask's pictures and numbers, for the eye.
export function contactSheet(report: Report, before?: Report): string {
  const total = summary(report), then = before ? summary(before) : null;
  const cards = report.results.map((item) => {
    const old = before?.results.find((entry) => entry.id === item.id);
    const head = `<b>${h(item.title ?? "no page")}</b><span class="score">${old ? `${old.score ?? "–"} → ` : ""}${item.score ?? "–"}</span>`;
    const shots = item.shots.map((shot) => `<a href="${h(shot)}"><img src="${h(shot)}" loading="lazy" alt=""></a>`).join("");
    const parts = item.checks ? CHECKS.map((check) => `<i title="${h(CHECK_WORDS[check])}" style="--v:${item.checks![check]}">${check}</i>`).join("") : "";
    return `<article><header>${head}</header><p class="ask">${h(item.prompt)}</p><div class="shots">${shots}</div><div class="bars">${parts}</div>`
      + `<p class="meta">${h(item.id)} · ${item.kind ?? "–"} · ${(item.bytes / 1024).toFixed(1)} KB · v${item.versions} · ${item.seconds}s · ${item.outputTokens} out${item.error ? ` · ${h(item.error)}` : ""}</p>`
      + (item.fit ? `<p class="meta">as asked ${Math.round(item.fit.score * 100)}%${item.fit.misses.length ? `: ${h(item.fit.misses.join("; "))}` : ""}</p>` : "")
      + (item.issues.length ? `<details><summary>${item.issues.length} faults</summary><ul>${item.issues.map((issue) => `<li>${h(issue)}</li>`).join("")}</ul></details>` : "")
      + `</article>`;
  }).join("");
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Foundry quality · ${h(report.label)}</title>
<style>
:root{color-scheme:dark;--fg:#e9eaec;--muted:#9a9ea6;--hair:rgba(255,255,255,.09);--pink:#f2b6c8;--acc:#7eaef0}
body{margin:0;padding:24px 16px 48px;background:#0e0f11;color:var(--fg);font:14px/1.45 Inter,system-ui,sans-serif}
h1{margin:0 0 4px;font-size:22px}.lede{margin:0 0 20px;color:var(--muted)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,340px),1fr));gap:16px}
article{display:flex;flex-direction:column;gap:8px;padding:12px;border-radius:12px;background:#1c1c1e;box-shadow:inset 0 0 0 1px var(--hair);min-width:0}
header{display:flex;justify-content:space-between;gap:8px}.score{font-variant-numeric:tabular-nums;color:var(--pink);font-weight:600}
.ask{margin:0;color:var(--muted);font-size:12.5px}.meta{margin:0;color:var(--muted);font-size:11.5px}
.shots{display:grid;grid-template-columns:3fr 1fr;gap:6px;align-items:start}.shots img{width:100%;border-radius:6px;box-shadow:0 0 0 1px var(--hair);display:block;max-height:260px;object-fit:cover;object-position:top}
.bars{display:grid;grid-template-columns:repeat(7,1fr);gap:4px}.bars i{font-style:normal;font-size:10.5px;color:var(--muted);border-top:3px solid color-mix(in srgb,var(--acc) calc(var(--v)*100%),#3a3a3d);padding-top:2px}
details{font-size:12px;color:var(--muted)}ul{margin:4px 0 0;padding-left:18px}
.totals{display:flex;flex-wrap:wrap;gap:6px 18px;margin:0 0 20px;font-size:13px;color:var(--muted)}.totals b{color:var(--fg);font-weight:500}
</style>
<h1>Foundry quality · ${h(report.label)}</h1><p class="lede">${h(report.model)} · ${h(report.when)} · score ${then ? `${then.score} → ` : ""}${total.score}, ${total.made} of ${total.of} pages made</p>
<div class="totals">${CHECKS.map((check) => `<span>${h(CHECK_WORDS[check])} <b>${then ? `${then.checks[check]} → ` : ""}${total.checks[check]}</b></span>`).join("")}</div>
<div class="grid">${cards}</div>`;
}
