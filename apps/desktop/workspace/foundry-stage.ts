/// The stages on Foundry's long page come alive (pass 221 A): each surface
/// is fitted to the page, a page that grows with its content gets the height
/// it says, a mockup with options gets one stage per option (named on the
/// line above it), and a demo plays while its stage is on screen. Moving
/// into a stage stops its demo and hands the page to you; a moment after you
/// leave, it starts again from a fresh page. Nothing here adds a control:
/// the demo's words go on the quiet line under the stage.

import { FOUNDRY_MAX_VARIANTS, isStyleColour } from "@demesne/protocol";
import { knobValue } from "@demesne/protocol";
import { cleanKnobs, knobsHTML, knobsSet } from "./foundry-knobs.ts";

const STEADY = 1800, AGAIN = 1400;
const h = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

interface Live { ready: boolean; dirty: boolean; visible: boolean; inside: boolean; lost: boolean; want: boolean; timer: number }

/// The words under a stage while its demo plays: a tick per beat and what it says.
export function demoLine(step: number, of: number, say: string) {
  const ticks = `<span class="fd-ticks" aria-hidden="true">${Array.from({ length: Math.min(of, 12) }, (_, k) => `<i${k <= step ? ' class="on"' : ""}></i>`).join("")}</span>`;
  return `${ticks}<span>${say ? h(say) : `Step ${step + 1} of ${of}`}</span>`;
}
export const YOURS = "Yours now. It plays again a moment after you leave.";

/// How much a surface shrinks to fit the width it has: never larger than real size.
export function fitScale(available: number, width: number) {
  return width > 0 && available > 0 ? Math.min(1, available / width) : 1;
}

/// One option of a mockup, as its page reports it. A style (pass 246 A) also has its colours.
export interface StageOption { name: string; note: string; colors?: string[] }

/// The line above an option's stage: its name, the pick in words, and what it
/// says about itself. A style shows its colours as small dots before that.
export function optionHead(option: StageOption, pick: boolean) {
  const dots = option.colors?.length ? `<span class="fd-sw" aria-hidden="true">${option.colors.map((colour) => `<i style="background:${h(colour)}"></i>`).join("")}</span>` : "";
  return `<div class="fd-opt"><b>${h(option.name)}</b>${pick ? '<span class="fd-rec-pill">recommended</span>' : ""}${dots}${option.note ? `<span>${h(option.note)}</span>` : ""}</div>`;
}

/// Pass 263 A, variants as tabs: the names over one stage, the pick first
/// with a small dot. Choosing one shows that variant in the stage and its
/// walkthrough under it; it only changes what you look at.
export function variantTabs(options: readonly StageOption[], shown: number, rec: number) {
  return `<div class="fd-tabs" role="tablist" aria-label="Variants">${options.map((option, index) =>
    `<button type="button" role="tab" class="fd-tab${index === shown ? " on" : ""}" data-variant="${index}" aria-selected="${index === shown}"${option.note ? ` title="${h(option.note)}"` : ""}>${h(option.name)}${index === rec ? '<i class="fd-tab-pick" aria-label="recommended" title="Recommended"></i>' : ""}</button>`).join("")}</div>`;
}

/// The walkthrough section for a variant: the one naming it (or the start of its name), else the only one.
export function walkSection(walk: Element | null | undefined, name: string | undefined): HTMLElement | null {
  if (!walk) return null;
  const all = [...walk.querySelectorAll<HTMLElement>(".fd-walk-v")];
  if (!name) return all[0] ?? null;
  const said = name.trim().toLowerCase();
  return all.find((item) => item.dataset.option?.toLowerCase() === said)
    ?? all.find((item) => { const option = item.dataset.option?.toLowerCase(); return !!option && (said.startsWith(option) || option.startsWith(said)); })
    ?? (all.length === 1 ? all[0]! : null);
}

/// At most this much of a tall page shows in the row of small ones: three quarters of its width.
const GLANCE_TALL = 0.75;
/// Pass 246 A, styles at a glance: one row of the same page in each style,
/// small, so they can be compared without scrolling between three full
/// screens. Only to look at: nothing in it takes the pointer.
export function glanceRow(src: string, title: string, options: readonly StageOption[], rec: number, width: number, height: number) {
  const shown = Math.min(height, Math.round(width * GLANCE_TALL));
  return `<div class="fd-glance" data-ow="${width}" data-oh="${shown}" role="group" aria-label="The styles side by side">${options.map((option, index) =>
    `<figure><div class="fd-mini" style="--ow:${width}px;--oh:${shown}px"><iframe class="fd-mini-frame" src="${h(`${src}&option=${index}`)}" loading="lazy" tabindex="-1" aria-hidden="true" sandbox="allow-scripts" referrerpolicy="no-referrer" title="${h(`${title}, ${option.name}, small`)}"></iframe></div>`
    + `<figcaption><b>${h(option.name)}</b>${index === rec ? '<span class="fd-rec-pill">recommended</span>' : ""}</figcaption></figure>`).join("")}</div>`;
}

export function watchFoundryStages(root: HTMLElement): () => void {
  const lives = new WeakMap<HTMLElement, Live>();
  const stages = () => [...root.querySelectorAll<HTMLElement>(".fd-stage")];
  const frameOf = (stage: HTMLElement) => stage.querySelector<HTMLIFrameElement>("iframe.fd-frame");
  const lineOf = (stage: HTMLElement) => stage.nextElementSibling instanceof HTMLElement && stage.nextElementSibling.classList.contains("fd-demo") ? stage.nextElementSibling : null;
  const plays = (stage: HTMLElement) => stage.dataset.demo !== undefined || stage.dataset.deck !== undefined;
  const live = (stage: HTMLElement) => {
    let known = lives.get(stage);
    if (!known) { known = { ready: false, dirty: false, visible: false, inside: false, lost: false, want: false, timer: 0 }; lives.set(stage, known); }
    return known;
  };
  const steps = (stage: HTMLElement) => { try { return stage.dataset.demo ? JSON.parse(stage.dataset.demo) as unknown[] : []; } catch { return []; } };
  const post = (stage: HTMLElement, message: Record<string, unknown>) => { try { frameOf(stage)?.contentWindow?.postMessage({ demesne: "demo", ...message }, "*"); } catch {} };

  function fit(stage: HTMLElement) {
    if (!stage.classList.contains("fd-s") || stage.classList.contains("fd-fluid")) return;
    const style = getComputedStyle(stage), pad = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
    const bezel = stage.classList.contains("s-phone") ? 24 : 0;
    stage.style.setProperty("--s", String(fitScale(stage.clientWidth - pad - bezel, Number(stage.dataset.ow) || 0)));
  }

  function play(stage: HTMLElement) {
    const state = live(stage);
    if (!plays(stage) || state.lost || state.inside || !state.visible) return;
    const deck = stage.dataset.deck !== undefined && !stage.dataset.demo;
    // A demo changes the page; the next run starts from a fresh one.
    if (state.dirty && !deck) {
      state.ready = false; state.want = true; state.dirty = false;
      const frame = frameOf(stage);
      if (frame) frame.src = frame.src;
      return;
    }
    if (!state.ready) { state.want = true; return; }
    state.want = false;
    if (!deck) state.dirty = true;
    post(stage, { action: "play", steps: steps(stage) });
  }
  function stop(stage: HTMLElement, said?: string) {
    const state = live(stage);
    clearTimeout(state.timer);
    state.want = false;
    post(stage, { action: "stop" });
    const line = lineOf(stage);
    if (line && said !== undefined) line.innerHTML = said ? `<span class="fd-quiet">${h(said)}</span>` : "";
  }

  const seen = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const stage = entry.target as HTMLElement, state = live(stage);
      state.visible = entry.isIntersecting;
      if (state.visible) play(stage); else stop(stage);
    }
  }, { threshold: 0.5 });
  const enter = (event: Event) => {
    const stage = event.currentTarget as HTMLElement, state = live(stage);
    state.inside = true;
    if (!plays(stage) || state.lost) return;
    stop(stage, YOURS);
    // What you do to the page is yours; the demo starts over on a fresh one.
    state.dirty = stage.dataset.deck === undefined || !!stage.dataset.demo;
  };
  const leave = (event: Event) => {
    const stage = event.currentTarget as HTMLElement, state = live(stage);
    // Onto a note's tag, or while a note is typed (foundry-notes.ts): still with the mockup.
    const onto = (event as PointerEvent).relatedTarget;
    if ((onto instanceof Element && onto.closest(".fn-layer")) || stage.closest(".fd-item")?.classList.contains("fn-noting")) return;
    state.inside = false;
    clearTimeout(state.timer);
    state.timer = window.setTimeout(() => play(stage), STEADY);
  };
  function watch(stage: HTMLElement) {
    fit(stage);
    if (!plays(stage)) return;
    seen.observe(stage);
    stage.addEventListener("pointerenter", enter);
    stage.addEventListener("pointerleave", leave);
  }

  /// The small ones keep the page's own width and are scaled to the room each has.
  function fitGlance(row: HTMLElement) {
    const width = Number(row.dataset.ow) || 0;
    for (const mini of row.querySelectorAll<HTMLElement>(".fd-mini")) mini.style.setProperty("--k", String(width > 0 && mini.clientWidth > 0 ? mini.clientWidth / width : 1));
  }
  const glances = () => [...root.querySelectorAll<HTMLElement>(".fd-glance")];

  /// Options get a stage each: the one the page shows first, then the rest.
  /// Styles (pass 246 A) get the row of small ones above them first.
  function split(stage: HTMLElement, options: StageOption[], shown: number, rec: number, styles = false) {
    if (stage.dataset.split !== undefined || options.length < 2) return;
    stage.dataset.split = String(shown);
    if (!styles) { tabbed(stage, options, shown, rec); return; }
    const head = (option: StageOption, index: number) => optionHead(option, index === rec);
    const first = frameOf(stage);
    if (styles && first) {
      const surfaced = stage.classList.contains("fd-s") && !stage.classList.contains("fd-fluid");
      const width = surfaced ? Number(stage.dataset.ow) || 0 : Math.round(first.clientWidth), height = surfaced ? (Number(stage.dataset.oh) || 0) - (Number(stage.dataset.bar) || 0) : Math.round(first.clientHeight);
      if (width > 0 && height > 0) {
        stage.insertAdjacentHTML("beforebegin", glanceRow((first.getAttribute("src") ?? "").replace("&first=1", ""), first.title, options, rec, width, height));
        fitGlance(stage.previousElementSibling as HTMLElement);
      }
    }
    stage.insertAdjacentHTML("beforebegin", head(options[shown]!, shown));
    let after: Element = lineOf(stage) ?? stage;
    options.forEach((option, index) => {
      if (index === shown) return;
      const copy = stage.cloneNode(true) as HTMLElement;
      copy.dataset.split = String(index);
      const frame = copy.querySelector<HTMLIFrameElement>("iframe.fd-frame");
      if (frame) frame.src = `${frame.getAttribute("src")}&option=${index}`;
      after.insertAdjacentHTML("afterend", head(option, index));
      after = after.nextElementSibling!;
      after.insertAdjacentElement("afterend", copy);
      after = copy;
      const line = lineOf(stage);
      if (line) { const copied = line.cloneNode(false) as HTMLElement; after.insertAdjacentElement("afterend", copied); after = copied; }
      watch(copy);
    });
  }

  /// Pass 263 A: the variants as tabs over the one stage; a tab loads its variant there.
  const walkOf = (stage: HTMLElement) => stage.closest(".fd-item")?.querySelector(":scope > .fd-walk") ?? null;
  const names = new WeakMap<HTMLElement, StageOption[]>();
  function showWalk(stage: HTMLElement, name: string | undefined) {
    const walk = walkOf(stage), section = walkSection(walk, name);
    if (!walk) return;
    for (const item of walk.querySelectorAll<HTMLElement>(".fd-walk-v")) item.hidden = item !== section;
  }
  function tabbed(stage: HTMLElement, options: StageOption[], shown: number, rec: number) {
    names.set(stage, options);
    stage.insertAdjacentHTML("beforebegin", variantTabs(options, shown, rec));
    const tabs = stage.previousElementSibling as HTMLElement;
    showWalk(stage, options[shown]?.name);
    tabs.addEventListener("click", (event) => {
      const tab = (event.target as Element).closest<HTMLElement>("[data-variant]");
      const frame = frameOf(stage), index = Number(tab?.dataset.variant);
      if (!tab || !frame || String(index) === stage.dataset.split) return;
      stage.dataset.split = String(index);
      for (const item of tabs.querySelectorAll<HTMLElement>("[data-variant]")) { const on = item === tab; item.classList.toggle("on", on); item.setAttribute("aria-selected", String(on)); }
      const state = live(stage);
      state.ready = false; state.dirty = false; state.lost = false;
      frame.src = `${(frame.getAttribute("src") ?? "").replace(/&option=\d+/, "").replace("&first=1", "")}&option=${index}`;
      showWalk(stage, options[index]?.name);
    });
  }
  /// The numbers of the shown variant's parts, for its page to draw where they point.
  function marks(stage: HTMLElement) {
    const options = names.get(stage), name = options?.[Number(stage.dataset.split) || 0]?.name;
    const section = walkSection(walkOf(stage), options ? name : undefined);
    const list = section ? [...section.querySelectorAll<HTMLElement>("li[data-at]")].map((item) => ({ n: Number(item.dataset.n), at: item.dataset.at! })) : [];
    try { frameOf(stage)?.contentWindow?.postMessage({ demesne: "marks", marks: list }, "*"); } catch {}
  }
  const lit = (event: Event) => {
    const item = (event.target as Element).closest?.<HTMLElement>(".fd-walk-parts li[data-n]");
    const walk = (event.target as Element).closest?.(".fd-walk");
    const stage = walk?.closest(".fd-item")?.querySelector<HTMLElement>(".fd-stage");
    if (!stage) return;
    try { frameOf(stage)?.contentWindow?.postMessage({ demesne: "marks", hl: event.type === "pointerover" && item ? Number(item.dataset.n) : 0 }, "*"); } catch {}
  };
  root.addEventListener("pointerover", lit);
  root.addEventListener("pointerout", lit);

  /// Piece 5 of pass 274, knobs: the page named some of its values; over the opened mockup each gets a slider.
  /// A page that loads again (its demo starting over, another tab) is put back on what the sliders say.
  const setKnobs = (stage: HTMLElement, set: Record<string, number>) => { try { frameOf(stage)?.contentWindow?.postMessage({ demesne: "knobs", set }, "*"); } catch {} };
  function knobs(stage: HTMLElement, reported: unknown) {
    const item = stage.closest<HTMLElement>(".fd-item.fd-open"), list = cleanKnobs(reported);
    if (!item || !list.length) return;
    const had = item.querySelector<HTMLElement>(":scope > .fd-knobs");
    if (had) { const { set, moved } = knobsSet(had); if (moved) setKnobs(stage, set); return; }
    // Over the page, right under its one head line: in sight while you look at what they change.
    const head = item.querySelector<HTMLElement>(":scope > .fd-ln");
    if (head) head.insertAdjacentHTML("afterend", knobsHTML(list)); else stage.insertAdjacentHTML("beforebegin", knobsHTML(list));
  }
  const turned = (event: Event) => {
    const input = event.target as HTMLInputElement, row = input.closest?.<HTMLElement>(".fd-knobs");
    if (!row || !input.dataset?.knob) return;
    const stage = row.closest(".fd-item")?.querySelector<HTMLElement>(".fd-stage");
    const { knobs: all, set, moved } = knobsSet(row), knob = all.find((one) => one.name === input.dataset.knob);
    if (!stage || !knob) return;
    const output = input.nextElementSibling;
    if (output) output.textContent = knobValue(knob, set[knob.name] ?? knob.value);
    setKnobs(stage, { [knob.name]: set[knob.name] ?? knob.value });
    const send = row.querySelector<HTMLButtonElement>(".fd-knobs-send");
    if (send && !row.dataset.sent) send.hidden = !moved;
  };
  root.addEventListener("input", turned);

  const stageFor = (source: MessageEventSource | null) => stages().find((stage) => frameOf(stage)?.contentWindow === source) ?? null;
  const heard = (event: MessageEvent) => {
    const data = event.data as Record<string, unknown> | null;
    if (!data || typeof data !== "object") return;
    const stage = stageFor(event.source);
    if (!stage) return;
    const state = live(stage);
    if (data.demesne === "size" && stage.dataset.grow !== undefined && typeof data.height === "number") {
      const height = Math.max(120, Math.min(6000, Math.round(data.height))) + (Number(stage.dataset.bar) || 0);
      stage.dataset.oh = String(height);
      stage.querySelector<HTMLElement>(".fd-fit")?.style.setProperty("--oh", `${height}px`);
      // The row of small ones above the first style follows the page's real height, up to its cap.
      const row = stage.previousElementSibling?.previousElementSibling;
      if (row instanceof HTMLElement && row.classList.contains("fd-glance")) {
        const shown = Math.min(height - (Number(stage.dataset.bar) || 0), Math.round((Number(row.dataset.ow) || 0) * GLANCE_TALL));
        if (shown > 0) for (const mini of row.querySelectorAll<HTMLElement>(".fd-mini")) mini.style.setProperty("--oh", `${shown}px`);
      }
      return;
    }
    if (data.demesne === "options" && Array.isArray(data.options)) {
      const options = (data.options as unknown[]).filter((item): item is { name: string; note: string; colors?: unknown } => !!item && typeof (item as { name?: unknown }).name === "string")
        .slice(0, FOUNDRY_MAX_VARIANTS).map((item): StageOption => ({ name: item.name.slice(0, 120), note: typeof item.note === "string" ? item.note.slice(0, 200) : "",
          // The colours come from the page, so only plain colour values are drawn.
          ...(Array.isArray(item.colors) ? { colors: item.colors.filter(isStyleColour).slice(0, 5) } : {}) }));
      split(stage, options, Number(data.shown) || 0, typeof data.rec === "number" ? data.rec : -1, data.styles === true);
      return;
    }
    if (data.demesne === "knobs") { if (data.state === "ready") knobs(stage, data.knobs); return; }
    if (data.demesne === "marks") {
      if (data.state === "ready") marks(stage);
      else if (typeof data.over === "number") {
        const section = walkSection(walkOf(stage), names.get(stage)?.[Number(stage.dataset.split) || 0]?.name);
        for (const item of walkOf(stage)?.querySelectorAll<HTMLElement>(".fd-walk-parts li") ?? []) item.classList.toggle("lit", item.closest(".fd-walk-v") === section && Number(item.dataset.n) === data.over);
      }
      return;
    }
    if (data.demesne !== "demo") return;
    const line = lineOf(stage);
    if (data.state === "ready") { state.ready = true; if (state.want || (state.visible && !state.inside)) play(stage); }
    else if (data.state === "step" && line && !state.inside) line.innerHTML = demoLine(Number(data.step) || 0, Math.max(1, Number(data.of) || 1), typeof data.say === "string" ? data.say : "");
    else if (data.state === "done") { clearTimeout(state.timer); state.timer = window.setTimeout(() => play(stage), AGAIN); }
    // A step that finds nothing: the demo stops quietly rather than miming at empty space.
    else if (data.state === "lost") { state.lost = true; if (line) line.innerHTML = ""; }
  };
  window.addEventListener("message", heard);
  const resized = new ResizeObserver(() => { stages().forEach(fit); glances().forEach(fitGlance); });
  resized.observe(root);
  stages().forEach(watch);
  return () => { window.removeEventListener("message", heard); root.removeEventListener("pointerover", lit); root.removeEventListener("pointerout", lit); root.removeEventListener("input", turned); seen.disconnect(); resized.disconnect(); };
}
