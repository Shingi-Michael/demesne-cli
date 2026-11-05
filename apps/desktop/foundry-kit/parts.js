/* Foundry parts: ready pieces a page builds a mockup from, served as
   foundry://kit/parts.js (after base.css). Each part is a custom element that
   draws itself in the page's own DOM, so the page's CSS still reaches it and
   the look can measure it. A page writes the idea; the parts are the frame
   around it: a Mac window, a browser, a phone, Demesne's own shell and
   pieces, icons, avatars, charts, stats, and options side by side.
   The catalogue the model reads (foundry_read id "kit:parts") is PARTS_GUIDE
   in apps/daemon/src/foundry.ts; keep the two in step. Frame chrome (bars,
   the Demesne sidebar and tabs, option heads) carries data-chrome, so the
   design measure judges the page's own content, not the frame. Content parts
   size text and space from the kit's scales. */
(function () {
  if (window.customElements.get("d-icon")) return;
  var doc = document;

  var CSS = `
:where(d-window,d-browser,d-phone,d-demesne,d-message,d-composer,d-card,d-row,d-toggle,d-seg,d-tabs,d-icon,d-avatar,d-chart,d-stat,d-compare,d-mark,d-sidebar){box-sizing:border-box}
d-icon{display:inline-flex;width:var(--size,16px);height:var(--size,16px);flex:none;vertical-align:-.15em}
d-icon svg{width:100%;height:100%;fill:none;stroke:currentColor;stroke-width:1.75;stroke-linecap:round;stroke-linejoin:round}
d-avatar{display:inline-grid;place-items:center;flex:none;width:var(--size,28px);height:var(--size,28px);border-radius:50%;font-size:calc(var(--size,28px)*.4);font-weight:600;color:#fff;letter-spacing:0}
d-mark{display:inline-grid;place-items:center;width:20px;height:20px;border-radius:50%;background:#f2b6c8;color:#141416;font-size:12px;font-weight:600;flex:none}
.dp-frame{display:flex;flex-direction:column;border-radius:12px;overflow:hidden;box-shadow:0 0 0 1px rgba(0,0,0,.12),0 24px 60px -24px rgba(0,0,0,.45);background:var(--paper);min-width:0}
.dp-bar{display:flex;align-items:center;gap:8px;height:38px;padding:0 14px;flex:none;background:var(--tone-2);border-bottom:1px solid var(--hair);font-size:12px;color:var(--muted)}
.dp-lights{display:flex;gap:7px;flex:none}.dp-lights i{width:12px;height:12px;border-radius:50%;background:#ff5f57}.dp-lights i+i{background:#febc2e}.dp-lights i+i+i{background:#28c840}
.dp-bar .dp-title{flex:1;text-align:center;font-weight:500;color:var(--secondary);margin-right:56px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dp-url{flex:1;max-width:520px;margin:0 auto;height:26px;border-radius:8px;background:var(--paper);box-shadow:inset 0 0 0 1px var(--hair);display:flex;align-items:center;gap:6px;padding:0 10px;color:var(--muted);font-size:12px;white-space:nowrap;overflow:hidden}
.dp-body{position:relative;flex:1;min-height:0;overflow:hidden}
d-window,d-browser{display:block}
d-phone{display:inline-block}
.dp-phone{width:min(390px,100%);aspect-ratio:390/844;border-radius:48px;padding:12px;background:#111;box-shadow:0 0 0 1px rgba(255,255,255,.08),0 30px 70px -30px rgba(0,0,0,.6)}
.dp-screen{position:relative;height:100%;border-radius:37px;overflow:hidden;background:var(--paper);display:flex;flex-direction:column}
.dp-status{display:flex;justify-content:space-between;align-items:center;height:44px;padding:0 26px;flex:none;font-size:14px;font-weight:600;color:var(--ink)}
.dp-status b{width:110px;height:30px;border-radius:20px;background:#111}
.dp-screen>.dp-body{overflow:auto}
d-compare{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr));gap:24px;align-items:start}
d-compare>*{min-width:0;display:flex;flex-direction:column;gap:12px}
.dp-opt{display:flex;align-items:baseline;gap:8px;font-weight:600;font-size:14px}
.dp-opt em{font-style:normal;font-size:12px;font-weight:500;color:var(--accent)}
.dp-opt span{font-weight:400;color:var(--muted);font-size:12px}
d-stat{display:flex;flex-direction:column;gap:4px;min-width:0}
d-stat .dp-l{font-size:12px;color:var(--muted)}d-stat .dp-v{font-size:32px;line-height:40px;font-weight:600;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
d-stat .dp-d{font-size:12px;font-weight:500}d-stat .dp-d.up{color:var(--ok)}d-stat .dp-d.down{color:var(--bad)}
d-chart{display:block;width:100%;color:var(--accent)}d-chart svg{display:block;width:100%;height:auto;overflow:visible}
d-chart text{fill:var(--muted);font:11px var(--font)}
/* Demesne's own look */
d-demesne{display:block;--dm-side:linear-gradient(180deg,#5b5c60,#4f5054);--dm-shell:#161617;--dm-main:#1c1c1e;--dm-raised:#262628;--dm-bubble:#2c2c2f;--dm-t1:rgba(235,236,239,.94);--dm-t2:rgba(235,236,239,.68);--dm-t3:rgba(235,236,239,.46);--dm-hair:rgba(235,236,239,.09);--dm-pink:#f2b6c8;--dm-blue:#7eaef0;color:var(--dm-t1);font:14px/1.45 var(--font)}
d-demesne[theme=light]{--dm-side:linear-gradient(180deg,#e9e9eb,#dfdfe2);--dm-shell:#ececee;--dm-main:#ffffff;--dm-raised:#f4f4f5;--dm-bubble:#efeff1;--dm-t1:rgba(22,24,28,.94);--dm-t2:rgba(22,24,28,.68);--dm-t3:rgba(22,24,28,.46);--dm-hair:rgba(22,24,28,.09);--dm-pink:#c2477a;--dm-blue:#2f6fdb}
.dm-app{position:relative;display:flex;max-width:none;min-height:var(--height,620px);border-radius:12px;overflow:hidden;background:var(--dm-shell);box-shadow:0 0 0 1px rgba(255,255,255,.08),0 24px 60px -30px rgba(0,0,0,.7)}
d-sidebar{display:flex;flex-direction:column;width:var(--side-width,240px);flex:none;background:var(--dm-side);color:rgba(255,255,255,.88);padding:44px 10px 0}
d-demesne[theme=light] d-sidebar{color:var(--dm-t1)}
.dm-lights{position:absolute;left:18px;top:16px}
.dm-nav{display:flex;align-items:center;gap:11px;height:32px;padding:0 10px;border-radius:8px;font-size:14px;white-space:nowrap}
.dm-nav.on{background:rgba(255,255,255,.12)}
.dm-nav d-icon{opacity:.8}
.dm-proj{display:flex;align-items:center;gap:8px;height:30px;padding:0 10px;margin-top:10px;font-weight:600;font-size:14px}
.dm-proj small{margin-left:auto;font-weight:400;font-size:12px;opacity:.55}
.dm-chat{display:flex;align-items:center;gap:8px;height:30px;margin-left:12px;padding:0 10px;border-radius:8px;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;opacity:.86}
.dm-chat.on{background:rgba(255,255,255,.12);opacity:1;box-shadow:inset 2px 0 0 var(--dm-blue)}
.dm-foot{margin-top:auto;display:flex;flex-direction:column;gap:6px;padding:10px 10px 12px}
.dm-release{font-size:12px;color:var(--dm-pink)}
.dm-user{display:flex;align-items:center;gap:9px;font-size:14px}
.dm-right{flex:1;min-width:0;display:flex;flex-direction:column}
.dm-tabs{display:flex;align-items:flex-end;gap:2px;height:44px;padding:0 12px;flex:none}
.dm-tab{height:36px;max-width:220px;display:flex;align-items:center;gap:8px;padding:0 14px;border-radius:10px 10px 0 0;font-size:14px;font-weight:500;color:var(--dm-t2);white-space:nowrap;overflow:hidden}
.dm-tab.on{background:var(--dm-main);color:var(--dm-t1)}
.dm-card{flex:1;display:flex;margin:0 8px 8px;border-radius:12px;background:var(--dm-main);overflow:hidden}
.dm-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:16px;padding:24px 32px 16px}
.dm-cards{width:270px;flex:none;display:flex;flex-direction:column;gap:12px;padding:16px 16px 16px 0}
d-message{display:flex;gap:12px;max-width:100%}
d-message[from=you]{align-self:flex-end;max-width:78%;padding:8px 12px;border-radius:12px;background:var(--dm-bubble,var(--tone-2))}
.dm-d{flex:none;width:20px;font-weight:700;font-size:14px;line-height:20px;color:var(--dm-t1,var(--ink))}.dm-d i{font-style:normal;color:var(--dm-pink,#f2b6c8)}
.dm-said{min-width:0;display:flex;flex-direction:column;gap:8px;color:var(--dm-t1,var(--ink))}
.dm-meta{font-size:12px;color:var(--dm-t3,var(--muted))}
d-composer{display:flex;flex-direction:column;gap:8px;margin-top:auto}
.dm-box{display:flex;align-items:center;min-height:48px;padding:0 16px;border-radius:12px;background:var(--dm-raised,var(--tone));box-shadow:inset 0 0 0 1px var(--dm-hair,var(--hair));color:var(--dm-t3,var(--muted))}
.dm-under{display:flex;align-items:center;gap:12px;padding:0 4px;font-size:12px;color:var(--dm-t3,var(--muted))}.dm-under span:last-child{margin-left:auto}
d-card{display:flex;flex-direction:column;gap:8px;padding:12px;border-radius:12px;background:var(--dm-raised,var(--tone));box-shadow:inset 0 0 0 1px var(--dm-hair,var(--hair));font-size:12px;color:var(--dm-t2,var(--secondary))}
d-card>.dm-ch{display:flex;align-items:center;gap:8px;font-size:14px;font-weight:600;color:var(--dm-t1,var(--ink))}
d-row{display:flex;align-items:center;gap:16px;min-height:52px;padding:8px 16px;border-bottom:1px solid var(--dm-hair,var(--hair))}
d-row:last-child{border-bottom:0}
.dm-rt{flex:1;min-width:0}.dm-rt b{display:block;font-weight:500;color:var(--dm-t1,var(--ink))}.dm-rt small{display:block;font-size:12px;color:var(--dm-t3,var(--muted))}
d-toggle{display:inline-block;position:relative;width:36px;height:20px;border-radius:99px;background:var(--dm-hair,var(--tone-2));box-shadow:inset 0 0 0 1px var(--dm-hair,var(--hair));flex:none;cursor:pointer}
d-toggle::after{content:"";position:absolute;left:3px;top:3px;width:14px;height:14px;border-radius:50%;background:#fff;transition:left .18s}
d-toggle[on]{background:var(--dm-blue,var(--accent))}d-toggle[on]::after{left:19px}
d-seg,d-tabs{display:inline-flex;padding:2px;border-radius:9px;background:var(--dm-hair,var(--tone-2));gap:2px;flex:none}
d-seg button,d-tabs button{all:unset;cursor:pointer;padding:3px 11px;border-radius:7px;font-size:14px;color:var(--dm-t2,var(--secondary))}
d-seg button.on,d-tabs button.on{background:var(--dm-raised,var(--paper));color:var(--dm-t1,var(--ink));box-shadow:0 1px 2px rgba(0,0,0,.12)}
`;
  var style = doc.createElement("style");
  style.setAttribute("data-demesne-parts", "");
  style.textContent = CSS;
  (doc.head || doc.documentElement).prepend(style);

  // Icons: 24px grid, 1.75 stroke, drawn for the kit.
  var ICONS = {
    plus: "M12 5v14M5 12h14", x: "M6 6l12 12M18 6 6 18", check: "m5 12 5 5 9-10", "chevron-right": "m9 6 6 6-6 6", "chevron-left": "m15 6-6 6 6 6", "chevron-down": "m6 9 6 6 6-6",
    "arrow-right": "M5 12h14M13 6l6 6-6 6", "arrow-up": "M12 19V5M6 11l6-6 6 6", search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14ZM20 20l-4-4", menu: "M4 7h16M4 12h16M4 17h16",
    home: "M4 11 12 4l8 7M6 10v10h12V10", settings: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9 7 7M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1",
    sliders: "M4 7h10M18 7h2M4 17h4M12 17h8M14 4v6M8 14v6", user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM4 21a8 8 0 0 1 16 0", users: "M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM2 21a7 7 0 0 1 14 0M16 3.5a4 4 0 0 1 0 7M22 21a7 7 0 0 0-4-6.3",
    bell: "M6 16V11a6 6 0 0 1 12 0v5l2 2H4zM10 21h4", mail: "M3 6h18v12H3zM3 7l9 6 9-6", chat: "M5 5h14v10H9l-4 4z", calendar: "M4 6h16v14H4zM4 10h16M8 3v4M16 3v4", clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 7v5l3 2",
    star: "m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z", heart: "M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z", bolt: "M13 3 5 14h6l-1 7 8-11h-6z",
    folder: "M3 6h6l2 2h10v11H3z", file: "M7 3h7l5 5v13H7zM14 3v5h5", code: "m8 8-4 4 4 4M16 8l4 4-4 4", terminal: "M4 5h16v14H4zM8 10l3 2-3 2M13 15h4", "git-branch": "M6 3v12M6 15a3 3 0 1 0 0 6 3 3 0 0 0 0-6ZM18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM18 9a9 9 0 0 1-9 9",
    image: "M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4M15 9h.01", camera: "M4 8h4l2-3h4l2 3h4v11H4zM12 17a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z", play: "M7 5v14l12-7z", pause: "M8 5v14M16 5v14",
    trash: "M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3", edit: "M4 20h4L19 9l-4-4L4 16zM14 6l4 4", copy: "M9 9h11v11H9zM5 15V4h11", download: "M12 4v11M7 10l5 5 5-5M5 20h14", upload: "M12 20V9M7 14l5-5 5 5M5 4h14",
    link: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1", lock: "M6 11h12v9H6zM8 11V8a4 4 0 0 1 8 0v3", eye: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12ZM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z",
    sun: "M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4", moon: "M20 14A8 8 0 1 1 10 4a6 6 0 0 0 10 10Z",
    cart: "M3 4h2l2.5 11h11L21 8H6.5M9 20h.01M18 20h.01", tag: "M3 12V4h8l9 9-8 8zM8 8h.01", chart: "M4 20V10M10 20V4M16 20v-7M22 20H2", "trending-up": "m3 17 6-6 4 4 8-8M15 7h6v6",
    pin: "M12 21s-7-6-7-11a7 7 0 0 1 14 0c0 5-7 11-7 11ZM12 12a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z", globe: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18",
    sparkles: "M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2 2M16 16l2 2M6 18l2-2M16 8l2-2", drive: "M12 3a9 9 0 1 0 9 9M12 7v5l3 3M17 3h4v4", foundry: "M4 15h16l-2 5H6zM8 15V9h8v6M10 9V5h4v4",
    archive: "M3 5h18v4H3zM5 9v10h14V9M10 13h4", filter: "M4 5h16l-6 8v6l-4-2v-4z", more: "M5 12h.01M12 12h.01M19 12h.01", info: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 11v5M12 8h.01",
    alert: "M12 3 2 20h20zM12 10v4M12 17h.01", "check-circle": "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM8 12l3 3 5-6", send: "M4 12 20 4l-6 16-3-7z", mic: "M9 4a3 3 0 0 1 6 0v7a3 3 0 0 1-6 0zM5 11a7 7 0 0 0 14 0M12 18v3",
    sidebar: "M4 5h16v14H4zM9 5v14", phone: "M7 3h10v18H7zM11 18h2", laptop: "M5 5h14v10H5zM3 19h18", coffee: "M5 8h11v6a5 5 0 0 1-10 0zM16 10h2a2 2 0 0 1 0 4h-2M8 3v2M11 3v2", leaf: "M5 19C5 9 11 5 20 4c0 9-4 15-14 15M5 19l8-8",
  };
  var icon = function (name) { var d = ICONS[name] || ICONS.sparkles; return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="' + d + '"/></svg>'; };

  var hue = function (text) { var h = 0; for (var i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) % 360; return h; };
  var initials = function (name) { return name.trim().split(/\s+/).slice(0, 2).map(function (word) { return word[0] || ""; }).join("").toUpperCase(); };
  var esc = function (value) { return String(value == null ? "" : value).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
  var list = function (value) { return value ? String(value).split("|").map(function (item) { return item.trim(); }).filter(Boolean) : []; };
  var size = function (el, fallback) { var value = el.getAttribute("size"); if (value) el.style.setProperty("--size", /^\d+$/.test(value) ? value + "px" : value); else if (fallback) el.style.setProperty("--size", fallback); };
  /// Move what the author wrote inside into a new container.
  var adopt = function (el, into) { while (el.firstChild) into.appendChild(el.firstChild); };
  /// A desktop frame keeps its layout at any width: narrower than its design
  /// width, it scales down whole, like a picture of the app.
  var fitWidth = function (el, inner, width) {
    inner.style.width = width + "px";
    var fit = function () { var room = el.clientWidth, zoom = room && room < width ? String(Math.floor(room / width * 1000) / 1000) : ""; if (inner.style.zoom !== zoom) inner.style.zoom = zoom; };
    if (window.ResizeObserver) new ResizeObserver(function () { requestAnimationFrame(fit); }).observe(el);
    fit();
  };
  var once = function (el) { if (el.__drawn) return false; el.__drawn = true; return true; };

  // A part draws once its children are parsed: while the page is still
  // loading, it waits for DOMContentLoaded (the script may sit in <head>).
  var waiting = [];
  if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", function () { var queue = waiting; waiting = null; queue.forEach(function (job) { job(); }); });
  else waiting = null;
  function define(name, draw) {
    customElements.define(name, class extends HTMLElement {
      connectedCallback() { var el = this, job = function () { if (el.isConnected && once(el)) draw(el); }; if (waiting) waiting.push(job); else job(); }
    });
  }

  define("d-icon", function (el) { size(el); el.innerHTML = icon(el.getAttribute("name")); });
  define("d-avatar", function (el) {
    size(el); var name = el.getAttribute("name") || el.textContent || "?";
    el.textContent = initials(name); el.setAttribute("aria-label", name); el.title = name;
    el.style.background = "hsl(" + hue(name) + " 45% 34%)";
  });
  define("d-mark", function () {});

  define("d-window", function (el) {
    var body = doc.createElement("div"); body.className = "dp-body"; adopt(el, body);
    var frame = doc.createElement("div"); frame.className = "dp-frame";
    if (el.getAttribute("height")) body.style.height = el.getAttribute("height") + (/^\d+$/.test(el.getAttribute("height")) ? "px" : "");
    frame.innerHTML = '<div class="dp-bar" data-chrome><span class="dp-lights"><i></i><i></i><i></i></span><span class="dp-title">' + esc(el.getAttribute("title") || "") + "</span></div>";
    frame.appendChild(body); el.appendChild(frame); el.removeAttribute("title");
    if (Number(el.getAttribute("width"))) fitWidth(el, frame, Number(el.getAttribute("width")));
  });
  define("d-browser", function (el) {
    var body = doc.createElement("div"); body.className = "dp-body"; adopt(el, body);
    var frame = doc.createElement("div"); frame.className = "dp-frame";
    if (el.getAttribute("height")) body.style.height = el.getAttribute("height") + (/^\d+$/.test(el.getAttribute("height")) ? "px" : "");
    frame.innerHTML = '<div class="dp-bar" data-chrome><span class="dp-lights"><i></i><i></i><i></i></span><span class="dp-url">' + icon("lock") + esc(el.getAttribute("url") || "example.com") + "</span></div>";
    frame.querySelector(".dp-url svg").setAttribute("style", "width:12px;height:12px;fill:none;stroke:currentColor;stroke-width:2");
    frame.appendChild(body); el.appendChild(frame);
    if (Number(el.getAttribute("width"))) fitWidth(el, frame, Number(el.getAttribute("width")));
  });
  define("d-phone", function (el) {
    var body = doc.createElement("div"); body.className = "dp-body"; adopt(el, body);
    var phone = doc.createElement("div"); phone.className = "dp-phone";
    phone.innerHTML = '<div class="dp-screen"><div class="dp-status" data-chrome><span>' + esc(el.getAttribute("time") || "9:41") + "</span><b></b><span>●●●</span></div></div>";
    phone.firstChild.appendChild(body); el.appendChild(phone);
  });

  define("d-compare", function (el) {
    var rec = el.getAttribute("recommended");
    Array.prototype.forEach.call(el.children, function (option) {
      var name = option.getAttribute("data-option") || option.getAttribute("title");
      if (!name) return;
      var head = doc.createElement("div"); head.className = "dp-opt";
      head.setAttribute("data-chrome", "");
      head.innerHTML = esc(name) + (rec && name.indexOf(rec) === 0 ? "<em>recommended</em>" : "") + (option.getAttribute("note") ? "<span>" + esc(option.getAttribute("note")) + "</span>" : "");
      option.prepend(head); option.removeAttribute("title");
    });
  });

  define("d-stat", function (el) {
    var delta = el.getAttribute("delta") || "";
    el.innerHTML = '<span class="dp-l">' + esc(el.getAttribute("label")) + '</span><span class="dp-v">' + esc(el.getAttribute("value")) + "</span>"
      + (delta ? '<span class="dp-d ' + (/^-|−/.test(delta) ? "down" : "up") + '">' + esc(delta) + "</span>" : "");
  });

  define("d-chart", function (el) {
    var values = (el.getAttribute("values") || "").split(",").map(Number).filter(function (n) { return !isNaN(n); });
    var labels = (el.getAttribute("labels") || "").split(",").map(function (s) { return s.trim(); });
    var type = el.getAttribute("type") || "line", W = Math.max(240, Math.round(el.clientWidth) || 600), H = Number(el.getAttribute("height")) || 220, pad = 24;
    if (!values.length) return;
    var max = Math.max.apply(null, values.concat([0])), min = type === "line" || type === "area" ? Math.min.apply(null, values) : 0;
    if (type === "donut") {
      var total = values.reduce(function (a, b) { return a + b; }, 0) || 1, r = 70, c = 2 * Math.PI * r, at = 0, out = "";
      values.forEach(function (v, i) {
        var len = c * v / total;
        out += '<circle cx="100" cy="100" r="' + r + '" fill="none" stroke="currentColor" stroke-opacity="' + (1 - i * (0.7 / values.length)) + '" stroke-width="26" stroke-dasharray="' + len + " " + (c - len) + '" stroke-dashoffset="' + (-at) + '" transform="rotate(-90 100 100)"/>';
        at += len;
      });
      var legend = labels.map(function (label, i) { return '<text x="220" y="' + (60 + i * 22) + '"><tspan fill="currentColor" fill-opacity="' + (1 - i * (0.7 / values.length)) + '">●</tspan> ' + esc(label) + " · " + values[i] + "</text>"; }).join("");
      el.innerHTML = '<svg viewBox="0 0 420 200" role="img" style="max-width:420px">' + out + legend + "</svg>";
      return;
    }
    var span = max - min || 1, x = function (i) { return pad + i * (W - pad * 2) / Math.max(1, values.length - (type === "bar" ? 0 : 1)); }, y = function (v) { return H - pad - (v - min) / span * (H - pad * 2); };
    var grid = [0, 0.5, 1].map(function (f) { var gy = pad + f * (H - pad * 2); return '<line x1="' + pad + '" x2="' + (W - pad) + '" y1="' + gy + '" y2="' + gy + '" stroke="currentColor" stroke-opacity=".12"/>'; }).join("");
    var marks = "";
    if (type === "bar") {
      var bw = (W - pad * 2) / values.length * 0.62;
      values.forEach(function (v, i) { var bx = x(i) + ((W - pad * 2) / values.length - bw) / 2; marks += '<rect x="' + bx + '" y="' + y(v) + '" width="' + bw + '" height="' + (H - pad - y(v)) + '" rx="4" fill="currentColor"/>'; });
    } else {
      var pts = values.map(function (v, i) { return x(i) + "," + y(v); }).join(" ");
      if (type === "area") marks += '<polygon points="' + x(0) + "," + (H - pad) + " " + pts + " " + x(values.length - 1) + "," + (H - pad) + '" fill="currentColor" fill-opacity=".14"/>';
      marks += '<polyline points="' + pts + '" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>';
      marks += '<circle cx="' + x(values.length - 1) + '" cy="' + y(values[values.length - 1]) + '" r="4" fill="currentColor"/>';
    }
    var ticks = labels.length ? labels.map(function (label, i) { var lx = type === "bar" ? x(i) + (W - pad * 2) / values.length / 2 : x(i); return '<text x="' + lx + '" y="' + (H - 4) + '" text-anchor="middle">' + esc(label) + "</text>"; }).join("") : "";
    el.innerHTML = '<svg viewBox="0 0 ' + W + " " + H + '" role="img">' + grid + marks + ticks + "</svg>";
  });

  // Demesne's own pieces.
  define("d-message", function (el) {
    var said = doc.createElement("div"); said.className = "dm-said"; adopt(el, said);
    if (el.getAttribute("from") !== "you") {
      var mark = doc.createElement("span"); mark.className = "dm-d"; mark.innerHTML = "d<i>.</i>"; el.appendChild(mark);
      if (el.getAttribute("meta")) said.insertAdjacentHTML("beforeend", '<span class="dm-meta">' + esc(el.getAttribute("meta")) + "</span>");
    }
    el.appendChild(said);
  });
  define("d-composer", function (el) {
    el.innerHTML = '<div class="dm-box">' + esc(el.getAttribute("placeholder") || "Ask anything") + '</div><div class="dm-under"><span>＋</span><span>' + esc(el.getAttribute("mode") || "Ask") + "</span><span>" + esc(el.getAttribute("model") || "GPT-6.1") + "</span></div>";
  });
  define("d-card", function (el) {
    var title = el.getAttribute("title");
    if (title) { var head = doc.createElement("div"); head.className = "dm-ch"; head.innerHTML = (el.getAttribute("icon") ? icon(el.getAttribute("icon")).replace("<svg", '<svg style="width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:1.75"') : "") + esc(title); el.prepend(head); el.removeAttribute("title"); }
  });
  define("d-row", function (el) {
    var text = doc.createElement("div"); text.className = "dm-rt";
    text.innerHTML = "<b>" + esc(el.getAttribute("title")) + "</b>" + (el.getAttribute("note") ? "<small>" + esc(el.getAttribute("note")) + "</small>" : "");
    el.prepend(text); el.removeAttribute("title");
  });
  define("d-toggle", function (el) {
    el.setAttribute("role", "switch"); el.setAttribute("aria-checked", el.hasAttribute("on"));
    el.addEventListener("click", function () { el.toggleAttribute("on"); el.setAttribute("aria-checked", el.hasAttribute("on")); });
  });
  var segmented = function (el) {
    var items = list(el.getAttribute("options") || el.getAttribute("items")), value = el.getAttribute("value") || items[0];
    el.innerHTML = items.map(function (item) { return '<button type="button" class="' + (item === value ? "on" : "") + '">' + esc(item) + "</button>"; }).join("");
    el.addEventListener("click", function (event) { var button = event.target.closest("button"); if (!button) return; el.querySelectorAll("button").forEach(function (b) { b.classList.toggle("on", b === button); }); el.setAttribute("value", button.textContent); el.dispatchEvent(new Event("change", { bubbles: true })); });
  };
  define("d-seg", segmented);
  define("d-tabs", segmented);
  define("d-sidebar", function (el) {
    var on = el.getAttribute("page") || "", chats = list(el.getAttribute("chats") || "Tidy the sidebar|Drive picks that land"), current = el.getAttribute("chat") || chats[0];
    var nav = [["plus", "New chat"], ["sparkles", "Assistant"], ["search", "Search"], ["clock", "Scheduled"], ["foundry", "Foundry"], ["sliders", "Customize"]];
    var extra = doc.createElement("div"); adopt(el, extra);
    el.innerHTML = nav.map(function (n) { return '<div class="dm-nav' + (n[1].toLowerCase() === on.toLowerCase() ? " on" : "") + '"><d-icon name="' + n[0] + '"></d-icon>' + n[1] + "</div>"; }).join("")
      + '<div class="dm-proj"><d-icon name="folder"></d-icon>' + esc(el.getAttribute("project") || "demesne-cli") + "<small>main</small></div>"
      + chats.map(function (chat) { return '<div class="dm-chat' + (chat === current && !on ? " on" : "") + '">' + esc(chat) + "</div>"; }).join("")
      + '<div class="dm-foot"><span class="dm-release">Demesne · Cherry Blossom</span><span class="dm-user"><d-avatar name="' + esc(el.getAttribute("user") || "Mike") + '" size="24"></d-avatar>' + esc(el.getAttribute("user") || "Mike") + "</span></div>";
    if (extra.childNodes.length) el.querySelector(".dm-foot").before(extra);
  });
  define("d-demesne", function (el) {
    var cards = Array.prototype.filter.call(el.children, function (child) { return child.getAttribute("slot") === "cards"; });
    var main = doc.createElement("div"); main.className = "dm-main"; adopt(el, main);
    if (el.getAttribute("height")) el.style.setProperty("--height", /^\d+$/.test(el.getAttribute("height")) ? el.getAttribute("height") + "px" : el.getAttribute("height"));
    var tabs = list(el.getAttribute("tabs") || el.getAttribute("tab") || "New chat");
    var app = doc.createElement("div"); app.className = "dm-app";
    app.innerHTML = '<span class="dp-lights dm-lights" data-chrome><i></i><i></i><i></i></span><d-sidebar data-chrome page="' + esc(el.getAttribute("page") || "") + '" chats="' + esc(el.getAttribute("chats") || "") + '" chat="' + esc(el.getAttribute("chat") || "") + '" project="' + esc(el.getAttribute("project") || "demesne-cli") + '"></d-sidebar>'
      + '<div class="dm-right"><div class="dm-tabs" data-chrome>' + tabs.map(function (tab, i) { return '<span class="dm-tab' + (i === 0 ? " on" : "") + '">' + esc(tab) + "</span>"; }).join("") + '</div><div class="dm-card"></div></div>';
    var card = app.querySelector(".dm-card"); card.appendChild(main);
    if (cards.length) { var column = doc.createElement("div"); column.className = "dm-cards"; cards.forEach(function (c) { c.removeAttribute("slot"); column.appendChild(c); }); card.appendChild(column); }
    el.appendChild(app);
    fitWidth(el, app, Number(el.getAttribute("width")) || 1100);
  });

  // Believable sample data, the same on every run.
  var PEOPLE = ["Amara Okafor", "Lucas Brandt", "Mei Tanaka", "Sofia Marín", "Tomás Silva", "Priya Raman", "Jonah Weiss", "Leila Haddad", "Oskar Lind", "Nia Mensah", "Hugo Laurent", "Yuki Mori"];
  var seeded = function (seed) { var s = seed || 7; return function () { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; }; };
  window.demesne = window.demesne || {};
  window.demesne.sample = {
    people: function (n) { return PEOPLE.slice(0, n || PEOPLE.length); },
    series: function (n, start, drift, seed) { var r = seeded(seed), v = start == null ? 100 : start, out = []; for (var i = 0; i < (n || 12); i++) { v = Math.max(0, v + (r() - 0.45) * (drift == null ? 10 : drift)); out.push(Math.round(v * 10) / 10); } return out; },
    icons: Object.keys(ICONS),
  };
})();
