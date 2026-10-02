import { marked, Renderer, type Token, type TokensList } from "marked";
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";

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
const options = { async: false as const, gfm: true, renderer };
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
    ],
    ALLOWED_ATTR: ["href", "title", "class", "start"],
  });
  const wrapper = document.createElement("div");
  wrapper.innerHTML = safe;
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
}

/** Lex the complete document to keep Markdown's context-sensitive semantics
 * (references, setext headings, loose lists, unfinished fences), but only parse,
 * sanitize, highlight and replace blocks whose source or link context changed.
 * Comment boundaries preserve the original DOM layout without extra wrappers. */
export class MarkdownView {
  readonly element = document.createElement("div");
  private raw: string | null = null;
  private links = "";
  private blocks: Block[] = [];
  constructor() {
    this.element.className = "markdown";
  }
  update(raw: string): boolean {
    if (raw === this.raw) return false;
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
        block = { raw: "", type: "", html: "", nodes: [], end };
        this.blocks.push(block);
      }
      if (block.html !== html) {
        const template = document.createElement("template");
        template.innerHTML = html;
        const nodes = [...template.content.childNodes];
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
