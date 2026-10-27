/// Foundry: the agent makes things for the person — HTML prototypes, SVG
/// graphics, Markdown documents — as text Demesne renders in a sandbox. Every
/// save is a new version, so revisions never lose the earlier work. A revision
/// names the version it was read from, so a version the agent has not seen is
/// never overwritten; small changes go through foundry_edit as exact find and
/// replace, like edits to a file.
import type { DemesneStore } from "@demesne/storage";
import { FOUNDRY_KINDS, FOUNDRY_MAX_SOURCE_BYTES, isRecord, type FoundryKind } from "@demesne/protocol";
import type { AgentTool } from "./tools.ts";

// Foundry stores artifacts in Demesne, so these tools need no project folder.
export const FOUNDRY_TOOL_NAMES = new Set(["foundry_read", "foundry_save", "foundry_edit"]);

/// Where an artifact may load from (the frame's policy allows exactly this).
export const FOUNDRY_LIBRARY_HOSTS = ["cdnjs.cloudflare.com", "cdn.jsdelivr.net", "unpkg.com"] as const;

const FILE_RULES = "HTML is one document with inline CSS and JS. The only outside resources allowed are scripts from "
  + FOUNDRY_LIBRARY_HOSTS.join(", ") + " at an exact pinned version (react@18.3.1, never react or react@18) and Google Fonts stylesheets; "
  + "every other request (fetch, images, other hosts) is blocked, so images are inline SVG or data URIs. SVG must be one <svg> element with a viewBox. Markdown is a document. Keep sources under 512 KB.";

/// The design brief every artifact follows, so Foundry's work reads as one
/// hand; the tokens are Demesne's own, so a prototype of Demesne matches the app.
export const DESIGN_BRIEF = "Design brief: a title of two to four words. Define every colour as a custom property on :root and redefine them for dark mode under "
  + "@media (prefers-color-scheme: dark); give body an explicit background. One ink and tints of it: text at full strength, secondary text at 76%, muted at 56%, "
  + "hairlines at 8% and tones at 4% (no solid 1px grey outlines, no drop shadows on flat things), radii 8px and 12px, a 13px to 15px system or Inter type ramp with 1.5 line height, "
  + "motion 140 to 220ms under prefers-reduced-motion: no-preference. Works at phone width with 16px side gutters and no horizontal scroll. "
  + "Real content, not lorem ipsum. No gradient heroes, emoji bullets, purple-on-white, glassmorphism or other stock AI looks. "
  + "Interactive mockups have working controls. When the person asks for Demesne's own UI, use Demesne's look: neutral greys, hairlines, 13px base, no menus or side panels.";

const GUIDE = FILE_RULES + " " + DESIGN_BRIEF;

const clean = (value: unknown, max: number) => typeof value === "string" ? value.slice(0, max) : undefined;

function baseVersionOf(input: Record<string, unknown>) {
  if (input.base_version === undefined) return undefined;
  if (!Number.isSafeInteger(input.base_version) || (input.base_version as number) < 1) throw new Error("[invalid_input] base_version must be the version number you read. Hint: foundry_read returns it");
  return input.base_version as number;
}

/// A save that lost the race (the artifact moved past the version the agent
/// read) comes back as a conflict the agent can resolve by reading again.
function conflict(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  if (/is at version/.test(message)) throw new Error(`[conflict] ${message}. Hint: foundry_read the latest version, carry your change onto it, then save with that base_version`);
  throw error;
}

export function foundrySaveTool(store: DemesneStore): AgentTool {
  return {
    definition: {
      name: "foundry_save",
      description: "Create a design, prototype, graphic or document with an interactive preview directly in the chat, and save it to Foundry. "
        + "Use for anything the person wants made as an artifact (a landing page, UI mockup, logo, icon, diagram, chart, one-pager). "
        + "Omit id to create a new artifact; pass the id of an existing one to replace its whole source as a new version, with base_version set to the version you read "
        + "(for small changes use foundry_edit instead). "
        + GUIDE + " Returns the artifact id and version.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Existing artifact to revise. Omit to create." },
          title: { type: "string", maxLength: 200 },
          kind: { type: "string", enum: [...FOUNDRY_KINDS], description: "Required when creating." },
          source: { type: "string", description: "The complete source." },
          base_version: { type: "integer", minimum: 1, description: "When revising: the version you read. The save is refused if the artifact has moved past it." },
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
      const baseVersion = id ? baseVersionOf(input) : undefined;
      const session = context.sessionId ? store.getSession(context.sessionId) : undefined;
      context.signal.throwIfAborted();
      let saved;
      try {
        saved = store.saveFoundryArtifact({ id, kind, title: clean(input.title, 200), source: input.source, note: clean(input.note, 300) ?? "", baseVersion,
          sessionId: context.sessionId ?? null, turnId: context.turnId ?? null, workspace: session?.workspace?.root ?? null });
      } catch (error) { conflict(error); }
      return JSON.stringify({ id: saved.id, title: saved.title, kind: saved.kind, version: saved.version,
        message: `Saved as version ${saved.version}. Its preview appears automatically in this chat and is kept in Foundry.` });
    },
  };
}

/// One exact edit: `find` must occur exactly once (or `all` replaces every
/// occurrence), so an edit never lands somewhere the agent did not mean.
interface FoundryEdit { find: string; replace: string; all?: boolean }

export function applyFoundryEdits(source: string, edits: FoundryEdit[]) {
  let out = source;
  edits.forEach((edit, index) => {
    const count = out.split(edit.find).length - 1;
    if (count === 0) throw new Error(`[no_match] Edit ${index + 1}: find text is not in the current version. Hint: foundry_read the latest version and copy the text exactly`);
    if (count > 1 && !edit.all) throw new Error(`[ambiguous] Edit ${index + 1}: find text occurs ${count} times. Hint: include more surrounding text, or set all: true`);
    out = edit.all ? out.split(edit.find).join(edit.replace) : out.replace(edit.find, () => edit.replace);
  });
  return out;
}

export function foundryEditTool(store: DemesneStore): AgentTool {
  return {
    definition: {
      name: "foundry_edit",
      description: "Change part of an existing Foundry artifact without resending it: exact find-and-replace edits applied to the version you read, saved as a new version. "
        + "Prefer this over foundry_save for any revision that leaves most of the source as it is. Each find must match the current source exactly once (set all to replace every occurrence). "
        + "The edits are refused if the artifact has moved past base_version. Returns the new version.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "The artifact to change." },
          base_version: { type: "integer", minimum: 1, description: "The version you read, from foundry_read or your last save." },
          edits: {
            type: "array", minItems: 1, maxItems: 50,
            items: {
              type: "object",
              properties: {
                find: { type: "string", minLength: 1, description: "Text copied exactly from the current source." },
                replace: { type: "string", description: "Its replacement; empty deletes it." },
                all: { type: "boolean", description: "Replace every occurrence instead of requiring exactly one." },
              },
              required: ["find", "replace"],
              additionalProperties: false,
            },
          },
          title: { type: "string", maxLength: 200, description: "A new title, if it changes." },
          note: { type: "string", maxLength: 300, description: "What this version changed, in a few words." },
        },
        required: ["id", "base_version", "edits"],
        additionalProperties: false,
      },
    },
    permission: () => null,
    async execute(input, context) {
      if (!isRecord(input) || typeof input.id !== "string" || !input.id) throw new Error("[invalid_input] foundry_edit needs the artifact id. Hint: foundry_read lists them");
      const baseVersion = baseVersionOf(input);
      if (baseVersion === undefined) throw new Error("[invalid_input] foundry_edit needs base_version. Hint: pass the version you read");
      if (!Array.isArray(input.edits) || input.edits.length === 0 || input.edits.length > 50) throw new Error("[invalid_input] edits must be 1 to 50 {find, replace} items");
      const edits: FoundryEdit[] = input.edits.map((edit, index) => {
        if (!isRecord(edit) || typeof edit.find !== "string" || !edit.find || typeof edit.replace !== "string") throw new Error(`[invalid_input] Edit ${index + 1} needs find (non-empty) and replace strings`);
        return { find: edit.find, replace: edit.replace, all: edit.all === true };
      });
      const current = store.getFoundryArtifact(input.id);
      if (!current) throw new Error("[not_found] No such Foundry artifact. Hint: call foundry_read without id to list them");
      if (current.version !== baseVersion) conflict(new Error(`Foundry artifact is at version ${current.version}, not ${baseVersion}`));
      const source = applyFoundryEdits(current.source, edits);
      if (Buffer.byteLength(source) > FOUNDRY_MAX_SOURCE_BYTES) throw new Error("[too_large] The edited source is over 512 KB. Hint: simplify it");
      const session = context.sessionId ? store.getSession(context.sessionId) : undefined;
      context.signal.throwIfAborted();
      let saved;
      try {
        saved = store.saveFoundryArtifact({ id: input.id, title: clean(input.title, 200), source, note: clean(input.note, 300) ?? "", baseVersion,
          sessionId: context.sessionId ?? null, turnId: context.turnId ?? null, workspace: session?.workspace?.root ?? null });
      } catch (error) { conflict(error); }
      return JSON.stringify({ id: saved.id, title: saved.title, kind: saved.kind, version: saved.version, edits: edits.length,
        message: `Saved as version ${saved.version} with ${edits.length} edit${edits.length === 1 ? "" : "s"}. The preview in this chat updates by itself.` });
    },
  };
}

export function foundryReadTool(store: DemesneStore): AgentTool {
  return {
    definition: {
      name: "foundry_read",
      description: "Read Foundry artifacts. Without id, lists them (newest first). With id, returns that artifact's current source (or an earlier version) and its version number, which you pass as base_version to foundry_edit or foundry_save.",
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
