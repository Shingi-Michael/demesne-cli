/// Foundry: the agent makes things for the person — HTML prototypes, SVG
/// graphics, Markdown documents — as text Demesne renders in a sandbox. Every
/// save is a new version, so revisions never lose the earlier work. A revision
/// names the version it was read from, so a version the agent has not seen is
/// never overwritten; small changes go through foundry_edit as exact find and
/// replace, like edits to a file. The tools ride along in every chat, so
/// their text is kept short, and a page's source leaves the transcript
/// once its turn is over (forgetFoundrySources): the artifact is stored,
/// and foundry_read brings it back when the agent needs it.
import type { DemesneStore } from "@demesne/storage";
import { FOUNDRY_KINDS, FOUNDRY_MAX_SOURCE_BYTES, isRecord, type FoundryKind, type ModelMessage } from "@demesne/protocol";
import type { AgentTool } from "./tools.ts";

// Foundry stores artifacts in Demesne, so these tools need no project folder.
export const FOUNDRY_TOOL_NAMES = new Set(["foundry_read", "foundry_save", "foundry_edit"]);

/// Where an artifact may load from (the frame's policy allows exactly this).
export const FOUNDRY_LIBRARY_HOSTS = ["cdnjs.cloudflare.com", "cdn.jsdelivr.net", "unpkg.com"] as const;

/// The kit every page starts from, served to its frame from inside the app
/// (apps/desktop/foundry-kit, policy.ts FOUNDRY_KIT): Demesne's type,
/// colours, light and dark, buttons, inputs, tables, cards, and anime.js.
export const FOUNDRY_KIT_STYLE = "foundry://kit/base.css", FOUNDRY_KIT_SCRIPT = "foundry://kit/anime.js";

const FILE_RULES = `HTML is one document that starts with <link rel="stylesheet" href="${FOUNDRY_KIT_STYLE}"> (the kit: light and dark from the system, Inter at 14px, `
  + "one ink with --secondary/--muted/--hair/--tone tints, --accent, radii 8 and 12; plain elements styled; classes .container(.narrow) .card(.outlined/.raised) .row(.between) .stack .grid(.two/.three) "
  + `.pill(.accent/.ok/.warn/.bad) .tabs .list .eyebrow .muted .secondary .sp; buttons .primary .quiet .danger .small) and, when it moves, <script src="${FOUNDRY_KIT_SCRIPT}"></script> (anime.js 4 as window.anime; name each motion with demesne.motion("Arrive", timeline) so the person can play and scrub it under the page). `
  + "Other outside loads: pinned scripts from " + FOUNDRY_LIBRARY_HOSTS.join(", ") + " (react@18.3.1, never react@18) and Google Fonts; everything else is blocked, so images are inline SVG or data URIs. "
  + "SVG is one <svg> with a viewBox. Under 512 KB.";

/// The design brief every artifact follows, so Foundry's work reads as one
/// competent hand: the kit carries the look, the page brings content,
/// layout and its own character.
export const DESIGN_BRIEF = "Design brief: a title of two to four words. Lean on the kit: write real content and layout, little CSS of your own, and use its variables for anything you add "
  + "(never fixed greys or shadows on flat things). Give the page its own character by setting --accent, and --ink/--paper for a tinted page, on :root, plus at most one display face from Google Fonts for headings if it fits. "
  + "Works at phone width with no horizontal scroll. Real content, never lorem ipsum; interactive mockups have working controls. No gradient heroes, emoji bullets, purple on white, glassmorphism or other stock AI looks. "
  + "Motion with anime.js: things arrive once (300 to 600ms, staggered), respond fast (140 to 220ms), nothing loops; none under prefers-reduced-motion: reduce. Demesne's own UI: the kit as it is, no menus or side panels.";

const GUIDE = FILE_RULES + " " + DESIGN_BRIEF;

/// What stands in for a page's source once its turn is over.
export const FORGOTTEN_SOURCE = "[source omitted from history; foundry_read the artifact for it]";

const forget = (value: unknown, callName: string) =>
  callName === "foundry_save" && isRecord(value) && typeof value.source === "string" ? { ...value, source: FORGOTTEN_SOURCE }
    : callName === "foundry_read" && isRecord(value) && typeof value.source === "string" ? { ...value, source: FORGOTTEN_SOURCE }
    : null;

const forgetJSON = (text: string, callName: string) => {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return null; }
  const forgotten = forget(parsed, callName);
  return forgotten ? JSON.stringify(forgotten) : null;
};

/// A finished turn's messages without the page sources in them: the source
/// the agent sent to foundry_save and the one foundry_read gave back, in
/// the tool calls, their results and the retained Responses items alike.
/// The artifact itself is kept, so the agent reads it again when it needs
/// the text; what stays is the title, kind, version and note.
export function forgetFoundrySources<T extends ModelMessage>(messages: T[]): T[] {
  const names = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const call of message.toolCalls ?? []) names.set(call.id, call.name);
  }
  return messages.map((message) => {
    if (message.role === "assistant" && message.toolCalls?.some((call) => FOUNDRY_TOOL_NAMES.has(call.name))) {
      const toolCalls = message.toolCalls.map((call) => {
        const forgotten = forgetJSON(call.arguments, call.name);
        return forgotten ? { ...call, arguments: forgotten } : call;
      });
      const responses = message.responses
        ? { ...message.responses, output: message.responses.output.map((item) => {
          if (item.type !== "function_call" || typeof item.arguments !== "string") return item;
          const forgotten = forgetJSON(item.arguments, names.get(String(item.call_id)) ?? "");
          return forgotten ? { ...item, arguments: forgotten } : item;
        }) }
        : undefined;
      return { ...message, toolCalls, ...(responses ? { responses } : {}) };
    }
    if (message.role === "tool" && names.get(message.toolCallId) === "foundry_read") {
      const forgotten = forgetJSON(message.content, "foundry_read");
      return forgotten ? { ...message, content: forgotten } : message;
    }
    return message;
  });
}

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
      description: "Show the person something they can see, click or compare: a screen or layout, a flow, an interactive prototype, a small game or tool, a chart or diagram, a logo or palette, a page or one-pager. It opens live beside the chat. "
        + "Omit id to create; pass id and base_version to replace the whole source as a new version (small changes: foundry_edit). "
        + GUIDE,
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Omit to create." },
          title: { type: "string", maxLength: 200 },
          kind: { type: "string", enum: [...FOUNDRY_KINDS], description: "Required when creating." },
          source: { type: "string", description: "The complete source." },
          base_version: { type: "integer", minimum: 1, description: "When revising: the version you read." },
          note: { type: "string", maxLength: 300, description: "What changed, in a few words." },
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
      description: "Change part of a Foundry artifact without resending it: exact find-and-replace edits on the version you read, saved as a new version. "
        + "Each find must match exactly once (all: true replaces every occurrence). Refused if the artifact moved past base_version.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          base_version: { type: "integer", minimum: 1, description: "The version you read." },
          edits: {
            type: "array", minItems: 1, maxItems: 50,
            items: {
              type: "object",
              properties: {
                find: { type: "string", minLength: 1, description: "Exact text from the current source." },
                replace: { type: "string" },
                all: { type: "boolean", description: "Replace every occurrence." },
              },
              required: ["find", "replace"],
              additionalProperties: false,
            },
          },
          title: { type: "string", maxLength: 200 },
          note: { type: "string", maxLength: 300, description: "What changed, in a few words." },
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
      description: "List Foundry artifacts (no id), or read one's current source (or a version) with the version number you pass as base_version to foundry_edit or foundry_save.",
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
