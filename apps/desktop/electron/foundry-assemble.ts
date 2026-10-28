/// The assembly: the first time a version of an artifact shows in the pane,
/// its page puts itself together in front of you. The frame is sandboxed
/// with its own origin, so the pane can't reach in; instead the frame is
/// served with anime.js and this script appended, once, for that first show.
/// A first version arrives in parts: every piece starts a little way off,
/// small and tilted, and springs into place in reading order. A later
/// version moves only the pieces the edit touched, so you see what changed.
/// Reduce motion in the OS shows the finished page.

/** Runs inside the artifact frame after anime.js (UMD, `window.anime`); the
 * previous version's source, when there is one, is in `window.__demesnePrevious`. */
export const ASSEMBLE_SCRIPT = String.raw`(function () {
  var doc = document, html = doc.documentElement, A = window.anime;
  var reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!A || reduced) return;
  var SKIP = { SCRIPT: 1, STYLE: 1, TEMPLATE: 1, LINK: 1, META: 1, NOSCRIPT: 1, TITLE: 1, BR: 1, HR: 0 };
  var MAX = 80;
  html.style.visibility = "hidden";
  var shown = false;
  function show() { if (!shown) { shown = true; html.style.visibility = ""; } }
  // A piece is a block of the page: body's children, opened into their
  // children while that keeps the count sensible, three levels deep at most.
  function kids(el, live) {
    var out = [], list = el.children;
    for (var i = 0; i < list.length; i++) {
      var k = list[i];
      if (SKIP[k.tagName]) continue;
      if (live) {
        if (!k.getClientRects().length) continue;
        var cs = getComputedStyle(k);
        if (cs.position === "fixed" || cs.position === "sticky") continue;
      }
      out.push(k);
    }
    return out;
  }
  function collect(el, depth, limit, live) {
    var list = kids(el, live);
    if (depth < limit && list.length >= 2 && list.length <= 60) {
      var out = [];
      for (var i = 0; i < list.length; i++) out = out.concat(collect(list[i], depth + 1, limit, live));
      return out;
    }
    return [el];
  }
  function pieces(root, live) {
    for (var limit = 3; limit >= 1; limit--) {
      var list = kids(root, live), out = [];
      for (var i = 0; i < list.length; i++) out = out.concat(collect(list[i], 1, limit, live));
      if (out.length <= MAX) return out;
    }
    return kids(root, live).slice(0, MAX);
  }
  var norm = function (el) { return el.outerHTML.replace(/\s+/g, " ").trim(); };
  function changed(list, previous) {
    var old;
    try { old = pieces(new DOMParser().parseFromString(previous, "text/html").body, false); } catch (e) { return list; }
    var out = [];
    for (var i = 0; i < list.length; i++) if (!old[i] || norm(old[i]) !== norm(list[i])) out.push(list[i]);
    return out;
  }
  function run() {
    try {
      var list = pieces(doc.body, true), previous = window.__demesnePrevious, u = A.utils;
      if (typeof previous === "string") list = changed(list, previous);
      if (!list.length) { show(); return; }
      // The page's own inline transform and opacity, if any, come back at the end.
      var kept = list.map(function (el) { return [el.style.transform, el.style.opacity]; });
      var clean = function () { for (var i = 0; i < list.length; i++) { list[i].style.transform = kept[i][0]; list[i].style.opacity = kept[i][1]; } };
      if (typeof previous === "string") {
        // A revision: the changed pieces settle in; the rest never moves.
        u.set(list, { y: 14, scale: 0.96, opacity: 0 });
        show();
        A.animate(list, { y: 0, scale: 1, opacity: 1, duration: 480, ease: "outExpo", delay: A.stagger(40), onComplete: clean });
        return;
      }
      // A first version: scattered, small and tilted, then into place in reading order.
      u.set(list, {
        x: function () { return u.random(-200, 200); }, y: function () { return u.random(-140, 140); },
        rotate: function () { return u.random(-24, 24); }, scale: 0.6, opacity: 0,
      });
      show();
      A.animate(list, {
        x: 0, y: 0, rotate: 0, scale: 1, opacity: 1,
        ease: A.spring({ mass: 1, stiffness: 150, damping: 14 }),
        delay: A.stagger(Math.min(22, 1100 / list.length)),
        onComplete: clean,
      });
    } catch (e) { show(); }
  }
  function start() { requestAnimationFrame(function () { requestAnimationFrame(run); }); }
  if (doc.readyState === "complete") start(); else window.addEventListener("load", start, { once: true });
  // Whatever happens, the page is never left hidden.
  setTimeout(show, 4000);
})();`;

/** Text that is safe inside a script element: no sequence can close it early. */
export const scriptText = (value: unknown) => JSON.stringify(value).replace(/<\//g, "<\\/").replace(/<!--/g, "<\\!--");

/** The frame's page with the assembly appended: anime.js, the previous
 * version to diff against (or null), then the script above. */
export function assembledDocument(source: string, library: string, previous: string | null) {
  return `${source}\n<script>${library}</script>\n<script>window.__demesnePrevious=${scriptText(previous)};${ASSEMBLE_SCRIPT}</script>`;
}
