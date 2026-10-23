/** Point at it: runs inside a live preview frame. It outlines the element
 * under the pointer, names it, and resolves with what was clicked (or null on
 * Esc or cancel). Nothing it reads leaves the frame except that description. */
export const POINT_SCRIPT = String.raw`(() => new Promise((resolve) => {
  const w = window;
  if (w.__demesnePoint) w.__demesnePoint.cancel();
  const box = document.createElement("div"), tag = document.createElement("div");
  box.style.cssText = "position:fixed;z-index:2147483647;pointer-events:none;border-radius:3px;outline:2px solid #4c8dff;outline-offset:2px;background:rgba(76,141,255,.12);transition:all 80ms ease-out;display:none";
  tag.style.cssText = "position:fixed;z-index:2147483647;pointer-events:none;font:11px/16px ui-monospace,SFMono-Regular,Menlo,monospace;color:#fff;background:#4c8dff;padding:2px 7px;border-radius:5px;white-space:nowrap;display:none;max-width:60vw;overflow:hidden;text-overflow:ellipsis";
  document.documentElement.append(box, tag);
  const prior = document.documentElement.style.cursor;
  document.documentElement.style.cursor = "crosshair";
  let target = null;
  const words = (el) => (el.getAttribute("aria-label") || el.getAttribute("alt") || el.getAttribute("title") || el.getAttribute("placeholder") || el.innerText || el.value || "").replace(/\s+/g, " ").trim().slice(0, 80);
  const step = (el) => {
    const name = el.tagName.toLowerCase();
    if (el.id && /^[A-Za-z][\w-]*$/.test(el.id)) return name + "#" + el.id;
    const parent = el.parentElement;
    const same = parent ? [...parent.children].filter((child) => child.tagName === el.tagName) : [];
    const cls = [...el.classList].filter((c) => /^[A-Za-z][\w-]*$/.test(c) && c.length < 32).slice(0, 2).map((c) => "." + c).join("");
    return name + cls + (same.length > 1 ? ":nth-of-type(" + (same.indexOf(el) + 1) + ")" : "");
  };
  const selector = (el) => {
    const parts = [];
    for (let at = el; at && at.nodeType === 1 && at !== document.documentElement && parts.length < 5; at = at.parentElement) {
      parts.unshift(step(at));
      if (at.id) break;
    }
    return parts.join(" > ");
  };
  const markup = (el) => {
    const copy = el.cloneNode(true);
    const html = copy.outerHTML.replace(/\s+/g, " ");
    return html.length > 400 ? html.slice(0, 399) + "…" : html;
  };
  const source = (el) => {
    for (let at = el, depth = 0; at && depth < 8; at = at.parentElement, depth++) {
      const d = at.dataset || {};
      const file = d.source || d.sourceFile || d.inspectorRelativePath || d.loc || d.file;
      if (file) { const m = /^(.*?)(?::(\d+))?(?::\d+)?$/.exec(file); return { file: m[1], line: Number(d.inspectorLine || d.sourceLine || m[2]) || undefined }; }
      if (at.__svelte_meta && at.__svelte_meta.loc) return { file: at.__svelte_meta.loc.file, line: at.__svelte_meta.loc.line + 1 };
      const vue = at.__vueParentComponent;
      if (vue && vue.type && vue.type.__file) return { file: vue.type.__file };
      const key = Object.keys(at).find((k) => k.startsWith("__reactFiber$"));
      if (key) for (let fiber = at[key], hops = 0; fiber && hops < 12; fiber = fiber._debugOwner || fiber.return, hops++)
        if (fiber._debugSource) return { file: fiber._debugSource.fileName, line: fiber._debugSource.lineNumber };
    }
    return undefined;
  };
  const component = (el) => {
    for (let at = el, depth = 0; at && depth < 8; at = at.parentElement, depth++) {
      const key = Object.keys(at).find((k) => k.startsWith("__reactFiber$"));
      if (key) for (let fiber = at[key], hops = 0; fiber && hops < 30; fiber = fiber.return, hops++) {
        const type = fiber.type;
        const name = type && typeof type !== "string" && (type.displayName || type.name);
        if (name && /^[A-Z]/.test(name)) return name;
      }
      const vue = at.__vueParentComponent;
      if (vue && vue.type && (vue.type.name || vue.type.__name)) return vue.type.name || vue.type.__name;
    }
    return undefined;
  };
  const show = (el) => {
    const r = el.getBoundingClientRect();
    Object.assign(box.style, { display: "block", left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px" });
    tag.textContent = step(el);
    tag.style.display = "block";
    const top = r.bottom + 6 + 20 < innerHeight ? r.bottom + 6 : Math.max(2, r.top - 26);
    Object.assign(tag.style, { left: Math.max(2, Math.min(r.left, innerWidth - tag.offsetWidth - 4)) + "px", top: top + "px" });
  };
  const move = (event) => {
    const el = document.elementFromPoint(event.clientX, event.clientY);
    if (!el || el === box || el === tag || el === document.documentElement || el === document.body) return;
    target = el; show(el);
  };
  const block = (event) => { event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation(); };
  const click = (event) => {
    block(event);
    if (!target) return;
    done({ tag: target.tagName.toLowerCase(), text: (target.innerText || "").replace(/\s+/g, " ").trim().slice(0, 120), label: words(target), selector: selector(target), html: markup(target), page: location.pathname + location.search, component: component(target), hint: source(target) });
  };
  const key = (event) => { if (event.key === "Escape") { block(event); done(null); } };
  const events = [["mousemove", move], ["click", click], ["mousedown", block], ["mouseup", block], ["pointerdown", block], ["pointerup", block], ["keydown", key]];
  for (const [name, fn] of events) w.addEventListener(name, fn, true);
  function done(value) {
    for (const [name, fn] of events) w.removeEventListener(name, fn, true);
    box.remove(); tag.remove();
    document.documentElement.style.cursor = prior;
    delete w.__demesnePoint;
    resolve(value);
  }
  w.__demesnePoint = { cancel: () => done(null) };
}))()`;
export const POINT_CANCEL = "window.__demesnePoint && window.__demesnePoint.cancel(), true";
