/// The stages on Foundry's long page come alive (pass 221 A): each surface
/// is fitted to the page, a page that grows with its content gets the height
/// it says, a mockup with options gets one stage per option (named on the
/// line above it), and a demo plays while its stage is on screen. Moving
/// into a stage stops its demo and hands the page to you; a moment after you
/// leave, it starts again from a fresh page. Nothing here adds a control:
/// the demo's words go on the quiet line under the stage.

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

  /// Options get a stage each: the one the page shows first, then the rest.
  function split(stage: HTMLElement, options: { name: string; note: string }[], shown: number, rec: number) {
    if (stage.dataset.split !== undefined || options.length < 2) return;
    stage.dataset.split = String(shown);
    const head = (option: { name: string; note: string }, index: number) =>
      `<div class="fd-opt"><b>${h(option.name)}</b>${index === rec ? '<span class="fd-rec-pill">recommended</span>' : ""}${option.note ? `<span>${h(option.note)}</span>` : ""}</div>`;
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

  const stageFor = (source: MessageEventSource | null) => stages().find((stage) => frameOf(stage)?.contentWindow === source) ?? null;
  const heard = (event: MessageEvent) => {
    const data = event.data as Record<string, unknown> | null;
    if (!data || typeof data !== "object") return;
    const stage = stageFor(event.source);
    if (!stage) return;
    const state = live(stage);
    if (data.demesne === "size" && stage.dataset.grow !== undefined && typeof data.height === "number") {
      const height = Math.max(120, Math.min(4000, Math.round(data.height))) + (Number(stage.dataset.bar) || 0);
      stage.dataset.oh = String(height);
      stage.querySelector<HTMLElement>(".fd-fit")?.style.setProperty("--oh", `${height}px`);
      return;
    }
    if (data.demesne === "options" && Array.isArray(data.options)) {
      const options = (data.options as unknown[]).filter((item): item is { name: string; note: string } => !!item && typeof (item as { name?: unknown }).name === "string")
        .slice(0, 3).map((item) => ({ name: item.name.slice(0, 120), note: typeof item.note === "string" ? item.note.slice(0, 200) : "" }));
      split(stage, options, Number(data.shown) || 0, typeof data.rec === "number" ? data.rec : -1);
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
  const resized = new ResizeObserver(() => stages().forEach(fit));
  resized.observe(root);
  stages().forEach(watch);
  return () => { window.removeEventListener("message", heard); seen.disconnect(); resized.disconnect(); };
}
