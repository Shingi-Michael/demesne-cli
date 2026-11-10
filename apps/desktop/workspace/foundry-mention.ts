/// @ a mockup (pass 208 A). In any chat, "@" offers Foundry's mockups by
/// name next to the files; picking one writes "@Roaster pricing" in the
/// message. Sending adds one line the model reads (which mockup, its id and
/// version), and the bubble hides that line and makes the name a link that
/// opens the mockup on the Foundry page.
import type { FoundryKind } from "@demesne/protocol";

export interface MockupName { id: string; title: string; version: number; description: string; kind: FoundryKind }
export interface MockupRef { id: string; title: string; version: number }

export const MOCKUP_REFS_HEAD = "Mockups I mentioned with @ (in Foundry; foundry_read one by its id):";

/// The mockups a message names with "@Title", longest names first, so
/// "@Roaster pricing, phone" is never taken for "@Roaster pricing".
export function mentionedMockups(text: string, names: readonly MockupName[]): MockupName[] {
  const found: MockupName[] = [];
  let rest = text;
  for (const name of [...names].sort((a, b) => b.title.length - a.title.length)) {
    if (!name.title || found.some((item) => item.id === name.id)) continue;
    const token = whole(`@${name.title}`);
    if (!token.test(rest)) continue;
    found.push(name);
    rest = rest.replace(token, " ");
  }
  return found;
}

/// "@Logo" but not inside "@Logos".
const whole = (token: string) => new RegExp(`${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}_])`, "gu");

/// The line that goes after the message, for the model.
export function mockupRefs(mockups: readonly MockupRef[]): string {
  if (!mockups.length) return "";
  return `${MOCKUP_REFS_HEAD}\n${mockups.map((item) => `- "${item.title.replace(/"/g, "'")}" id ${item.id} (v${item.version})`).join("\n")}`;
}

/// A sent message back into what you wrote and the mockups it named.
export function splitMockupRefs(content: string): { text: string; refs: MockupRef[] } {
  const at = content.lastIndexOf(`\n\n${MOCKUP_REFS_HEAD}\n`);
  const start = at >= 0 ? at : content.startsWith(`${MOCKUP_REFS_HEAD}\n`) ? -2 : -1;
  if (start === -1) return { text: content, refs: [] };
  const block = content.slice(start + 2 + MOCKUP_REFS_HEAD.length + 1);
  const refs: MockupRef[] = [];
  for (const line of block.split("\n")) {
    const match = /^- "(.*)" id ([\w-]{1,200}) \(v(\d+)\)$/.exec(line);
    if (!match) return { text: content, refs: [] };
    refs.push({ title: match[1]!, id: match[2]!, version: Number(match[3]) });
  }
  return { text: content.slice(0, Math.max(0, start)), refs };
}

const h = (value: string) => value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

/// In escaped message HTML, each "@Title" a message named becomes a link.
export function linkMockups(html: string, refs: readonly MockupRef[]): string {
  let out = html;
  for (const ref of [...refs].sort((a, b) => b.title.length - a.title.length)) {
    const token = h(`@${ref.title}`);
    const args = h(JSON.stringify({ id: ref.id, version: ref.version }));
    out = out.replace(whole(token), () => `<button type="button" class="fd-at" data-action="foundry-open" data-args="${args}" title="Show ${h(ref.title)} v${ref.version} in Foundry">\u0000${ref.id}\u0000</button>`);
  }
  // Placeholders keep a shorter title from matching inside a longer link.
  return out.replace(/\u0000([\w-]{1,200})\u0000/g, (_, id: string) => h(`@${refs.find((ref) => ref.id === id)!.title}`));
}
