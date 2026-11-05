/** The ruler for Foundry's pages (eval-foundry-quality.ts): the fixed asks,
 * how a rendered page's numbers become a score, and the contact sheet.
 *
 * A page's score is the mean of six checks, each 0 to 1:
 *   faults   nothing broken: no sideways scroll, clipped, spilling, faint or
 *            overlapping text, console errors (both widths)
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

export type Where = "project" | "chat";
export interface QualityCase { id: string; where: Where; prompt: string }

/// Twelve asks: four mockups of Demesne itself, the rest the kinds of page
/// people ask Foundry for. Kept fixed so scores compare across changes.
export const QUALITY_CASES: QualityCase[] = [
  { id: "demesne-settings", where: "project", prompt: "show me what a calmer, more organised Settings page for Demesne could look like" },
  { id: "demesne-empty", where: "project", prompt: "what could Demesne's home look like for someone who has no chats yet? mock it" },
  { id: "demesne-topbar", where: "project", prompt: "the top bar feels busy. show me two calmer versions side by side" },
  { id: "demesne-drive", where: "project", prompt: "mock how Drive could show the work it finished overnight when I open the app in the morning" },
  { id: "landing", where: "chat", prompt: "put together a landing page for a coffee subscription called Slow Pour" },
  { id: "pricing", where: "chat", prompt: "make a pricing page for a notes app with three plans and a monthly/yearly switch" },
  { id: "dashboard", where: "chat", prompt: "i want a little dashboard for my running: weekly km, a chart, and my next race" },
  { id: "phone-app", where: "chat", prompt: "mock a phone app screen for booking a haircut at a small barber shop" },
  { id: "onboarding", where: "chat", prompt: "show me the onboarding of a budgeting app as screens, from first launch to the first budget" },
  { id: "admin", where: "chat", prompt: "mock an admin page for a small online shop: orders with filters, and one order open" },
  { id: "chart", where: "chat", prompt: "visualize how my savings grow at 5% a year over 20 years starting with 1000" },
  { id: "announce", where: "chat", prompt: "make a one-page launch announcement for a calendar app called Fold" },
];

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

/// Each check 0..1 from the desktop page's numbers and the faults found at every width.
export function checks(design: DesignNumbers, faults: number): Record<Check, number> {
  return {
    faults: clamp(1 - faults / 6),
    sizes: design.sizes <= 2 ? 0.5 : design.sizes <= 6 ? 1 : ramp(design.sizes, 12, 6),
    lead: ramp(design.lead, 1.4, 2.8),
    rhythm: ramp(design.rhythm, 0.6, 0.9),
    aligned: ramp(design.aligned, 0.4, 0.85),
    colours: design.colours <= 2 ? 0.4 : design.colours <= 8 ? 1 : ramp(design.colours, 18, 8),
    surface: ramp(design.surface ?? 0, 0.05, 0.35),
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
