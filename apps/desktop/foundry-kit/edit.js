/* Edit in place (Foundry, step 3 after pass 262 C). Demesne puts this in
 * front of a deck, a doc or a dashboard on the Foundry page while you edit
 * it, instead of the demo and the notes. Every piece of text becomes
 * editable where it sits; when you leave one (click away, Enter, Tab), what
 * it said and what it says now go to the Foundry page, which finds that text
 * in the content and changes it there. Escape puts a piece back. If the
 * Foundry page can't place a change, it says so and the piece goes back.
 * Charts, the contents list and the deck's own bar stay as they are. */
(function () {
  "use strict";
  if (window.__demesneEdit) return;
  window.__demesneEdit = true;
  var TEXT = "h1,h2,h3,h4,h5,h6,p,li,th,td,figcaption,dt,dd,.k-stat-l,.k-stat-v,.k-stat-f b,.k-stat-f span";
  var SKIP = "[data-chrome],.doc-toc,.s-foot,svg,pre,code,.doc-head .eyebrow";
  var pieces = [], before = {};
  function tell(message) { message.demesne = "edit"; try { parent.postMessage(message, "*"); } catch (error) {} }
  function text(el) { return el.innerText.replace(/ /g, " ").replace(/\s*\n\s*/g, " ").trim(); }
  function start() {
    var found = document.querySelectorAll(TEXT);
    for (var i = 0; i < found.length; i++) {
      var el = found[i];
      if (el.closest(SKIP) || el.querySelector(TEXT) || !text(el)) continue;
      el.setAttribute("contenteditable", "plaintext-only");
      el.setAttribute("spellcheck", "true");
      el.dataset.edit = String(pieces.length);
      pieces.push(el);
    }
    var style = document.createElement("style");
    style.textContent = "[data-edit]{outline:none;border-radius:3px;cursor:text;transition:box-shadow .15s}"
      + "[data-edit]:hover{box-shadow:0 0 0 3px rgba(128,128,128,.14)}"
      + "[data-edit]:focus{box-shadow:0 0 0 3px rgba(128,128,128,.28)}"
      + "[data-edit].demesne-back{box-shadow:0 0 0 3px rgba(217,164,65,.55)}";
    document.head.appendChild(style);
    tell({ action: "ready", pieces: pieces.length });
  }
  function piece(target) { return target && target.closest ? target.closest("[data-edit]") : null; }
  // The deck turns its slide on a click or an arrow: not while you type in a piece.
  document.addEventListener("click", function (event) { if (piece(event.target)) event.stopPropagation(); }, true);
  window.addEventListener("keydown", function (event) {
    var el = piece(event.target);
    if (!el) return;
    event.stopPropagation();
    if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); el.blur(); }
    else if (event.key === "Escape") { event.preventDefault(); el.innerText = before[el.dataset.edit] != null ? before[el.dataset.edit] : el.innerText; el.blur(); }
  }, true);
  document.addEventListener("focusin", function (event) {
    var el = piece(event.target);
    if (el && before[el.dataset.edit] == null) before[el.dataset.edit] = el.innerText;
  });
  document.addEventListener("focusout", function (event) {
    var el = piece(event.target);
    if (!el || before[el.dataset.edit] == null) return;
    var was = before[el.dataset.edit];
    delete before[el.dataset.edit];
    var from = was.replace(/ /g, " ").replace(/\s*\n\s*/g, " ").trim(), to = text(el);
    if (from === to) return;
    el.dataset.was = was;
    tell({ action: "change", piece: Number(el.dataset.edit), before: from, after: to });
  });
  // The Foundry page couldn't place a change: the piece goes back, marked for a moment.
  window.addEventListener("message", function (event) {
    var data = event.data;
    if (event.source !== parent || !data || data.demesne !== "edit" || data.action !== "back") return;
    var el = pieces[data.piece];
    if (!el || el.dataset.was == null) return;
    el.innerText = el.dataset.was;
    el.classList.add("demesne-back");
    setTimeout(function () { el.classList.remove("demesne-back"); }, 1600);
  });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
