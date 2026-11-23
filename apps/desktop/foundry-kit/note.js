/* Notes on a mockup (pass 233 A, pass 242 A). Demesne puts this in front of
   every page on the Foundry page. It tells the Foundry page where the pointer
   is, and where the parts that carry notes are now, so the Foundry page can
   show a small + when the pointer rests and pin notes exactly where you click.

   A click on the mockup is a pin: it is told to the Foundry page and kept from
   the page. A click on a control (a button, a link, a field, a switch) still
   works, so a page that is a tool to keep stays one; resting on it shows the +
   beside the pointer, and the Foundry page asks for a pin there ("pin-at").
   Only a page the Foundry page takes notes on pins at all.
   A picture dropped on the mockup (step 6) is a pin that carries it.
   It draws nothing and changes nothing on the page: the +, the pins and the
   note box are the Foundry page's, outside this frame. */
(function () {
  "use strict";
  if (window.__demesneNote) return;
  window.__demesneNote = true;
  var doc = document, point = null, watched = [], queued = false, last = "", noting = false;
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

  /* Where things are now: the pointer, and each part with a note. */
  function send(force) {
    queued = false;
    var message = { state: "at", vw: innerWidth, vh: innerHeight, point: point,
      pins: watched.map(function (pin) { var el = find(pin.selector); return { n: pin.n, rect: el ? box(el.getBoundingClientRect()) : null }; }) };
    var now = JSON.stringify(message);
    if (!force && now === last) return;
    last = now;
    tell(message);
  }
  function soon() { if (!queued) { queued = true; requestAnimationFrame(function () { send(false); }); } }
  // The page itself holds a pin that is on no part: it moves with the page as it scrolls.
  function page() {
    return { tag: "html", role: "", type: "", cls: "", label: "", text: "", heading: "", kids: 0, selector: "html", html: "", rect: box(doc.documentElement.getBoundingClientRect()) };
  }
  // Controls keep working when clicked: the page's own, and the deck's arrows and strip.
  var CONTROL = "button,a[href],input,select,textarea,label,summary,[contenteditable],[onclick],[data-go],[role=button],[role=tab],[role=switch],[role=checkbox],[role=radio],[role=menuitem],[role=option],[role=link],[role=slider],d-toggle,d-seg,d-composer,.deck-prev,.deck-next,.deck-strip";
  function control(el) { return !!(el && el.closest && el.closest(CONTROL)); }
  function pinAt(x, y) {
    var el = partOf(doc.elementFromPoint(x, y)), part = el ? describe(el) : page(), r = part.rect;
    tell({ state: "pin", vw: innerWidth, vh: innerHeight, point: { x: x, y: y }, part: part, fx: r.w > 0 ? (x - r.x) / r.w : 0, fy: r.h > 0 ? (y - r.y) / r.h : 0 });
  }

  doc.addEventListener("pointermove", function (event) {
    // The demo's own pointer moves are not the person's.
    if (!event.isTrusted) return;
    point = { x: event.clientX, y: event.clientY };
    soon();
  }, true);
  doc.documentElement.addEventListener("pointerleave", function (event) { if (event.isTrusted && point) { point = null; soon(); } });
  /* A click is a pin, exactly where it landed, held by the smallest piece under it. */
  doc.addEventListener("click", function (event) {
    if (!noting || !event.isTrusted || event.button !== 0 || control(event.target)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    pinAt(event.clientX, event.clientY);
  }, true);
  // Off the controls, a press is the start of a pin, not of a selection.
  doc.addEventListener("mousedown", function (event) { if (noting && event.isTrusted && event.button === 0 && !control(event.target)) event.preventDefault(); }, true);
  /* Step 6: a picture dropped on the mockup is a pin there that carries it,
     for the chat to put in the page. Only pictures, and one at a time. */
  function picture(event) {
    var files = event.dataTransfer && event.dataTransfer.files;
    for (var i = 0; files && i < files.length; i++) if (/^image\//.test(files[i].type)) return files[i];
    return null;
  }
  function carries(event) { var types = event.dataTransfer && event.dataTransfer.types; return !!types && Array.prototype.indexOf.call(types, "Files") >= 0; }
  doc.addEventListener("dragover", function (event) {
    if (!noting || !carries(event)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    event.dataTransfer.dropEffect = "copy";
  }, true);
  doc.addEventListener("drop", function (event) {
    if (!noting || !carries(event)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    var file = picture(event), x = event.clientX, y = event.clientY;
    if (!file) { tell({ state: "drop", refused: "Only a picture can go on a mockup" }); return; }
    if (file.size > 25 * 1024 * 1024) { tell({ state: "drop", refused: (file.name || "That picture") + " is over 25 MB" }); return; }
    var reader = new FileReader();
    reader.onload = function () {
      var el = partOf(doc.elementFromPoint(x, y)), part = el ? describe(el) : page(), r = part.rect;
      tell({ state: "drop", vw: innerWidth, vh: innerHeight, point: { x: x, y: y }, part: part, fx: r.w > 0 ? (x - r.x) / r.w : 0, fy: r.h > 0 ? (y - r.y) / r.h : 0,
        name: String(file.name || "picture").slice(0, 120), type: file.type, data: String(reader.result) });
    };
    reader.onerror = function () { tell({ state: "drop", refused: (file.name || "That picture") + " couldn't be read" }); };
    reader.readAsDataURL(file);
  }, true);
  addEventListener("scroll", soon, true);
  addEventListener("resize", soon);
  // The page moves under a part (a tab switches, a list grows): keep the pins on it.
  setInterval(function () { if (watched.length) send(false); }, 400);
  addEventListener("message", function (event) {
    var data = event.data;
    if (!data || data.demesne !== "note" || event.source !== parent) return;
    // The pointer is on the Foundry page's own drawing over this frame: it is on no part here.
    if (data.action === "away") { if (point) { point = null; soon(); } return; }
    // The + beside a control was clicked: a pin where the pointer rested.
    if (data.action === "pin-at" && typeof data.x === "number" && typeof data.y === "number") { pinAt(data.x, data.y); return; }
    if (data.action === "watch" && Array.isArray(data.pins)) {
      noting = true;
      watched = data.pins.filter(function (pin) { return pin && typeof pin.selector === "string" && typeof pin.n === "number"; }).slice(0, 40);
      send(true);
    }
  });
  tell({ state: "ready" });
})();
