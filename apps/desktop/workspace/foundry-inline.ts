/// What a chat made in Foundry, in the conversation: a link card per
/// artifact (pass 192 A). Its kind's tile, the title, "Prototype · v2" and
/// Open; nothing live runs in the chat. Click opens the page in Foundry.
/// Every turn that made or changed a page ends with its chip, so the newest
/// version is always one click away (a quiet "Edited" line was missed).
import { FOUNDRY_KINDS, type FoundryKind } from "@demesne/protocol";
import type { ToolEntry, WorkbenchEntry } from "@demesne/workbench/entries.ts";
import { KIND_ICON, KIND_WORD } from "./foundry-page.ts";

export interface ChatArtifact { id: string; title: string; kind: FoundryKind; version: number }

/** Successful saves and edits are the durable link between a conversation and its chips.
 * Keep the last save of each artifact in a turn; failed or unfinished saves
 * must never appear to be completed work. */
export function chatArtifacts(entries: readonly Pick<ToolEntry, "name" | "state" | "message">[]): ChatArtifact[] {
  const saved = new Map<string, ChatArtifact>();
  for (const entry of entries) {
    if ((entry.name !== "foundry_save" && entry.name !== "foundry_edit") || entry.state !== "done" || !entry.message) continue;
    try {
      const value = JSON.parse(entry.message);
      if (!value || typeof value.id !== "string" || !/^[\w-]{1,200}$/.test(value.id)
        || typeof value.title !== "string" || !FOUNDRY_KINDS.includes(value.kind)
        || !Number.isSafeInteger(value.version) || value.version < 1) continue;
      saved.set(value.id, { id: value.id, title: value.title, kind: value.kind, version: value.version });
    } catch { /* Older or failed tool output remains available in the step. */ }
  }
  return [...saved.values()];
}

interface ChipOptions {
  open(artifact: ChatArtifact): void | Promise<unknown>;
}

/** The chip's words: what it is and which version. */
export const chipWords = (artifact: ChatArtifact) => `${KIND_WORD[artifact.kind]} · v${artifact.version}`;

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
  // Its kind's tile; nothing live runs in the chat.
  const tile = document.createElement("span");
  tile.className = "fd-chip-thumb";
  tile.innerHTML = KIND_ICON[artifact.kind];
  const text = document.createElement("span"), words = document.createElement("span");
  text.className = "fd-chip-text";
  words.textContent = chipWords(artifact);
  text.append(title, words);
  const open = document.createElement("span");
  open.className = "fd-chip-open";
  open.textContent = "Open";
  node.replaceChildren(tile, text, open);
  node.setAttribute("aria-label", `Open ${artifact.title}, ${chipWords(artifact)}`);
}

/** The chips of one turn, kept across repaints so focus and state survive. */
export class FoundryChatArtifacts {
  readonly element = document.createElement("div");
  private readonly chips = new Map<string, { artifact: ChatArtifact; node: HTMLButtonElement }>();
  artifacts: ChatArtifact[] = [];
  constructor(private readonly options: ChipOptions) {
    this.element.className = "fd-chips";
    this.element.hidden = true;
  }
  update(entries: readonly WorkbenchEntry[]) {
    const artifacts = chatArtifacts(entries.filter((entry): entry is ToolEntry => entry.type === "tool"));
    const keys = new Set(artifacts.map(artifact => `${artifact.id}:${artifact.version}`));
    for (const [key, item] of this.chips) if (!keys.has(key)) { item.node.remove(); this.chips.delete(key); }
    artifacts.forEach((artifact, index) => {
      const key = `${artifact.id}:${artifact.version}`;
      let item = this.chips.get(key);
      if (!item) {
        item = { artifact, node: chip(artifact, this.options) };
        this.chips.set(key, item);
      }
      if (this.element.children[index] !== item.node) this.element.insertBefore(item.node, this.element.children[index] ?? null);
    });
    this.artifacts = artifacts;
    this.element.hidden = !artifacts.length;
    return artifacts;
  }
  dispose() { for (const item of this.chips.values()) item.node.remove(); this.chips.clear(); this.element.remove(); }
}
