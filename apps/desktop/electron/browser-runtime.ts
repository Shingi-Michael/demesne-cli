/// The model's browser reads a page as an outline (browser-host.ts): its
/// headings, and every control on a numbered line, like `[12] button "Save"`.
/// The model acts on a control by its number, which stays the same for as
/// long as that element is on the page. Installed after TRY_RUNTIME
/// (foundry-try.ts), whose helpers it uses. Kept free of Electron so a test
/// can run it in any Chromium.

export const OUTLINE_MAX_LINES = 120;
export const PAGE_TEXT_CHARS = 6_000;

export const BROWSER_RUNTIME = String.raw`(() => {
  if (window.__demesneBrowser) return true;
  const { CONTROLS, shown, name, role, cut, place } = window.__demesneTry.kit;
  const numbers = new WeakMap(), byNumber = new Map();
  let next = 1;
  const numberOf = (el) => {
    let n = numbers.get(el);
    if (!n) { n = next++; numbers.set(el, n); byNumber.set(n, new WeakRef(el)); }
    return n;
  };
  const NATIVE = /^(BUTTON|A|INPUT|SELECT|TEXTAREA|SUMMARY)$/;
  function outline(max) {
    const all = [...document.querySelectorAll("h1,h2,h3,h4,dialog[open],[role=dialog]," + CONTROLS)].filter(shown);
    const controls = new Set(all.filter((el) => el.matches(CONTROLS)));
    // A wrapper around a real control (a label, a clickable card) is left out: the control inside is the line.
    const kept = all.filter((el) => !controls.has(el) || NATIVE.test(el.tagName) || ![...controls].some((other) => other !== el && el.contains(other)));
    const out = [];
    for (const el of kept) {
      if (out.length >= max) { out.push("… and " + (kept.length - max) + " more; scroll, or narrow down with text"); break; }
      const r = role(el);
      if (/^H[1-4]$/.test(el.tagName)) { out.push("#".repeat(Number(el.tagName[1])) + " " + cut(name(el), 80)); continue; }
      if (!controls.has(el)) { const label = cut(el.getAttribute("aria-label") || "", 40); out.push("(" + r + (label ? ' "' + label + '"' : "") + " is open)"); continue; }
      const bits = ["[" + numberOf(el) + "] " + r + ' "' + cut(name(el), 60) + '"'];
      if (el.tagName === "A" && el.getAttribute("href") && !el.getAttribute("href").startsWith("#")) bits.push("→ " + cut(el.getAttribute("href"), 60));
      if (el.checked === true || el.getAttribute("aria-checked") === "true" || el.getAttribute("aria-selected") === "true" || el.getAttribute("aria-pressed") === "true") bits.push("on");
      if (el.getAttribute("aria-expanded") === "true") bits.push("open");
      if (el.disabled === true || el.getAttribute("aria-disabled") === "true") bits.push("disabled");
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) && !/^(checkbox|radio|button|submit|reset|password)$/.test(el.type) && el.value) bits.push('value "' + cut(el.value, 40) + '"');
      if (el.tagName === "SELECT") bits.push("options: " + [...el.options].slice(0, 8).map((o) => cut(o.text, 20)).join(" | "));
      if (el === document.activeElement) bits.push("focused");
      out.push(bits.join("  "));
    }
    return out;
  }
  function locate(n) {
    const el = byNumber.get(Number(n))?.deref();
    if (!el || !el.isConnected) return { found: false, gone: true };
    if (!shown(el)) return { found: false, hidden: true, what: role(el) + ' "' + cut(name(el), 30) + '"' };
    return place(el, 1);
  }
  function text(from, max) {
    const all = String(document.body ? document.body.innerText : "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    return { text: all.slice(from, from + max), from, total: all.length };
  }
  // A page that asks or tells with a dialog: nobody is there to press OK, so it is answered and noted.
  const dialogs = [];
  window.alert = (message) => { dialogs.push("alert: " + cut(message, 120)); };
  window.confirm = (message) => { dialogs.push("confirm (answered OK): " + cut(message, 120)); return true; };
  window.prompt = (message) => { dialogs.push("prompt (left empty): " + cut(message, 120)); return null; };
  window.__demesneBrowser = { outline, locate, text, dialogs: () => dialogs.splice(0) };
  return true;
})()`;
