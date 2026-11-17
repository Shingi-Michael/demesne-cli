/* Notes on a mockup (pass 233 A). Demesne puts this in front of every page
   on the Foundry page. It tells the Foundry page which part is under the
   pointer (its place, what it is, where it is in the markup) and where the
   parts that carry notes are now, so the Foundry page can outline a part,
   name it and pin notes to it.

   It draws nothing and changes nothing on the page: the outline, the tag,
   the pins and the note box are the Foundry page's, outside this frame. */
(function () {
  "use strict";
  if (window.__demesneNote) return;
  window.__demesneNote = true;
  var doc = document, over = null, watched = [], queued = false, last = "";
  // A piece a person would name: a control, a row, or one of the kit's parts.
  var PIECE = "button,a,input,select,textarea,label,summary,tr,li,[role=button],[role=tab],[role=switch],[role=checkbox],[role=radio],[role=menuitem],[role=option],[role=link],"
    + "d-row,d-card,d-stat,d-toggle,d-seg,d-tabs,d-chart,d-avatar,d-message,d-composer,d-icon,d-mark";
  // Frames and stages hold the mockup. They are never the part.
  var FRAME = /^(HTML|BODY|MAIN|D-DEMESNE|D-APP|D-WINDOW|D-BROWSER|D-PHONE|D-COMPARE|D-REVIEW|D-CROP)$/;
  var PLAIN = /^(DIV|SPAN)$/;

  function tell(message) { message.demesne = "note"; try { parent.postMessage(message, "*"); } catch (error) {} }
  function clean(text) { return String(text || "").replace(/\s+/g, " ").trim(); }
  function box(r) { return { x: r.left, y: r.top, w: r.width, h: r.height }; }
  // Demesne's own drawing on the page (the demo's pointer, what changed) is no part of it.
  function chrome(el) { return !!el.closest("[data-chrome],#demesne-changed"); }
  function tiny(el) { var r = el.getBoundingClientRect(); return r.width < 20 && r.height < 20; }
  function unnamed(el) { return PLAIN.test(el.tagName) && !el.id && !(typeof el.className === "string" && el.className.trim()); }

  /* The smallest piece under the pointer that a person would name. */
  function partOf(el) {
    if (!el || el.nodeType !== 1 || FRAME.test(el.tagName) || chrome(el)) return null;
    var drawing = el.closest("svg");
    if (drawing) el = drawing;
    var piece = el.closest(PIECE);
    if (piece) el = piece;
    else {
      // A word or an icon belongs to the block that holds it, and a bare wrapper to what it wraps.
      while (el.parentElement && !FRAME.test(el.parentElement.tagName) && (getComputedStyle(el).display === "inline" || tiny(el) || unnamed(el))) el = el.parentElement;
    }
    if (FRAME.test(el.tagName)) return null;
    var r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return null;
    // The page's own wrapper is the whole mockup (all of the window, or all there is on a short page): there is nothing to point at.
    var all = doc.body ? doc.body.getBoundingClientRect() : r;
    if (el.firstElementChild && r.width >= Math.min(innerWidth, all.width) * 0.9 && r.height >= Math.min(innerHeight, all.height) * 0.9) return null;
    return el;
  }

  function step(el) {
    var name = el.tagName.toLowerCase();
    if (el.id && /^[A-Za-z][\w-]*$/.test(el.id)) return name + "#" + el.id;
    var parent = el.parentElement;
    var same = parent ? Array.prototype.filter.call(parent.children, function (child) { return child.tagName === el.tagName; }) : [];
    var cls = typeof el.className === "string" ? el.className.split(/\s+/).filter(function (c) { return /^[A-Za-z][\w-]*$/.test(c) && c.length < 32; }).slice(0, 2).map(function (c) { return "." + c; }).join("") : "";
    return name + cls + (same.length > 1 ? ":nth-of-type(" + (same.indexOf(el) + 1) + ")" : "");
  }
  function selector(el) {
    var parts = [];
    for (var at = el; at && at.nodeType === 1 && at !== doc.documentElement && at !== doc.body && parts.length < 6; at = at.parentElement) {
      parts.unshift(step(at));
      if (at.id && /^[A-Za-z][\w-]*$/.test(at.id)) break;
    }
    return parts.join(" > ");
  }
  function markup(el) {
    var html = el.outerHTML.replace(/\s+/g, " ");
    return html.length > 600 ? html.slice(0, 599) + "…" : html;
  }
  // A piece with no heading is named by the first words in it.
  function firstWords(el) {
    var all = el.querySelectorAll("*");
    for (var i = 0; i < all.length && i < 40; i++)
      for (var n = all[i].firstChild; n; n = n.nextSibling) if (n.nodeType === 3 && /[A-Za-z0-9]{2}/.test(n.nodeValue)) return all[i];
    return null;
  }
  function describe(el) {
    var lead = el.querySelector("h1,h2,h3,h4,h5,h6,legend,caption,b,strong") || firstWords(el);
    return {
      tag: el.tagName.toLowerCase(), role: el.getAttribute("role") || "", type: el.getAttribute("type") || "",
      cls: typeof el.className === "string" ? el.className.slice(0, 120) : "",
      label: clean(el.getAttribute("aria-label") || el.getAttribute("alt") || el.getAttribute("title") || el.getAttribute("label") || el.getAttribute("placeholder")).slice(0, 80),
      text: clean(el.innerText || el.textContent || el.value).slice(0, 120),
      heading: lead ? clean(lead.textContent).slice(0, 60) : "",
      kids: el.childElementCount, selector: selector(el), html: markup(el), rect: box(el.getBoundingClientRect()),
    };
  }
  function find(sel) { try { return doc.querySelector(sel); } catch (error) { return null; } }

  /* Where things are now: the part under the pointer, and each part with a note. */
  function send(force) {
    queued = false;
    if (over && !over.isConnected) over = null;
    var message = { state: "at", vw: innerWidth, vh: innerHeight, part: over ? describe(over) : null,
      pins: watched.map(function (pin) { var el = find(pin.selector); return { n: pin.n, rect: el ? box(el.getBoundingClientRect()) : null }; }) };
    var now = JSON.stringify(message);
    if (!force && now === last) return;
    last = now;
    tell(message);
  }
  function soon() { if (!queued) { queued = true; requestAnimationFrame(function () { send(false); }); } }

  doc.addEventListener("pointermove", function (event) {
    // The demo's own pointer moves are not the person's.
    if (!event.isTrusted) return;
    var el = partOf(doc.elementFromPoint(event.clientX, event.clientY));
    if (el !== over) { over = el; soon(); }
  }, true);
  doc.documentElement.addEventListener("pointerleave", function (event) { if (event.isTrusted && over) { over = null; soon(); } });
  addEventListener("scroll", soon, true);
  addEventListener("resize", soon);
  // The page moves under a part (a tab switches, a list grows): keep the outline and the pins on it.
  setInterval(function () { if (over || watched.length) send(false); }, 400);
  addEventListener("message", function (event) {
    var data = event.data;
    if (!data || data.demesne !== "note" || event.source !== parent) return;
    // The pointer is on the Foundry page's own drawing over this frame: it is on no part here.
    if (data.action === "away") { if (over) { over = null; soon(); } return; }
    if (data.action === "watch" && Array.isArray(data.pins)) {
      watched = data.pins.filter(function (pin) { return pin && typeof pin.selector === "string" && typeof pin.n === "number"; }).slice(0, 40);
      send(true);
    }
  });
  tell({ state: "ready" });
})();
