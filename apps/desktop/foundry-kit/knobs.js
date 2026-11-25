/* Knobs (piece 5 of pass 274). Demesne puts this in front of a page on the
 * Foundry page. A page names up to four of its own values as knobs:
 *   <meta name="knob" content="Room | --pad | 8 | 24 | px">
 * This reads them, tells the Foundry page (which draws a slider for each
 * over the opened mockup), and sets the property on the page when a slider
 * moves. Nothing is drawn here, and nothing leaves but the knobs' own
 * names, ranges and values. */
(function () {
  "use strict";
  if (window.__demesneKnobs) return;
  window.__demesneKnobs = true;
  var UNITS = ["", "px", "%", "rem", "em", "deg", "ms", "s", "vw", "vh"], names = {};
  function tell(message) { message.demesne = "knobs"; try { parent.postMessage(message, "*"); } catch (error) {} }
  function start() {
    var metas = document.querySelectorAll('meta[name="knob"]'), knobs = [], root = getComputedStyle(document.documentElement);
    for (var i = 0; i < metas.length && knobs.length < 4; i++) {
      var parts = (metas[i].getAttribute("content") || "").split("|").map(function (part) { return part.trim(); });
      if (parts.length < 4 || parts.length > 5) continue;
      var label = parts[0], name = parts[1], min = Number(parts[2]), max = Number(parts[3]), unit = parts[4] || "";
      if (!label || label.length > 24 || !/^--[A-Za-z][\w-]{0,40}$/.test(name) || !parts[2] || !parts[3] || !isFinite(min) || !isFinite(max) || min >= max || UNITS.indexOf(unit) < 0 || names[name]) continue;
      var value = parseFloat(root.getPropertyValue(name));
      if (!isFinite(value)) continue;
      names[name] = unit;
      knobs.push({ label: label, name: name, min: min, max: max, unit: unit, value: Math.min(max, Math.max(min, value)) });
    }
    if (knobs.length) tell({ state: "ready", knobs: knobs });
  }
  // The Foundry page moved a slider: only a knob's own property, only to a number in its unit.
  window.addEventListener("message", function (event) {
    var data = event.data;
    if (event.source !== parent || !data || data.demesne !== "knobs" || !data.set || typeof data.set !== "object") return;
    for (var name in data.set) {
      if (!Object.prototype.hasOwnProperty.call(names, name)) continue;
      var value = Number(data.set[name]);
      if (isFinite(value)) document.documentElement.style.setProperty(name, value + names[name]);
    }
  });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
