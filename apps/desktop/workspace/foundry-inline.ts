/// What a chat made in Foundry, in the conversation: a chip per artifact,
/// the way Claude shows an artifact. A kind tile, the title and "Prototype ·
/// v2"; nothing live runs in the chat. Click opens the page in the pane
/// beside the conversation (foundry-pane.ts); the open one wears a tone.
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
  /// Whether the pane shows this artifact at this version.
  isOpen(artifact: ChatArtifact): boolean;
}

/** What Foundry is writing, from a save still being drafted: the title
 * arrives early in the arguments, long before the page's source is done. */
export function makingTitle(tools: readonly Pick<ToolEntry, "name" | "state" | "input" | "drafting" | "draftArguments">[]): string | null {
  const writing = tools.findLast((tool) => tool.name === "foundry_save" && (tool.drafting || tool.state === "running"));
  if (!writing) return null;
  if (typeof writing.input.title === "string" && writing.input.title) return writing.input.title;
  const found = /"title"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(writing.draftArguments ?? "");
  if (!found) return "Something new";
  try { return (JSON.parse(`"${found[1]}"`) as string) || "Something new"; } catch { return "Something new"; }
}

/** The chip's words: what it is and which version. */
export const chipWords = (artifact: ChatArtifact) => `${KIND_WORD[artifact.kind]} · v${artifact.version}`;

function chip(artifact: ChatArtifact, options: ChipOptions) {
  const node = document.createElement("button");
  node.type = "button";
  node.className = "fd-chip";
  node.dataset.artifactId = artifact.id;
  node.dataset.version = String(artifact.version);
  node.setAttribute("aria-label", `Open ${artifact.title}, ${chipWords(artifact)}`);
  const tile = document.createElement("span");
  tile.className = "fd-chip-ic";
  tile.innerHTML = KIND_ICON[artifact.kind];
  const text = document.createElement("span");
  text.className = "fd-chip-text";
  const title = document.createElement("b"), words = document.createElement("span");
  title.textContent = artifact.title;
  words.textContent = chipWords(artifact);
  text.append(title, words);
  node.append(tile, text);
  node.addEventListener("click", () => { void options.open(artifact); });
  return node;
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
    this.mark();
    return artifacts;
  }
  /// The chip whose artifact the pane shows wears a tone.
  mark() {
    for (const item of this.chips.values()) item.node.setAttribute("aria-pressed", String(this.options.isOpen(item.artifact)));
  }
  dispose() { for (const item of this.chips.values()) item.node.remove(); this.chips.clear(); this.element.remove(); }
}
