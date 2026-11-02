/// What a Foundry page looks like once rendered, measured in the page itself:
/// the layout faults a single look catches (sideways scroll, text cut off or
/// spilling out of its box, text on text, text you can barely read, broken
/// images). Runs as one expression in the page; returns plain JSON. Kept
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
    if (ratio > 1.05 && ratio < 3) { faint++; say("Hard to read (" + ratio.toFixed(1) + ":1 contrast): " + label(el)); }
  }

  for (const img of document.images) if (img.complete && !img.naturalWidth) say("Image did not load: " + label(img));
  return { width: W, height: document.documentElement.scrollHeight, issues };
})()`;
