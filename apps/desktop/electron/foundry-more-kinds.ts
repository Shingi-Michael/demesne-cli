/// More kinds (Foundry, step 2 after pass 262 C; like Claude artifacts'
/// React, Mermaid and code kinds). The model writes what it would write
/// anyway, and Demesne draws it:
///   - react: one component in JSX or TSX with `export default`, styled with
///     Tailwind classes, importing only react, react-dom, lucide-react
///     (icons) and recharts (charts). Compiled here with Sucrase, run with
///     the libraries from the kit, so it works offline.
///   - mermaid: a Mermaid diagram (flowchart, sequence, class, state, ER,
///     gantt, journey, pie, mindmap, timeline…), drawn by Mermaid in the page.
///   - code: a file of code, shown highlighted; the title's extension
///     ("orders.ts") picks the language, else it is guessed.
///   - sheet: CSV, drawn as a table you sort, type into and add up (sheetPage).
///   - board: JSON notes, arrows and groups, drawn as a whiteboard you move things on (boardPage).
/// Each page is plain HTML with foundry://kit/ scripts, so Save a copy
/// inlines them (exportedSource) and the file stands on its own.
import { BOARD_NOTE_WIDTH, FOUNDRY_REACT_IMPORTS, numberColumns, parseSheet, readBoard } from "@demesne/protocol";
import { transform } from "sucrase";
import hljs from "highlight.js/lib/common";
import lightTheme from "highlight.js/styles/github.min.css" with { type: "text" };
import darkTheme from "highlight.js/styles/github-dark.min.css" with { type: "text" };

const esc = (text: string) => text.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
const inline = (code: string) => code.replace(/<\//g, "<\\/");

/// What a React page may import, the kit file that brings it, and the global it sets.
export const REACT_MODULES: Record<typeof FOUNDRY_REACT_IMPORTS[number], { kit: string; global: string; needs?: string[] }> = {
  "react": { kit: "react.js", global: "React" },
  "react-dom": { kit: "react-dom.js", global: "ReactDOM" },
  "react-dom/client": { kit: "react-dom.js", global: "ReactDOM" },
  "lucide-react": { kit: "lucide.js", global: "LucideReact" },
  "recharts": { kit: "recharts.js", global: "Recharts", needs: ["prop-types.js"] },
};
const ALLOWED = Object.keys(REACT_MODULES).filter((name) => name !== "react-dom/client").join(", ");

export type ReactBuild = { code: string; kits: string[] } | { error: string };

/// The component compiled to a plain script, and the kit files it needs, in order.
export function buildReact(source: string): ReactBuild {
  let code: string;
  try {
    code = transform(source, { transforms: ["typescript", "jsx", "imports"], production: true, jsxRuntime: "classic" }).code;
  } catch (error) { return { error: `This component doesn't compile: ${error instanceof Error ? error.message : String(error)}` }; }
  const wanted = new Set<string>();
  for (const found of code.matchAll(/\brequire\((['"])([^'"]+)\1\)/g)) {
    const name = found[2]!;
    if (!(FOUNDRY_REACT_IMPORTS as readonly string[]).includes(name)) return { error: `"${name}" can't be imported here. Only ${ALLOWED} can.` };
    wanted.add(name);
  }
  if (!/\bexports\.\s*default\s*=/.test(code)) return { error: "The component needs an `export default`." };
  const kits = ["react.js", "react-dom.js"];
  for (const name of wanted) for (const kit of [...REACT_MODULES[name as keyof typeof REACT_MODULES].needs ?? [], REACT_MODULES[name as keyof typeof REACT_MODULES].kit]) if (!kits.includes(kit)) kits.push(kit);
  return { code, kits };
}

// crossorigin: the kit sends Access-Control-Allow-Origin, so an error inside a library is told in full, not as "Script error".
// lucide-react's build looks for React as window.react.
const scripts = (kits: string[]) => kits.map((kit) => `<script src="foundry://kit/${kit}" crossorigin="anonymous"></script>${kit === "react.js" ? "<script>window.react = React;</script>" : ""}`).join("");

/// A React component as a page: Tailwind, the libraries it imports, then it, mounted.
export function reactPage(source: string, title: string) {
  const built = buildReact(source);
  const head = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>`;
  // A page that doesn't compile says so, and throws, so the line under it (errors come back) offers to send it.
  if ("error" in built) return `${head}<style>body{margin:0;font:14px/1.5 system-ui,sans-serif;color:#555;display:grid;place-items:center;min-height:100vh}p{max-width:60ch;padding:24px}</style></head><body><p>${esc(built.error)}</p><script>throw new SyntaxError(${inline(JSON.stringify(built.error))});</script></body></html>`;
  const globals = JSON.stringify(Object.fromEntries(Object.entries(REACT_MODULES).map(([name, one]) => [name, one.global])));
  return `${head}<script src="foundry://kit/tailwind.js" crossorigin="anonymous"></script>${scripts(built.kits)}<style>html,body{margin:0}#root{min-height:100vh}</style></head><body><div id="root"></div><script>
(function () {
  var names = ${globals}, exports = {}, module = { exports: exports };
  function require(name) { return window[names[name]]; }
${inline(built.code)}
  var App = module.exports.default;
  ReactDOM.createRoot(document.getElementById("root")).render(React.createElement(App));
})();
</script></body></html>`;
}


/// A Mermaid diagram as a page: drawn on load, centred, in calm greys.
/// A diagram that doesn't parse throws, so the line under it offers to send it.
export function mermaidPage(source: string, title: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><script src="foundry://kit/mermaid.js" crossorigin="anonymous"></script><style>html,body{margin:0;min-height:100%;background:#fff}body{display:grid;place-items:center;min-height:100vh;font-family:system-ui,sans-serif}.mermaid{margin:0;padding:32px;max-width:100%;box-sizing:border-box;white-space:pre}.mermaid svg{max-width:100%;height:auto}@media (prefers-color-scheme:dark){html,body{background:#161616}}</style></head><body><pre class="mermaid">${esc(source)}</pre><script>
mermaid.initialize({ startOnLoad: false, securityLevel: "strict", suppressErrorRendering: true, theme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "neutral", fontFamily: "system-ui, sans-serif" });
mermaid.run({ querySelector: ".mermaid" }).catch(function (error) { setTimeout(function () { throw new Error("This diagram doesn't parse: " + ((error && error.message) || error)); }); });
</script></body></html>`;
}

/// The language a code artifact is in, from its title's extension, or null to guess.
export function codeLanguage(title: string): string | null {
  const extension = /\.([A-Za-z0-9+#-]{1,12})\s*$/.exec(title)?.[1]?.toLowerCase();
  return extension && hljs.getLanguage(extension) ? extension : null;
}

/// The file a code artifact saves as: its title when that has an extension, else .txt.
export function codeExtension(title: string) {
  return /\.([A-Za-z0-9+-]{1,12})\s*$/.exec(title)?.[1]?.toLowerCase() ?? "txt";
}

/// Code as a page: highlighted, with line numbers, light or dark like the app.
export function codePage(source: string, title: string) {
  const language = codeLanguage(title);
  const html = language ? hljs.highlight(source, { language, ignoreIllegals: true }).value : hljs.highlightAuto(source).value;
  // Line numbers: one span per line, with spans that cross a line closed and reopened around it.
  const lines: string[] = [];
  let open: string[] = [], line = "";
  for (const piece of html.split(/(<span[^>]*>|<\/span>|\n)/)) {
    if (piece === "\n") { lines.push(line + "</span>".repeat(open.length)); line = open.join(""); }
    else if (piece.startsWith("<span")) { open.push(piece); line += piece; }
    else if (piece === "</span>") { open.pop(); line += piece; }
    else line += piece;
  }
  lines.push(line + "</span>".repeat(open.length));
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>${lightTheme}
@media (prefers-color-scheme: dark) { ${darkTheme} }
html,body{margin:0}body{font:13px/1.6 ui-monospace,"JetBrains Mono",SFMono-Regular,Menlo,monospace}
pre.hljs{margin:0;padding:20px 24px 28px 0;min-height:100vh;box-sizing:border-box;counter-reset:line;overflow:auto}
.ln{display:block;padding-left:4.2em;position:relative;white-space:pre}
.ln::before{counter-increment:line;content:counter(line);position:absolute;left:0;width:3em;text-align:right;opacity:.38;user-select:none}</style></head><body><pre class="hljs"><code>${lines.map((one) => `<span class="ln">${one || " "}</span>`).join("")}</code></pre></body></html>`;
}

/// Step 3 of pass 273 A, a sheet: the CSV drawn as a table you sort (press a
/// column's name), type into (any cell), add rows to, and add up (a number
/// column's total sits at its foot). What you type is kept with the mockup
/// through demesne.save, until the model makes a new version: then its rows win.
export function sheetPage(source: string, title: string) {
  const sheet = parseSheet(source), numbers = numberColumns(sheet);
  const data = JSON.stringify({ head: sheet.head, rows: sheet.rows, numbers, base: sheetBase(source) }).replace(/</g, "\\u003c");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>
:root{color-scheme:light dark;--bg:#fff;--fg:#1f2125;--muted:#6b6f76;--line:#e6e7ea;--head:#f6f7f8;--hover:#f1f2f4;--focus:#3a6df0}
@media (prefers-color-scheme:dark){:root{--bg:#141518;--fg:#e8e9ec;--muted:#9a9ea6;--line:#2a2c31;--head:#1b1c20;--hover:#202227;--focus:#7aa7ff}}
html,body{margin:0;background:var(--bg);color:var(--fg);font:13.5px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif}
.wrap{padding:16px 20px 24px;overflow:auto}
table{border-collapse:separate;border-spacing:0;min-width:100%;font-variant-numeric:tabular-nums}
th,td{padding:7px 12px;border-bottom:1px solid var(--line);text-align:left;white-space:nowrap;max-width:360px;overflow:hidden;text-overflow:ellipsis}
th{position:sticky;top:0;background:var(--head);font-weight:600;font-size:12.5px;color:var(--muted);cursor:pointer;user-select:none}
th:hover{color:var(--fg)}
th .arrow{margin-left:6px;font-size:10px;opacity:.8}
th.n,td.n{text-align:right}
td[contenteditable]:hover{background:var(--hover)}
td[contenteditable]:focus{outline:2px solid var(--focus);outline-offset:-2px;background:var(--bg);white-space:normal}
tfoot td{font-weight:600;border-bottom:0;border-top:1px solid var(--line);color:var(--fg)}
tfoot td.lbl{color:var(--muted);font-weight:500}
.foot{display:flex;align-items:center;gap:14px;margin-top:10px;color:var(--muted);font-size:12.5px}
button{all:unset;cursor:pointer;color:var(--fg);padding:4px 10px;border-radius:6px;box-shadow:inset 0 0 0 1px var(--line)}
button:hover{background:var(--hover)}
button:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
</style></head><body><div class="wrap"><table><thead></thead><tbody></tbody><tfoot></tfoot></table><div class="foot"><button type="button" id="add">Add a row</button><span id="said" aria-live="polite"></span></div></div><script>
(function () {
  var S = ${data};
  var rows = S.rows.map(function (row) { return row.slice(); }), sort = null;
  var head = document.querySelector("thead"), body = document.querySelector("tbody"), foot = document.querySelector("tfoot"), said = document.getElementById("said");
  function num(text) {
    var clean = String(text).trim(), sign = 1;
    if (/^\\(.*\\)$/.test(clean)) { sign = -1; clean = clean.slice(1, -1).trim(); }
    clean = clean.replace(/^([-+]?)[$€£¥]/, "$1").replace(/%$/, "").replace(/,(?=\\d{3}(?:\\D|$))/g, "");
    if (!/^[-+]?(\\d+\\.?\\d*|\\.\\d+)(e[-+]?\\d+)?$/i.test(clean)) return null;
    var value = Number(clean) * sign; return isFinite(value) ? value : null;
  }
  function places(column) { var most = 0; rows.forEach(function (row) { var m = /\\.(\\d+)/.exec(String(row[column] || "").replace(/[^\\d.]/g, "")); if (m) most = Math.max(most, m[1].length); }); return Math.min(most, 4); }
  function money(column) { return rows.some(function (row) { return /^[-+(]?[$€£¥]/.test(String(row[column] || "").trim()); }); }
  function total(column) {
    var sum = 0, any = false;
    rows.forEach(function (row) { var value = num(row[column] || ""); if (value !== null) { sum += value; any = true; } });
    if (!any) return "";
    var mark = money(column) ? (String(rows.find(function (row) { return /[$€£¥]/.test(row[column] || ""); })[column]).match(/[$€£¥]/) || [""])[0] : "";
    return mark + sum.toLocaleString(undefined, { minimumFractionDigits: places(column), maximumFractionDigits: places(column) });
  }
  function order() {
    var list = rows.map(function (row, at) { return at; });
    if (!sort) return list;
    var column = sort.column, dir = sort.dir;
    return list.sort(function (a, b) {
      var x = rows[a][column] || "", y = rows[b][column] || "", nx = num(x), ny = num(y);
      var by = nx !== null && ny !== null ? nx - ny : String(x).localeCompare(String(y), undefined, { numeric: true, sensitivity: "base" });
      return by * dir || a - b;
    });
  }
  function draw() {
    head.innerHTML = "<tr>" + S.head.map(function (name, at) {
      var arrow = sort && sort.column === at ? '<span class="arrow" aria-hidden="true">' + (sort.dir > 0 ? "▲" : "▼") + "</span>" : "";
      return '<th scope="col" data-c="' + at + '" class="' + (S.numbers[at] ? "n" : "") + '" aria-sort="' + (sort && sort.column === at ? (sort.dir > 0 ? "ascending" : "descending") : "none") + '" tabindex="0">' + esc(name) + arrow + "</th>";
    }).join("") + "</tr>";
    body.innerHTML = order().map(function (at) {
      return '<tr data-r="' + at + '">' + S.head.map(function (_, column) { return '<td contenteditable="plaintext-only" spellcheck="false" data-c="' + column + '" class="' + (S.numbers[column] ? "n" : "") + '">' + esc(rows[at][column] || "") + "</td>"; }).join("") + "</tr>";
    }).join("");
    drawFoot();
  }
  function drawFoot() {
    if (!S.numbers.some(Boolean)) { foot.innerHTML = ""; return; }
    foot.innerHTML = "<tr>" + S.head.map(function (_, column) { return S.numbers[column] ? '<td class="n">' + esc(total(column)) + "</td>" : column === 0 ? '<td class="lbl">Total</td>' : "<td></td>"; }).join("") + "</tr>";
  }
  function esc(text) { return String(text).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  var timer = 0;
  function keep() {
    clearTimeout(timer);
    timer = setTimeout(function () {
      if (!window.demesne || !window.demesne.save) return;
      window.demesne.save("sheet", { base: S.base, rows: rows }).then(function () { said.textContent = "Saved"; setTimeout(function () { said.textContent = ""; }, 1200); }, function (error) { said.textContent = "Couldn't save: " + ((error && error.message) || error); });
    }, 400);
  }
  head.addEventListener("click", function (event) {
    var th = event.target.closest("th"); if (!th) return;
    var column = Number(th.dataset.c);
    sort = sort && sort.column === column ? (sort.dir > 0 ? { column: column, dir: -1 } : null) : { column: column, dir: 1 };
    draw();
  });
  head.addEventListener("keydown", function (event) { if ((event.key === "Enter" || event.key === " ") && event.target.closest("th")) { event.preventDefault(); event.target.click(); } });
  body.addEventListener("input", function (event) {
    var td = event.target.closest("td"); if (!td) return;
    rows[Number(td.parentNode.dataset.r)][Number(td.dataset.c)] = td.textContent;
    drawFoot(); keep();
  });
  body.addEventListener("keydown", function (event) {
    var td = event.target.closest("td"); if (!td || event.key !== "Enter") return;
    event.preventDefault();
    var below = td.parentNode.nextElementSibling;
    if (below) below.children[Number(td.dataset.c)].focus(); else td.blur();
  });
  document.getElementById("add").addEventListener("click", function () {
    rows.push(S.head.map(function () { return ""; }));
    sort = null; draw(); keep();
    var last = body.lastElementChild; if (last) last.firstElementChild.focus();
  });
  draw();
  if (window.demesne && window.demesne.load) window.demesne.load("sheet", null).then(function (kept) {
    if (kept && kept.base === S.base && Array.isArray(kept.rows)) { rows = kept.rows.map(function (row) { return S.head.map(function (_, at) { return String((row || [])[at] == null ? "" : row[at]); }); }); draw(); }
  }, function () {});
})();
</script></body></html>`;
}

/// What a sheet's saved edits belong to: its CSV, hashed, so a new version starts from the model's rows.
export function sheetBase(source: string) {
  let hash = 5381;
  for (let at = 0; at < source.length; at++) hash = ((hash << 5) + hash + source.charCodeAt(at)) | 0;
  return `s${(hash >>> 0).toString(36)}-${source.length}`;
}

/// Step 4 of pass 273 A, a whiteboard: the board's notes on a canvas you
/// scroll, its groups as quiet frames behind them, its arrows drawn between
/// notes. Drag a note (or a group's name, which brings its notes along) to
/// move it; double-click a note to change its words, or empty space for a new
/// one; drag from a note's dot to another note for an arrow; Delete takes the
/// chosen note away. Where things are and what you wrote is kept with the
/// mockup through demesne.save, until the model makes a new version.
export function boardPage(source: string, title: string) {
  const read = readBoard(source);
  const board = "board" in read ? read.board : { notes: [], arrows: [], groups: [] };
  const data = JSON.stringify({ board, base: sheetBase(source), width: BOARD_NOTE_WIDTH }).replace(/</g, "\\u003c");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>
:root{color-scheme:light dark;--bg:#f7f7f5;--dot:#dedfdb;--fg:#24262a;--muted:#6f7278;--line:#9a9ea6;--note:#fff;--edge:rgba(0,0,0,.08);--group:rgba(0,0,0,.025);--focus:#3a6df0;
--plain:#ffffff;--sand:#f6efdc;--sky:#e6eef8;--mint:#e5f2ea;--rose:#f7e7e7;--lilac:#eee8f6}
@media (prefers-color-scheme:dark){:root{--bg:#151618;--dot:#26282c;--fg:#e8e9ec;--muted:#9a9ea6;--line:#6b7078;--edge:rgba(255,255,255,.08);--group:rgba(255,255,255,.025);--focus:#7aa7ff;
--plain:#202226;--sand:#2a2720;--sky:#1f2630;--mint:#1f2924;--rose:#2c2223;--lilac:#26222e}}
html,body{margin:0;height:100%;background:var(--bg);color:var(--fg);font:13.5px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif}
#board{position:relative;min-height:100vh;background-image:radial-gradient(var(--dot) 1px,transparent 1px);background-size:20px 20px;user-select:none;touch-action:none}
svg.lines{position:absolute;left:0;top:0;overflow:visible;pointer-events:none}
svg.lines path{fill:none;stroke:var(--line);stroke-width:1.4}
svg.lines text{fill:var(--muted);font-size:11.5px;paint-order:stroke;stroke:var(--bg);stroke-width:4px;text-anchor:middle}
.group{position:absolute;border-radius:14px;background:var(--group);box-shadow:inset 0 0 0 1px var(--edge)}
.group b{position:absolute;left:12px;top:8px;font-size:12px;font-weight:600;color:var(--muted);cursor:grab;padding:2px 4px}
.note{position:absolute;box-sizing:border-box;width:${BOARD_NOTE_WIDTH}px;min-height:64px;padding:12px 14px;border-radius:10px;background:var(--plain);box-shadow:0 0 0 1px var(--edge),0 1px 2px rgba(0,0,0,.06);cursor:grab;white-space:pre-wrap;word-break:break-word}
.note.on{box-shadow:0 0 0 2px var(--focus)}
.note.moving{cursor:grabbing;box-shadow:0 0 0 1px var(--edge),0 10px 24px -10px rgba(0,0,0,.35)}
.note[contenteditable]{cursor:text;user-select:text;outline:2px solid var(--focus);outline-offset:0}
.note .dot{position:absolute;right:-6px;top:50%;width:10px;height:10px;margin-top:-5px;border-radius:50%;background:var(--bg);box-shadow:inset 0 0 0 1.5px var(--line);cursor:crosshair;opacity:0}
.note:hover .dot,.note.on .dot{opacity:1}
.t-sand{background:var(--sand)}.t-sky{background:var(--sky)}.t-mint{background:var(--mint)}.t-rose{background:var(--rose)}.t-lilac{background:var(--lilac)}
#said{position:fixed;right:14px;bottom:10px;font-size:12px;color:var(--muted)}
#tip{position:fixed;left:14px;bottom:10px;font-size:12px;color:var(--muted)}
</style></head><body><div id="board"><svg class="lines" aria-hidden="true"><defs><marker id="head" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 10 5 0 10z" style="fill:var(--line);stroke:none"/></marker></defs><g id="arrows"></g><path id="draft" style="stroke-dasharray:4 4"></path></svg></div><span id="tip">Double-click for a note · drag a note's dot to another for an arrow</span><span id="said" aria-live="polite"></span><script>
(function () {
  var S = ${data}, W = S.width;
  var B = JSON.parse(JSON.stringify(S.board)), chosen = null, made = 0;
  var root = document.getElementById("board"), lines = root.querySelector("svg"), arrows = document.getElementById("arrows"), draft = document.getElementById("draft"), said = document.getElementById("said");
  function esc(text) { return String(text).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function note(id) { return root.querySelector('.note[data-id="' + CSS.escape(id) + '"]'); }
  function box(id) { var el = note(id), n = B.notes.find(function (one) { return one.id === id; }); return { x: n.x, y: n.y, w: W, h: el ? el.offsetHeight : 64 }; }
  function edge(a, b) {
    var cx = a.x + a.w / 2, cy = a.y + a.h / 2, dx = b.x + b.w / 2 - cx, dy = b.y + b.h / 2 - cy;
    if (!dx && !dy) return { x: cx, y: cy };
    var sx = dx ? (a.w / 2) / Math.abs(dx) : Infinity, sy = dy ? (a.h / 2) / Math.abs(dy) : Infinity, s = Math.min(sx, sy);
    return { x: cx + dx * s, y: cy + dy * s };
  }
  function drawArrows() {
    arrows.innerHTML = B.arrows.map(function (arrow) {
      if (!note(arrow.from) || !note(arrow.to)) return "";
      var a = box(arrow.from), b = box(arrow.to), p = edge(a, b), q = edge(b, a);
      var label = arrow.label ? '<text x="' + (p.x + q.x) / 2 + '" y="' + ((p.y + q.y) / 2 - 6) + '">' + esc(arrow.label) + "</text>" : "";
      return '<path marker-end="url(#head)" d="M' + p.x + " " + p.y + "L" + q.x + " " + q.y + '"></path>' + label;
    }).join("");
  }
  function size() {
    var right = 0, bottom = 0;
    B.notes.forEach(function (n) { right = Math.max(right, n.x + W); bottom = Math.max(bottom, n.y + (note(n.id) ? note(n.id).offsetHeight : 64)); });
    B.groups.forEach(function (g) { right = Math.max(right, g.x + g.w); bottom = Math.max(bottom, g.y + g.h); });
    root.style.width = Math.max(innerWidth, right + 200) + "px"; root.style.height = Math.max(innerHeight, bottom + 200) + "px";
    lines.setAttribute("width", root.style.width); lines.setAttribute("height", root.style.height);
  }
  function draw() {
    root.querySelectorAll(".note,.group").forEach(function (el) { el.remove(); });
    B.groups.forEach(function (g, at) {
      var el = document.createElement("div"); el.className = "group"; el.dataset.g = at;
      el.style.cssText = "left:" + g.x + "px;top:" + g.y + "px;width:" + g.w + "px;height:" + g.h + "px";
      el.innerHTML = g.label ? "<b>" + esc(g.label) + "</b>" : ""; root.insertBefore(el, lines);
    });
    B.notes.forEach(function (n) {
      var el = document.createElement("div"); el.className = "note t-" + n.tone + (chosen === n.id ? " on" : ""); el.dataset.id = n.id; el.tabIndex = 0;
      el.style.left = n.x + "px"; el.style.top = n.y + "px"; el.textContent = n.text;
      var dot = document.createElement("i"); dot.className = "dot"; el.appendChild(dot); root.appendChild(el);
    });
    size(); drawArrows();
  }
  var timer = 0;
  function keep() {
    clearTimeout(timer);
    timer = setTimeout(function () {
      if (!window.demesne || !window.demesne.save) return;
      window.demesne.save("board", { base: S.base, board: B }).then(function () { said.textContent = "Saved"; setTimeout(function () { said.textContent = ""; }, 1200); }, function (error) { said.textContent = "Couldn't save: " + ((error && error.message) || error); });
    }, 400);
  }
  function choose(id) { chosen = id; root.querySelectorAll(".note").forEach(function (el) { el.classList.toggle("on", el.dataset.id === id); }); }
  function at(event) { var r = root.getBoundingClientRect(); return { x: event.clientX - r.left, y: event.clientY - r.top }; }
  var drag = null;
  root.addEventListener("pointerdown", function (event) {
    if (event.button !== 0) return;
    var el = event.target.closest(".note"), label = event.target.closest(".group b");
    if (el && el.isContentEditable) return;
    var p = at(event);
    if (el && event.target.classList.contains("dot")) { drag = { kind: "link", from: el.dataset.id }; choose(el.dataset.id); }
    else if (el) { var n = B.notes.find(function (one) { return one.id === el.dataset.id; }); drag = { kind: "note", n: n, el: el, dx: p.x - n.x, dy: p.y - n.y, moved: false }; choose(n.id); el.classList.add("moving"); }
    else if (label) {
      var g = B.groups[Number(label.parentNode.dataset.g)];
      var inside = B.notes.filter(function (n) { var cx = n.x + W / 2, cy = n.y + 32; return cx >= g.x && cx <= g.x + g.w && cy >= g.y && cy <= g.y + g.h; });
      drag = { kind: "group", g: g, el: label.parentNode, start: p, gx: g.x, gy: g.y, notes: inside.map(function (n) { return { n: n, x: n.x, y: n.y }; }), moved: false };
    } else { choose(null); return; }
    root.setPointerCapture(event.pointerId); event.preventDefault();
  });
  root.addEventListener("pointermove", function (event) {
    if (!drag) return;
    var p = at(event);
    if (drag.kind === "note") { drag.n.x = Math.max(0, Math.round(p.x - drag.dx)); drag.n.y = Math.max(0, Math.round(p.y - drag.dy)); drag.el.style.left = drag.n.x + "px"; drag.el.style.top = drag.n.y + "px"; drag.moved = true; drawArrows(); }
    else if (drag.kind === "group") {
      var dx = p.x - drag.start.x, dy = p.y - drag.start.y;
      drag.g.x = Math.max(0, Math.round(drag.gx + dx)); drag.g.y = Math.max(0, Math.round(drag.gy + dy)); drag.el.style.left = drag.g.x + "px"; drag.el.style.top = drag.g.y + "px";
      drag.notes.forEach(function (one) { one.n.x = Math.max(0, Math.round(one.x + dx)); one.n.y = Math.max(0, Math.round(one.y + dy)); var el = note(one.n.id); el.style.left = one.n.x + "px"; el.style.top = one.n.y + "px"; });
      drag.moved = true; drawArrows();
    } else if (drag.kind === "link") { var a = box(drag.from), c = { x: a.x + a.w, y: a.y + a.h / 2 }; draft.setAttribute("d", "M" + c.x + " " + c.y + "L" + p.x + " " + p.y); }
  });
  root.addEventListener("pointerup", function (event) {
    if (!drag) return;
    var was = drag; drag = null;
    if (was.el) was.el.classList.remove("moving");
    if (was.kind === "link") {
      draft.setAttribute("d", "");
      var target = document.elementFromPoint(event.clientX, event.clientY), to = target && target.closest(".note");
      if (to && to.dataset.id !== was.from && !B.arrows.some(function (a) { return a.from === was.from && a.to === to.dataset.id; })) { B.arrows.push({ from: was.from, to: to.dataset.id, label: "" }); drawArrows(); keep(); }
      return;
    }
    if (was.moved) { size(); keep(); }
  });
  root.addEventListener("dblclick", function (event) {
    var el = event.target.closest(".note");
    if (!el) {
      if (event.target.closest(".group b")) return;
      var p = at(event), id = "new-" + Date.now().toString(36) + "-" + (++made);
      B.notes.push({ id: id, text: "", x: Math.max(0, Math.round(p.x - W / 2)), y: Math.max(0, Math.round(p.y - 24)), tone: "plain" });
      draw(); el = note(id);
    }
    edit(el);
  });
  function edit(el) {
    var n = B.notes.find(function (one) { return one.id === el.dataset.id; });
    el.textContent = n.text; el.contentEditable = "plaintext-only"; el.focus();
    var range = document.createRange(); range.selectNodeContents(el); range.collapse(false); var sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
    el.addEventListener("blur", function done() {
      el.removeEventListener("blur", done);
      var text = el.textContent.trim();
      if (!text) { B.notes = B.notes.filter(function (one) { return one !== n; }); B.arrows = B.arrows.filter(function (a) { return a.from !== n.id && a.to !== n.id; }); }
      else n.text = text.slice(0, 600);
      el.removeAttribute("contenteditable"); draw(); keep();
    });
  }
  document.addEventListener("keydown", function (event) {
    var el = document.activeElement;
    if (el && el.isContentEditable) { if (event.key === "Escape" || (event.key === "Enter" && (event.metaKey || event.ctrlKey))) { event.preventDefault(); el.blur(); } return; }
    if (!chosen) return;
    if (event.key === "Enter") { event.preventDefault(); edit(note(chosen)); }
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      B.notes = B.notes.filter(function (n) { return n.id !== chosen; }); B.arrows = B.arrows.filter(function (a) { return a.from !== chosen && a.to !== chosen; });
      chosen = null; draw(); keep();
    }
  });
  draw();
  if (window.demesne && window.demesne.load) window.demesne.load("board", null).then(function (kept) {
    if (kept && kept.base === S.base && kept.board && Array.isArray(kept.board.notes)) { B = { notes: kept.board.notes, arrows: kept.board.arrows || [], groups: kept.board.groups || [] }; draw(); }
  }, function () {});
})();
</script></body></html>`;
}
