/// Point at it: an element picked in a chat's live preview rides with the
/// next message as a chip, named by what it is and the code behind it.

/// What the picker reads off the element the person clicked.
export interface PointPick {
  tag: string;
  text: string;
  label: string;
  selector: string;
  html: string;
  page: string;
  component?: string;
  /// A file (and line) the page itself names, from dev-build metadata.
  hint?: { file: string; line?: number };
}
export interface PointSource { path: string; line: number }
export interface Pointed extends PointPick { id: string; source: PointSource | null }

const WORDS: Record<string, string> = { a: "link", button: "button", input: "field", textarea: "field", select: "menu", img: "image", svg: "icon", label: "label", form: "form", nav: "navigation", table: "table", li: "item", p: "paragraph", span: "text", h1: "heading", h2: "heading", h3: "heading", h4: "heading", h5: "heading", h6: "heading" };

/// The chip's words: the element's own text when it is short, then what kind
/// of element it is ("Save button", "Display name field", "image").
export function pointLabel(pick: Pick<PointPick, "tag" | "label">): string {
  const word = WORDS[pick.tag] ?? pick.tag;
  const text = pick.label.replace(/\s+/g, " ").trim();
  if (!text) return word;
  const short = text.length > 24 ? `${text.slice(0, 23).trimEnd()}…` : text;
  return word === "text" || word === "paragraph" ? `“${short}”` : `${short} ${word}`;
}

/// The picks as the start of the next message, one block per element.
export function pointMessage(points: readonly Pointed[]): string {
  if (!points.length) return "";
  const lines = points.map((point) => {
    const where = point.source ? `\`${point.source.path}:${point.source.line}\`` : "source not found";
    const component = point.component ? ` · component ${point.component}` : "";
    return `- ${pointLabel(point)} on ${point.page} · ${where}${component}\n  selector \`${point.selector}\`\n  \`\`\`html\n  ${point.html}\n  \`\`\``;
  });
  return `${points.length === 1 ? "The element I pointed at" : "The elements I pointed at"} in the live preview:\n${lines.join("\n")}`;
}

/// Files a page's markup can live in.
export const SOURCE_FILE = /\.(tsx|jsx|ts|js|mjs|vue|svelte|astro|html|erb|hbs|php|mdx)$/i;
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/// Where the element is written in the project. A file the page names wins;
/// otherwise the source is searched for the element's id, its own text as
/// markup, its label or the component's definition, in that order.
export function findSource(files: readonly { path: string; text: string }[], pick: PointPick, root = ""): PointSource | null {
  if (pick.hint?.file) {
    let file = pick.hint.file.replace(/^file:\/\//, "").replace(/[?#].*$/, "");
    if (root && file.startsWith(`${root.replace(/\/$/, "")}/`)) file = file.slice(root.replace(/\/$/, "").length + 1);
    file = file.replace(/^\.?\//, "");
    const match = files.find((candidate) => candidate.path === file) ?? files.find((candidate) => file.endsWith(`/${candidate.path}`) || candidate.path.endsWith(`/${file}`));
    if (match) return { path: match.path, line: pick.hint.line ?? 1 };
  }
  const id = /\bid="([^"]+)"/.exec(pick.html.slice(0, pick.html.indexOf(">") + 1))?.[1];
  const text = pick.text.replace(/\s+/g, " ").trim();
  const tests: RegExp[] = [];
  if (id) tests.push(new RegExp(`\\bid=["'{]${escape(id)}["'}]`));
  if (text && text.length <= 80) {
    tests.push(new RegExp(`>\\s*${escape(text)}\\s*<`));
    tests.push(new RegExp(`["'\`]${escape(text)}["'\`]`));
  }
  if (pick.label && pick.label !== text && pick.label.length <= 80) tests.push(new RegExp(`["'\`]${escape(pick.label)}["'\`]`));
  if (pick.component) tests.push(new RegExp(`(?:function|class|const|let)\\s+${escape(pick.component)}\\b`));
  // Components and pages before scripts, shorter paths before deep ones.
  const ranked = files.filter((file) => SOURCE_FILE.test(file.path)).sort((a, b) => rank(a.path) - rank(b.path) || a.path.length - b.path.length);
  for (const test of tests)
    for (const file of ranked) {
      const at = file.text.search(test);
      if (at >= 0) return { path: file.path, line: file.text.slice(0, at).split("\n").length };
    }
  return null;
}
const rank = (path: string) => (/(^|\/)(node_modules|dist|build|\.next|out|coverage)\//.test(path) ? 9 : /\.(test|spec)\./.test(path) ? 5 : /\.(tsx|jsx|vue|svelte|astro|html)$/.test(path) ? 0 : 2);
