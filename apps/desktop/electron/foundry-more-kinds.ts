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
/// Each page is plain HTML with foundry://kit/ scripts, so Save a copy
/// inlines them (exportedSource) and the file stands on its own.
import { FOUNDRY_REACT_IMPORTS } from "@demesne/protocol";
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
