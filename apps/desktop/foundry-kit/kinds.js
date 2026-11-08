/* Foundry's ready kinds in the page (foundry://kit/kinds.js): a Deck shows
   one slide at a time with a strip of the rest, moves with the arrow keys,
   a click or the strip, and shrinks a slide's words until they fit.
   A Doc lights up the contents line you're reading. Without this script a
   deck is its slides one under another, which is also how it prints. */
(function () {
  "use strict";
  var doc = document, root = doc.documentElement, kind = root.getAttribute("data-kind");

  // Each slide's words get smaller until they fit its box (never under 55%).
  function fit(slide) {
    var box = slide.querySelector(".s-in");
    if (!box) return;
    var scale = 1;
    box.style.setProperty("--fit", "1");
    while (scale > 0.56 && box.scrollHeight > box.clientHeight + 1) {
      scale -= 0.04;
      box.style.setProperty("--fit", scale.toFixed(2));
    }
  }

  function deck() {
    var stage = doc.querySelector(".deck-stage"), strip = doc.querySelector(".deck-strip"), count = doc.querySelector(".deck-count");
    if (!stage) return;
    var slides = Array.prototype.slice.call(stage.querySelectorAll(":scope > .slide"));
    if (!slides.length) return;
    slides.forEach(fit);
    var thumbs = slides.map(function (slide, i) {
      var button = doc.createElement("button");
      button.type = "button"; button.className = "deck-thumb"; button.setAttribute("aria-label", "Slide " + (i + 1));
      var copy = slide.cloneNode(true); copy.removeAttribute("aria-label"); copy.setAttribute("aria-hidden", "true");
      button.appendChild(copy);
      button.addEventListener("click", function () { go(i); });
      strip.appendChild(button);
      return button;
    });
    var at = 0, start = Number((location.hash.match(/^#(\d+)$/) || [])[1]) - 1;
    function go(index) {
      at = Math.max(0, Math.min(slides.length - 1, index));
      slides.forEach(function (slide, i) { slide.classList.toggle("on", i === at); });
      thumbs.forEach(function (thumb, i) { thumb.setAttribute("aria-current", String(i === at)); });
      if (thumbs[at] && root.classList.contains("js")) thumbs[at].scrollIntoView({ block: "nearest", inline: "nearest" });
      if (count) count.textContent = (at + 1) + " / " + slides.length;
      try { history.replaceState(null, "", "#" + (at + 1)); } catch (e) {}
    }
    root.classList.add("js");
    go(start > 0 ? start : 0);
    doc.querySelector(".deck-prev").addEventListener("click", function () { go(at - 1); });
    doc.querySelector(".deck-next").addEventListener("click", function () { go(at + 1); });
    stage.addEventListener("click", function (event) {
      if (event.target.closest("a, button, input, select, textarea")) return;
      var box = stage.getBoundingClientRect();
      go(event.clientX - box.left < box.width / 3 ? at - 1 : at + 1);
    });
    doc.addEventListener("keydown", function (event) {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      var key = event.key;
      if (key === "ArrowRight" || key === "ArrowDown" || key === "PageDown" || key === " ") { event.preventDefault(); go(at + 1); }
      else if (key === "ArrowLeft" || key === "ArrowUp" || key === "PageUp") { event.preventDefault(); go(at - 1); }
      else if (key === "Home") go(0);
      else if (key === "End") go(slides.length - 1);
      else if (key === "Escape" && root.classList.contains("present")) { root.classList.remove("present"); tell("stopped"); }
    });
    function tell(state) { try { parent.postMessage({ demesne: "deck", state: state, slide: at + 1, slides: slides.length }, "*"); } catch (e) {} }
    window.addEventListener("message", function (event) {
      var data = event.data;
      if (event.source !== parent || !data || data.demesne !== "deck") return;
      if (data.action === "play") { root.classList.add("present"); if (typeof data.slide === "number") go(data.slide - 1); }
      else if (data.action === "stop") root.classList.remove("present");
      else if (data.action === "go" && typeof data.slide === "number") go(data.slide - 1);
    });
    tell("ready");
  }

  function docContents() {
    var links = Array.prototype.slice.call(doc.querySelectorAll(".doc-toc a"));
    if (!links.length || !("IntersectionObserver" in window)) return;
    var byId = {};
    links.forEach(function (link) { byId[link.getAttribute("href").slice(1)] = link; });
    var seen = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        links.forEach(function (link) { link.classList.remove("on"); });
        var link = byId[entry.target.id]; if (link) link.classList.add("on");
      });
    }, { rootMargin: "0px 0px -70% 0px" });
    Object.keys(byId).forEach(function (id) { var heading = doc.getElementById(id); if (heading) seen.observe(heading); });
  }

  function start() {
    if (kind === "deck") (doc.fonts && doc.fonts.ready ? doc.fonts.ready : Promise.resolve()).then(deck, deck);
    else if (kind === "doc") docContents();
  }
  if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", start); else start();
})();
