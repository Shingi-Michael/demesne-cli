/* Foundry plays a mockup's demo (pass 221 A). Demesne puts this in front of
   every page on the Foundry page, after the try runtime (foundry-try.ts),
   whose find() it uses so a demo names controls the way foundry_try does.

   The Foundry page sends {demesne: "demo", action: "play", steps} when the
   mockup is on screen and {action: "stop"} when the person moves into it.
   Each step runs on the page itself with a drawn pointer; what it says goes
   back to the Foundry page, which shows it under the stage, never on the
   drawing. A deck with no steps moves through its slides. The page tells
   its height for surfaces that grow with their content.

   Nothing here draws a control: the pointer is chrome, out of the page's
   way (pointer-events: none). */
(function () {
  "use strict";
  if (window.__demesneDemo) return;
  var doc = document, root = doc.documentElement;
  var state = { playing: false };
  window.__demesneDemo = state;
  var run = 0, pointer = null, hoverMirrored = false, at = null;
  var ARROW = '<svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true"><path d="M2 1.5v13.2l3.6-3.4 2.4 5.4 2.3-1-2.4-5.3h5z" fill="#fff" stroke="#111" stroke-width="1.2" stroke-linejoin="round"/></svg>';
  var PAUSE = 650, TYPE_GAP = 55, SLIDE = 3600;

  function tell(message) { message.demesne = "demo"; try { parent.postMessage(message, "*"); } catch (error) {} }
  function sleep(ms, mine) { return new Promise(function (done) { setTimeout(function () { done(mine === run); }, ms); }); }

  function drawPointer() {
    if (pointer && pointer.isConnected) return pointer;
    pointer = doc.createElement("div");
    pointer.setAttribute("data-chrome", ""); pointer.setAttribute("aria-hidden", "true");
    pointer.style.cssText = "position:fixed;left:0;top:0;width:18px;height:18px;z-index:2147483647;pointer-events:none;opacity:0;"
      + "transition:transform .7s cubic-bezier(.3,.7,.2,1),opacity .25s;filter:drop-shadow(0 1px 2px rgba(0,0,0,.45))";
    pointer.innerHTML = ARROW;
    pointer.firstChild.style.cssText = "display:block;transform-origin:2px 2px;transition:transform .12s";
    root.appendChild(pointer);
    return pointer;
  }
  function moveTo(x, y, now) {
    var arrow = drawPointer();
    if (now) { arrow.style.transition = "none"; arrow.style.transform = "translate(" + x + "px," + y + "px)"; void arrow.offsetWidth; arrow.style.transition = "transform .7s cubic-bezier(.3,.7,.2,1),opacity .25s"; }
    else arrow.style.transform = "translate(" + x + "px," + y + "px)";
    arrow.style.opacity = "1";
    at = [x, y];
  }
  function press(down) { if (pointer) pointer.firstChild.style.transform = down ? "scale(.82)" : ""; }
  function hidePointer() { if (pointer) pointer.style.opacity = "0"; }

  /// :hover can't be set from script, so each page rule with :hover gets a
  /// twin on [data-demo-hover], which the pointer sets on what it is over.
  function mirrorHover() {
    if (hoverMirrored) return;
    hoverMirrored = true;
    function walk(list, owner) {
      for (var i = list.length - 1; i >= 0; i--) {
        var rule = list[i];
        if (rule.selectorText && rule.selectorText.indexOf(":hover") >= 0) {
          try { owner.insertRule(rule.cssText.replace(/:hover/g, "[data-demo-hover]"), i + 1); } catch (error) {}
        } else if (rule.cssRules && !rule.selectorText) {
          try { walk(rule.cssRules, rule); } catch (error) {}
        }
      }
    }
    for (var s = 0; s < doc.styleSheets.length; s++) {
      var sheet = doc.styleSheets[s], rules = null;
      try { rules = sheet.cssRules; } catch (error) { continue; }
      if (rules) walk(rules, sheet);
    }
  }
  function unhover() {
    var lit = doc.querySelectorAll("[data-demo-hover]");
    for (var i = 0; i < lit.length; i++) lit[i].removeAttribute("data-demo-hover");
  }
  function hover(el) {
    mirrorHover(); unhover();
    for (var node = el; node && node.nodeType === 1; node = node.parentElement) node.setAttribute("data-demo-hover", "");
    var box = el.getBoundingClientRect(), init = { bubbles: true, clientX: box.left + box.width / 2, clientY: box.top + box.height / 2 };
    el.dispatchEvent(new PointerEvent("pointerover", init)); el.dispatchEvent(new MouseEvent("mouseover", init));
    el.dispatchEvent(new PointerEvent("pointerenter", { clientX: init.clientX, clientY: init.clientY })); el.dispatchEvent(new MouseEvent("mouseenter", { clientX: init.clientX, clientY: init.clientY }));
  }

  /// The control a step names, as foundry_try finds it; brought on screen
  /// by scrolling this page only (the Foundry page around it stays put).
  function find(name) {
    var tryer = window.__demesneTry;
    var hits = tryer && tryer.kit && tryer.kit.candidates ? tryer.kit.candidates(name) : [];
    var el = hits && hits[0];
    if (!el) return null;
    var box = el.getBoundingClientRect(), scroller = doc.scrollingElement || root;
    if (box.top < 0 || box.bottom > innerHeight) scroller.scrollTop += box.top - innerHeight / 2 + box.height / 2;
    return el;
  }
  function centre(el, nudge) {
    var box = el.getBoundingClientRect();
    return [Math.round(box.left + Math.min(box.width * 0.55, box.width - 6) + (nudge || 0)), Math.round(box.top + box.height * 0.55)];
  }
  function setValue(el, value) {
    var proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    var setter = Object.getOwnPropertyDescriptor(proto, "value");
    if (setter && setter.set) setter.set.call(el, value); else el.value = value;
  }
  function key(name, target) {
    var el = target || doc.activeElement || doc.body, k = name === "Space" ? " " : name;
    var init = { key: k, code: name === "Space" ? "Space" : name, bubbles: true, cancelable: true };
    var go = el.dispatchEvent(new KeyboardEvent("keydown", init));
    if (go && name === "Enter" && el.form && /^(INPUT)$/.test(el.tagName)) { try { el.form.requestSubmit(); } catch (error) {} }
    if (go && (name === "Enter" || name === "Space") && /^(BUTTON|A|SUMMARY)$/.test(el.tagName)) el.click();
    el.dispatchEvent(new KeyboardEvent("keyup", init));
  }

  async function step(item, mine) {
    if (item.wait !== undefined) return sleep(item.wait, mine);
    if (item.scroll !== undefined) { (doc.scrollingElement || root).scrollBy({ top: item.scroll, behavior: "smooth" }); return sleep(700, mine); }
    if (item.key !== undefined) { key(item.key); return sleep(PAUSE, mine); }
    var name = item.click !== undefined ? item.click : item.hover !== undefined ? item.hover : item.into;
    var el = name !== undefined ? find(name) : doc.activeElement;
    if (name !== undefined && !el) { tell({ state: "lost", name: String(name) }); return false; }
    if (el && el !== doc.body) {
      var spot = centre(el, item.click !== undefined ? -2 : 0);
      moveTo(spot[0], spot[1]);
      if (!(await sleep(780, mine))) return false;
      hover(el);
    }
    if (item.hover !== undefined) return sleep(PAUSE, mine);
    if (item.click !== undefined) {
      press(true);
      var box = el.getBoundingClientRect(), init = { bubbles: true, cancelable: true, clientX: box.left + box.width / 2, clientY: box.top + box.height / 2 };
      el.dispatchEvent(new PointerEvent("pointerdown", init)); el.dispatchEvent(new MouseEvent("mousedown", init));
      if (typeof el.focus === "function") el.focus({ preventScroll: true });
      if (!(await sleep(150, mine))) return false;
      press(false);
      el.dispatchEvent(new PointerEvent("pointerup", init)); el.dispatchEvent(new MouseEvent("mouseup", init));
      el.click();
      return sleep(PAUSE, mine);
    }
    if (item.type !== undefined) {
      var field = el && el !== doc.body ? el : doc.activeElement;
      if (!field) return true;
      if (typeof field.focus === "function") field.focus({ preventScroll: true });
      for (var i = 0; i < item.type.length; i++) {
        if (field.isContentEditable) doc.execCommand("insertText", false, item.type[i]);
        else if ("value" in field) { setValue(field, field.value + item.type[i]); field.dispatchEvent(new InputEvent("input", { bubbles: true, data: item.type[i], inputType: "insertText" })); }
        if (!(await sleep(TYPE_GAP, mine))) return false;
      }
      if ("value" in field) field.dispatchEvent(new Event("change", { bubbles: true }));
      return sleep(PAUSE, mine);
    }
    return true;
  }

  async function play(steps) {
    var mine = ++run;
    state.playing = true;
    var beats = steps.filter(function (item) { return item.say; }).length || steps.length, beat = -1;
    moveTo(innerWidth * 0.82, innerHeight * 0.86, true);
    if (!(await sleep(400, mine))) return;
    for (var i = 0; i < steps.length; i++) {
      var item = steps[i];
      if (item.say || !steps.some(function (other) { return other.say; })) { beat++; tell({ state: "step", step: beat, of: beats, say: item.say || "" }); }
      var ok = await step(item, mine);
      if (mine !== run) return;
      if (ok === false) { state.playing = false; hidePointer(); unhover(); return; }
    }
    if (!(await sleep(1800, mine))) return;
    hidePointer(); unhover();
    state.playing = false;
    tell({ state: "done" });
  }

  /// A deck with no demo of its own moves through its slides.
  async function slides() {
    var mine = ++run, all = doc.querySelectorAll(".deck-stage > .slide");
    if (all.length < 2) return;
    state.playing = true;
    while (mine === run) {
      var on = 0;
      for (var i = 0; i < all.length; i++) if (all[i].classList.contains("on")) on = i;
      tell({ state: "step", step: on, of: all.length, say: "Slide " + (on + 1) + " of " + all.length });
      if (!(await sleep(SLIDE, mine))) return;
      key(on === all.length - 1 ? "Home" : "ArrowRight", doc.body);
    }
  }

  function stop() { run++; state.playing = false; hidePointer(); unhover(); press(false); }

  window.addEventListener("message", function (event) {
    var data = event.data;
    if (event.source !== parent || !data || data.demesne !== "demo") return;
    if (data.action === "stop") stop();
    else if (data.action === "play") {
      if (Array.isArray(data.steps) && data.steps.length) play(data.steps);
      else if (root.getAttribute("data-kind") === "deck") slides();
    }
  });

  // Surfaces that grow with the page: say how tall it is.
  var told = 0;
  function size() {
    // The content's own height: the body's, with its margins (the document is never shorter than the frame).
    var body = doc.body;
    if (!body) return;
    var style = getComputedStyle(body), height = Math.ceil(body.scrollHeight + parseFloat(style.marginTop) + parseFloat(style.marginBottom));
    if (Math.abs(height - told) > 1) { told = height; try { parent.postMessage({ demesne: "size", height: height }, "*"); } catch (error) {} }
  }
  function ready() {
    size();
    if ("ResizeObserver" in window) new ResizeObserver(size).observe(doc.body || root);
    tell({ state: "ready" });
  }
  if (doc.readyState === "complete") ready(); else window.addEventListener("load", ready);
})();
