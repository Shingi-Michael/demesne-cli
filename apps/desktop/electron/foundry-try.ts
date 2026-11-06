/// Foundry tries its own page (pass 164 E, the idea from anomalyco/rune: an
/// agent drives its UI headlessly and reads the element tree). The look
/// window runs a short script of steps on the page (click, type, key, scroll,
/// hover, wait) with real input events, and after each step says what
/// happened: the page changed, nothing changed, the control is covered or
/// disabled, or nothing matches. At the end it reads the page's tree: every
/// heading and control with its name, place, size and state. Kept free of
/// Electron so a test can run the page side in any Chromium.

import type { TryStep } from "../../../packages/protocol/src/foundry-try.ts";
export { parseSteps, stepName, TRY_KEYS, TRY_MAX_STEPS, type TryStep } from "../../../packages/protocol/src/foundry-try.ts";

export interface TryPlan { width: number; steps: TryStep[] }
export interface TryStepResult { step: string; ok: boolean; said: string }
export interface TryResult { width: number; steps: TryStepResult[]; tree: string[]; errors: string[]; pictures: { after: string; png: string }[]; title?: string; url?: string }

const short = (text: string, n = 40) => { const clean = text.replace(/\s+/g, " ").trim(); return clean.length > n ? `${clean.slice(0, n - 1)}…` : clean; };
export const TRY_WIDTHS = { desktop: { width: 1280, height: 800, scaleTo: 960 }, phone: { width: 390, height: 844, scaleTo: 390 } } as const;

/// Installed in the page once: window.__demesneTry with find, tree and
/// fingerprint. find(target) puts the best match in the middle of the view
/// and says where its centre is and whether something else is on top of it.
export const TRY_RUNTIME = String.raw`(() => {
  if (window.__demesneTry) return true;
  const clean = (text) => String(text || "").replace(/\s+/g, " ").trim();
  const cut = (text, n = 40) => { text = clean(text); return text.length > n ? text.slice(0, n - 1) + "…" : text; };
  const shown = (el) => {
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
    const box = el.getBoundingClientRect();
    return box.width > 0 && box.height > 0;
  };
  const labelled = (el) => {
    const by = el.getAttribute("aria-labelledby");
    if (by) { const text = by.split(/\s+/).map((id) => document.getElementById(id)?.textContent || "").join(" "); if (clean(text)) return text; }
    if (el.labels && el.labels.length) return [...el.labels].map((label) => label.textContent).join(" ");
    return "";
  };
  const name = (el) => clean(el.getAttribute("aria-label") || labelled(el) || (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) ? el.getAttribute("placeholder") || el.getAttribute("title") || el.getAttribute("name") : "")
    || el.innerText || el.getAttribute("title") || el.getAttribute("alt") || (el.tagName === "INPUT" && /^(submit|button|reset)$/.test(el.type) ? el.value : ""));
  const role = (el) => {
    const given = el.getAttribute("role");
    if (given) return given;
    const tag = el.tagName.toLowerCase();
    if (/^h[1-6]$/.test(tag)) return "heading";
    if (tag === "a") return "link";
    if (tag === "select") return "select";
    if (tag === "textarea") return "textbox";
    if (tag === "input") return ({ checkbox: "checkbox", radio: "radio", range: "slider", button: "button", submit: "button", reset: "button" })[el.type] || "textbox";
    if (tag === "summary") return "button";
    return tag === "button" ? "button" : tag;
  };
  const CONTROLS = "button,a[href],input:not([type=hidden]),select,textarea,summary,label,[role=button],[role=tab],[role=checkbox],[role=switch],[role=radio],[role=menuitem],[role=option],[role=link],[role=slider],[role=textbox],[onclick],[tabindex]:not([tabindex='-1']),[data-option],[contenteditable=true]";
  const describe = (el) => {
    let tag = el.tagName.toLowerCase();
    if (el.id) tag += "#" + el.id; else if (el.classList.length) tag += "." + [...el.classList].slice(0, 2).join(".");
    const text = cut(el.innerText || el.getAttribute("aria-label") || "", 30);
    return text ? tag + ' "' + text + '"' : tag;
  };
  const selector = (target) => /^[#.\[]|^[a-z][a-z0-9-]*([#.\[:]|$)/.test(target) && !/\s{2}/.test(target);
  function candidates(target) {
    const want = clean(target).toLowerCase();
    if (selector(target)) {
      try { const found = [...document.querySelectorAll(target)].filter(shown); if (found.length) return found; } catch {}
    }
    const controls = [...document.querySelectorAll(CONTROLS)].filter(shown);
    // Every name a person might use: its text, label, aria-label, placeholder or title.
    const named = controls.map((el) => [el, [name(el), el.getAttribute("placeholder"), el.getAttribute("title"), el.getAttribute("aria-label"), labelled(el)].map((n) => clean(n).toLowerCase()).filter(Boolean)]);
    for (const test of [(n) => n === want, (n) => n.startsWith(want), (n) => n.includes(want)]) {
      const hits = named.filter(([, ns]) => ns.some(test)).map(([el]) => el);
      // The innermost control: a label around an input, a card around a button.
      const inner = hits.filter((el) => !hits.some((other) => other !== el && el.contains(other)));
      if (inner.length) return inner;
    }
    // Any visible element with exactly that text (a div with a click handler).
    const plain = [...document.body.querySelectorAll("*")].filter((el) => clean(el.innerText).toLowerCase() === want && shown(el));
    return plain.filter((el) => !plain.some((other) => other !== el && el.contains(other)));
  }
  function find(target) {
    const hits = candidates(target);
    if (!hits.length) {
      const names = [...new Set([...document.querySelectorAll(CONTROLS)].filter(shown).map((el) => cut(name(el), 30)).filter(Boolean))].slice(0, 10);
      return { found: false, names };
    }
    const el = hits[0];
    el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    const box = el.getBoundingClientRect();
    const x = Math.round(Math.min(Math.max(box.left + box.width / 2, 1), innerWidth - 2)), y = Math.round(Math.min(Math.max(box.top + box.height / 2, 1), innerHeight - 2));
    const top = document.elementFromPoint(x, y);
    const covered = top && top !== el && !el.contains(top) && !top.contains(el) && !(el.labels && [...el.labels].some((label) => label.contains(top))) ? describe(top) : null;
    const disabled = el.disabled === true || el.getAttribute("aria-disabled") === "true";
    return { found: true, x, y, many: hits.length, what: role(el) + ' "' + cut(name(el), 30) + '"', covered, disabled, offscreen: box.bottom < 0 || box.top > innerHeight };
  }
  // What a person would notice changed: the visible text, the controls' states and the scroll.
  function fingerprint() {
    const states = [...document.querySelectorAll("input,select,textarea,[aria-checked],[aria-selected],[aria-expanded],[aria-pressed],details")]
      .map((el) => [el.value, el.checked, el.getAttribute("aria-checked"), el.getAttribute("aria-selected"), el.getAttribute("aria-expanded"), el.getAttribute("aria-pressed"), el.open].join("|")).join(";");
    const hiddenNow = [...document.body.querySelectorAll("*")].slice(0, 3000).filter((el) => !shown(el)).length;
    return { text: document.body.innerText, states, hidden: hiddenNow, active: document.activeElement ? describe(document.activeElement) : "" };
  }
  function tree() {
    const out = [];
    const els = [...document.querySelectorAll("h1,h2,h3,h4,dialog[open],[role=dialog]," + CONTROLS)].filter(shown);
    for (const el of els) {
      if (out.length >= 60) { out.push("… and " + (els.length - 60) + " more"); break; }
      const box = el.getBoundingClientRect(), r = role(el);
      const bits = [r + ' "' + cut(name(el), 36) + '"', Math.round(box.left + scrollX) + "," + Math.round(box.top + scrollY) + " " + Math.round(box.width) + "×" + Math.round(box.height)];
      if (el.checked === true || el.getAttribute("aria-checked") === "true" || el.getAttribute("aria-selected") === "true" || el.getAttribute("aria-pressed") === "true") bits.push("on");
      if (el.disabled === true || el.getAttribute("aria-disabled") === "true") bits.push("disabled");
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) && !/^(checkbox|radio|button|submit|reset)$/.test(el.type) && el.value) bits.push('value "' + cut(el.value, 30) + '"');
      if (el === document.activeElement) bits.push("focused");
      if (box.width < 24 || box.height < 24) { if (r !== "heading" && r !== "link" && r !== "label") bits.push("small target"); }
      if (box.bottom > 0 && box.top < innerHeight && r !== "heading") {
        const x = Math.min(Math.max(box.left + box.width / 2, 1), innerWidth - 2), y = Math.min(Math.max(box.top + box.height / 2, 1), innerHeight - 2), top = document.elementFromPoint(x, y);
        if (top && top !== el && !el.contains(top) && !top.contains(el) && !(el.labels && [...el.labels].some((label) => label.contains(top)))) bits.push("covered by " + describe(top));
      }
      out.push(bits.join("  "));
    }
    return out;
  }
  window.__demesneTry = { find, fingerprint, tree };
  return true;
})()`;

export interface Fingerprint { text: string; states: string; hidden: number; active: string }
/// What changed between two fingerprints, in words; null when nothing did.
/// Focus counts only for a key (Tab moves it); a click focusing its own
/// button is not something a person sees happen.
export function changed(before: Fingerprint, after: Fingerprint, scrolled = false, focus = false): string | null {
  const said: string[] = [];
  if (before.text !== after.text) {
    const a = new Set(before.text.split("\n").map((line) => line.trim()).filter(Boolean)), b = after.text.split("\n").map((line) => line.trim()).filter(Boolean);
    const added = b.filter((line) => !a.has(line)), gone = [...a].filter((line) => !b.includes(line));
    const show = (lines: string[]) => lines.slice(0, 3).map((line) => `“${short(line, 50)}”`).join(", ") + (lines.length > 3 ? ` and ${lines.length - 3} more` : "");
    if (added.length) said.push(`new text ${show(added)}`);
    if (gone.length) said.push(`gone ${show(gone)}`);
    if (!added.length && !gone.length) said.push("text moved");
  }
  if (before.states !== after.states) said.push("a control's value or state changed");
  if (before.hidden !== after.hidden) said.push(after.hidden < before.hidden ? "something appeared" : "something was hidden");
  if (focus && before.active !== after.active && after.active && !/^body\b/.test(after.active)) said.push(`focus on ${after.active}`);
  if (scrolled) said.push("scrolled");
  return said.length ? said.join("; ") : null;
}
