/// Only reconciles nodes produced by markdown.ts's existing sanitizer and
/// decorators. This is not an HTML parser or an alternative sanitization path.
const fades: WeakMap<Node, object> = new WeakMap();
export function markMarkdownFade(node: Node, run: object) { fades.set(node, run); }

function compatible(before: ChildNode, after: ChildNode): boolean {
  if (before.nodeType !== after.nodeType) return false;
  if (before.nodeType !== 1) return true;
  const a = before as Element, b = after as Element;
  return a.localName === b.localName && a.namespaceURI === b.namespaceURI && fades.get(a) === fades.get(b);
}

/// Ordered, block-local patching, with no search/move across Markdown block
/// boundaries. Preserve paragraphs, highlighted spans and table scroll hosts;
/// structural/namespace changes replace only the incompatible subtree. Math is
/// atomic: an unchanged formula keeps its layout/MathML, a changed one takes the
/// entire freshly decorated formula, never HTML injected into MathML.
export function reconcileMarkdownNodes(before: ChildNode[], after: ChildNode[], end: Comment): ChildNode[] {
  const budget = { left: 4000 };
  function patch(parent: Node, old: ChildNode[], fresh: ChildNode[], boundary: ChildNode | null, depth: number): ChildNode[] {
    const kept: ChildNode[] = [];
    for (let index = 0; index < fresh.length; index++) {
      const next = fresh[index]!, previous = old[index];
      if (!previous) {
        parent.insertBefore(next, boundary);
        kept.push(next);
        continue;
      }
      // Limit recursive work in unusually large/deep changing blocks. The
      // fallback still uses the fully sanitized and decorated fresh subtree.
      const reuse = budget.left-- > 0 && depth < 64 && compatible(previous, next);
      const math = previous.nodeType === 1 && ((previous as Element).classList.contains("math") || (next.nodeType === 1 && (next as Element).classList.contains("math")));
      if (!reuse || (math && !previous.isEqualNode(next))) {
        parent.replaceChild(next, previous);
        kept.push(next);
        continue;
      }
      if (!previous.isEqualNode(next)) {
        if (previous.nodeType === 1) {
          const a = previous as Element, b = next as Element;
          // A retained fade is already running on the live timeline. Changing
          // its negative delay would advance it twice; new wrappers still get
          // wrapFades' original duration and elapsed delay.
          const liveFade = fades.has(a);
          for (const attr of [...a.attributes]) {
            if (liveFade && attr.name === "style") continue;
            if (!b.hasAttributeNS(attr.namespaceURI, attr.localName)) a.removeAttributeNS(attr.namespaceURI, attr.localName);
          }
          for (const attr of [...b.attributes]) {
            if (liveFade && attr.name === "style") continue;
            if (a.getAttributeNS(attr.namespaceURI, attr.localName) !== attr.value) a.setAttributeNS(attr.namespaceURI, attr.name, attr.value);
          }
          patch(a, [...a.childNodes], [...b.childNodes], null, depth + 1);
        } else if (previous.nodeValue !== next.nodeValue) {
          // Append without replacing the Text node (also keeps existing DOM
          // ranges anchored in the stable prefix where possible).
          if (previous.nodeType === 3 && next.nodeValue?.startsWith(previous.nodeValue ?? ""))
            (previous as Text).appendData(next.nodeValue.slice(previous.nodeValue?.length ?? 0));
          else previous.nodeValue = next.nodeValue;
        }
      }
      kept.push(previous);
    }
    for (const node of old.slice(fresh.length)) node.remove();
    return kept;
  }
  return patch(end.parentNode!, before, after, end, 0);
}
