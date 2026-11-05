/// What changed: the first time a new version of a page shows, the parts the
/// revision touched are outlined in pink for a few seconds, so you see
/// where the edit landed without comparing by eye. Works for HTML pages and
/// the ready kinds alike, since both arrive as a document.
///
/// The frame gets the previous version's document as a string; the script
/// runs while the page is still parsing, so the live DOM is exactly the new
/// document's markup. It walks both by position (tag and place among
/// siblings), marks the elements whose own tag, attributes or text differ or
/// are new, folds a parent whose children mostly changed into the parent,
/// and keeps the elements to outline once the page has settled (parts and
/// the deck's runtime may have rearranged it by then). A rewrite (most of
/// the page changed) is outlined nowhere: there's nothing to point out.
/// In a deck, the first changed slide is the one that opens.

export const CHANGED_SCRIPT = String.raw`(function () {
  var prev = window.__demesneChangedFrom;
  if (typeof prev !== "string") return;
  var SKIP = { SCRIPT: 1, STYLE: 1, LINK: 1, META: 1, TEMPLATE: 1, TITLE: 1, NOSCRIPT: 1, BR: 1 };
  var before = new DOMParser().parseFromString(prev, "text/html");
  function own(el) {
    var text = "";
    for (var n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 3) text += n.nodeValue;
    var attrs = [];
    for (var i = 0; i < el.attributes.length; i++) { var a = el.attributes[i]; if (a.name !== "style" || el.tagName !== "HTML") attrs.push(a.name + "=" + a.value); }
    return el.tagName + "|" + attrs.sort().join("&") + "|" + text.replace(/\s+/g, " ").trim();
  }
  function walk(el, key, out) {
    var counts = {};
    for (var c = el.firstElementChild; c; c = c.nextElementSibling) {
      if (SKIP[c.tagName] || c.id === "demesne-changed") continue;
      counts[c.tagName] = (counts[c.tagName] || 0) + 1;
      var k = key + "/" + c.tagName + counts[c.tagName];
      out.push({ key: k, el: c, sig: own(c) });
      walk(c, k, out);
    }
    return out;
  }
  if (!document.body || !before.body) return;
  var old = {}, oldList = walk(before.body, "", []);
  oldList.forEach(function (item) { old[item.key] = item.sig; });
  var now = walk(document.body, "", []);
  if (!now.length) return;
  var changed = now.filter(function (item) { return old[item.key] !== item.sig; });
  if (!changed.length || changed.length === now.length || changed.length > Math.max(6, now.length * 0.5)) return;
  // A parent whose children mostly changed is outlined whole.
  var set = new Set(changed.map(function (item) { return item.el; }));
  now.forEach(function (item) {
    var kids = Array.prototype.filter.call(item.el.children, function (c) { return !SKIP[c.tagName]; });
    if (kids.length >= 2 && kids.filter(function (c) { return set.has(c); }).length / kids.length >= 0.6) set.add(item.el);
  });
  var picked = Array.from(set).filter(function (el) {
    for (var up = el.parentElement; up; up = up.parentElement) if (set.has(up)) return false;
    return true;
  }).slice(0, 12);
  if (!picked.length) return;
  // A deck opens on the first slide the revision touched.
  var slide = picked[0].closest && picked[0].closest(".slide[data-index]");
  if (slide && !/^#\d+$/.test(location.hash)) try { history.replaceState(null, "", "#" + slide.getAttribute("data-index")); } catch (e) {}
  var reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  function draw() {
    var layer = document.createElement("div");
    layer.id = "demesne-changed";
    layer.setAttribute("aria-hidden", "true");
    layer.style.cssText = "position:absolute;left:0;top:0;width:0;height:0;z-index:2147483646;pointer-events:none";
    var drawn = 0;
    picked.forEach(function (el) {
      if (!el.isConnected) return;
      var r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2 || getComputedStyle(el).visibility === "hidden") return;
      var box = document.createElement("div");
      box.style.cssText = "position:absolute;border-radius:6px;box-shadow:0 0 0 2px #f2b6c8,0 0 0 6px rgba(242,182,200,.28);transition:opacity .6s ease"
        + ";left:" + (r.left + scrollX - 4) + "px;top:" + (r.top + scrollY - 4) + "px;width:" + (r.width + 8) + "px;height:" + (r.height + 8) + "px";
      layer.appendChild(box); drawn++;
    });
    if (!drawn) return;
    document.body.appendChild(layer);
    window.__demesneChanged = drawn;
    setTimeout(function () {
      Array.prototype.forEach.call(layer.children, function (box) { box.style.opacity = "0"; });
      setTimeout(function () { layer.remove(); }, reduced ? 0 : 700);
    }, 2600);
  }
  function settle() { setTimeout(draw, 650); }
  if (document.readyState === "complete") settle(); else window.addEventListener("load", settle);
})();`;

/// The new version's document with the previous one riding along for the
/// comparison (the script runs before the page's own scripts finish).
export function withChanges(document: string, previous: string) {
  const data = `<script>window.__demesneChangedFrom=${JSON.stringify(previous).replace(/</g, "\\u003c")};</script><script>${CHANGED_SCRIPT}</script>`;
  return /<\/body>/i.test(document) ? document.replace(/<\/body>(?![\s\S]*<\/body>)/i, `${data}</body>`) : `${document}\n${data}`;
}
