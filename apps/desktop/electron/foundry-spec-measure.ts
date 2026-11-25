/// Piece 7 of pass 274, a measured hand-off: what a mockup measures once it
/// is drawn, read in the page itself, so "build it" starts from numbers
/// instead of a picture. Runs as one expression in the page and returns plain
/// JSON. Kept free of Electron so a test can run it in any Chromium.
///
/// It reads: the page's size and ground, the colours in use and what each is
/// used for, the type styles with a sample of each, the spacings and corner
/// radii the page keeps to, each named part (where it sits, how big it is,
/// its type, colours, padding and corners), the words in reading order, and
/// how things move (transitions and animations with their timing).
export interface SpecPart { name: string; tag: string; text: string; x: number; y: number; width: number; height: number; font: string; color: string; background: string; padding: string; radius: string; border: string; gap: string; layout: string; missing?: boolean }
/// on: the rule's selector; frames: an animation's first and last keyframes.
export interface SpecMotion { on: string; what: string; duration: string; easing: string; delay: string; name?: string; frames?: string }
export interface SpecMeasure {
  page: { width: number; height: number; background: string; color: string; font: string };
  colours: { value: string; uses: string[]; share: number }[];
  type: { font: string; size: string; weight: string; line: string; sample: string; chars: number }[];
  spacing: number[];
  radii: string[];
  parts: SpecPart[];
  words: string[];
  motion: SpecMotion[];
}

const SPEC_FN = String.raw`(given) => {
  const skip = new Set(["SCRIPT", "STYLE", "LINK", "META", "TITLE", "BR", "TEMPLATE", "NOSCRIPT", "HEAD"]);
  const hex = (value) => { const m = /rgba?\(([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\)/.exec(value || ""); if (!m) return ""; const a = m[4] === undefined ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]); if (a === 0) return ""; return "#" + [m[1], m[2], m[3]].map((n) => Math.round(Number(n)).toString(16).padStart(2, "0")).join("") + (a < 1 ? " at " + Math.round(a * 100) + "%" : ""); };
  const shown = (el) => { const s = getComputedStyle(el); if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) === 0) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const own = (el) => [...el.childNodes].filter((node) => node.nodeType === 3).map((node) => node.textContent).join(" ").replace(/\s+/g, " ").trim();
  const quiet = (value) => value && !/^(0px|none|normal|auto)( (0px|none|normal|auto))*$/.test(value) ? value : "";
  const family = (s) => (s.fontFamily.split(",")[0] || "").replace(/["']/g, "").trim().slice(0, 40);
  const round = (n) => Math.round(n * 10) / 10;
  const all = [document.body, ...document.body.querySelectorAll("*")].filter((el) => !skip.has(el.tagName) && !el.closest("[data-chrome]") && shown(el)).slice(0, 4000);
  const colours = new Map(), type = new Map(), spacing = new Map(), radii = new Map(), words = [], motion = [];
  const pageArea = Math.max(1, innerWidth * Math.max(innerHeight, document.documentElement.scrollHeight));
  const tint = (value, use, weight) => { if (!value) return; const had = colours.get(value) || { uses: new Map(), weight: 0 }; had.uses.set(use, (had.uses.get(use) || 0) + 1); had.weight += weight; colours.set(value, had); };
  const count = (map, key, by) => { if (key) map.set(key, (map.get(key) || 0) + (by || 1)); };
  const seconds = (value) => (value || "0s").split(",").map((part) => parseFloat(part) * (/ms\s*$/.test(part.trim()) ? 1 : 1000) || 0);
  const label = (el) => { const text = (el.innerText || el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim(); const tag = el.tagName.toLowerCase() + (el.id ? "#" + el.id : el.classList.length ? "." + [...el.classList].slice(0, 2).join(".") : ""); return text ? tag + ' "' + (text.length > 30 ? text.slice(0, 29) + "…" : text) + '"' : tag; };
  for (const el of all) {
    const s = getComputedStyle(el), r = el.getBoundingClientRect(), text = own(el);
    if (text) {
      tint(hex(s.color), "text", text.length / 400);
      const key = [family(s), s.fontSize, s.fontWeight, s.lineHeight].join("|"), had = type.get(key) || { chars: 0, sample: "" };
      had.chars += text.length; if (text.length > had.sample.length && had.sample.length < 24) had.sample = text.slice(0, 48); type.set(key, had);
      if (words.length < 120 && !words.includes(text)) words.push(text.length > 160 ? text.slice(0, 159) + "…" : text);
    }
    const fill = hex(s.backgroundColor);
    if (fill) tint(fill, r.width * r.height > pageArea * 0.4 ? "ground" : /^(BUTTON|A)$/.test(el.tagName) || el.getAttribute("role") === "button" ? "button" : "surface", (r.width * r.height) / pageArea);
    if (parseFloat(s.borderTopWidth) > 0 && s.borderTopStyle !== "none") tint(hex(s.borderTopColor), "line", 0.01);
    for (const side of ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "rowGap", "columnGap", "marginTop", "marginBottom"]) { const px = parseFloat(s[side]); if (px > 0 && px <= 200) count(spacing, String(round(px))); }
    if (quiet(s.borderTopLeftRadius)) count(radii, s.borderTopLeftRadius);
  }
  // How it moves, read from the page's own style rules and not from the drawn
  // state: the look draws pages settled (reduced motion), and a rule also says
  // what a hover or an opened state does. The kit's own sheets are left out.
  const frames = new Map(), moving = [];
  const walk = (rules) => { for (const rule of rules || []) {
    if (rule.type === 7 || rule.constructor.name === "CSSKeyframesRule") {
      const steps = [...rule.cssRules].map((step) => step.keyText + " " + step.style.cssText.replace(/;\s*$/, ""));
      if (steps.length) frames.set(rule.name, steps.length > 2 ? [steps[0], steps[steps.length - 1]].join(" → ") : steps.join(" → "));
    } else if (rule.selectorText && rule.style) { if (rule.style.transitionDuration || rule.style.animationName) moving.push(rule); if (rule.cssRules && rule.cssRules.length) walk(rule.cssRules); }
    else if (rule.cssRules && !/prefers-reduced-motion/.test(rule.conditionText || "")) walk(rule.cssRules);
  } };
  for (const sheet of document.styleSheets) { if (/^foundry:\/\/kit\//.test(sheet.href || "")) continue; try { walk(sheet.cssRules); } catch (error) {} }
  const list = (value) => (value || "").split(/,(?![^(]*\))/).map((part) => part.trim());
  const there = (selector) => { try { return !!document.querySelector(selector.replace(/::?(hover|focus-visible|focus-within|focus|active|before|after|checked|disabled)\b/g, "") || "*"); } catch (error) { return false; } };
  for (const rule of moving) {
    if (motion.length >= 16) break;
    const st = rule.style, on = rule.selectorText.slice(0, 80);
    if (!there(rule.selectorText)) continue;
    const tp = list(st.transitionProperty || "all"), td = seconds(st.transitionDuration), te = list(st.transitionTimingFunction || "ease"), tl = seconds(st.transitionDelay || "0s");
    if (st.transitionDuration) tp.forEach((what, at) => { const ms = td[at % td.length] || 0; if (ms > 0 && what !== "none") motion.push({ on: on, what: what, duration: ms + "ms", easing: te[at % te.length] || "ease", delay: (tl[at % tl.length] || 0) + "ms" }); });
    const an = list(st.animationName), ad = seconds(st.animationDuration || "0s"), ae = list(st.animationTimingFunction || "ease"), al = seconds(st.animationDelay || "0s");
    if (st.animationName) an.forEach((name, at) => { const ms = ad[at % ad.length] || 0; if (ms > 0 && name !== "none") motion.push({ on: on, what: "animation", name: name, duration: ms + "ms", easing: ae[at % ae.length] || "ease", delay: (al[at % al.length] || 0) + "ms", ...(frames.get(name) ? { frames: frames.get(name).slice(0, 200) } : {}) }); });
  }
  const describe = (name, el) => {
    const s = getComputedStyle(el), r = el.getBoundingClientRect();
    let behind = "";
    for (let at = el; at && at.nodeType === 1 && !behind; at = at.parentElement) behind = hex(getComputedStyle(at).backgroundColor);
    return { name: name, tag: el.tagName.toLowerCase(), text: (el.innerText || el.getAttribute("aria-label") || el.getAttribute("placeholder") || "").replace(/\s+/g, " ").trim().slice(0, 100),
      x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY), width: Math.round(r.width), height: Math.round(r.height),
      font: [s.fontWeight, s.fontSize + (s.lineHeight !== "normal" ? "/" + s.lineHeight : ""), family(s)].join(" "), color: hex(s.color), background: hex(s.backgroundColor) || (behind ? "none, on " + behind : ""),
      padding: quiet(s.padding), radius: quiet(s.borderRadius), border: parseFloat(s.borderTopWidth) > 0 && s.borderTopStyle !== "none" ? s.borderTopWidth + " " + hex(s.borderTopColor) : "", gap: quiet(s.gap),
      layout: s.display.includes("flex") ? "flex " + s.flexDirection : s.display.includes("grid") ? "grid " + s.gridTemplateColumns.split(" ").length + " columns" : "" };
  };
  const parts = [];
  for (const part of Array.isArray(given) ? given.slice(0, 12) : []) {
    let el = null;
    // The first match that is drawn: an option shown alone leaves the others in the page, hidden.
    try { el = part.at ? [...document.querySelectorAll(part.at)].find(shown) || null : null; } catch (error) {}
    parts.push(el ? describe(part.name, el) : { name: part.name, missing: true });
  }
  // Nothing named: the page's own landmarks, in reading order.
  if (!parts.some((part) => !part.missing)) {
    const marks = all.filter((el) => /^(H1|H2|H3|BUTTON|INPUT|SELECT|TEXTAREA|IMG|NAV|TABLE|FORM)$/.test(el.tagName) || el.getAttribute("role") === "button" || (el.tagName === "A" && hex(getComputedStyle(el).backgroundColor))).slice(0, 14);
    for (const el of marks) parts.push(describe(label(el), el));
  }
  const body = getComputedStyle(document.body), root = getComputedStyle(document.documentElement);
  const top = (map, n) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
  return {
    page: { width: innerWidth, height: Math.round(Math.max(document.documentElement.scrollHeight, document.body.scrollHeight)), background: hex(body.backgroundColor) || hex(root.backgroundColor) || "#ffffff", color: hex(body.color), font: [body.fontSize + (body.lineHeight !== "normal" ? "/" + body.lineHeight : ""), family(body)].join(" ") },
    colours: [...colours.entries()].sort((a, b) => b[1].weight - a[1].weight).slice(0, 10).map(([value, had]) => ({ value: value, uses: [...had.uses.entries()].sort((a, b) => b[1] - a[1]).map(([use]) => use), share: Math.round(Math.min(1, had.weight) * 100) / 100 })),
    type: [...type.entries()].sort((a, b) => b[1].chars - a[1].chars).slice(0, 8).map(([key, had]) => { const p = key.split("|"); return { font: p[0], size: p[1], weight: p[2], line: p[3], sample: had.sample, chars: had.chars }; }),
    spacing: top(spacing, 8).map(([px]) => Number(px)).sort((a, b) => a - b),
    radii: top(radii, 4).map(([value]) => value),
    parts: parts, words: words, motion: motion,
  };
}`;

/// The expression to run in the page: the parts are the walkthrough's, each with the selector it points at.
export const specMeasure = (parts: readonly { name: string; at?: string }[] = []) => `(${SPEC_FN})(${JSON.stringify(parts.map((part) => ({ name: String(part.name).slice(0, 80), at: typeof part.at === "string" ? part.at.slice(0, 200) : "" })))})`;
