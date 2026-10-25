import { marked, Renderer, type Token, type TokensList } from "marked";
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";
import katex from "katex";

const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ]!,
  );
const renderer = new Renderer();
renderer.html = (token) => escape(token.text);

/// Math, the way models write it: $…$ and \(…\) inline, $$…$$ and \[…\]
/// displayed. Parsed before Markdown can eat the backslashes, never inside
/// code, and $ only pairs like TeX ($x$, not "$5 and $10"). The renderer
/// leaves a placeholder; KaTeX fills it after sanitizing (see decorate).
const mathPlaceholder = (tex: string, display: boolean) =>
  `<span class="math" data-math="${escape(tex.trim())}"${display ? ' data-display="1"' : ""}></span>`;
const INLINE_MATH = [
  { pattern: /^\$\$([\s\S]+?)\$\$/, display: true },
  { pattern: /^\\\[([\s\S]+?)\\\]/, display: true },
  { pattern: /^\\\(([\s\S]+?)\\\)/, display: false },
  { pattern: /^\$(?![\s$])((?:\\\$|[^$\n])+?)(?<!\s)\$(?!\d)/, display: false },
];
marked.use({
  extensions: [
    {
      name: "mathBlock",
      level: "block",
      start: (src: string) => src.match(/^ {0,3}(?:\$\$|\\\[)/m)?.index,
      tokenizer(src: string) {
        const match = /^ {0,3}(?:\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\])[ \t]*(?:\n|$)/.exec(src);
        if (match) return { type: "mathBlock", raw: match[0], text: match[1] ?? match[2] ?? "" };
      },
      renderer: (token) => `<p>${mathPlaceholder(String(token.text), true)}</p>`,
    },
    {
      name: "mathInline",
      level: "inline",
      start: (src: string) => src.match(/\$|\\[([]/)?.index,
      tokenizer(src: string) {
        for (const { pattern, display } of INLINE_MATH) {
          const match = pattern.exec(src);
          if (match) return { type: "mathInline", raw: match[0], text: match[1]!, display };
        }
      },
      renderer: (token) => mathPlaceholder(String(token.text), Boolean(token.display)),
    },
  ],
});
// From marked's defaults, which carry the math extensions registered above:
// lexer() and parser() use exactly the options they are given.
export const options = { ...marked.defaults, async: false as const, gfm: true, renderer };
function decorate(parsed: string): string {
  const safe = DOMPurify.sanitize(parsed, {
    ALLOWED_TAGS: [
      "p",
      "br",
      "strong",
      "em",
      "del",
      "code",
      "pre",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "ul",
      "ol",
      "li",
      "blockquote",
      "table",
      "thead",
      "tbody",
      "tr",
      "th",
      "td",
      "a",
      "hr",
      "span",
      "input",
    ],
    ALLOWED_ATTR: ["href", "title", "class", "start", "data-math", "data-display", "type", "checked", "disabled"],
  });
  const wrapper = document.createElement("div");
  wrapper.innerHTML = safe;
  // Task-list boxes are display-only.
  for (const box of wrapper.querySelectorAll("input"))
    if (box.type !== "checkbox") box.remove();
    else box.disabled = true;
  for (const element of wrapper.querySelectorAll<HTMLElement>("[data-math]")) {
    const display = element.dataset.display === "1";
    // A formula KaTeX cannot parse stays readable as its source.
    katex.render(element.dataset.math ?? "", element, { displayMode: display, throwOnError: false, output: "html", strict: "ignore", trust: false });
  }
  for (const block of wrapper.querySelectorAll("pre")) {
    const code = block.querySelector("code");
    if (!code) continue;
    const language = /language-([^ ]+)/.exec(code.className)?.[1] ?? "code";
    if (hljs.getLanguage(language))
      code.innerHTML = hljs.highlight(code.textContent ?? "", {
        language,
        ignoreIllegals: true,
      }).value;
    const head = document.createElement("div");
    head.className = "code-header";
    const label = document.createElement("span");
    label.textContent = language === "ts" ? "typescript" : language;
    const copy = document.createElement("button");
    copy.type = "button";
    copy.dataset.action = "copy-code";
    copy.textContent = "copy";
    head.append(label, copy);
    block.prepend(head);
  }
  return wrapper.innerHTML;
}

// Static views reuse finished Markdown, bounded by bytes rather than retaining
// dozens of full versions of a growing answer. Streaming uses MarkdownView.
const cache = new Map<string, string>();
let cacheSize = 0;
const CACHE_LIMIT = 2 * 1024 * 1024;
export function markdown(raw: string): string {
  const cached = cache.get(raw);
  if (cached !== undefined) return cached;
  const result = decorate(marked.parse(raw, options));
  const size = (raw.length + result.length) * 2;
  if (size <= CACHE_LIMIT) {
    while (cacheSize + size > CACHE_LIMIT || cache.size >= 64) {
      const key = cache.keys().next().value!;
      cacheSize -= (key.length + cache.get(key)!.length) * 2;
      cache.delete(key);
    }
    cache.set(raw, result);
    cacheSize += size;
  }
  return result;
}
interface Block {
  raw: string;
  type: string;
  html: string;
  nodes: ChildNode[];
  end: Comment;
  /// Runs of words still fading in: where each starts in the block's text,
  /// when it started, and for how long.
  fades: Fade[];
}
interface Fade { at: number; start: number; ms: number }

/// Words arrive softly: each new run of streamed text fades in, over 120–400 ms
/// matched to the stream's pace. A block is redrawn whole on every update, so
/// runs still fading are wrapped again with a negative delay and carry on
/// where they were instead of popping to full.
function wrapFades(nodes: ChildNode[], fades: Fade[], now: number) {
  if (!fades.length) return;
  const texts: Text[] = [];
  for (const node of nodes) {
    if (node.nodeType === Node.TEXT_NODE) { texts.push(node as Text); continue; }
    if (node.nodeType !== Node.ELEMENT_NODE) continue;
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    for (let text = walker.nextNode(); text; text = walker.nextNode()) texts.push(text as Text);
  }
  let offset = 0;
  for (const text of texts) {
    const length = text.data.length, from = offset;
    offset += length;
    if (!length) continue;
    // Cut this text node where fades begin, then wrap each piece that fades.
    let piece = text, pieceAt = from;
    for (let i = 0; i < fades.length; i++) {
      const fade = fades[i]!, end = fades[i + 1]?.at ?? Infinity;
      if (end <= pieceAt || fade.at >= pieceAt + piece.data.length) continue;
      if (fade.at > pieceAt) { piece = piece.splitText(fade.at - pieceAt); pieceAt = fade.at; }
      const rest = end < pieceAt + piece.data.length ? piece.splitText(end - pieceAt) : null;
      if (piece.data.trim()) {
        const span = document.createElement("span");
        span.className = "md-in";
        span.style.animationDuration = `${fade.ms}ms`;
        span.style.animationDelay = `${-Math.round(now - fade.start)}ms`;
        piece.replaceWith(span);
        span.append(piece);
      }
      if (!rest) break;
      pieceAt += piece.data.length; piece = rest;
    }
  }
}
const commonPrefix = (a: string, b: string) => {
  let i = 0;
  while (i < a.length && i < b.length && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return i;
};

/** Lex the complete document to keep Markdown's context-sensitive semantics
 * (references, setext headings, loose lists, unfinished fences), but only parse,
 * sanitize, highlight and replace blocks whose source or link context changed.
 * Comment boundaries preserve the original DOM layout without extra wrappers. */
export class MarkdownView {
  readonly element = document.createElement("div");
  private raw: string | null = null;
  private links = "";
  private blocks: Block[] = [];
  private lastUpdate = 0;
  constructor() {
    this.element.className = "markdown";
  }
  /// `fade` while the answer streams: new words fade in (see wrapFades).
  update(raw: string, fade = false): boolean {
    if (raw === this.raw) return false;
    const now = performance.now(), gap = this.lastUpdate ? now - this.lastUpdate : 200;
    this.lastUpdate = now;
    const ms = Math.round(Math.min(400, Math.max(120, gap * 1.5)));
    const tokens = marked.lexer(raw, options);
    const links = JSON.stringify(tokens.links),
      contextChanged = links !== this.links;
    let mutated = false;
    for (let index = 0; index < tokens.length; index++) {
      const token: Token = tokens[index]!;
      let block = this.blocks[index];
      if (
        block &&
        !contextChanged &&
        block.raw === token.raw &&
        block.type === token.type
      )
        continue;
      const list = Object.assign([token], {
        links: tokens.links,
      }) as TokensList;
      const html = decorate(marked.parser(list, options));
      if (!block) {
        const end = document.createComment("markdown block");
        this.element.append(end);
        block = { raw: "", type: "", html: "", nodes: [], end, fades: [] };
        this.blocks.push(block);
      }
      if (block.html !== html) {
        const template = document.createElement("template");
        template.innerHTML = html;
        const nodes = [...template.content.childNodes];
        // The last update of an answer still lets its words finish fading.
        if (fade || block.fades.length) {
          const before = block.nodes.map((node) => node.textContent ?? "").join(""),
            after = nodes.map((node) => node.textContent ?? "").join(""),
            kept = commonPrefix(before, after);
          block.fades = block.fades.filter((run) => now - run.start < run.ms && run.at < kept);
          if (fade && after.length > kept) block.fades.push({ at: kept, start: now, ms });
          wrapFades(nodes, block.fades, now);
        }
        for (const node of block.nodes) node.remove();
        block.end.before(template.content);
        block.nodes = nodes;
        block.html = html;
        mutated = true;
      }
      block.raw = token.raw;
      block.type = token.type;
    }
    for (const block of this.blocks.splice(tokens.length)) {
      for (const node of block.nodes) node.remove();
      block.end.remove();
      mutated = true;
    }
    this.links = links;
    this.raw = raw;
    return mutated;
  }
}
