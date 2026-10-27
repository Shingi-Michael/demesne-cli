/// Foundry: the agent makes things for the person — HTML prototypes, SVG
/// graphics, Markdown documents — as text Demesne renders in a sandbox. Every
/// save is a new version, so revisions never lose the earlier work.
import type { DemesneStore } from "@demesne/storage";
import { FOUNDRY_KINDS, FOUNDRY_MAX_SOURCE_BYTES, isRecord, type FoundryKind } from "@demesne/protocol";
import type { AgentTool } from "./tools.ts";

// Foundry stores artifacts in Demesne, so these tools need no project folder.
export const FOUNDRY_TOOL_NAMES = new Set(["foundry_read", "foundry_save"]);

const GUIDE = "HTML must be one self-contained document: inline CSS and JS only, no external scripts, fonts, images or network requests (they are blocked). "
  + "SVG must be one <svg> element with a viewBox. Markdown is a document. Keep sources under 512 KB.";

export function foundrySaveTool(store: DemesneStore): AgentTool {
  return {
    definition: {
      name: "foundry_save",
      description: "Create a design, prototype, graphic or document with an interactive preview directly in the chat, and save it to Foundry. "
        + "Use for anything the person wants made as an artifact (a landing page, UI mockup, logo, icon, diagram, chart, one-pager). "
        + "Omit id to create a new artifact; pass the id of an existing one to save a new version of it (send the complete source each time). "
        + GUIDE + " Returns the artifact id and version.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Existing artifact to revise. Omit to create." },
          title: { type: "string", maxLength: 200 },
          kind: { type: "string", enum: [...FOUNDRY_KINDS], description: "Required when creating." },
          source: { type: "string", description: "The complete source." },
          note: { type: "string", maxLength: 300, description: "What this version changed, in a few words." },
        },
        required: ["source"],
        additionalProperties: false,
      },
    },
    permission: () => null,
    async execute(input, context) {
      if (!isRecord(input) || typeof input.source !== "string" || !input.source.trim()) throw new Error("[invalid_input] foundry_save needs the complete source. Hint: send the whole file as source");
      if (Buffer.byteLength(input.source) > FOUNDRY_MAX_SOURCE_BYTES) throw new Error("[too_large] Source is over 512 KB. Hint: simplify or split it");
      const id = typeof input.id === "string" && input.id ? input.id : undefined;
      const kind = typeof input.kind === "string" ? input.kind as FoundryKind : undefined;
      if (!id && (!kind || !FOUNDRY_KINDS.includes(kind))) throw new Error("[invalid_input] kind must be html, svg or markdown when creating. Hint: pick the kind that fits");
      if (!id && (typeof input.title !== "string" || !input.title.trim())) throw new Error("[invalid_input] A new artifact needs a title. Hint: name it in a few words");
      const session = context.sessionId ? store.getSession(context.sessionId) : undefined;
      context.signal.throwIfAborted();
      const saved = store.saveFoundryArtifact({ id, kind, title: typeof input.title === "string" ? input.title : undefined,
        source: input.source, note: typeof input.note === "string" ? input.note.slice(0, 300) : "",
        sessionId: context.sessionId ?? null, turnId: context.turnId ?? null, workspace: session?.workspace?.root ?? null });
      return JSON.stringify({ id: saved.id, title: saved.title, kind: saved.kind, version: saved.version,
        message: `Saved as version ${saved.version}. Its preview appears automatically in this chat and is kept in Foundry.` });
    },
  };
}

export function foundryReadTool(store: DemesneStore): AgentTool {
  return {
    definition: {
      name: "foundry_read",
      description: "Read Foundry artifacts. Without id, lists them (newest first). With id, returns that artifact's current source (or an earlier version) so you can revise it with foundry_save.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" }, version: { type: "integer", minimum: 1 } },
        additionalProperties: false,
      },
    },
    permission: () => null,
    async execute(input) {
      const args = isRecord(input) ? input : {};
      if (typeof args.id !== "string" || !args.id) {
        return JSON.stringify(store.listFoundryArtifacts().slice(0, 50).map(({ id, title, kind, version, updatedAt, workspace }) => ({ id, title, kind, version, updatedAt, workspace })));
      }
      const found = store.getFoundryArtifact(args.id, typeof args.version === "number" ? args.version : undefined);
      if (!found) throw new Error("[not_found] No such Foundry artifact or version. Hint: call foundry_read without id to list them");
      return JSON.stringify({ id: found.id, title: found.title, kind: found.kind, version: found.version, source: found.source,
        versions: found.versions.map(({ version, note, createdAt }) => ({ version, note, createdAt })) });
    },
  };
}
