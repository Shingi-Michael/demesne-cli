/* The numbers of a mockup's parts (pass 263 A). Demesne puts this in front of
   every page on the Foundry page. The Foundry page sends the parts its
   walkthrough names ({demesne: "marks", marks: [{n, at}]}, at a CSS selector),
   and each number is drawn as a small dot on the corner of the first piece on
   screen that matches. Resting on a numbered piece tells the Foundry page
   ({over: n}) so it lights that line; resting on a line lights the piece
   ({hl: n}). The dots take no pointer and are Demesne's (data-chrome). */
(function () {
  "use strict";
  if (window.__demesneMarks) return;
  window.__demesneMarks = true;
  var doc = document, list = [], layer = null, lit = 0, over = 0, queued = false;
  function tell(message) { message.demesne = "marks"; try { parent.postMessage(message, "*"); } catch (error) {} }
  function shown(el) { var r = el.getBoundingClientRect(); return r.width > 1 && r.height > 1 && getComputedStyle(el).visibility !== "hidden"; }
  function find(at) {
    var all;
    try { all = doc.querySelectorAll(at); } catch (error) { return null; }
    for (var i = 0; i < all.length; i++) if (!all[i].closest("[data-chrome]") && shown(all[i])) return all[i];
    return null;
  }
  function draw() {
    queued = false;
    if (!doc.body) return;
    // Nothing to number: nothing is drawn on the page at all.
    if (!list.length) { if (layer) layer.remove(); return; }
    if (!layer) {
      layer = doc.createElement("div");
      layer.setAttribute("data-chrome", ""); layer.setAttribute("aria-hidden", "true"); layer.id = "demesne-marks";
      layer.style.cssText = "position:absolute;left:0;top:0;width:0;height:0;pointer-events:none;z-index:2147483646";
    }
    if (layer.parentNode !== doc.body) doc.body.appendChild(layer);
    layer.textContent = "";
    var x = scrollX, y = scrollY;
    list.forEach(function (mark) {
      var el = mark.el = find(mark.at);
      if (!el) return;
      var r = el.getBoundingClientRect();
      var dot = doc.createElement("i");
      dot.textContent = String(mark.n);
      dot.style.cssText = "position:absolute;width:18px;height:18px;border-radius:50%;font:600 10.5px/18px Inter,system-ui,sans-serif;font-style:normal;text-align:center;"
        + "background:#26282b;color:#f4f4f2;box-shadow:0 0 0 2px rgba(255,255,255,.9),0 2px 6px rgba(0,0,0,.25);"
        + "left:" + Math.max(2, r.left + x - 9) + "px;top:" + Math.max(2, r.top + y - 9) + "px";
      layer.appendChild(dot);
      if (lit === mark.n) {
        var ring = doc.createElement("b");
        ring.style.cssText = "position:absolute;border-radius:8px;box-shadow:0 0 0 2px rgba(38,40,43,.6);left:" + (r.left + x - 3) + "px;top:" + (r.top + y - 3) + "px;width:" + (r.width + 6) + "px;height:" + (r.height + 6) + "px";
        layer.appendChild(ring);
      }
    });
  }
  function later() { if (!queued) { queued = true; requestAnimationFrame(draw); } }
  addEventListener("message", function (event) {
    var data = event.data;
    if (event.source !== parent || !data || data.demesne !== "marks") return;
    if (Array.isArray(data.marks)) list = data.marks.filter(function (mark) { return mark && typeof mark.at === "string" && typeof mark.n === "number"; }).slice(0, 12).map(function (mark) { return { n: mark.n, at: mark.at }; });
    if (typeof data.hl === "number") lit = data.hl;
    later();
  });
  addEventListener("resize", later);
  addEventListener("scroll", later, true);
  if (window.ResizeObserver) new ResizeObserver(later).observe(doc.documentElement);
  doc.addEventListener("pointerover", function (event) {
    var hit = 0;
    list.forEach(function (mark) { if (!hit && mark.el && mark.el.contains(event.target)) hit = mark.n; });
    if (hit !== over) { over = hit; tell({ over: hit }); }
  }, true);
  function ready() { tell({ state: "ready" }); }
  if (doc.readyState === "complete") ready(); else addEventListener("load", ready);
})();
