import { FOUNDRY_KINDS, type FoundryKind } from "@demesne/protocol";
import type { ToolEntry, WorkbenchEntry } from "@demesne/workbench/entries.ts";
import { frameURL, KIND_WORD } from "./foundry-page.ts";

export interface ChatArtifact { id: string; title: string; kind: FoundryKind; version: number }

/** Successful saves are the durable link between a conversation and its previews.
 * Keep the last save of each artifact in a turn; failed or unfinished saves
 * must never appear to be completed work. */
export function chatArtifacts(entries: readonly Pick<ToolEntry, "name" | "state" | "message">[]): ChatArtifact[] {
  const saved = new Map<string, ChatArtifact>();
  for (const entry of entries) {
    if (entry.name !== "foundry_save" || entry.state !== "done" || !entry.message) continue;
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

interface InlineOptions {
  read(artifact: ChatArtifact): Promise<{ source: string }>;
  markdown(source: string): string;
  open(artifact: ChatArtifact): void | Promise<unknown>;
  revise(artifact: ChatArtifact): void | Promise<unknown>;
  export(artifact: ChatArtifact): void | Promise<unknown>;
}

function button(label: string, action: () => void) {
  const node = document.createElement("button");
  node.type = "button";
  node.textContent = label;
  node.addEventListener("click", action);
  return node;
}

class InlineArtifact {
  readonly element = document.createElement("section");
  private source?: Promise<string>;
  private disposed = false;

  constructor(readonly artifact: ChatArtifact, options: InlineOptions) {
    const root = this.element;
    root.className = "fd-chat-artifact";
    root.dataset.artifactId = artifact.id;
    root.dataset.version = String(artifact.version);
    root.setAttribute("aria-label", `${artifact.title} artifact`);
    const header = document.createElement("div");
    header.className = "fd-chat-head";
    const heading = document.createElement("div"), title = document.createElement("strong"), meta = document.createElement("span");
    title.textContent = artifact.title;
    meta.textContent = `${KIND_WORD[artifact.kind]} · v${artifact.version} · Foundry`;
    heading.append(title, meta);
    header.append(heading);
    const error = document.createElement("p");
    error.className = "fd-chat-error";
    error.hidden = true;
    error.setAttribute("role", "alert");
    const action = (label: string, fn: (artifact: ChatArtifact) => void | Promise<unknown>) => button(label, () => {
      void Promise.resolve().then(() => fn(artifact)).catch(reason => {
        error.textContent = reason instanceof Error ? reason.message : String(reason);
        error.hidden = false;
      });
    });
    header.append(action("Open in Foundry", options.open));

    const toolbar = document.createElement("div");
    toolbar.className = "fd-chat-toolbar";
    const preview = document.createElement("div");
    preview.className = `fd-chat-preview ${artifact.kind}`;
    const code = document.createElement("pre");
    code.className = "fd-chat-code";
    code.hidden = true;
    code.tabIndex = 0;
    code.setAttribute("aria-label", `${artifact.title} source`);
    const load = () => this.source ??= options.read(artifact).then(value => value.source).catch(reason => {
      this.source = undefined;
      throw reason;
    });
    const populate = async (target: HTMLElement, markdown = false) => {
      target.textContent = "Loading…";
      target.setAttribute("aria-busy", "true");
      try {
        const source = await load();
        if (this.disposed) return;
        if (markdown) target.innerHTML = options.markdown(source);
        else target.textContent = source;
      } catch (reason) {
        if (this.disposed) return;
        target.textContent = `Couldn’t load this artifact. ${reason instanceof Error ? reason.message : String(reason)} `;
        target.append(button("Retry", () => { void populate(target, markdown); }));
      } finally { target.removeAttribute("aria-busy"); }
    };
    const showPreview = button("Preview", () => show(false));
    const showCode = button("Code", () => show(true));
    const show = (source: boolean) => {
      preview.hidden = source;
      code.hidden = !source;
      showPreview.setAttribute("aria-pressed", String(!source));
      showCode.setAttribute("aria-pressed", String(source));
      if (source) void populate(code);
    };
    showPreview.setAttribute("aria-pressed", "true");
    showCode.setAttribute("aria-pressed", "false");
    const views = document.createElement("div");
    views.className = "fd-chat-segments";
    views.setAttribute("role", "group");
    views.setAttribute("aria-label", "Artifact view");
    views.append(showPreview, showCode);
    toolbar.append(views);

    if (artifact.kind === "markdown") {
      preview.classList.add("markdown");
      void populate(preview, true);
    } else {
      const frame = document.createElement("iframe");
      frame.src = frameURL(artifact.id, artifact.version);
      frame.title = `${artifact.title} interactive preview`;
      frame.setAttribute("sandbox", "allow-scripts allow-forms allow-modals");
      frame.referrerPolicy = "no-referrer";
      frame.loading = "lazy";
      preview.append(frame);
      if (artifact.kind === "html") {
        const widths = document.createElement("div");
        widths.className = "fd-chat-segments fd-chat-widths";
        widths.setAttribute("role", "group");
        widths.setAttribute("aria-label", "Preview width");
        const desktop = button("Desktop", () => width(false)), phone = button("Phone", () => width(true));
        const width = (small: boolean) => {
          preview.classList.toggle("phone", small);
          desktop.setAttribute("aria-pressed", String(!small));
          phone.setAttribute("aria-pressed", String(small));
        };
        width(false);
        widths.append(desktop, phone);
        toolbar.append(widths);
      }
    }
    const footer = document.createElement("div");
    footer.className = "fd-chat-footer";
    footer.append(action("Revise", options.revise), action("Export", options.export));
    const hint = document.createElement("span");
    hint.textContent = artifact.kind === "html" ? "Interact with the preview, or ask for a change below." : "Ask for a change below.";
    footer.append(hint);
    root.append(header, toolbar, preview, code, error, footer);
  }

  dispose() { this.disposed = true; this.element.remove(); }
}

/** This lives beside the turn's changing text shell. An iframe must stay
 * connected during streaming, completion, step folding and later messages:
 * reattaching it would reset form input, buttons and application state. */
export class FoundryChatArtifacts {
  readonly element = document.createElement("div");
  private readonly views = new Map<string, InlineArtifact>();
  constructor(private readonly options: InlineOptions) {
    this.element.className = "fd-chat-artifacts";
    this.element.hidden = true;
  }
  update(entries: readonly WorkbenchEntry[]) {
    const artifacts = chatArtifacts(entries.filter((entry): entry is ToolEntry => entry.type === "tool"));
    const keys = new Set(artifacts.map(artifact => `${artifact.id}:${artifact.version}`));
    for (const [key, view] of this.views) if (!keys.has(key)) { view.dispose(); this.views.delete(key); }
    artifacts.forEach((artifact, index) => {
      const key = `${artifact.id}:${artifact.version}`;
      let view = this.views.get(key);
      if (!view) {
        view = new InlineArtifact(artifact, this.options);
        this.views.set(key, view);
      }
      if (this.element.children[index] !== view.element) this.element.insertBefore(view.element, this.element.children[index] ?? null);
    });
    this.element.hidden = !artifacts.length;
  }
  dispose() { for (const view of this.views.values()) view.dispose(); this.views.clear(); }
}
