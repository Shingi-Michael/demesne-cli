/// What a Foundry page looks like once rendered, measured in the page itself:
/// the layout faults a single look catches (sideways scroll, text cut off or
/// spilling out of its box, text on text, text you can barely read, broken
/// images, and a crooked layout: cards in a row of different sizes, uneven
/// gaps, uneven margins, edges a few pixels off). Runs as one expression in the page; returns plain JSON. Kept
/// free of Electron so a test can run it in any Chromium.
export interface LookMeasure { width: number; height: number; issues: string[] }

export const LOOK_MEASURE = String.raw`(() => {
  const W = innerWidth, issues = [], MAX = 12;
  const say = (text) => { if (issues.length < MAX && !issues.includes(text)) issues.push(text); };
  const own = (el) => [...el.childNodes].some((node) => node.nodeType === 3 && node.textContent.trim());
  const label = (el) => {
    let tag = el.tagName.toLowerCase();
    if (el.id) tag += "#" + el.id; else if (el.classList.length) tag += "." + [...el.classList].slice(0, 2).join(".");
    const text = (el.innerText || el.getAttribute("aria-label") || "").trim().replace(/\s+/g, " ");
    return text ? tag + ' "' + (text.length > 40 ? text.slice(0, 39) + "…" : text) + '"' : tag;
  };
  const shown = (el) => {
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
    const box = el.getBoundingClientRect();
    return box.width > 0 && box.height > 0;
  };
  const skip = new Set(["SCRIPT", "STYLE", "LINK", "META", "TITLE", "BR", "TEMPLATE", "NOSCRIPT"]);
  const all = [...document.body.querySelectorAll("*")].filter((el) => !skip.has(el.tagName) && !el.closest("svg *")).slice(0, 4000).filter(shown);

  // Sideways scroll: name the outermost things that stick out.
  const wide = document.documentElement.scrollWidth;
  if (wide > W + 1) {
    const out = all.filter((el) => el.getBoundingClientRect().right > W + 1);
    const roots = out.filter((el) => !out.includes(el.parentElement)).slice(0, 3).map(label);
    say("Scrolls sideways by " + (wide - W) + "px at " + W + "px wide" + (roots.length ? "; too wide: " + roots.join(", ") : ""));
  }

  const texts = all.filter(own);
  const clips = (style) => /hidden|clip/.test(style.overflowX + style.overflowY);
  const boxed = (el, style) => el.tagName === "BUTTON" || el.tagName === "INPUT" || style.backgroundColor !== "rgba(0, 0, 0, 0)" && !/^rgba\(.*, 0\)$/.test(style.backgroundColor)
    || ["Top", "Right", "Bottom", "Left"].some((side) => parseFloat(style["border" + side + "Width"]) > 0);
  for (const el of texts) {
    const style = getComputedStyle(el);
    if (style.display.startsWith("inline") && style.display !== "inline-block" && style.display !== "inline-flex") continue;
    const overW = el.scrollWidth - el.clientWidth, overH = el.scrollHeight - el.clientHeight;
    if (el.clientWidth && (overW > 1 || overH > 2 && clips(style))) {
      if (clips(style)) { if (style.textOverflow !== "ellipsis") say("Text cut off in " + label(el)); }
      else if (boxed(el, style)) say("Text spills out of its box: " + label(el));
    }
    // Cut off by a container that hides overflow.
    for (let up = el.parentElement; up && up !== document.body; up = up.parentElement) {
      const upStyle = getComputedStyle(up);
      if (!clips(upStyle) || /auto|scroll/.test(upStyle.overflowX + upStyle.overflowY)) continue;
      const a = el.getBoundingClientRect(), b = up.getBoundingClientRect();
      if (a.left < b.left - 2 || a.right > b.right + 2 || a.top < b.top - 2 || a.bottom > b.bottom + 2) say(label(el) + " is clipped by " + label(up));
      break;
    }
  }

  // Text over text.
  const boxes = texts.slice(0, 300).map((el) => [el, el.getBoundingClientRect()]);
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const [a, ra] = boxes[i], [b, rb] = boxes[j];
    if (a.contains(b) || b.contains(a)) continue;
    const w = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left), h = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
    if (w > 2 && h > 2 && w * h > 0.3 * Math.min(ra.width * ra.height, rb.width * rb.height)) say(label(a) + " overlaps " + label(b));
  }

  // Text that can barely be read against what is behind it.
  // rgb()/rgba() in 0-255; color(srgb r g b / a) (what color-mix() gives) in 0-1; other spaces are skipped.
  const rgba = (value) => {
    const m = value.match(/-?[\d.]+(?:e-?\d+)?/g);
    if (!m) return null;
    const n = m.map(Number), alpha = (list) => list.concat(list.length < 4 ? [1] : []).slice(0, 4);
    if (value.startsWith("rgb")) return alpha(n);
    if (value.startsWith("color(srgb ")) return alpha(n.slice(0, 3).map((v) => v * 255).concat(n.slice(3)));
    return null;
  };
  const lum = ([r, g, b]) => { const c = [r, g, b].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
  const behind = (el) => {
    for (let at = el; at; at = at.parentElement) {
      const style = getComputedStyle(at);
      if (style.backgroundImage !== "none") return null;
      const bg = rgba(style.backgroundColor);
      if (bg && bg[3] > 0.5) return bg;
    }
    return rgba(getComputedStyle(document.documentElement).backgroundColor) ?? [255, 255, 255, 1];
  };
  let faint = 0;
  for (const el of texts) {
    if (faint >= 4) break;
    const fg = rgba(getComputedStyle(el).color), bg = behind(el);
    // Hidden on purpose (a transparent colour, or the background's own, like an unticked box's tick) is not faint.
    if (!fg || !bg || fg[3] < 0.15) continue;
    const mix = fg.slice(0, 3).map((v, k) => v * fg[3] + bg[k] * (1 - fg[3]));
    const [hi, lo] = [lum(mix), lum(bg)].sort((x, y) => y - x);
    const ratio = (hi + 0.05) / (lo + 0.05);
    // WCAG 2.1 AA (1.4.3): 4.5:1 for text, 3:1 for large text (24px, or 18.66px bold). A switched-off control is exempt.
    const style = getComputedStyle(el), size = parseFloat(style.fontSize), large = size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700);
    const need = large ? 3 : 4.5;
    if (el.closest(":disabled, [aria-disabled=true]")) continue;
    if (ratio > 1.05 && ratio < need - 0.05) { faint++; say("Hard to read (" + ratio.toFixed(1) + ":1 contrast, needs " + need + ":1): " + label(el)); }
  }

  // On a phone, things to tap are at least 44px each way (WCAG 2.5.5). A link
  // inside a sentence, a tick box with its label and a framed desktop app are exempt.
  if (W < 800) {
    let small = 0;
    for (const el of all) {
      if (small >= 3) break;
      if (!el.matches("button, a[href], select, input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=hidden]), [role=button], [role=tab]")) continue;
      // A desktop app drawn in a frame keeps its desktop-size controls: it is a picture of that app, not a phone screen.
      if (el.closest("[data-chrome], d-demesne, d-window, d-browser") || el.matches(":disabled, [aria-disabled=true]")) continue;
      if (el.tagName === "A" && getComputedStyle(el).display === "inline") continue;
      const box = el.getBoundingClientRect();
      if (box.height < 43.5 || box.width < 43.5) { small++; say("Too small to tap (" + Math.round(box.width) + "×" + Math.round(box.height) + "px, needs 44×44): " + label(el)); }
    }
  }

  // Text drawn too small to read: its size times every zoom above it (a part
  // shrunk to fit reports its own 14px while drawing 7px). Initials in an avatar, and
  // what's inside something named by its own aria-label (a slide's thumbnail), are pictures, not text.
  const drawn = (el) => { let size = parseFloat(getComputedStyle(el).fontSize); for (let at = el; at && at !== document.documentElement; at = at.parentElement) { const z = parseFloat(getComputedStyle(at).zoom); if (z > 0 && z !== 1) size *= z; } return size; };
  let tiny = 0;
  for (const el of texts) { if (tiny >= 3) break; if (el.closest("d-avatar") || el.parentElement?.closest("[aria-label]")) continue; const size = drawn(el); if (size < 10.5) { tiny++; say("Text drawn at " + size.toFixed(1) + "px, too small to read: " + label(el)); } }
  for (const img of document.images) if (img.complete && !img.naturalWidth) say("Image did not load: " + label(img));

  // A crooked layout (pass 200 A): what an eye sees as "not quite even".
  // Only near misses are named, never a difference that is clearly meant
  // (a 2fr/1fr grid, a tall card beside a short one by design is a big gap).
  // The parts' own frame chrome (data-chrome) is not the design.
  let crooked = 0;
  const bent = (text) => { if (crooked < 4) { crooked++; say(text); } };
  const px = (n) => Math.round(n) + "px";
  const design = all.filter((el) => !el.closest("[data-chrome]"));
  const card = (el) => {
    const style = getComputedStyle(el), box = el.getBoundingClientRect();
    return box.width >= 80 && box.height >= 40 && (boxed(el, style) || style.boxShadow !== "none");
  };
  // Rows: boxed siblings side by side under one parent.
  const parents = new Set(design.map((el) => el.parentElement).filter(Boolean));
  for (const parent of parents) {
    const kids = [...parent.children].filter((el) => design.includes(el) && card(el)).map((el) => [el, el.getBoundingClientRect()]);
    if (kids.length < 2) continue;
    const rows = [];
    for (const kid of kids.sort((a, b) => a[1].top - b[1].top || a[1].left - b[1].left)) {
      const row = rows.find((r) => Math.abs(r[0][1].top - kid[1].top) <= 12 && r.every(([, b]) => b.right <= kid[1].left + 1 || b.left >= kid[1].right - 1));
      if (row) row.push(kid); else rows.push([kid]);
    }
    for (const row of rows) {
      if (row.length < 2) continue;
      row.sort((a, b) => a[1].left - b[1].left);
      const name = label(parent), boxes = row.map(([, b]) => b);
      const tops = boxes.map((b) => b.top), heights = boxes.map((b) => b.height), widths = boxes.map((b) => b.width);
      const spread = (list) => Math.max(...list) - Math.min(...list);
      if (spread(tops) >= 2) bent("Cards side by side don't line up at the top (off by " + px(spread(tops)) + ") in " + name);
      else if (spread(heights) >= 3 && spread(heights) <= 0.25 * Math.max(...heights)) bent("Cards side by side differ in height: " + heights.map(px).join(", ") + " in " + name);
      const gaps = boxes.slice(1).map((b, i) => b.left - boxes[i].right);
      if (gaps.length > 1 && spread(gaps) >= 3) bent("Uneven gaps in a row: " + gaps.map(px).join(", ") + " in " + name);
      if (spread(widths) >= 4 && spread(widths) <= 0.15 * Math.max(...widths)) bent("Cards in a row are nearly but not quite the same width: " + widths.map(px).join(", ") + " in " + name);
    }
  }
  // Margins: the page's wide blocks, under something full width, sit off
  // centre (the margins most of them share, so one stray block isn't it).
  const sides = new Map();
  for (const el of design) {
    const box = el.getBoundingClientRect(), up = el.parentElement?.getBoundingClientRect();
    if (!up || up.width < W - 2 || box.width < 0.6 * W || box.width > W - 4) continue;
    const left = Math.round(box.left), right = Math.round(W - box.right);
    if (left < 0 || right < 0 || Math.max(left, right) > 0.25 * W) continue;
    const key = left + ":" + right, seen = sides.get(key) || { left, right, count: 0, el };
    seen.count++; sides.set(key, seen);
  }
  const usual = [...sides.values()].sort((a, b) => b.count - a.count)[0];
  if (usual && Math.abs(usual.left - usual.right) >= 4) bent("Left and right margins differ: " + px(usual.left) + " vs " + px(usual.right) + " around " + label(usual.el));
  // Edges: a block a few pixels off a left edge others in the same card (or
  // on the same page, outside any card) share. A card's inset is its own.
  const frameOf = (el) => { for (let at = el.parentElement; at && at !== document.body; at = at.parentElement) if (card(at)) return at; return document.body; };
  const blocks = design.filter((el) => (own(el) || card(el)) && !/^inline$/.test(getComputedStyle(el).display)).slice(0, 400).map((el) => [el, Math.round(el.getBoundingClientRect().left * 2) / 2, frameOf(el)]);
  const edges = new Map();
  const at = (frame, left) => edges.get(frame)?.get(left) || 0;
  for (const [, left, frame] of blocks) { if (!edges.has(frame)) edges.set(frame, new Map()); edges.get(frame).set(left, at(frame, left) + 1); }
  for (const [el, left, frame] of blocks) {
    const near = [...edges.get(frame).entries()].find(([edge, count]) => count >= 3 && Math.abs(edge - left) >= 1 && Math.abs(edge - left) <= 4);
    if (!near || at(frame, left) > 1) continue;
    if (blocks.some(([other, edge]) => edge === near[0] && (other.contains(el) || el.contains(other)))) continue;
    bent(label(el) + " starts " + px(Math.abs(near[0] - left)) + (left < near[0] ? " left" : " right") + " of the edge " + near[1] + " other blocks share");
  }
  return { width: W, height: document.documentElement.scrollHeight, issues };
})()`;

/// How designed a rendered page is, as numbers (eval-foundry-quality.ts
/// scores them; the model is not shown them yet). Measured on what shows:
/// how many type sizes, how big the lead is against the body, how much of
/// the spacing comes from a few steps, how many text blocks share a left edge
/// with another, and how many colours the page paints with.
export interface DesignMeasure {
  /// Distinct font sizes (px) of visible text, and the body size (most characters).
  sizes: number; body: number;
  /// The largest text size over the body size.
  lead: number;
  /// Share of margins, paddings and gaps drawn from the page's six most used spacings.
  rhythm: number;
  /// Share of text blocks whose left edge lines up with another block's.
  aligned: number;
  /// Distinct colours painted (text, fills, borders), near shades merged.
  colours: number;
  /// Share of the first screen painted with something other than the paper
  /// (its most common fill): other fills, gradients, pictures, SVG, canvas.
  surface: number;
}

export const DESIGN_MEASURE = String.raw`(() => {
  const skip = new Set(["SCRIPT", "STYLE", "LINK", "META", "TITLE", "BR", "TEMPLATE", "NOSCRIPT"]);
  const shown = (el) => {
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
    const box = el.getBoundingClientRect();
    return box.width > 0 && box.height > 0;
  };
  // Frame chrome from the parts (data-chrome: window bars, Demesne's sidebar and tabs) is the frame, not the design.
  const all = [...document.body.querySelectorAll("*")].filter((el) => !skip.has(el.tagName) && !el.closest("svg *") && !el.closest("[data-chrome]")).slice(0, 4000).filter(shown);
  const ownText = (el) => [...el.childNodes].filter((node) => node.nodeType === 3).map((node) => node.textContent.trim()).join("");
  const texts = all.map((el) => [el, ownText(el)]).filter(([, text]) => text.length > 0);

  const chars = new Map();
  for (const [el, text] of texts) { const size = Math.round(parseFloat(getComputedStyle(el).fontSize)); chars.set(size, (chars.get(size) || 0) + text.length); }
  const sizes = [...chars.keys()];
  const body = sizes.length ? [...chars.entries()].sort((a, b) => b[1] - a[1])[0][0] : 16;
  const lead = sizes.length ? Math.max(...sizes) / body : 1;

  const spacing = new Map();
  const sides = ["Top", "Right", "Bottom", "Left"];
  for (const el of all) {
    const style = getComputedStyle(el);
    const values = sides.flatMap((side) => [style["margin" + side], style["padding" + side]]).concat(style.display.includes("flex") || style.display.includes("grid") ? [style.rowGap, style.columnGap] : []);
    for (const value of values) {
      const px = Math.round(Math.abs(parseFloat(value)));
      if (!px || !Number.isFinite(px)) continue;
      spacing.set(px, (spacing.get(px) || 0) + 1);
    }
  }
  const counts = [...spacing.values()].sort((a, b) => b - a), spaced = counts.reduce((a, b) => a + b, 0);
  const onScale = counts.slice(0, 6).reduce((a, b) => a + b, 0);

  const blocks = texts.map(([el]) => el).filter((el) => { const display = getComputedStyle(el).display; return !display.startsWith("inline") || display === "inline-block" || display === "inline-flex"; });
  const edges = blocks.map((el) => Math.round(el.getBoundingClientRect().left));
  const aligned = edges.filter((x, i) => edges.some((y, j) => j !== i && Math.abs(x - y) <= 2)).length;

  const paint = new Set();
  const add = (value) => {
    const m = value && value.match(/-?[\d.]+(?:e-?\d+)?/g);
    if (!m || !value.startsWith("rgb") && !value.startsWith("color(srgb ")) return;
    let n = m.map(Number);
    if (value.startsWith("color(srgb ")) n = n.slice(0, 3).map((v) => v * 255).concat(n.slice(3));
    if (n.length > 3 && n[3] < 0.06) return;
    paint.add(n.slice(0, 3).map((v) => Math.round(v / 24)).join(","));
  };
  for (const el of all) {
    const style = getComputedStyle(el);
    if (ownText(el)) add(style.color);
    add(style.backgroundColor);
    if (parseFloat(style.borderTopWidth) > 0 || parseFloat(style.borderLeftWidth) > 0) add(style.borderTopColor);
  }
  add(getComputedStyle(document.documentElement).backgroundColor);

  // What paints each point: a picture, or the nearest fill. The most common fill is the paper.
  const rootBg = getComputedStyle(document.documentElement).backgroundColor;
  const fill = (el) => {
    for (let at = el; at; at = at.parentElement) {
      if (/^(IMG|CANVAS|VIDEO|svg)$/.test(at.tagName)) return "picture";
      const style = getComputedStyle(at);
      if (style.backgroundImage !== "none") return "picture";
      const bg = style.backgroundColor;
      if (bg !== "rgba(0, 0, 0, 0)" && !/, 0\)$/.test(bg)) return bg;
    }
    return rootBg;
  };
  const fills = [], H = Math.min(innerHeight, document.documentElement.scrollHeight);
  for (let y = 10; y < H; y += H / 24) for (let x = 10; x < innerWidth; x += innerWidth / 32) {
    const el = document.elementFromPoint(x, y);
    fills.push(el ? fill(el) : rootBg);
  }
  const tally = new Map();
  for (const value of fills) if (value !== "picture") tally.set(value, (tally.get(value) || 0) + 1);
  const paper = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const surface = fills.length ? fills.filter((value) => value !== paper).length / fills.length : 0;

  const round = (value) => Math.round(value * 100) / 100;
  return { surface: round(surface), sizes: sizes.length, body, lead: round(lead), rhythm: spaced ? round(onScale / spaced) : 1, aligned: blocks.length > 1 ? round(aligned / blocks.length) : 1, colours: paint.size };
})()`;
