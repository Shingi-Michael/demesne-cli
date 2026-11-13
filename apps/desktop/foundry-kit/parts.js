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
d-app>d-body{display:block}
d-demesne>d-app{display:block;position:relative;max-width:none;height:var(--height,620px);min-height:0;margin:0;overflow:hidden;border-radius:12px;container:app/size;contain:layout paint style;box-shadow:0 0 0 1px rgba(128,128,128,.22),0 24px 60px -20px rgba(0,0,0,.45);text-align:left}
/* The app's window is glass over the desktop; here a still backdrop stands in for what is behind it. */
d-demesne>d-app.glass{background:linear-gradient(180deg,#5b5c60,#4f5054)}
d-demesne[theme=light]>d-app.glass{background:linear-gradient(180deg,#e9e9eb,#dfdfe2)}
d-app #mac-lights-hole .dp-lights{position:absolute;left:14px;top:14px}
/* What the author adds inside the window has no kit under it (the kit stops at d-app): plain controls take Demesne's own tokens. */
d-app .dm-main :where(button:not([class]),button.quiet,button.small,button.primary,button.danger):not(article.turn *){display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 11px;border-radius:var(--r-sm);background:var(--tone2);color:var(--t1);font-size:13px;font-weight:500;white-space:nowrap}
d-app .dm-main :where(button.primary):not(article.turn *){background:var(--acc);color:var(--on-dusk)}
d-app .dm-main :where(button.danger):not(article.turn *){color:var(--bad)}
d-app .dm-main :where(input:not([type=checkbox]):not([type=radio]):not([type=range]),select,textarea):not(article.turn *){min-height:30px;padding:0 10px;border:0;border-radius:var(--r-sm);background:var(--tone);box-shadow:inset 0 0 0 1px var(--hair);color:var(--t1);font:inherit}
d-app .dm-main :where(h1,h2,h3):not(article.turn *){margin:0;color:var(--t1);font-weight:600;letter-spacing:0}
d-app .dm-main :where(h1):not(article.turn *){font-size:20px;line-height:28px}d-app .dm-main :where(h2):not(article.turn *){font-size:16px;line-height:24px}d-app .dm-main :where(h3):not(article.turn *){font-size:14px;line-height:22px}
d-app .dm-main>:where(button,input,select){align-self:flex-start}
d-app .dm-main :where(.muted,small):not(article.turn *){color:var(--t3)}d-app .dm-main :where(.secondary):not(article.turn *){color:var(--t2)}
d-demesne{display:block;overflow-x:auto;--dm-side:linear-gradient(180deg,#5b5c60,#4f5054);--dm-shell:#161617;--dm-main:#1c1c1e;--dm-raised:#262628;--dm-bubble:#2c2c2f;--dm-t1:rgba(235,236,239,.94);--dm-t2:rgba(235,236,239,.68);--dm-t3:rgba(235,236,239,.46);--dm-hair:rgba(235,236,239,.09);--dm-pink:#f2b6c8;--dm-blue:#7eaef0;color:var(--dm-t1);font:14px/1.45 var(--font)}
d-demesne[theme=light]{--dm-side:linear-gradient(180deg,#e9e9eb,#dfdfe2);--dm-shell:#ececee;--dm-main:#ffffff;--dm-raised:#f4f4f5;--dm-bubble:#efeff1;--dm-t1:rgba(22,24,28,.94);--dm-t2:rgba(22,24,28,.68);--dm-t3:rgba(22,24,28,.46);--dm-hair:rgba(22,24,28,.09);--dm-pink:#c2477a;--dm-blue:#2f6fdb}
.dm-main{display:flex;flex-direction:column;gap:16px;min-width:0}
.dm-main>[data-view],d-message{animation:dp-in .22s ease-out}
.dm-main>[data-view]{display:flex;flex-direction:column;gap:16px;min-width:0}
/* The kit's own elements inside Demesne's chat take its colours. */
@keyframes dp-in{from{opacity:0;transform:translateY(3px)}}
@media (prefers-reduced-motion:reduce){.dm-main>[data-view],d-message{animation:none}}
d-message{display:flex;gap:12px;max-width:100%}
d-message[from=you]{align-self:flex-end;max-width:78%;padding:8px 12px;border-radius:12px;background:var(--dm-bubble,var(--tone-2))}
.dm-d{flex:none;width:20px;font-weight:700;font-size:14px;line-height:20px;color:var(--dm-t1,var(--ink))}.dm-d i{font-style:normal;color:var(--dm-pink,#f2b6c8)}
.dm-said{min-width:0;display:flex;flex-direction:column;gap:8px;color:var(--dm-t1,var(--ink))}
.dm-said>button{align-self:flex-start}
.dm-meta{font-size:12px;color:var(--dm-t3,var(--muted))}
d-composer{display:flex;flex-direction:column;gap:8px;margin-top:auto}
.dm-box{display:flex;align-items:center;gap:8px;min-height:48px;padding:0 8px 0 16px;border-radius:12px;background:var(--dm-raised,var(--tone));box-shadow:inset 0 0 0 1px var(--dm-hair,var(--hair));color:var(--dm-t3,var(--muted))}
d-composer .dm-box>input{all:unset;flex:1;min-width:0;height:46px;color:var(--dm-t1,var(--ink));font-size:14px}
d-composer .dm-box>input::placeholder{color:var(--dm-t3,var(--muted))}
d-composer .dm-box>button{all:unset;box-sizing:border-box;display:grid;place-items:center;width:30px;height:30px;border-radius:50%;flex:none;cursor:pointer;background:var(--dm-blue,var(--accent));color:#121417;opacity:.35;transition:opacity .14s}
d-composer .dm-box>button.on{opacity:1}
d-composer .dm-box>button svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round}
.dm-under{display:flex;align-items:center;gap:12px;padding:0 4px;font-size:12px;color:var(--dm-t3,var(--muted))}.dm-under span:last-child{margin-left:auto}
d-card{display:flex;flex-direction:column;gap:8px;padding:12px;border-radius:12px;background:var(--dm-raised,var(--tone));box-shadow:inset 0 0 0 1px var(--dm-hair,var(--hair));font-size:12px;color:var(--dm-t2,var(--secondary))}
d-card>.dm-ch{display:flex;align-items:center;gap:8px;font-size:14px;font-weight:600;color:var(--dm-t1,var(--ink))}
d-row{display:flex;align-items:center;gap:16px;min-height:52px;padding:8px 16px;border-bottom:1px solid var(--dm-hair,var(--hair))}
d-row:last-child{border-bottom:0}
.dm-rt{flex:1;min-width:0}.dm-rt b{display:block;font-weight:500;color:var(--dm-t1,var(--ink))}.dm-rt small{display:block;font-size:12px;color:var(--dm-t2,var(--muted))}
d-toggle{display:inline-block;position:relative;width:36px;height:20px;border-radius:99px;background:var(--dm-hair,var(--tone-2));box-shadow:inset 0 0 0 1px var(--dm-hair,var(--hair));flex:none;cursor:pointer}
d-toggle::after{content:"";position:absolute;left:3px;top:3px;width:14px;height:14px;border-radius:50%;background:#fff;transition:left .18s}
d-toggle[on]{background:var(--dm-blue,var(--accent))}d-toggle[on]::after{left:19px}
[data-view][hidden]{display:none!important}
/* Options to choose between: a strip on top, one option at a time, at full size. */
d-compare.dp-switch{display:flex;flex-direction:column;align-items:stretch;gap:16px}
d-compare.dp-stack{display:flex;flex-direction:column;align-items:stretch;gap:40px}
d-compare.dp-stack>.dp-rec{outline:2px solid #f2b6c8;outline-offset:10px;border-radius:12px}
d-compare.dp-switch>[hidden]{display:none}
d-compare.dp-one{display:block}d-compare.dp-one>[hidden]{display:none}
.dp-strip{position:sticky;top:0;z-index:20;display:flex;flex-direction:row;align-items:center;gap:4px;padding:6px;border-radius:12px;background:color-mix(in srgb,var(--paper) 90%,transparent);-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);box-shadow:inset 0 0 0 1px var(--hair);flex-wrap:wrap}
.dp-strip>button{padding:4px 12px;border-radius:99px;background:transparent;color:var(--secondary);font-size:14px}
.dp-strip>button.on{background:var(--tone-2);color:var(--ink)}
.dp-strip>button em{font-style:normal;font-size:12px;color:var(--accent);margin-left:6px}
.dp-strip>.dp-note{padding:0 8px;font-size:12px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;flex:1}
d-seg,d-tabs{display:inline-flex;padding:2px;border-radius:9px;background:var(--dm-hair,var(--tone-2));gap:2px;flex:none}
d-seg button,d-tabs button{all:unset;cursor:pointer;padding:3px 11px;border-radius:7px;font-size:14px;color:var(--dm-t2,var(--secondary))}
d-seg button.on,d-tabs button.on{background:var(--dm-raised,var(--paper));color:var(--dm-t1,var(--ink));box-shadow:0 1px 2px rgba(0,0,0,.12)}
`;
  var KIT = doc.currentScript && /parts\.js(\?.*)?$/.test(doc.currentScript.src || "") ? doc.currentScript.src.replace(/parts\.js(\?.*)?$/, "") : "foundry://kit/";
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
  /// A desktop frame keeps its layout when a little narrower than its design
  /// width, scaled down to 85% at most. Narrower than that it lays out at the
  /// room it has (dp-narrow; Demesne's sidebar folds away under 520px, dp-tight):
  /// shrinking a whole app to fit a pane made 14px text 7px, too small to read
  /// or use.
  var MIN_ZOOM = 0.85;
  var fitWidth = function (el, inner, width, least) {
    var fit = function () {
      var room = el.clientWidth, ratio = room && room < width ? room / width : 1, narrow = ratio < MIN_ZOOM;
      // `least`: a window has a smallest size; in less room than that it keeps it and scrolls sideways.
      var zoom = ratio < 1 && !narrow ? String(Math.floor(ratio * 1000) / 1000) : "", wide = narrow ? (least && room < least ? least + "px" : "100%") : width + "px";
      if (inner.style.zoom !== zoom) inner.style.zoom = zoom;
      if (inner.style.width !== wide) inner.style.width = wide;
      el.classList.toggle("dp-narrow", narrow);
      el.classList.toggle("dp-tight", narrow && room < 520);
    };
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

  /// Views: elements marked data-view="Settings" are places in a mockup.
  /// Showing one hides its sibling views; anything with data-go="Settings",
  /// and Demesne's tabs, sidebar items and chats of the same name, go there.
  var same = function (a, b) { return String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase(); };
  var go = function (scope, name) {
    var views = Array.prototype.filter.call(scope.querySelectorAll("[data-view]"), function (view) { return same(view.getAttribute("data-view"), name); });
    views.forEach(function (view) {
      view.parentElement.__went = true;
      Array.prototype.forEach.call(view.parentElement.children, function (sibling) { if (sibling.hasAttribute("data-view")) sibling.hidden = sibling !== view; });
    });
    return views.length > 0;
  };
  /// The first view of each group shows until something goes elsewhere.
  var firstViews = function (scope) {
    Array.prototype.forEach.call(scope.querySelectorAll("[data-view]"), function (view) {
      if (view.parentElement.__went) return;
      var first = Array.prototype.find.call(view.parentElement.children, function (sibling) { return sibling.hasAttribute("data-view"); });
      view.hidden = view !== first;
    });
  };
  doc.addEventListener("click", function (event) {
    var link = event.target.closest && event.target.closest("[data-go]");
    if (!link) return;
    var name = link.getAttribute("data-go"), shell = link.closest("d-demesne");
    if (shell && shell.__select) shell.__select(name);
    else go(doc, name);
  });
  if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", function () { firstViews(doc); }); else setTimeout(function () { firstViews(doc); });

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

  /// On Foundry's long page (?stack=1) each option gets a stage of its own
  /// (pass 221 A): the page shows one option (?option=N, else the
  /// recommended one) with nothing drawn on it, and tells the Foundry page
  /// the names, which it writes on the line above each stage.
  var STACK = /[?&]stack=1(&|$)/.test(location.search);
  var ONE = /[?&]option=(\d+)(&|$)/.exec(location.search);
  define("d-compare", function (el) {
    var rec = el.getAttribute("recommended");
    if (STACK && el.getAttribute("layout") !== "side") { stage(el, rec); return; }
    if (STACK) {
      el.classList.add("dp-stack");
      var first = rec && Array.prototype.find.call(el.children, function (option) { return (option.getAttribute("data-option") || option.getAttribute("title") || "").indexOf(rec) === 0; });
      if (first) { first.classList.add("dp-rec"); el.prepend(first); }
    } else if (el.getAttribute("layout") !== "side") { switcher(el, rec); return; }
    Array.prototype.forEach.call(el.children, function (option) {
      var name = option.getAttribute("data-option") || option.getAttribute("title");
      if (!name) return;
      var head = doc.createElement("div"); head.className = "dp-opt";
      head.setAttribute("data-chrome", "");
      head.innerHTML = esc(name) + (rec && name.indexOf(rec) === 0 ? "<em>recommended</em>" : "") + (option.getAttribute("note") ? "<span>" + esc(option.getAttribute("note")) + "</span>" : "");
      option.prepend(head); option.removeAttribute("title");
    });
  });

  function stage(el, rec) {
    var options = Array.prototype.filter.call(el.children, function (option) { return option.getAttribute("data-option") || option.getAttribute("title"); });
    if (!options.length) return;
    var names = options.map(function (option) { var name = option.getAttribute("data-option") || option.getAttribute("title"); option.setAttribute("data-option", name); option.removeAttribute("title"); return name; });
    var best = rec ? names.findIndex(function (name) { return name.indexOf(rec) === 0; }) : -1;
    var shown = ONE ? Math.min(Number(ONE[1]), options.length - 1) : best < 0 ? 0 : best;
    el.classList.add("dp-one");
    options.forEach(function (option, i) { option.hidden = i !== shown; });
    if (!ONE) try { parent.postMessage({ demesne: "options", shown: shown, rec: best, options: names.map(function (name, i) { return { name: name, note: options[i].getAttribute("note") || "" }; }) }, "*"); } catch (error) {}
  }

  /// Options as a strip on top: one at a time at full size. You choose in the
  /// chat, never on the page.
  function switcher(el, rec) {
    var options = Array.prototype.filter.call(el.children, function (option) { return option.getAttribute("data-option") || option.getAttribute("title"); });
    if (!options.length) return;
    el.classList.add("dp-switch");
    var names = options.map(function (option) { var name = option.getAttribute("data-option") || option.getAttribute("title"); option.setAttribute("data-option", name); option.removeAttribute("title"); return name; });
    var strip = doc.createElement("div"); strip.className = "dp-strip"; strip.setAttribute("data-chrome", ""); strip.setAttribute("role", "tablist");
    strip.innerHTML = names.map(function (name, i) { return '<button type="button" role="tab" data-i="' + i + '">' + esc(name) + (rec && name.indexOf(rec) === 0 ? "<em>recommended</em>" : "") + "</button>"; }).join("")
      + '<span class="dp-note"></span>';
    var tabs = strip.querySelectorAll("[data-i]"), note = strip.querySelector(".dp-note");
    var show = function (i) {
      options.forEach(function (option, k) { option.hidden = k !== i; });
      Array.prototype.forEach.call(tabs, function (tab, k) { tab.classList.toggle("on", k === i); tab.setAttribute("aria-selected", k === i); });
      note.textContent = options[i].getAttribute("note") || "";
      // A part that sized itself while hidden measures again.
      window.dispatchEvent(new Event("resize"));
    };
    strip.addEventListener("click", function (event) {
      var tab = event.target.closest("[data-i]");
      if (tab) show(Number(tab.getAttribute("data-i")));
    });
    el.prepend(strip);
    var start = rec ? names.findIndex(function (name) { return name.indexOf(rec) === 0; }) : 0;
    show(start < 0 ? 0 : start);
  }

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
  // Demesne itself (pass 220 A): the app's own markup, styled by the app's
  // own stylesheet (kit/app.css, the shipped styles scoped to <d-app>), so a
  // mockup starts out identical to the app and the change is the only
  // difference. SHELL is the window as the app draws it for one chat;
  // scripts/check-foundry-app.ts fails when the two drift apart.
  var appStyle = function () {
    if (doc.querySelector("[data-demesne-app]")) return;
    var link = doc.createElement("link"); link.rel = "stylesheet"; link.href = KIT + "app.css"; link.setAttribute("data-demesne-app", "");
    (doc.head || doc.documentElement).appendChild(link);
  };
  // The theme's colours, as the app sets them on its window (Cherry Blossom).
  var APP_THEME = {
    dark: ["demesne", '--shell-a:0.715;--panel-a:0.724;--back-a:0;--ink:#0B1218;--paper:#C5D2DC;--strong:#E6EEF4;--surface:#0E161D;--raised:#182530;--rule:#1E2C38;--borderBright:#2F4150;--secondary:#8FA1AF;--muted:#6B7D8B;--electric:#5AA9E6;--electricBright:#5AA9E6;--signal:#E5534B;--citron:#4CC38A;--thinking:#E5A93C;--thinkingSurface:#282821;--errorSurface:#281D23;--accentSurface:#172835;--menuSelection:#172835;--tileSelection:#213749;--diffAddedSurface:#0F2219;--diffRemovedSurface:#26161A;--userSurface:#0E161D;--inspect:#5AA9E6;--execute:#E5A93C;--toolSurface:#0E161D;--toolActive:#182530;--syntaxKeyword:#C49CE6;--syntaxString:#9CCF8D;--syntaxNumber:#E5A93C;--syntaxComment:#5F7280;--syntaxType:#6FC2D6;--syntaxFunction:#5AA9E6;--contextMessages:#5AA9E6;--contextTools:#C49CE6;--contextReserved:#E5A93C;--contextFree:#6B7D8B;--composerQueuedBorder:#6F582B;--composerStoppedBorder:#8F3B39;--composerRestoredBorder:#2C516D;'],
    light: ["demesne-light", '--shell-a:0.715;--panel-a:0.724;--back-a:0;--ink:#F6F8FA;--paper:#1F2A33;--strong:#1F2A33;--surface:#EEF2F5;--raised:#E2E8ED;--rule:#CBD5DD;--borderBright:#A7B6C2;--secondary:#4B5D6B;--muted:#55687A;--electric:#1F62A8;--electricBright:#1A5591;--signal:#B3302A;--citron:#166A3F;--thinking:#8A5700;--thinkingSurface:#E2DFD8;--errorSurface:#E8DFE1;--accentSurface:#D5E1EC;--menuSelection:#D5E1EC;--tileSelection:#C7D5E3;--diffAddedSurface:#D4E2DF;--diffRemovedSurface:#E8DFE1;--userSurface:#EEF2F5;--inspect:#1F62A8;--execute:#8A5700;--toolSurface:#EEF2F5;--toolActive:#E2E8ED;--syntaxKeyword:#7A3E9D;--syntaxString:#2F6F1F;--syntaxNumber:#8A5600;--syntaxComment:#5E7684;--syntaxType:#0B6A74;--syntaxFunction:#1F5FAD;--contextMessages:#1F62A8;--contextTools:#7A3E9D;--contextReserved:#8A5700;--contextFree:#55687A;--composerQueuedBorder:#c1ac87;--composerStoppedBorder:#cb7e7b;--composerRestoredBorder:#9bb8d6;'],
  };
  // The d. mark and the app's other shared drawings (index.html).
  var DEFS = '<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs><mask id="demesne-heart"><rect x="-40" y="-40" width="80" height="80" fill="#fff"/><circle r="5" fill="#000"/></mask><symbol id="demesne-mark" viewBox="0 0 100 100"><circle cx="43" cy="59" r="15" fill="none" stroke="currentColor" stroke-width="9"/><path d="M58 24V74" stroke="currentColor" stroke-width="9" stroke-linecap="round"/><g transform="translate(80 66) scale(.31)" fill="#e0457a" mask="url(#demesne-heart)"><path d="M0 -3C-11 -9 -17 -24 -9 -35L0 -29.5L9 -35C17 -24 11 -9 0 -3Z" transform="rotate(0)"/><path d="M0 -3C-11 -9 -17 -24 -9 -35L0 -29.5L9 -35C17 -24 11 -9 0 -3Z" transform="rotate(72)"/><path d="M0 -3C-11 -9 -17 -24 -9 -35L0 -29.5L9 -35C17 -24 11 -9 0 -3Z" transform="rotate(144)"/><path d="M0 -3C-11 -9 -17 -24 -9 -35L0 -29.5L9 -35C17 -24 11 -9 0 -3Z" transform="rotate(216)"/><path d="M0 -3C-11 -9 -17 -24 -9 -35L0 -29.5L9 -35C17 -24 11 -9 0 -3Z" transform="rotate(288)"/></g></symbol></defs></svg>';
  var SHELL = '<div id="desktop-shell" aria-busy="false"><aside id="desktop-sidebar" aria-label="Workspace navigation"><nav class="sidebar-nav" aria-label="Workspace"><button type="button" class="sidebar-new" aria-label="New chat"><svg viewBox="0 0 24 24" class="ico" aria-hidden="true"><path d="M5 12h14"></path><path d="M12 5v14"></path></svg>New chat<kbd class="sidebar-key" id="sidebar-new-key">Ctrl N</kbd></button><label class="sidebar-search"><svg viewBox="0 0 24 24" class="ico" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><path d="m20 20-3.5-3.5"></path></svg><input id="sidebar-search" type="search" placeholder="Search" aria-label="Search chats and projects" autocomplete="off" style=""><kbd class="sidebar-key" id="sidebar-search-key">Ctrl K</kbd></label><button type="button" aria-label="Scheduled"><svg viewBox="0 0 24 24" class="ico" aria-hidden="true"><circle cx="12" cy="12" r="8.5"></circle><path d="M12 7.5V12l3 2"></path></svg>Scheduled<small class="sidebar-say" id="sidebar-say-scheduled"></small></button><button type="button" aria-label="Foundry"><svg viewBox="0 0 24 24" class="ico" aria-hidden="true"><path d="M4 15h16l-2 5H6z"></path><path d="M8 15V9h8v6"></path><path d="M10 9V5h4v4"></path></svg>Foundry<small class="sidebar-say" id="sidebar-say-foundry"></small></button></nav><nav id="sidebar-projects" aria-label="Chats and projects"><button type="button" id="sidebar-assistant" aria-label="Assistant" class="sidebar-assistant" hidden=""><svg viewBox="0 0 24 24" class="ico" aria-hidden="true"><circle cx="12" cy="12" r="3.2"></circle><path d="M12 3.5v2M12 18.5v2M3.5 12h2M18.5 12h2"></path></svg>Assistant<span class="sidebar-session-mark " aria-hidden="true" hidden=""></span></button><div id="sidebar-pinned" role="navigation" aria-label="Pinned" hidden=""></div><div class="sidebar-label" id="sidebar-projects-label"><span>Projects</span><button type="button" id="sidebar-open-project" class="sidebar-label-button" aria-label="Open a project"><svg viewBox="0 0 24 24" class="ico" aria-hidden="true"><path d="M12 6v12"></path><path d="M6 12h12"></path></svg></button></div><div id="sidebar-sessions" role="navigation" aria-label="Conversations"><section class="sidebar-project active" style="--face:#5fb0c8"><div class="sidebar-project-header"><button aria-expanded="true" aria-current="location" type="button" class="sidebar-project-name"><span class="project-face" style="--face:#5fb0c8" aria-hidden="true"><b>w</b></span><span>workspace</span></button><span class="sidebar-project-state sidebar-project-branch"><svg class="ico sidebar-branch" viewBox="0 0 24 24" aria-hidden="true"><line x1="6" x2="6" y1="3" y2="15"></line><circle cx="18" cy="6" r="3"></circle><circle cx="6" cy="18" r="3"></circle><path d="M18 9a9 9 0 0 1-9 9"></path></svg><span>master</span></span><button aria-label="New chat in workspace" type="button" class="sidebar-project-new"><svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 6v12"></path><path d="M6 12h12"></path></svg></button><button aria-label="Group and sort" aria-expanded="false" type="button" class="sidebar-view-button"><svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4v16"></path><path d="m3 8 4-4 4 4"></path><path d="M17 20V4"></path><path d="m13 16 4 4 4-4"></path></svg></button></div><div class="sidebar-project-chats" id="project-chats-0"><div class="sidebar-item"><button aria-label="Chat" aria-current="page" type="button" class="sidebar-session selected"><span class="sidebar-session-mark " aria-hidden="true"></span><span class="sidebar-session-name">Chat</span><span class="sidebar-session-age">now</span></button><span class="sidebar-row-actions"><button aria-label="Bring Chat back later" aria-expanded="false" tabindex="-1" type="button" class="sidebar-bell"><svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 16v-5a6 6 0 1 1 12 0v5l1.5 2h-15z"></path><path d="M10 20.5a2 2 0 0 0 4 0"></path></svg></button><button aria-label="Pin Chat" tabindex="-1" type="button" class="sidebar-pin"><svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4h6l-1 6 4 4H6l4-4z"></path><path d="M12 14v6"></path></svg></button><button aria-label="Archive Chat" tabindex="-1" type="button" class="sidebar-delete"><svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="5" rx="1.5"></rect><path d="M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9"></path><path d="M10 13h4"></path></svg></button></span></div></div></section></div><div id="sidebar-chats" role="navigation" aria-label="Just a chat" hidden=""></div></nav><nav id="settings-nav" aria-label="Settings" hidden=""></nav><div id="sidebar-order-status" role="status" class="sidebar-order-status"></div><div id="sidebar-housed" role="navigation" aria-label="Agents" hidden=""></div><div class="sidebar-release">Demesne · Cherry Blossom</div><div class="sidebar-foot"><span class="sidebar-avatar" id="sidebar-avatar" aria-hidden="true"></span><span class="sidebar-you" id="sidebar-you"></span><small class="sidebar-plan" id="sidebar-plan"></small><button type="button" class="sidebar-foot-button" aria-label="Customize"><svg viewBox="0 0 24 24" class="ico" aria-hidden="true"><path d="M4 7h10M18 7h2M4 17h4M12 17h8"></path><circle cx="16" cy="7" r="2"></circle><circle cx="10" cy="17" r="2"></circle></svg></button><button type="button" id="sidebar-theme" class="sidebar-foot-button" aria-label="Light theme"><svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"></circle><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"></path></svg></button><button type="button" class="sidebar-settings sidebar-foot-button" aria-label="Settings"><svg viewBox="0 0 24 24" class="ico" aria-hidden="true"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"></path></svg></button></div><div class="sidebar-rail" aria-label="Folded sidebar"><button type="button" class="rail-button" data-tip="New chat" aria-label="New chat"><svg viewBox="0 0 24 24" class="ico" aria-hidden="true"><path d="M5 12h14"></path><path d="M12 5v14"></path></svg></button><button type="button" class="rail-button" id="rail-search" data-tip="Search chats" aria-label="Search chats"><svg viewBox="0 0 24 24" class="ico" aria-hidden="true"><circle cx="11" cy="11" r="6"></circle><path d="m20 20-4.5-4.5"></path></svg></button><button data-tip="Foundry" type="button" class="rail-button" aria-label="Foundry"><svg viewBox="0 0 24 24" class="ico" aria-hidden="true"><path d="M4 15h16l-2 5H6z"></path><path d="M8 15V9h8v6"></path><path d="M10 9V5h4v4"></path></svg></button><button data-tip="0 branches to review" type="button" class="rail-button" id="rail-review" aria-label="Branches to review" hidden=""><svg viewBox="0 0 24 24" class="ico" aria-hidden="true"><line x1="6" x2="6" y1="3" y2="15"></line><circle cx="18" cy="6" r="3"></circle><circle cx="6" cy="18" r="3"></circle><path d="M18 9a9 9 0 0 1-9 9"></path></svg><i class="rail-badge blue"></i></button><div class="rail-chats" id="rail-chats" aria-label="Open chats"><button type="button" class="rail-chat on" data-tip="Chat" aria-label="Chat" aria-current="page">M</button></div><div class="rail-foot"><button data-tip="Settings" type="button" class="rail-button" aria-label="Settings"><svg viewBox="0 0 24 24" class="ico" aria-hidden="true"><line x1="21" x2="14" y1="4" y2="4"></line><line x1="10" x2="3" y1="4" y2="4"></line><line x1="21" x2="12" y1="12" y2="12"></line><line x1="8" x2="3" y1="12" y2="12"></line><line x1="21" x2="16" y1="20" y2="20"></line><line x1="12" x2="3" y1="20" y2="20"></line><line x1="14" x2="14" y1="2" y2="6"></line><line x1="8" x2="8" y1="10" y2="14"></line><line x1="16" x2="16" y1="18" y2="22"></line></svg></button></div></div></aside><div id="desktop-toolbar"><button id="desktop-toggle-sidebar" type="button" aria-label="Toggle sidebar" aria-expanded="true"><svg viewBox="0 0 24 24" class="ico" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3"></rect><path d="M9 4v16"></path></svg></button><div id="workspace-pins" role="tablist" aria-label="Pinned chats"></div><div id="workspace-tabs" role="tablist" aria-label="Open chats"><div class="bar-tab on"><button type="button" role="tab"  tabindex="0" aria-selected="true" aria-label="Chat"><span class="sidebar-session-mark " aria-hidden="true"></span><span class="bar-tab-words"><span class="bar-tab-name" id="workspace-title">Chat</span><span class="bar-tab-sub" aria-hidden="true">workspace</span></span></button><button aria-label="Close Chat" tabindex="-1" type="button" class="bar-tab-close">×</button></div></div><button id="workspace-more" type="button" class="bar-more" hidden=""></button><button id="workspace-new-tab" type="button" class="bar-tab-new" aria-label="Open a new chat">+</button><span id="workspace-call"></span><div id="thread-tabs" hidden=""></div><div id="bar-drive"><button id="drive-pill" type="button" aria-haspopup="dialog" aria-expanded="false"><span class="bf-dot idea" aria-hidden="true"></span><span class="dp-word">Drive</span><span class="dp-about"></span></button></div><header id="header"><button aria-label="This conversation" type="button" class="header-more">⋯</button></header></div><div class="app live-app cards-on" id="app"><div class="status" id="status" hidden=""><span></span><div class="spacer"></div><div class="context"><div class="meter"><i style="--usage:8%"></i></div><span></span></div></div><div class="workspace" id="workspace" role="tabpanel"><main id="main"><div id="banner" hidden=""></div><div class="stage" id="stage"><div id="page" class="page" hidden=""></div><div id="conversation"><article class="turn" ><div class="turn-content"><div class="request"><span class="text">Chat</span><span class="request-meta"><span class="ask-actions"><button type="button" class="">edit</button><button type="button" class="">retry</button><button type="button" class="">rewind</button></span><time>01:35</time></span></div><div class="response "><div class="answer"><span class="answer-mark" aria-hidden="true"><svg viewBox="0 0 100 100"><use href="#demesne-mark"></use></svg></span><div class="markdown"></div></div><div class="turn-receipt"><span></span><span><button aria-expanded="false" type="button" class="receipt-files">1 file changed <span class="counts"><span class="plus">+1</span><span class="minus">−1</span></span><svg class="ico chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"></path></svg></button></span><span><span class="receipt-checks success">checks passed</span></span><span><button type="button" class="receipt-steps">2 steps</button></span><span class="receipt-actions"><button type="button" class="receipt-action copy-answer"><svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"></rect><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"></path></svg>Copy</button><button type="button" class="receipt-action"><svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 14 4 9l5-5"></path><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11"></path></svg>Undo changes</button></span></div></div></div><div class="live-activity working-line" role="status" hidden=""><span class="wl-mark"></span><span class="wl-line"><span class="wl-words"></span><span class="wl-glint" aria-hidden="true"><span class="wl-words wl-copy"></span></span></span></div><div class="fd-chips" hidden=""></div></article></div><div id="question"></div><div id="branch-done" hidden=""></div><div id="plain-line" hidden=""></div></div><div id="timeline" aria-hidden="true" hidden=""><i class="tl-line"><i class="tl-view"></i></i><div class="tl-marks"></div><span class="tl-label" hidden=""></span></div><nav id="foundry-rail" aria-label="Mockups" hidden=""><div class="fr-in"></div></nav><div id="drop-zone" hidden="">Drop files to attach</div><div id="input-area"><div id="threads-foot" hidden=""></div><div id="approval" hidden=""></div><div id="composer-slot"><div id="completion" class="popover" hidden=""></div><div id="context-card" hidden=""></div><form class="composer" id="composer"><div class="composer-box"><div id="queue-label" hidden=""><span>Restored · not sent <span class="muted">the turn did not finish</span></span><button type="button" class="">Clear ×</button></div><div id="attach-row" hidden=""></div><textarea aria-label="Message" rows="1" spellcheck="false" placeholder="Continue the conversation…"></textarea><div id="mention-chips"></div><button type="submit" class="send" aria-label="Send"><span id="tokens">~0 tok</span><kbd>↵</kbd><span id="send-label">send</span><svg class="ico send-arrow" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 10-5 5 5 5"></path><path d="M20 4v7a4 4 0 0 1-4 4H4"></path></svg><svg class="ico send-stop" viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"></rect></svg></button></div><div class="composer-bar"><input type="file" id="attach-input" multiple="" hidden="" style=""><button type="button" class="cb cb-plus" aria-label="Attach files"><svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14"></path><path d="M12 5v14"></path></svg></button><button type="button" id="composer-talk" class="cb cb-talk" aria-label="Talk" hidden=""><svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"></rect><path d="M5 11a7 7 0 0 0 14 0"></path><path d="M12 18v3"></path></svg></button><button type="button" id="composer-mode" class="cb mode-auto" aria-label="Mode: Auto"><span class="mode-list"><span class="mode-opt mode-ask" data-mode="ask">Ask</span><span class="mode-opt mode-edits" data-mode="edits">Accept edits</span><span class="mode-opt mode-plan" data-mode="plan">Plan</span><span class="mode-opt mode-auto on" data-mode="auto">Auto</span><span class="mode-opt mode-orchestrate" data-mode="orchestrate">Orchestrate</span></span><kbd>Alt+M</kbd></button><button type="button" id="composer-where" class="cb" aria-expanded="false" hidden="">in workspace<span class="where-caret" aria-hidden="true">⌄</span></button><div class="hints"><button type="button"><kbd>/</kbd> commands</button><button type="button" id="hint-mention"><kbd>@</kbd> files</button></div><span class="sp"></span><button type="button" id="composer-model" class="cb">Qwen3.8 27B</button><button type="button" id="composer-context" class="cb" aria-label="Context used" aria-expanded="false"><span class="cw-context">8%</span></button></div><div id="where-row" class="where-row" role="group" aria-label="Where this chat lives" hidden=""></div></form></div></div><div id="overlay" class="popover modal" hidden="" role="dialog" aria-label="Dialog"></div></main><aside id="thread-pane" class="thread-pane" aria-label="Thread" hidden=""></aside><aside id="cards" aria-label="This chat"><section class="card env" data-card="where"><button type="button" class="card-head" aria-expanded="false"><span class="env-row"><svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="2"></rect><path d="M8 20h8M12 16v4"></path></svg><span class="env-v">This computer</span><span class="env-r"><i class="env-dot on"></i></span></span><span class="env-row"><svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="6" r="2.5"></circle><circle cx="6" cy="18" r="2.5"></circle><circle cx="18" cy="8" r="2.5"></circle><path d="M6 8.5v7M18 10.5a7 7 0 0 1-7 7H8.5"></path></svg><span class="env-v">master</span><span class="env-r">1 uncommitted</span></span><span class="env-row"><svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"></path><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5"></path></svg><span class="env-v">Qwen3.8 27B</span><span class="env-r">262k</span></span></button><div class="card-body"><div class="env-more"></div></div></section></aside></div></div></div><div id="notice" role="status" hidden=""></div>';
  var BLOCK = /^(P|UL|OL|DIV|PRE|TABLE|H[1-6]|BLOCKQUOTE|HR|SECTION|FIGURE|D-[A-Z]+)$/;
  var mark = function (item, on, cls) { item.classList.toggle(cls, on); if (on) item.setAttribute("aria-current", "page"); else item.removeAttribute("aria-current"); };
  /// A message inside Demesne is a turn, as the app draws one.
  var turn = function (shell, el) {
    var article = shell.__turn.cloneNode(true), you = el.getAttribute("from") === "you";
    if (you) {
      article.querySelector(".response").remove();
      var text = article.querySelector(".request .text"); text.textContent = ""; adopt(el, text);
      article.querySelector("time").textContent = el.getAttribute("time") || "";
      article.setAttribute("data-asked", "");
    } else {
      var before = el.previousElementSibling;
      if (before && before.matches("article.turn[data-asked]") && !el.hasAttribute("data-view")) { before.removeAttribute("data-asked"); article = before; article.querySelector(".turn-content").appendChild(shell.__turn.querySelector(".response").cloneNode(true)); }
      else article.querySelector(".request").remove();
      var into = article.querySelector(".markdown"), line = null;
      Array.prototype.slice.call(el.childNodes).forEach(function (node) {
        if (node.nodeType === 1 && BLOCK.test(node.nodeName)) { line = null; into.appendChild(node); return; }
        if (!line) { if (node.nodeType === 3 && !node.nodeValue.trim()) return; line = doc.createElement("p"); into.appendChild(line); }
        line.appendChild(node);
      });
      var receipt = article.querySelector(".turn-receipt"), spans = receipt.children;
      spans[0].textContent = el.getAttribute("meta") || "";
      var files = el.getAttribute("files"), checks = el.getAttribute("checks"), steps = el.getAttribute("steps");
      // With no files changed there is nothing to undo: the app offers to ask again.
      if (files) spans[1].querySelector("button").firstChild.nodeValue = files + " ";
      else { spans[1].remove(); receipt.querySelector(".receipt-actions").lastChild.outerHTML = '<button type="button" class="receipt-action ask-again"><svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7"></path><path d="M20 5v6h-6"></path></svg>Ask again</button>'; }
      var checked = receipt.querySelector(".receipt-checks"), stepped = receipt.querySelector(".receipt-steps");
      if (checks) checked.textContent = checks; else checked.parentElement.remove();
      if (steps) stepped.textContent = steps; else stepped.parentElement.remove();
      if (!el.getAttribute("meta") && !files && !checks && !steps && el.hasAttribute("bare")) receipt.remove();
    }
    // The app's own small print under a turn is the frame, not the design.
    Array.prototype.forEach.call(article.querySelectorAll(".turn-receipt, .request-meta"), function (print) { print.setAttribute("data-chrome", ""); });
    if (article.isConnected) { el.remove(); return article; }
    if (el.hasAttribute("data-view")) article.setAttribute("data-view", el.getAttribute("data-view"));
    if (el.id) article.id = el.id;
    el.replaceWith(article);
    return article;
  };
  /// A card in the right column, as the app draws one.
  var sideCard = function (el) {
    var card = doc.createElement("section"), open = el.childNodes.length > 0;
    card.className = "card" + (open ? " open" : "");
    card.innerHTML = '<button type="button" class="card-head" aria-expanded="' + open + '">' + icon(el.getAttribute("icon") || "file").replace("<svg", '<svg class="ico"') + '<span class="card-line">' + esc(el.getAttribute("title") || "") + '</span><span class="card-sum">' + esc(el.getAttribute("note") || "") + '</span></button><div class="card-body"></div>';
    adopt(el, card.querySelector(".card-body"));
    card.querySelector(".card-head").addEventListener("click", function () { var on = card.classList.toggle("open"); this.setAttribute("aria-expanded", on); });
    el.replaceWith(card);
  };
  /// The composer inside Demesne is the app's own: typing and Enter put the
  /// message in the chat, then the next reply. The <d-composer> stays, hidden,
  /// so its "send" event still reaches the page.
  var compose = function (app, host, c) {
    c.__drawn = true;
    var area = app.querySelector("#input-area"), input = area.querySelector("textarea"), model = c.getAttribute("model") || host.getAttribute("model") || "GPT-6.1";
    var replies = list(c.getAttribute("reply")), next = 0, mode = c.getAttribute("mode") || "Ask", anchor = doc.createComment("composer");
    input.placeholder = c.getAttribute("placeholder") || "Ask anything";
    area.querySelector("#composer-model").textContent = model;
    Array.prototype.forEach.call(area.querySelectorAll(".mode-opt"), function (option) {
      var on = same(option.textContent, mode); option.classList.toggle("on", on);
      if (on) { area.querySelector("#composer-mode").className = "cb mode-" + option.getAttribute("data-mode"); area.querySelector("#composer-mode").setAttribute("aria-label", "Mode: " + option.textContent); }
    });
    c.replaceWith(anchor); c.hidden = true; area.appendChild(c); area.hidden = false;
    var say = function (from, text) {
      var message = doc.createElement("d-message");
      if (from) message.setAttribute("from", from); else message.setAttribute("meta", model + " · " + (1 + text.length % 4) + "s");
      message.textContent = text; anchor.before(message);
      var last = anchor.previousElementSibling; if (last && last.scrollIntoView) last.scrollIntoView({ block: "end" });
    };
    var send = function () {
      var text = input.value.trim();
      if (!text) return;
      input.value = "";
      say("you", text);
      var event = new CustomEvent("send", { detail: { text: text }, bubbles: true, cancelable: true });
      if (!c.dispatchEvent(event)) return;
      setTimeout(function () { say("", replies.length ? replies[next++ % replies.length] : "Got it."); }, 500);
    };
    area.querySelector("form").addEventListener("submit", function (event) { event.preventDefault(); send(); });
    input.addEventListener("keydown", function (event) { if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); send(); } });
  };
  var sideRow = function (el) {
    var row = doc.createElement("div"); row.className = "card-row";
    row.innerHTML = '<span class="card-label">' + esc(el.getAttribute("title")) + '</span><span class="card-right">' + esc(el.getAttribute("note") || "") + "</span>";
    adopt(el, row.lastChild); el.replaceWith(row);
  };
  define("d-demesne", function (el) {
    appStyle();
    var theme = el.getAttribute("theme") || (window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
    if (!APP_THEME[theme]) theme = "dark";
    el.setAttribute("theme", theme);
    if (el.getAttribute("height")) el.style.setProperty("--height", /^\d+$/.test(el.getAttribute("height")) ? el.getAttribute("height") + "px" : el.getAttribute("height"));
    var kids = Array.prototype.slice.call(el.childNodes);
    var mac = el.getAttribute("os") !== "other";
    var app = doc.createElement("d-app");
    app.className = "glass" + (mac ? " mac-chrome" : "");
    app.setAttribute("data-theme", APP_THEME[theme][0]); app.setAttribute("data-appearance", theme); app.setAttribute("style", APP_THEME[theme][1]);
    app.innerHTML = '<d-body class="desktop"><div id="mac-lights-hole" data-chrome aria-hidden="true">' + (mac ? '<span class="dp-lights"><i></i><i></i><i></i></span>' : "") + "</div>" + DEFS + SHELL + '<div id="notice" role="status" hidden></div></d-body>';
    var $ = function (selector) { return app.querySelector(selector); };
    var itemT = $(".sidebar-item"), tabT = $(".bar-tab"); app.__turn = $("article.turn");
    itemT.remove(); tabT.remove(); app.__turn.remove();
    ["#desktop-sidebar", "#desktop-toolbar", "#input-area", "#cards"].forEach(function (chrome) { $(chrome).setAttribute("data-chrome", ""); });
    if (mac) { $("#sidebar-new-key").textContent = "⌘N"; $("#sidebar-search-key").textContent = "⌘K"; $("#composer-mode kbd").textContent = "⌥M"; }
    // The project, its chats, the open tabs.
    // branch="" is a folder that is not a git checkout, as the app shows one.
    var project = el.getAttribute("project") || "demesne-cli", branch = el.hasAttribute("branch") ? el.getAttribute("branch") : "main", page = el.getAttribute("page") || "";
    var chats = list(el.getAttribute("chats") || "Tidy the sidebar|Drive picks that land"), current = el.getAttribute("chat") || chats[0];
    $(".sidebar-project-name > span:last-child").textContent = project;
    $(".project-face b").textContent = project.charAt(0).toLowerCase();
    if (branch) $(".sidebar-project-branch span").textContent = branch; else $(".sidebar-project-branch").remove();
    chats.forEach(function (chat, index) {
      var item = itemT.cloneNode(true), button = item.querySelector(".sidebar-session");
      item.querySelector(".sidebar-session-name").textContent = chat; button.setAttribute("aria-label", chat);
      Array.prototype.forEach.call(item.querySelectorAll(".sidebar-row-actions button"), function (action) { action.setAttribute("aria-label", action.getAttribute("aria-label").replace("Chat", chat)); });
      item.querySelector(".sidebar-session-age").textContent = index ? index + "h" : "now";
      mark(button, same(chat, current) && !page, "selected");
      $(".sidebar-project-chats").appendChild(item);
    });
    Array.prototype.forEach.call(app.querySelectorAll(".sidebar-nav > button"), function (button) { button.classList.toggle("on", !!page && same(button.getAttribute("aria-label"), page)); });
    var tabs = list(el.getAttribute("tabs") || el.getAttribute("tab") || (page || current));
    tabs.forEach(function (name, index) {
      var tab = tabT.cloneNode(true), button = tab.querySelector("[role=tab]"), label = tab.querySelector(".bar-tab-name");
      if (index) label.removeAttribute("id"); label.textContent = name; tab.querySelector(".bar-tab-sub").textContent = project;
      button.setAttribute("aria-label", name); button.setAttribute("aria-selected", index === 0); tab.classList.toggle("on", index === 0);
      tab.querySelector(".bar-tab-close").setAttribute("aria-label", "Close " + name);
      $("#workspace-tabs").appendChild(tab);
    });
    var user = el.getAttribute("user") || "Mike";
    $("#sidebar-you").textContent = user; $("#sidebar-avatar").textContent = user.charAt(0).toUpperCase();
    $("#sidebar-plan").textContent = el.getAttribute("plan") || "";
    // Drive's pill, as it sits with nothing running; drive="3 ideas" says more, drive="none" is a project without it.
    if (el.getAttribute("drive") === "none") $("#drive-pill").hidden = true;
    else $(".dp-about").textContent = el.getAttribute("drive") ? "· " + el.getAttribute("drive") : "";
    // What the author wrote: cards go to the right column, the rest is the
    // chat (or the page, when page="…" names one).
    var main = doc.createElement("div"); main.className = "dm-main";
    var cards = $("#cards"), env = cards.querySelectorAll(".env-row .env-v"), own = false;
    kids.forEach(function (kid) {
      if (kid.nodeType === 1 && kid.getAttribute("slot") === "cards") { kid.removeAttribute("slot"); cards.appendChild(kid); own = true; }
      else main.appendChild(kid);
    });
    if (branch) env[1].textContent = branch; else env[1].innerHTML = "<em>Not a git checkout</em>";
    cards.querySelector(".env-row .env-r:not(:has(i))").textContent = "";
    env[2].textContent = el.getAttribute("model") || "GPT-6.1"; cards.querySelectorAll(".env-row .env-r")[2].textContent = "";
    if (el.getAttribute("cards") === "none" && !own) { cards.hidden = true; $("#app").classList.remove("cards-on"); }
    $("#input-area").hidden = true;
    if (page) { $("#page").hidden = false; $("#page").appendChild(main); $("#conversation").hidden = true; }
    else $("#conversation").appendChild(main);
    el.appendChild(app);
    // The author's messages, cards and composer become the app's own.
    Array.prototype.forEach.call(cards.querySelectorAll(":scope > d-card"), sideCard);
    Array.prototype.forEach.call(cards.querySelectorAll("d-row"), sideRow);
    Array.prototype.forEach.call(main.querySelectorAll("d-message"), function (message) { message.__drawn = true; turn(app, message); });
    var composer = main.querySelector("d-composer"); if (composer) compose(app, el, composer);
    fitWidth(el, app, Number(el.getAttribute("width")) || 1100, 640);
    // Going somewhere: the tab, sidebar item or chat of that name lights up,
    // and the view of that name shows. Clicking a sidebar item or chat with no
    // tab of its name renames the open tab, as Demesne does.
    el.__select = function (name, from) {
      var tabs = app.querySelectorAll(".bar-tab"), items = app.querySelectorAll(".sidebar-nav > button, .sidebar-session");
      var label = function (item) { return item.getAttribute("aria-label") || item.textContent; };
      var tab = Array.prototype.find.call(tabs, function (t) { return same(t.querySelector(".bar-tab-name").textContent, name); });
      var item = from || Array.prototype.find.call(items, function (i) { return same(label(i), name); });
      if (!tab && from && from.classList.contains("sidebar-session")) { tab = app.querySelector(".bar-tab.on") || tabs[0]; if (tab) tab.querySelector(".bar-tab-name").textContent = name; }
      if (tab) Array.prototype.forEach.call(tabs, function (t) { t.classList.toggle("on", t === tab); t.querySelector("[role=tab]").setAttribute("aria-selected", t === tab); });
      if (item) Array.prototype.forEach.call(items, function (i) { if (i.classList.contains("sidebar-session")) mark(i, i === item, "selected"); else if (!i.classList.contains("sidebar-new")) i.classList.toggle("on", i === item); });
      go(el, name);
      el.dispatchEvent(new CustomEvent("go", { detail: { name: name }, bubbles: true }));
    };
    app.addEventListener("click", function (event) {
      var tab = event.target.closest(".bar-tab [role=tab]"), item = event.target.closest(".sidebar-nav > button:not(.sidebar-new), .sidebar-session");
      if (tab && app.contains(tab)) el.__select(tab.querySelector(".bar-tab-name").textContent.trim());
      else if (item && app.contains(item)) el.__select((item.getAttribute("aria-label") || item.textContent).trim(), item);
    });
    app.addEventListener("submit", function (event) { event.preventDefault(); });
    firstViews(el);
    go(el, tabs[0]) || go(el, current) || go(el, page);
  });

  define("d-message", function (el) {
    // Inside Demesne a message is one of the app's turns (d-demesne draws
    // the ones it starts with; this is for those added later).
    if (el.closest("d-demesne")) { var shell = el.closest("d-app"); if (shell && shell.__turn) turn(shell, el); else el.__drawn = false; return; }
    var said = doc.createElement("div"); said.className = "dm-said"; adopt(el, said);
    if (el.getAttribute("from") !== "you") {
      var mark = doc.createElement("span"); mark.className = "dm-d"; mark.innerHTML = "d<i>.</i>"; el.appendChild(mark);
      if (el.getAttribute("meta")) said.insertAdjacentHTML("beforeend", '<span class="dm-meta">' + esc(el.getAttribute("meta")) + "</span>");
    }
    el.appendChild(said);
  });
  /// A composer you can type in: Enter (or the arrow) puts your message above
  /// it, then an answer from reply="first|second|…" (taken in turn). The page
  /// can answer itself: listen for "send" (event.detail.text) and call
  /// event.preventDefault() to skip the reply.
  define("d-composer", function (el) {
    if (el.closest("d-demesne")) { var inside = el.closest("d-app"); if (!inside) el.__drawn = false; else if (!el.hidden) compose(inside, el.closest("d-demesne"), el); return; }
    var placeholder = el.getAttribute("placeholder") || "Ask anything", model = el.getAttribute("model") || "GPT-6.1";
    var replies = list(el.getAttribute("reply")), turn = 0;
    el.innerHTML = '<div class="dm-box"><input type="text" aria-label="' + esc(placeholder) + '" placeholder="' + esc(placeholder) + '"><button type="button" aria-label="Send">' + icon("arrow-up") + '</button></div><div class="dm-under"><span>＋</span><span>' + esc(el.getAttribute("mode") || "Ask") + "</span><span>" + esc(model) + "</span></div>";
    var input = el.querySelector("input"), button = el.querySelector("button");
    var scroll = function () { for (var at = el.parentElement; at; at = at.parentElement) { if (at.scrollHeight > at.clientHeight + 2 && /auto|scroll/.test(getComputedStyle(at).overflowY)) { at.scrollTop = at.scrollHeight; return; } } };
    var say = function (from, text) {
      var message = doc.createElement("d-message");
      if (from) message.setAttribute("from", from); else message.setAttribute("meta", model + " · " + (1 + text.length % 4) + "s");
      message.textContent = text; el.before(message); scroll(); return message;
    };
    var send = function () {
      var text = input.value.trim();
      if (!text) return;
      input.value = ""; button.classList.remove("on");
      say("you", text);
      var event = new CustomEvent("send", { detail: { text: text }, bubbles: true, cancelable: true });
      if (!el.dispatchEvent(event)) return;
      setTimeout(function () { say("", replies.length ? replies[turn++ % replies.length] : "Got it."); }, 500);
    };
    input.addEventListener("input", function () { button.classList.toggle("on", !!input.value.trim()); });
    input.addEventListener("keydown", function (event) { if (event.key === "Enter" && !event.isComposing) { event.preventDefault(); send(); } });
    button.addEventListener("click", send);
  });
  define("d-card", function (el) {
    if (el.parentElement && el.parentElement.id === "cards" && el.closest("d-app")) { sideCard(el); return; }
    var title = el.getAttribute("title");
    if (title) { var head = doc.createElement("div"); head.className = "dm-ch"; head.innerHTML = (el.getAttribute("icon") ? icon(el.getAttribute("icon")).replace("<svg", '<svg style="width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:1.75"') : "") + esc(title); el.prepend(head); el.removeAttribute("title"); }
  });
  define("d-row", function (el) {
    if (el.closest("d-app #cards")) { sideRow(el); return; }
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
