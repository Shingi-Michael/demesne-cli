/// Keep the tab controls themselves alive across status/title updates. Moving
/// between tabs is manual activation: arrows move focus, Enter/Space opens one.
const tabElements = (strip: HTMLElement) => [...strip.querySelectorAll<HTMLElement>('[role="tab"]')];

function patchNode(current: Node, next: Node) {
  if (current.nodeType !== next.nodeType || current.nodeName !== next.nodeName) {
    current.parentNode!.replaceChild(next, current);
    return;
  }
  if (current instanceof Element && next instanceof Element) {
    for (const attribute of [...current.attributes])
      if (!next.hasAttribute(attribute.name)) current.removeAttribute(attribute.name);
    for (const attribute of [...next.attributes])
      if (current.getAttribute(attribute.name) !== attribute.value) current.setAttribute(attribute.name, attribute.value);
    const before = [...current.childNodes], after = [...next.childNodes];
    for (let index = 0; index < Math.max(before.length, after.length); index++) {
      if (!after[index]) before[index]!.remove();
      else if (!before[index]) current.appendChild(after[index]!);
      else patchNode(before[index]!, after[index]!);
    }
  } else if (current.nodeValue !== next.nodeValue) current.nodeValue = next.nodeValue;
}

function tabStop(strip: HTMLElement, preferred?: HTMLElement) {
  const tabs = tabElements(strip);
  const stop = preferred?.matches('[role="tab"]') ? preferred
    : tabs.find(tab => tab.getAttribute("aria-selected") === "true") ?? tabs[0];
  for (const tab of tabs) tab.tabIndex = tab === stop ? 0 : -1;
}

export function updateTabStrip(strip: HTMLElement, html: string, fallback: HTMLElement | null) {
  const active = document.activeElement instanceof HTMLElement && strip.contains(document.activeElement)
    ? document.activeElement : null;
  const oldTabs = tabElements(strip);
  const oldIndex = active ? oldTabs.findIndex(tab => tab === active || tab.closest("[data-tab-key]") === active.closest("[data-tab-key]")) : -1;
  const template = document.createElement("template");
  template.innerHTML = html;
  const old = new Map([...strip.children].map(node => [(node as HTMLElement).dataset.tabKey, node]));
  const retained = new Set<Element>();
  let index = 0;
  for (const next of [...template.content.children]) {
    const previous = old.get((next as HTMLElement).dataset.tabKey);
    const node = previous?.tagName === next.tagName ? previous : next;
    if (node === previous) patchNode(node, next);
    retained.add(node);
    if (strip.children[index] !== node) strip.insertBefore(node, strip.children[index] ?? null);
    index++;
  }
  for (const node of [...strip.children]) if (!retained.has(node)) node.remove();
  // Removal chooses the next tab at the same position, then the previous one;
  // the last tab hands keyboard focus to New chat, never to document.body.
  const tabs = tabElements(strip);
  const focus = active ? active.isConnected ? active : tabs[Math.min(Math.max(oldIndex, 0), tabs.length - 1)] ?? fallback : null;
  tabStop(strip, focus ?? undefined);
  if (focus && document.activeElement !== focus) focus.focus({ preventScroll: true });
}

export function handleTabStripKey(event: KeyboardEvent, strip: HTMLElement): boolean {
  if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false;
  const target = event.target instanceof HTMLElement ? event.target : null;
  if (!target?.matches('[role="tab"]')) return false;
  const tabs = tabElements(strip), at = tabs.indexOf(target);
  const index = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1
    : event.key === "ArrowLeft" ? (at + tabs.length - 1) % tabs.length
    : event.key === "ArrowRight" ? (at + 1) % tabs.length : -1;
  if (index < 0) return false;
  event.preventDefault();
  const next = tabs[index]!;
  tabStop(strip, next);
  next.focus({ preventScroll: true });
  next.scrollIntoView({ block: "nearest", inline: "nearest" });
  return true;
}
