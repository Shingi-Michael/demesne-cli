/// What a chat made in Foundry, in the conversation: a link card per
/// artifact (pass 192 A). Its kind's tile, the title, "Prototype · v2" and
/// Open; nothing live runs in the chat. Click opens the page in Foundry.
/// Every turn that made or changed a page ends with its chip, so the newest
/// version is always one click away (a quiet "Edited" line was missed).
import { FOUNDRY_KINDS, type FoundryKind } from "@demesne/protocol";
import type { ToolEntry, WorkbenchEntry } from "@demesne/workbench/entries.ts";
import { BUILT_ICON, frameURL, KIND_ICON, KIND_WORD } from "./foundry-page.ts";

export interface ChatArtifact { id: string; title: string; kind: FoundryKind; version: number;
  /// Pass 208 A: what it is, the version's name, and whether it is the pick.
  description?: string; note?: string; recommended?: boolean;
  /// Pass 241 A: the record of a build beside its mockup (foundry_built); note is its verdict.
  built?: true }

/** Successful saves and edits are the durable link between a conversation and its chips.
 * Keep the last save of each artifact in a turn; failed or unfinished saves
 * must never appear to be completed work. */
export function chatArtifacts(entries: readonly Pick<ToolEntry, "name" | "state" | "message">[]): ChatArtifact[] {
  const saved = new Map<string, ChatArtifact>();
  for (const entry of entries) {
    if ((entry.name !== "foundry_save" && entry.name !== "foundry_models" && entry.name !== "foundry_edit" && entry.name !== "foundry_built") || entry.state !== "done" || !entry.message) continue;
    try {
      const value = JSON.parse(entry.message);
      if (!value || typeof value.id !== "string" || !/^[\w-]{1,200}$/.test(value.id)
        || typeof value.title !== "string" || !FOUNDRY_KINDS.includes(value.kind)
        || !Number.isSafeInteger(value.version) || value.version < 1) continue;
      const before = saved.get(value.id);
      saved.set(value.id, { id: value.id, title: value.title, kind: value.kind, version: value.version,
        ...(typeof value.description === "string" && value.description ? { description: value.description } : before?.description ? { description: before.description } : {}),
        ...(typeof value.note === "string" && value.note ? { note: value.note } : before?.note && before.version === value.version ? { note: before.note } : {}),
        ...(value.recommended === true ? { recommended: true } : {}), ...(entry.name === "foundry_built" && value.built === true ? { built: true as const } : {}) });
    } catch { /* Older or failed tool output remains available in the step. */ }
  }
  // One ask that made several shows the one it would use first, marked.
  const all = [...saved.values()];
  const several = all.length > 1, pick = several ? all.find((item) => item.recommended) : undefined;
  return pick ? [pick, ...all.filter((item) => item !== pick)] : all.map(({ recommended: _, ...item }) => item);
}

interface ChipOptions {
  open(artifact: ChatArtifact): void | Promise<unknown>;
}

/** The chip's words: what it is and which version. */
export const chipWords = (artifact: ChatArtifact) => artifact.built ? `Built like the mockup${artifact.note ? ` · ${artifact.note}` : ""}`
  : `${KIND_WORD[artifact.kind]} · v${artifact.version}${artifact.note ? ` · ${artifact.note}` : ""}`;

const ARROW = `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h13M13 6l6 6-6 6"/></svg>`;
const attr = (value: string) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
/** The mockup itself, at a desktop size, shrunk into the card. */
export const chipPicture = (artifact: Pick<ChatArtifact, "id" | "version">) =>
  `<iframe class="fd-chip-frame" src="${attr(frameURL(artifact.id, artifact.version))}" loading="lazy" tabindex="-1" inert aria-hidden="true" sandbox="allow-scripts" referrerpolicy="no-referrer" title=""></iframe>`;

/** How long the card's edge light takes for its one lap when a mockup lands. */
export const CHIP_LAP_MS = 6000;

function chip(artifact: ChatArtifact, options: ChipOptions) {
  const node = document.createElement("button");
  node.type = "button";
  node.className = "fd-chip";
  node.dataset.artifactId = artifact.id;
  node.dataset.version = String(artifact.version);
  fill(node, artifact);
  node.addEventListener("click", () => { void options.open(artifact); });
  return node;
}

function fill(node: HTMLButtonElement, artifact: ChatArtifact) {
  const title = document.createElement("b");
  title.textContent = artifact.title;
  // Pass 280 B: a still picture of the mockup, drawn small the way Foundry's
  // front page draws its cards. It loads only near the screen, takes no
  // input and plays no demo. A document or a build record keeps its icon.
  const tile = document.createElement("span");
  tile.className = "fd-chip-thumb";
  tile.innerHTML = artifact.built || artifact.kind === "markdown" ? artifact.built ? BUILT_ICON : KIND_ICON[artifact.kind] : chipPicture(artifact);
  tile.classList.toggle("pic", !artifact.built && artifact.kind !== "markdown");
  const text = document.createElement("span"), words = document.createElement("span");
  text.className = "fd-chip-text";
  words.textContent = chipWords(artifact);
  text.append(title);
  if (artifact.description) {
    const description = document.createElement("span");
    description.className = "fd-chip-desc";
    description.textContent = artifact.description;
    text.append(description);
  }
  text.append(words);
  if (artifact.recommended) {
    const pick = document.createElement("span");
    pick.className = "fd-chip-rec";
    pick.textContent = "recommended";
    text.append(pick);
  }
  const open = document.createElement("span");
  open.className = "fd-chip-open";
  open.innerHTML = `Open${ARROW}`;
  node.replaceChildren(tile, text, open);
  node.setAttribute("aria-label", `Open ${artifact.title}, ${chipWords(artifact)}${artifact.recommended ? ", recommended" : ""}`);
}

/** The chips of one turn, kept across repaints so focus and state survive. */
export class FoundryChatArtifacts {
  readonly element = document.createElement("div");
  private readonly chips = new Map<string, { artifact: ChatArtifact; node: HTMLButtonElement; words: string }>();
  artifacts: ChatArtifact[] = [];
  constructor(private readonly options: ChipOptions) {
    this.element.className = "fd-chips";
    this.element.hidden = true;
  }
  /// The first update draws what the turn already had (a chat opened later):
  /// only a card that arrives after it laps, once, as its mockup lands.
  private primed = false;
  update(entries: readonly WorkbenchEntry[]) {
    const artifacts = chatArtifacts(entries.filter((entry): entry is ToolEntry => entry.type === "tool"));
    const keys = new Set(artifacts.map(artifact => `${artifact.id}:${artifact.version}`));
    for (const [key, item] of this.chips) if (!keys.has(key)) { item.node.remove(); this.chips.delete(key); }
    artifacts.forEach((artifact, index) => {
      const key = `${artifact.id}:${artifact.version}`;
      let item = this.chips.get(key);
      const words = JSON.stringify(artifact);
      if (!item) {
        item = { artifact, node: chip(artifact, this.options), words };
        this.chips.set(key, item);
        if (this.primed) { const node = item.node; node.classList.add("lap"); setTimeout(() => node.classList.remove("lap"), CHIP_LAP_MS); }
      } else if (item.words !== words) {
        // A new name, description or pick redraws the chip in place.
        item.artifact = artifact;
        item.words = words;
        fill(item.node, artifact);
      }
      if (this.element.children[index] !== item.node) this.element.insertBefore(item.node, this.element.children[index] ?? null);
    });
    this.artifacts = artifacts;
    this.primed = true;
    this.element.hidden = !artifacts.length;
    return artifacts;
  }
  dispose() { for (const item of this.chips.values()) item.node.remove(); this.chips.clear(); this.element.remove(); }
}
