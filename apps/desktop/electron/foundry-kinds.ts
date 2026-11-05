/// Foundry's ready kinds: a Deck, a Doc and a Dashboard. The agent sends
/// only content, as Markdown with a few small blocks, and Demesne draws it
/// with a fixed, designed renderer, so the result looks good every time and
/// a revision is a small edit to text rather than a redesigned page.
///
/// The content, for all three:
///   - optional front matter between --- lines at the very top:
///     title, subtitle, author, date, theme (paper ink forest ocean sand
///     plum), accent (a #hex colour)
///   - Markdown (GitHub flavoured: tables, lists, quotes, code)
///   - ```chart blocks: type (bar line area donut hbar), title, labels,
///     then one or more series as "Name: 1, 2, 3" (or values: …), unit, note
///   - ```stats blocks: one tile per line, "label | value | delta | note"
///   - > [!NOTE] / [!TIP] / [!WARNING] quotes become callouts
/// A Deck splits into slides on lines that are only ---; a slide may pick
/// its layout with <!-- layout: title|statement|number|quote|split|points -->
/// or leave it to its content. A Dashboard groups its blocks under ##
/// headings into a grid of cards.
///
/// The page is drawn here, in the app (policy.ts foundryDocument), with
/// the kit's stylesheet and kinds.css/kinds.js from foundry://kit, so
/// Export inlines the same files and the page stands on its own.
import { Marked, type Token, type Tokens } from "marked";

export const READY_KINDS = ["deck", "doc", "dashboard"] as const;
export type ReadyKind = typeof READY_KINDS[number];
export const isReadyKind = (kind: string): kind is ReadyKind => (READY_KINDS as readonly string[]).includes(kind);

export const DECK_THEMES = ["paper", "ink", "forest", "ocean", "sand", "plum"] as const;
export const KINDS_STYLE = "foundry://kit/kinds.css", KINDS_SCRIPT = "foundry://kit/kinds.js";

const esc = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

export interface FrontMatter { title?: string; subtitle?: string; author?: string; date?: string; theme?: string; accent?: string }

/// The front matter at the top, if any, and the content after it.
export function frontMatter(source: string): { meta: FrontMatter; body: string } {
  const text = source.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const found = /^---[ \t]*\n((?:[ \t]*[A-Za-z][\w-]*[ \t]*:.*\n|[ \t]*\n)*?)---[ \t]*(?:\n|$)/.exec(text);
  if (!found) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  for (const line of found[1]!.split("\n")) {
    const pair = /^\s*([A-Za-z][\w-]*)\s*:\s*(.*?)\s*$/.exec(line);
    if (pair) meta[pair[1]!.toLowerCase()] = pair[2]!.replace(/^(["'])(.*)\1$/, "$2");
  }
  return { meta, body: text.slice(found[0].length) };
}

/// Splits on lines that are only --- (three or more), never inside a code fence.
export function splitSlides(body: string): string[] {
  const slides: string[] = [];
  let current: string[] = [], fence: string | null = null;
  for (const line of body.split("\n")) {
    const opens = /^\s*(`{3,}|~{3,})/.exec(line);
    if (opens) fence = fence === null ? opens[1]![0]! : line.trim().startsWith(fence) ? null : fence;
    if (fence === null && /^\s*-{3,}\s*$/.test(line)) { slides.push(current.join("\n")); current = []; continue; }
    current.push(line);
  }
  slides.push(current.join("\n"));
  return slides.filter((slide) => slide.replace(/<!--[\s\S]*?-->/g, "").trim());
}

// ---------------------------------------------------------------- charts

export interface ChartSpec { type: string; title: string; labels: string[]; series: { name: string; values: number[] }[]; unit: string; note: string }
const CHART_TYPES = ["bar", "line", "area", "donut", "hbar"];
const numbers = (text: string) => {
  const parts = text.split(/[,;]/).map((item) => item.trim()).filter(Boolean);
  const values = parts.map((item) => Number(item.replace(/[_\s]/g, "").replace(/%$/, "")));
  return parts.length && values.every(Number.isFinite) ? values : null;
};

export function parseChart(text: string): ChartSpec {
  const spec: ChartSpec = { type: "bar", title: "", labels: [], series: [], unit: "", note: "" };
  for (const line of text.split("\n")) {
    const pair = /^\s*([^:]+?)\s*:\s*(.*?)\s*$/.exec(line);
    if (!pair) continue;
    const key = pair[1]!.toLowerCase(), value = pair[2]!;
    if (key === "type") spec.type = CHART_TYPES.includes(value.toLowerCase()) ? value.toLowerCase() : "bar";
    else if (key === "title") spec.title = value;
    else if (key === "labels" || key === "x") spec.labels = value.split(",").map((item) => item.trim());
    else if (key === "unit") spec.unit = value;
    else if (key === "note" || key === "source") spec.note = value;
    else { const values = numbers(value); if (values) spec.series.push({ name: key === "values" || key === "y" ? "" : pair[1]!.trim(), values }); }
  }
  spec.series = spec.series.slice(0, 4);
  return spec;
}

/// 1200 → 1.2k, 3_400_000 → 3.4M, kept short for an axis.
export function compact(value: number) {
  const abs = Math.abs(value);
  const short = (n: number, suffix: string) => `${Number(n.toFixed(Math.abs(n) < 100 ? 1 : 0))}${suffix}`;
  if (abs >= 1e9) return short(value / 1e9, "B");
  if (abs >= 1e6) return short(value / 1e6, "M");
  if (abs >= 1e4) return short(value / 1e3, "k");
  return Number.isInteger(value) ? value.toLocaleString("en-US") : String(Number(value.toFixed(2)));
}

/// A round top for the axis: 3,700 → 4,000; 0.86 → 1.
function niceMax(value: number) {
  if (value <= 0) return 1;
  const step = 10 ** Math.floor(Math.log10(value)), lead = value / step;
  return (lead <= 1 ? 1 : lead <= 2 ? 2 : lead <= 2.5 ? 2.5 : lead <= 5 ? 5 : 10) * step;
}

const SERIES = ["var(--c1)", "var(--c2)", "var(--c3)", "var(--c4)"];

/// An SVG chart drawn from the spec: scales with its box, coloured by the
/// page's palette (--c1…--c4), labels in the page's own face.
export function chartSVG(spec: ChartSpec, size: { width: number; height: number } = { width: 640, height: 300 }): string {
  const { width: W, height: H } = size;
  const series = spec.series.filter((item) => item.values.length);
  if (!series.length) return `<p class="k-empty">No numbers for this chart.</p>`;
  const count = Math.max(...series.map((item) => item.values.length));
  const labels = Array.from({ length: count }, (_, i) => spec.labels[i] ?? "");
  const unit = (value: number) => `${compact(value)}${spec.unit && spec.unit.length <= 3 ? spec.unit : ""}`;
  const title = esc(spec.title || "Chart");
  if (spec.type === "donut") {
    // A fixed box, so the legend reads the same in a slide, a doc or a card;
    // the middle says the biggest part.
    const values = series[0]!.values.map((value) => Math.max(0, value)), total = values.reduce((a, b) => a + b, 0) || 1;
    const fill = (i: number) => i < 4 ? SERIES[i] : `color-mix(in srgb,var(--c1) ${Math.max(20, 100 - i * 18)}%,transparent)`;
    const r = 86, c = 2 * Math.PI * r; let at = 0;
    const rings = values.map((value, i) => {
      const length = c * value / total, ring = `<circle cx="120" cy="120" r="${r}" fill="none" style="stroke:${fill(i)}" stroke-width="34" stroke-dasharray="${length.toFixed(2)} ${(c - length).toFixed(2)}" stroke-dashoffset="${(-at).toFixed(2)}" transform="rotate(-90 120 120)"/>`;
      at += length; return ring;
    }).join("");
    const shown = values.slice(0, 8);
    const legend = shown.map((value, i) => `<g transform="translate(262 ${Math.round(124 - shown.length * 13 + i * 26)})"><rect width="12" height="12" rx="3" y="-10" style="fill:${fill(i)}"/><text x="22" class="k-lab">${esc((labels[i] || `Part ${i + 1}`).slice(0, 18))}</text><text x="196" class="k-val" text-anchor="end">${Math.round(value / total * 100)}%</text></g>`).join("");
    const top = values.indexOf(Math.max(...values));
    return `<svg class="k-chart donut" viewBox="0 0 460 240" role="img" aria-label="${title}">${rings}<text x="120" y="124" text-anchor="middle" class="k-total">${Math.round(values[top]! / total * 100)}%</text><text x="120" y="146" text-anchor="middle" class="k-axis">${esc((labels[top] ?? "").slice(0, 16))}</text>${legend}</svg>`;
  }
  const all = series.flatMap((item) => item.values);
  const low = Math.min(0, ...all), high = niceMax(Math.max(...all, 0)), span = high - low || 1;
  const left = 52, right = 16, top = 16, bottom = 34;
  if (spec.type === "hbar") {
    const values = series[0]!.values.slice(0, 12), rowH = Math.min(44, (H - top - 8) / values.length), labelW = Math.min(180, W * 0.3), most = Math.max(...values, 0) || 1;
    const bars = values.map((value, i) => {
      const y = top + i * rowH, w = Math.max(2, (W - labelW - 70) * Math.max(0, value) / most);
      return `<text x="${labelW - 12}" y="${(y + rowH / 2 + 4).toFixed(1)}" text-anchor="end" class="k-lab">${esc(labels[i])}</text><rect x="${labelW}" y="${(y + rowH * 0.18).toFixed(1)}" width="${w.toFixed(1)}" height="${(rowH * 0.64).toFixed(1)}" rx="4" style="fill:${i === 0 ? SERIES[0] : "color-mix(in srgb,var(--c1) 55%,transparent)"}"/><text x="${(labelW + w + 8).toFixed(1)}" y="${(y + rowH / 2 + 4).toFixed(1)}" class="k-val">${esc(unit(value))}</text>`;
    }).join("");
    return `<svg class="k-chart" viewBox="0 0 ${W} ${Math.ceil(top + rowH * values.length + 8)}" role="img" aria-label="${title}">${bars}</svg>`;
  }
  const plotW = W - left - right, plotH = H - top - bottom;
  const y = (value: number) => top + plotH - (value - low) / span * plotH;
  const grid = [0, 0.5, 1].map((f) => { const value = low + span * f, gy = y(value); return `<line x1="${left}" x2="${W - right}" y1="${gy.toFixed(1)}" y2="${gy.toFixed(1)}" class="k-grid"/><text x="${left - 10}" y="${(gy + 4).toFixed(1)}" text-anchor="end" class="k-axis">${esc(unit(value))}</text>`; }).join("");
  const every = Math.ceil(count / Math.max(1, Math.floor(plotW / 64)));
  let marks = "", ticks = "";
  if (spec.type === "bar") {
    const slot = plotW / count, groupW = slot * 0.7, barW = groupW / series.length;
    series.forEach((item, s) => item.values.forEach((value, i) => {
      const x = left + i * slot + (slot - groupW) / 2 + s * barW, from = y(Math.max(0, low)), to = y(value);
      marks += `<rect x="${(x + 1).toFixed(1)}" y="${Math.min(from, to).toFixed(1)}" width="${Math.max(1, barW - 2).toFixed(1)}" height="${Math.max(1, Math.abs(from - to)).toFixed(1)}" rx="${Math.min(5, barW / 4).toFixed(1)}" style="fill:${SERIES[s]}"/>`;
      if (series.length === 1 && count <= 8) marks += `<text x="${(x + barW / 2).toFixed(1)}" y="${(to - 7).toFixed(1)}" text-anchor="middle" class="k-val">${esc(unit(value))}</text>`;
    }));
    ticks = labels.map((label, i) => i % every ? "" : `<text x="${(left + i * slot + slot / 2).toFixed(1)}" y="${H - 10}" text-anchor="middle" class="k-axis">${esc(label)}</text>`).join("");
  } else {
    const x = (i: number) => left + (count === 1 ? plotW / 2 : i * plotW / (count - 1));
    series.forEach((item, s) => {
      const points = item.values.map((value, i) => `${x(i).toFixed(1)},${y(value).toFixed(1)}`).join(" ");
      if (spec.type === "area") marks += `<polygon points="${x(0).toFixed(1)},${y(Math.max(0, low)).toFixed(1)} ${points} ${x(item.values.length - 1).toFixed(1)},${y(Math.max(0, low)).toFixed(1)}" style="fill:${SERIES[s]};fill-opacity:${s ? 0.1 : 0.18}"/>`;
      marks += `<polyline points="${points}" fill="none" style="stroke:${SERIES[s]}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`;
      const last = item.values.length - 1;
      marks += `<circle cx="${x(last).toFixed(1)}" cy="${y(item.values[last]!).toFixed(1)}" r="4" style="fill:${SERIES[s]}"/>`;
      if (series.length === 1) marks += `<text x="${(x(last) - 8).toFixed(1)}" y="${(y(item.values[last]!) - 10).toFixed(1)}" text-anchor="end" class="k-val">${esc(unit(item.values[last]!))}</text>`;
    });
    ticks = labels.map((label, i) => i % every && i !== count - 1 ? "" : `<text x="${x(i).toFixed(1)}" y="${H - 10}" text-anchor="${i === 0 && count > 1 ? "start" : i === count - 1 && count > 1 ? "end" : "middle"}" class="k-axis">${esc(label)}</text>`).join("");
  }
  return `<svg class="k-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${title}">${grid}${marks}${ticks}</svg>`;
}

/// A chart as a figure: its title, a legend for more than one series, the SVG, a note.
export function chartFigure(text: string, size?: { width: number; height: number }) {
  const spec = parseChart(text);
  const legend = spec.series.length > 1 ? `<div class="k-legend">${spec.series.map((item, i) => `<span><i style="background:${SERIES[i]}"></i>${esc(item.name)}</span>`).join("")}</div>` : "";
  return `<figure class="k-figure${spec.type === "donut" ? " is-donut" : ""}">${spec.title ? `<figcaption class="k-ctitle">${esc(spec.title)}</figcaption>` : ""}${legend}<div class="k-plot">${chartSVG(spec, size)}</div>${spec.note ? `<p class="k-note">${esc(spec.note)}</p>` : ""}</figure>`;
}

/// One tile per line: label | value | delta | note.
export function statsHTML(text: string) {
  const tiles = text.split("\n").map((line) => line.split("|").map((cell) => cell.trim())).filter((cells) => cells.length >= 2 && cells[1]).slice(0, 8).map(([label, value, delta, note]) => {
    const down = delta ? /^[-−↓]/.test(delta) : false;
    return `<div class="k-stat"><span class="k-stat-l">${esc(label)}</span><span class="k-stat-v">${esc(value)}</span>${delta || note ? `<span class="k-stat-f">${delta ? `<b class="${down ? "down" : "up"}">${esc(delta)}</b>` : ""}${note ? `<span>${esc(note)}</span>` : ""}</span>` : ""}</div>`;
  }).join("");
  return tiles ? `<div class="k-stats" style="--n:${Math.min(4, (tiles.match(/class="k-stat"/g) ?? []).length)}">${tiles}</div>` : "";
}

// ---------------------------------------------------------------- Markdown

const CALLOUT = /^\s*(?:\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]|\*\*(Note|Tip|Important|Warning|Caution):?\*\*:?)\s*/i;

function markdown(chartSize?: { width: number; height: number }) {
  const marked = new Marked({ gfm: true, breaks: false });
  marked.use({
    renderer: {
      code(token: Tokens.Code) {
        const lang = (token.lang ?? "").trim().toLowerCase();
        if (lang === "chart") return chartFigure(token.text, chartSize);
        if (lang === "stats" || lang === "stat") return statsHTML(token.text);
        return `<pre><code>${esc(token.text)}</code></pre>`;
      },
      blockquote(token: Tokens.Blockquote) {
        const first = token.tokens[0];
        const found = first?.type === "paragraph" ? CALLOUT.exec((first as Tokens.Paragraph).raw) : null;
        if (!found) return `<blockquote>${this.parser.parse(token.tokens)}</blockquote>`;
        const kind = (found[1] ?? found[2]!).toLowerCase();
        const rest = token.text.replace(CALLOUT, "");
        return `<aside class="k-callout ${kind === "warning" || kind === "caution" ? "warn" : kind === "tip" ? "tip" : "note"}"><b>${esc(kind[0]!.toUpperCase() + kind.slice(1))}</b>${marked.parse(rest) as string}</aside>`;
      },
      table(token: Tokens.Table) {
        const numeric = token.header.map((_, column) => token.rows.length > 0 && token.rows.every((row) => /^[-+−]?[$€£¥]?[\d.,]+\s*[%kKmMxX×]?$|^[-–—]$/.test((row[column]?.text ?? "").trim() || "-")));
        const cell = (item: Tokens.TableCell, column: number, tag: string) => `<${tag}${numeric[column] || item.align === "right" ? ' class="num"' : item.align === "center" ? ' class="mid"' : ""}>${this.parser.parseInline(item.tokens)}</${tag}>`;
        return `<div class="k-table"><table><thead><tr>${token.header.map((item, i) => cell(item, i, "th")).join("")}</tr></thead><tbody>${token.rows.map((row) => `<tr>${row.map((item, i) => cell(item, i, "td")).join("")}</tr>`).join("")}</tbody></table></div>`;
      },
    },
  });
  return marked;
}

const page = (kind: ReadyKind, title: string, meta: FrontMatter, body: string) => {
  const theme = DECK_THEMES.find((name) => name === meta.theme?.toLowerCase());
  const accent = meta.accent && /^#[0-9a-f]{3,8}$/i.test(meta.accent) ? meta.accent : null;
  return `<!doctype html><html lang="en" data-kind="${kind}"${theme ? ` data-look="${theme}"` : ""}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<title>${esc(title)}</title><link rel="stylesheet" href="foundry://kit/base.css"><link rel="stylesheet" href="${KINDS_STYLE}">`
    + (accent ? `<style>:root,[data-look]{--accent:${accent};--c1:${accent}}</style>` : "")
    + `</head><body>${body}<script src="${KINDS_SCRIPT}"></script></body></html>`;
};

// ---------------------------------------------------------------- Deck

export type SlideLayout = "title" | "statement" | "number" | "quote" | "split" | "chart" | "points";
const LAYOUTS: SlideLayout[] = ["title", "statement", "number", "quote", "split", "chart", "points"];

/// What a slide's content asks for when it doesn't say.
export function slideLayout(source: string, index: number): SlideLayout {
  const said = /<!--\s*layout\s*:\s*([a-z]+)\s*-->/i.exec(source)?.[1]?.toLowerCase();
  if (said && (LAYOUTS as string[]).includes(said)) return said as SlideLayout;
  const text = source.replace(/<!--[\s\S]*?-->/g, "").trim();
  const lines = text.split("\n").filter((line) => line.trim());
  const heading = /^#{1,2}\s+(.+)$/.exec(lines[0] ?? "")?.[1]?.trim() ?? "";
  const hasChart = /```\s*(chart|stats?)\b/i.test(text);
  if (lines.length && lines.every((line) => /^\s*>/.test(line))) return "quote";
  if (/^[-+−]?[$€£¥]?\d[\d.,]*\s*(%|×|x|k|m|bn|b)?\b/i.test(heading) && heading.length <= 12 && !hasChart) return "number";
  if (hasChart) return /^\s*[-*]\s|^\s*\d+\.\s/m.test(text.replace(/```[\s\S]*?```/g, "")) ? "split" : "chart";
  const rest = lines.slice(1).join(" ");
  if (index === 0 && heading && rest.length < 200 && !/^\s*[-*]\s/m.test(text)) return "title";
  if (heading && lines.length <= 2 && rest.length < 140) return "statement";
  return "points";
}

export function renderDeck(source: string, fallbackTitle: string) {
  const { meta, body } = frontMatter(source);
  const marked = markdown({ width: 800, height: 340 });
  const slides = splitSlides(body);
  const title = meta.title || /^#\s+(.+)$/m.exec(slides[0] ?? "")?.[1]?.trim() || fallbackTitle;
  const total = slides.length;
  const html = slides.map((slide, i) => {
    const layout = slideLayout(slide, i);
    let inner = marked.parse(slide.replace(/<!--\s*layout\s*:[^>]*-->/gi, "")) as string;
    if (layout === "split") {
      // Words on the left, the chart or stats on the right.
      const visual = /<(figure|div class="k-stats")[\s\S]*$/.exec(inner)?.[0] ?? "";
      const head = /^\s*<h[12][^>]*>[\s\S]*?<\/h[12]>/.exec(inner)?.[0] ?? "";
      const words = inner.slice(head.length, visual ? inner.length - visual.length : undefined);
      inner = `${head}<div class="s-cols"><div class="s-words">${words}</div><div class="s-visual">${visual}</div></div>`;
    }
    const foot = i === 0 && (meta.author || meta.date) ? `<span>${esc([meta.author, meta.date].filter(Boolean).join(" · "))}</span>` : `<span>${esc(title)}</span><span>${i + 1} / ${total}</span>`;
    return `<section class="slide" data-layout="${layout}" data-index="${i + 1}" aria-label="Slide ${i + 1} of ${total}"><div class="s-in">${inner}</div><footer class="s-foot">${foot}</footer></section>`;
  }).join("");
  const body2 = `<main class="deck" aria-roledescription="slide deck"><div class="deck-stage">${html}</div><nav class="deck-strip" aria-label="Slides" data-chrome></nav><div class="deck-bar" data-chrome><button type="button" class="deck-prev" aria-label="Previous slide">‹</button><span class="deck-count">1 / ${total}</span><button type="button" class="deck-next" aria-label="Next slide">›</button></div></main>`;
  return page("deck", title, meta, body2);
}

// ---------------------------------------------------------------- Doc

export function renderDoc(source: string, fallbackTitle: string) {
  const { meta, body } = frontMatter(source);
  let text = body;
  let title = meta.title;
  if (!title) { const first = /^\s*#\s+(.+)\n?/.exec(text); if (first) { title = first[1]!.trim(); text = text.slice(first[0].length); } }
  title ||= fallbackTitle;
  const marked = markdown({ width: 680, height: 300 });
  const slugs = new Map<string, number>();
  const toc: { id: string; text: string }[] = [];
  const content = (marked.parse(text) as string).replace(/<h2>([\s\S]*?)<\/h2>/g, (_, inner: string) => {
    const words = inner.replace(/<[^>]+>/g, "").trim();
    let id = words.toLowerCase().replace(/&[a-z#0-9]+;/g, "").replace(/[^\w]+/g, "-").replace(/^-|-$/g, "") || "part";
    const seen = slugs.get(id) ?? 0; slugs.set(id, seen + 1); if (seen) id += `-${seen + 1}`;
    toc.push({ id, text: words });
    return `<h2 id="${id}">${inner}</h2>`;
  });
  const byline = [meta.author, meta.date].filter(Boolean).map(esc).join(" · ");
  const words = text.replace(/```[\s\S]*?```/g, "").split(/\s+/).filter(Boolean).length;
  const minutes = Math.max(1, Math.round(words / 230));
  const contents = toc.length >= 3 ? `<nav class="doc-toc" aria-label="Contents"><span class="eyebrow">Contents</span>${toc.map((item) => `<a href="#${item.id}">${esc(item.text)}</a>`).join("")}</nav>` : "";
  const html = `<div class="doc${contents ? " has-toc" : ""}">${contents}<article class="doc-body"><header class="doc-head"><p class="eyebrow">${byline ? `${byline} · ` : ""}${minutes} min read</p><h1>${esc(title)}</h1>${meta.subtitle ? `<p class="doc-lede">${esc(meta.subtitle)}</p>` : ""}</header>${content}</article></div>`;
  return page("doc", title, meta, html);
}

// ---------------------------------------------------------------- Dashboard

/// Each top-level block becomes a card sized by what it is: stats a row of
/// tiles, a chart half the width (a donut a third), a table the full width,
/// words a note.
export function renderDashboard(source: string, fallbackTitle: string) {
  const { meta, body } = frontMatter(source);
  const marked = markdown({ width: 640, height: 260 });
  const tokens = marked.lexer(body);
  let title = meta.title, lede = meta.subtitle ?? "";
  const sections: { heading: string; cards: string[] }[] = [{ heading: "", cards: [] }];
  let note: Token[] = [];
  const flush = () => { if (note.length) sections.at(-1)!.cards.push(`<div class="k-card span-note">${marked.parser(note as Token[] & { links: Record<string, never> })}</div>`); note = []; };
  for (const token of tokens) {
    if (token.type === "space") continue;
    if (token.type === "heading" && token.depth === 1 && !title) { title = token.text; continue; }
    if (token.type === "paragraph" && !lede && sections.length === 1 && !sections[0]!.cards.length && !note.length && title && !meta.subtitle) { lede = token.text; continue; }
    if (token.type === "heading" && token.depth <= 2) { flush(); sections.push({ heading: token.text, cards: [] }); continue; }
    const lang = token.type === "code" ? ((token as Tokens.Code).lang ?? "").trim().toLowerCase() : "";
    if (lang === "stats" || lang === "stat") { flush(); sections.at(-1)!.cards.push(`<div class="span-all">${statsHTML((token as Tokens.Code).text)}</div>`); continue; }
    if (lang === "chart") {
      flush();
      const spec = parseChart((token as Tokens.Code).text);
      sections.at(-1)!.cards.push(`<div class="k-card ${spec.type === "donut" ? "span-third" : "span-half"}">${chartFigure((token as Tokens.Code).text, spec.type === "donut" ? { width: 420, height: 240 } : { width: 640, height: 260 })}</div>`);
      continue;
    }
    if (token.type === "table") { flush(); sections.at(-1)!.cards.push(`<div class="k-card ${(token as Tokens.Table).header.length <= 3 ? "span-half" : "span-all"} is-table">${marked.parser([token] as Token[] & { links: Record<string, never> })}</div>`); continue; }
    note.push(token);
  }
  flush();
  for (const section of sections) section.cards = fillRows(section.cards);
  title ||= fallbackTitle;
  const html = `<main class="dash"><header class="dash-head"><div><h1>${esc(title)}</h1>${lede ? `<p class="dash-lede">${marked.parseInline(lede)}</p>` : ""}</div>${meta.date ? `<span class="dash-date">${esc(meta.date)}</span>` : ""}</header>`
    + sections.filter((section) => section.cards.length).map((section) => `<section class="dash-sec">${section.heading ? `<h2 class="eyebrow">${esc(section.heading)}</h2>` : ""}<div class="dash-grid">${section.cards.join("")}</div></section>`).join("")
    + `</main>`;
  return page("dashboard", title, meta, html);
}

/// Half-width cards pair up; one left alone on its row takes the whole row,
/// so a dashboard never shows a hole.
export function fillRows(cards: string[]) {
  const half = (card: string) => / span-(half|note|third)\b/.test(card.slice(0, 80));
  return cards.map((card, i) => {
    if (!half(card)) return card;
    let before = 0;
    for (let j = i - 1; j >= 0 && half(cards[j]!); j--) before++;
    const startsRow = before % 2 === 0, partner = cards[i + 1] !== undefined && half(cards[i + 1]!);
    return startsRow && !partner ? card.replace(/ span-(half|note|third)\b/, " span-all") : card.replace(/ span-third\b/, " span-half");
  });
}

export function renderReadyKind(kind: ReadyKind, source: string, title: string) {
  return kind === "deck" ? renderDeck(source, title) : kind === "doc" ? renderDoc(source, title) : renderDashboard(source, title);
}
