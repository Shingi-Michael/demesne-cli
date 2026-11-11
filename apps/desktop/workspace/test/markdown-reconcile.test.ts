import { test } from "node:test";
import assert from "node:assert/strict";
import { markMarkdownFade, reconcileMarkdownNodes } from "../markdown-reconcile.ts";

// A deliberately small DOM contract for dependency-free algorithm checks. The
// opt-in markdown-redraw.dom.test.ts uses real Chromium nodes and the complete
// sanitizer/math/highlighter pipeline; this contract is not browser proof.
class SpecNode {
  parentNode: SpecNode | null = null;
  childNodes: SpecNode[] = [];
  attrs = new Map<string, string>();
  writes = 0;
  constructor(readonly nodeType: number, readonly localName = "", public nodeValue: string | null = null, readonly namespaceURI = "http://www.w3.org/1999/xhtml") {}
  get attributes() { return [...this.attrs].map(([name, value]) => ({ name, localName: name, value, namespaceURI: null })); }
  classList = { contains: (name: string) => (this.attrs.get("class") ?? "").split(" ").includes(name) };
  hasAttributeNS(_ns: unknown, name: string) { return this.attrs.has(name); }
  getAttributeNS(_ns: unknown, name: string) { return this.attrs.get(name) ?? null; }
  setAttributeNS(_ns: unknown, name: string, value: string) { this.writes++; this.attrs.set(name, value); }
  removeAttributeNS(_ns: unknown, name: string) { this.writes++; this.attrs.delete(name); }
  isEqualNode(other: SpecNode): boolean {
    return this.nodeType === other.nodeType && this.localName === other.localName && this.namespaceURI === other.namespaceURI && this.nodeValue === other.nodeValue
      && JSON.stringify([...this.attrs].sort()) === JSON.stringify([...other.attrs].sort())
      && this.childNodes.length === other.childNodes.length && this.childNodes.every((child, index) => child.isEqualNode(other.childNodes[index]!));
  }
  insertBefore(node: SpecNode, boundary: SpecNode | null) {
    node.remove();
    const index = boundary ? this.childNodes.indexOf(boundary) : this.childNodes.length;
    assert.ok(index >= 0);
    this.childNodes.splice(index, 0, node); node.parentNode = this; this.writes++;
  }
  replaceChild(next: SpecNode, old: SpecNode) {
    next.remove();
    const index = this.childNodes.indexOf(old);
    assert.ok(index >= 0);
    this.childNodes[index] = next; next.parentNode = this; old.parentNode = null; this.writes++;
  }
  appendData(text: string) { this.nodeValue = (this.nodeValue ?? "") + text; this.writes++; }
  remove() {
    if (!this.parentNode) return;
    const parent = this.parentNode;
    parent.childNodes.splice(parent.childNodes.indexOf(this), 1); parent.writes++; this.parentNode = null;
  }
}
const text = (value: string) => new SpecNode(3, "", value);
function element(name: string, ...children: SpecNode[]) {
  const node = new SpecNode(1, name);
  children.forEach(child => node.insertBefore(child, null));
  node.writes = 0;
  return node;
}
function mounted(...nodes: SpecNode[]) {
  const end = new SpecNode(8, "", "markdown block"), following = element("p", text("untouched block"));
  const root = element("div", ...nodes, end, following);
  return { root, end, following };
}
const reconcile = (before: SpecNode[], after: SpecNode[], end: SpecNode) => reconcileMarkdownNodes(before as unknown as ChildNode[], after as unknown as ChildNode[], end as unknown as Comment) as unknown as SpecNode[];

test("append patches text in place and stays inside the current block boundary", () => {
  const prefix = text("Hello"), p = element("p", prefix), { root, end, following } = mounted(p);
  const fresh = element("p", text("Hello world"), element("strong", text("!")));
  assert.equal(reconcile([p], [fresh], end)[0], p);
  assert.equal(p.childNodes[0], prefix);
  assert.equal(prefix.nodeValue, "Hello world");
  assert.equal(prefix.writes, 1);
  assert.equal(p.childNodes[1]?.localName, "strong");
  assert.equal(root.writes, 0, "the paragraph and adjacent blocks were never detached");
  assert.equal(root.childNodes[2], following);
  assert.ok(p.isEqualNode(element("p", text("Hello world"), element("strong", text("!")))));
});

test("an identical subtree performs no DOM writes", () => {
  const p = element("p", text("same")), { root, end } = mounted(p);
  reconcile([p], [element("p", text("same"))], end);
  assert.equal(root.writes + p.writes + p.childNodes[0]!.writes, 0);
});

test("format transitions replace only incompatible nodes; removed tails disappear", () => {
  const p = element("p", text("*em"), element("code", text("old"))), { root, end, following } = mounted(p);
  reconcile([p], [element("p", element("em", text("em")))], end);
  assert.equal(root.childNodes[0], p);
  assert.equal(p.childNodes.length, 1);
  assert.equal(p.childNodes[0]?.localName, "em");
  assert.equal(root.childNodes[2], following);
  reconcile([p], [], end);
  assert.deepEqual(root.childNodes, [end, following]);
});

test("attributes are patched and namespace changes are never reused", () => {
  const a = element("a", text("link"));
  a.attrs.set("title", "old"); a.attrs.set("href", "/old");
  const { end } = mounted(a), next = element("a", text("link"));
  next.attrs.set("href", "/new");
  reconcile([a], [next], end);
  assert.equal(a.attrs.get("href"), "/new");
  assert.equal(a.attrs.has("title"), false);
  const html = element("span"), math = new SpecNode(1, "span", null, "http://www.w3.org/1998/Math/MathML");
  const second = mounted(html);
  assert.equal(reconcile([html], [math], second.end)[0], math);
});

test("unchanged math is atomic and retained, changed math is replaced as one tree", () => {
  const math = element("span", element("math", text("x"))); math.attrs.set("class", "math");
  const { end } = mounted(math), same = element("span", element("math", text("x"))); same.attrs.set("class", "math");
  assert.equal(reconcile([math], [same], end)[0], math);
  const changed = element("span", element("math", text("y"))); changed.attrs.set("class", "math");
  assert.equal(reconcile([math], [changed], end)[0], changed);
});

test("retained fade wrappers keep their timeline; new fade runs cannot reuse them", () => {
  const run = {}, old = element("span", text("new")), next = element("span", text("new"));
  for (const node of [old, next]) node.attrs.set("class", "md-in");
  old.attrs.set("style", "animation-duration:300ms;animation-delay:0ms");
  next.attrs.set("style", "animation-duration:300ms;animation-delay:-80ms");
  markMarkdownFade(old as unknown as Node, run); markMarkdownFade(next as unknown as Node, run);
  const { end } = mounted(old);
  assert.equal(reconcile([old], [next], end)[0], old);
  assert.equal(old.writes, 0);
  assert.equal(old.attrs.get("style"), "animation-duration:300ms;animation-delay:0ms");
  const newer = element("span", text("other")); newer.attrs.set("class", "md-in");
  markMarkdownFade(newer as unknown as Node, {});
  assert.equal(reconcile([old], [newer], end)[0], newer);
});

test("deep changes fall back to a fresh subtree without changing the final tree", () => {
  const nested = (value: string) => {
    let node = text(value);
    for (let i = 0; i < 75; i++) node = element("blockquote", node);
    return node;
  };
  const before = nested("before"), { end } = mounted(before);
  const result = reconcile([before], [nested("after")], end);
  assert.equal(result[0], before);
  assert.ok(result[0]!.isEqualNode(nested("after")));
});
