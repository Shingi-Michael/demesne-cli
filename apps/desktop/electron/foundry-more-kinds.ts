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
/// Each page is plain HTML with foundry://kit/ scripts, so Save a copy
/// inlines them (exportedSource) and the file stands on its own.
import { FOUNDRY_REACT_IMPORTS, numberColumns, parseSheet } from "@demesne/protocol";
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
