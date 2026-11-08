/// Foundry: the agent makes things for the person — HTML prototypes, SVG
/// graphics, decks, docs and dashboards — as text Demesne renders in a sandbox. Every
/// save is a new version, so revisions never lose the earlier work. A revision
/// names the version it was read from, so a version the agent has not seen is
/// never overwritten; small changes go through foundry_edit as exact find and
/// replace, like edits to a file. The tools ride along in every chat, so
/// their text is kept short, and a page's source leaves the transcript
/// once its turn is over (forgetFoundrySources): the artifact is stored,
/// and foundry_read brings it back when the agent needs it.
import type { DemesneStore } from "@demesne/storage";
import { LOOKS_PER_TURN, lookReport, tryReport, type FoundryLook, type FoundryTry } from "./foundry-look.ts";
import type { StructuredToolResult } from "./artifacts.ts";
import { FOUNDRY_KINDS, FOUNDRY_MAX_SOURCE_BYTES, isRecord, parseSteps, TRY_MAX_STEPS, type FoundryKind, type ModelMessage, type TryStep } from "@demesne/protocol";
import type { AgentTool } from "./tools.ts";

// Foundry stores artifacts in Demesne, so these tools need no project folder.
export const FOUNDRY_TOOL_NAMES = new Set(["foundry_read", "foundry_save", "foundry_edit", "foundry_try"]);

/// Where an artifact may load from (the frame's policy allows exactly this).
export const FOUNDRY_LIBRARY_HOSTS = ["cdnjs.cloudflare.com", "cdn.jsdelivr.net", "unpkg.com"] as const;

/// The kit every page starts from, served to its frame from inside the app
/// (apps/desktop/foundry-kit, policy.ts FOUNDRY_KIT): Demesne's type,
/// colours, light and dark, buttons, inputs, tables, cards, and anime.js.
export const FOUNDRY_KIT_STYLE = "foundry://kit/base.css", FOUNDRY_KIT_SCRIPT = "foundry://kit/anime.js", FOUNDRY_PARTS_SCRIPT = "foundry://kit/parts.js";

/// The parts catalogue (apps/desktop/foundry-kit/parts.js), read on demand
/// with foundry_read id "kit:parts" so it doesn't ride along in every chat.
export const PARTS_GUIDE = `Foundry parts: <script src="${FOUNDRY_PARTS_SCRIPT}"></script> after the kit stylesheet. Custom elements, drawn into the page's own DOM (style them with your CSS). Attributes only, lists split with |. The parts work: a mockup is something to use, not a picture of it.
Frames (the idea goes inside):
- <d-window title="Splits" width="900" height="400">…</d-window> a Mac window; width = its design width. A little narrower it scales to 85% at most; narrower than that it lays out at the width it has, so write its inside to reflow.
- <d-browser url="shop.example/orders" width="1100" height="520">…</d-browser> a browser.
- <d-phone time="9:41">…</d-phone> a phone, 390 wide; its inside scrolls.
Demesne itself (its real look: glass sidebar, tabs, dark card, pink release line):
- <d-demesne page="Customize|Foundry|Search|…" tabs="Settings|Fix sidebar" chats="Tidy the sidebar|Drive picks" chat="Tidy the sidebar" project="demesne-cli" theme="dark|light" height="620">main content</d-demesne>; give a child slot="cards" to put it in the right column. Designed at 1100 wide; in a narrow frame (about 620) it lays out narrower, the sidebar slimmer. Its tabs, sidebar items and chats are buttons: clicking one lights it and shows the child with data-view of the same name (<div data-view="Settings">…</div>), and the open tab takes a clicked chat's name.
Places: any elements marked data-view="Name" are places (siblings; the first shows); anything with data-go="Name" goes there. Give every tab and chat you name a view, so nothing you click is dead.
- <d-message from="you">text</d-message>, <d-message meta="gpt-6.1 · 4s · 2 steps">answer</d-message> (the d. mark), <d-composer placeholder="Ask anything" mode="Ask" model="GPT-6.1" reply="first answer|second answer">: a real input; Enter puts the message above it, then the next reply (or answer it yourself: on its "send" event, event.detail.text, call event.preventDefault()).
- <d-card title="Changes" icon="git-branch">…</d-card>, <d-row title="Keep awake" note="While it works"><d-toggle on></d-toggle></d-row> (a settings row; group rows in a box), <d-seg options="Home|Last chat" value="Home">, <d-tabs items="Week|Month">.
Anywhere:
- <d-icon name="search" size="18">: plus x check chevron-right chevron-left chevron-down arrow-right arrow-up search menu home settings sliders user users bell mail chat calendar clock star heart bolt folder file code terminal git-branch image camera play pause trash edit copy download upload link lock eye sun moon cart tag chart trending-up pin globe sparkles drive foundry archive filter more info alert check-circle send mic sidebar phone laptop coffee leaf.
- <d-avatar name="Amara Okafor" size="28"> initials on a steady colour. demesne.sample.people(n) gives 12 names; demesne.sample.series(n, start, drift, seed) a believable number series.
- <d-chart type="line|area|bar|donut" values="4,6,5,8" labels="Mon,Tue,Wed,Thu" height="200"> in --accent.
- <d-stat label="This week" value="32.4 km" delta="+12%">.
- <d-compare recommended="A"><section data-option="A · Pills" note="calm">…</section>…</d-compare> options to choose between: a strip on top names them, one shows at a time at full size; the person answers in the chat. layout="side" puts small options (a button, a card) side by side instead.
- <d-mark>1</d-mark> a pink numbered call-out dot.
The parts are the frame; the idea inside is yours to design.`;

const FILE_RULES = `HTML is one document that starts with <link rel="stylesheet" href="${FOUNDRY_KIT_STYLE}"> (the kit: light and dark from the system, Inter at 14px, `
  + "one ink with --secondary/--muted/--hair/--tone tints, --accent, radii 8 and 12; plain elements styled; classes .container(.narrow) .card(.outlined/.raised) .row(.between) .stack .grid(.two/.three) "
  + `.pill(.accent/.ok/.warn/.bad) .tabs .list .eyebrow .muted .secondary .sp; buttons .primary .quiet .danger .small) and, when it moves, <script src="${FOUNDRY_KIT_SCRIPT}"></script> (anime.js 4 as window.anime). `
  + "Other outside loads: pinned scripts from " + FOUNDRY_LIBRARY_HOSTS.join(", ") + " (react@18.3.1, never react@18) and Google Fonts; everything else is blocked, so images are inline SVG or data URIs. "
  + `Mockups build on the parts (<script src="${FOUNDRY_PARTS_SCRIPT}"></script>: <d-demesne> for Demesne itself, <d-window> <d-browser> <d-phone> frames, <d-icon> <d-avatar> <d-chart> <d-stat> <d-compare>); foundry_read id "kit:parts" lists them. `
  + "SVG is one <svg> with a viewBox. Under 512 KB.";

/// The design brief every artifact follows. The kit is the floor, not the
/// ceiling: a brief that only said "lean on the kit" and listed don'ts made
/// every page the same plain template (own CSS fell to a third, no fonts,
/// no motion), so this one says what good looks like.
export const DESIGN_BRIEF = "Design brief: make it look designed, never like a template; the kit is the floor, not the ceiling. "
  + "First pick a direction in a few words (who it is for, the mood) and let it decide the rest. Title of two to four words. "
  + "One focal point and a clear hierarchy, from the kit's scales and nothing else: text sizes var(--text-xs|sm|md|lg|xl|display) (12 14 18 24 32 48px; one bigger hero size at most), spaces var(--space-1…8) (4 8 12 16 24 32 48 64px), tight leading and tracking on big text, dense areas against quiet ones. "
  + "A small palette: the kit's ink tints, --accent and at most two colours of your own (tints of them via color-mix); small text never lighter than --muted. "
  + "One strong move per page: an oversized number or headline, a bold colour field, an asymmetric layout, an SVG illustration or a striking chart. "
  + "Write as much CSS of your own as the design needs, on the kit's variables and scales: set --accent (and --ink/--paper for a tinted page) on :root, and a display face from Google Fonts when it fits. "
  + "Depth and detail where they earn it: layered surfaces, soft shadows only on things that float, real data, hover/selected/empty states, small SVG icons. "
  + "Asked for options or ideas: two or three genuinely different directions side by side, each named, and say which you would pick. "
  + "A mockup is the working thing at real size, not a poster of it: no headline or notes above it (say what it is in the chat), it fills the page, and every control does something: tabs and links go somewhere, inputs take typing, buttons change what shows. Options go in one <d-compare>, one at a time. "
  + "A mockup of an existing app matches that app's look (Demesne: build on <d-demesne>, views for its tabs and chats; no menus or side panels). People open it in a pane about 620px wide: it reads and works there, and at phone width with no horizontal scroll. Real content, never lorem ipsum. "
  + "Motion with anime.js: things arrive once (300 to 600ms, staggered), respond fast (140 to 220ms), nothing loops; none under prefers-reduced-motion: reduce. "
  + "Avoid stock AI looks: purple-on-white gradients, glassmorphism, emoji bullets, a generic hero over three cards.";

/// The ready kinds (apps/desktop/electron/foundry-kinds.ts): the model sends
/// content and Demesne draws it, so a deck, a report or a dashboard looks
/// designed every time and costs a fraction of a hand-made page.
export const READY_KINDS_RULES = "Ready kinds: slides are kind deck, a report, brief, memo or article kind doc, numbers at a glance kind dashboard. Demesne designs these, so their source is content only, no HTML or CSS: "
  + "Markdown with optional front matter at the top (---, title:, subtitle:, author:, date:, theme: paper|ink|forest|ocean|sand|plum, accent: #hex, ---); "
  + "```chart blocks (type: bar|line|area|hbar|donut, title:, labels: a, b, c, then a line per series, Name: 1, 2, 3); ```stats blocks (a tile per line: label | value | delta | note); > [!NOTE] / [!TIP] / [!WARNING] callouts. "
  + "A deck splits into slides on lines that are only ---: one idea per slide, few words; # 3.1× with a sentence becomes a big-number slide, a lone quote a quote slide, a heading and a chart a chart slide, a list with a chart a split "
  + "(<!-- layout: title|statement|number|quote|split|chart|points --> overrides). A dashboard's ## headings group its stats, charts and tables. Anything interactive or custom is html.";

/// Pages that remember (apps/desktop/foundry-kit/remember.js): Demesne puts
/// the runtime in front of any page that calls it, so the page needs no tag.
export const REMEMBER_RULES = "Pages can remember and ask, with no script tag: await demesne.save(name, jsonValue) and await demesne.load(name, fallback) keep what the person enters with the artifact (across closing, reloads and new versions; 256 KB; localStorage does not work here); "
  + "await demesne.ask(question) returns the chat model's answer as text, for a button the person presses (never on load or in a loop; a few a minute); await demesne.pick({accept}) lets them choose a file ({name, type, text} or {name, type, dataURL}). "
  + "Use them when the page is a tool to keep (a tracker, checklist, planner, journal, quiz): load on start, save on every change, show a saved state.";

const GUIDE = READY_KINDS_RULES + " " + FILE_RULES + " " + REMEMBER_RULES + " " + DESIGN_BRIEF;

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

export function foundrySaveTool(store: DemesneStore, look?: FoundryLook, looks = new Map<string, number>()): AgentTool {
  const tool: AgentTool = {
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
          kind: { type: "string", enum: [...FOUNDRY_KINDS], description: "Required when creating: deck, doc or dashboard (content Demesne designs), html (a page you design), svg, or markdown (plain notes)." },
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
      if (!id && (!kind || !FOUNDRY_KINDS.includes(kind))) throw new Error(`[invalid_input] kind must be one of ${FOUNDRY_KINDS.join(", ")} when creating. Hint: deck, doc or dashboard for slides, a report or numbers; html for anything else`);
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
  if (look) tool.executeWithArtifacts = async (input, context) => lookAfter(store, look, looks, await tool.execute(input, context), context);
  return tool;
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

export function foundryEditTool(store: DemesneStore, look?: FoundryLook, looks = new Map<string, number>()): AgentTool {
  const tool: AgentTool = {
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
  if (look) tool.executeWithArtifacts = async (input, context) => lookAfter(store, look, looks, await tool.execute(input, context), context);
  return tool;
}

export function foundryReadTool(store: DemesneStore): AgentTool {
  return {
    definition: {
      name: "foundry_read",
      description: "List Foundry artifacts (no id), the parts catalogue (id \"kit:parts\"), or read one's current source (or a version) with the version number you pass as base_version to foundry_edit or foundry_save.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" }, version: { type: "integer", minimum: 1 } },
        additionalProperties: false,
      },
    },
    permission: () => null,
    async execute(input) {
      const args = isRecord(input) ? input : {};
      if (args.id === "kit:parts") return PARTS_GUIDE;
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

/// The kinds that render as a page, so the look can see them.
const LOOKED_KINDS = new Set(["html", "deck", "doc", "dashboard"]);

/// After a page is saved: render it, and hand the model the faults
/// found and a picture at each width. Twice per artifact per turn at most.
async function lookAfter(store: DemesneStore, look: FoundryLook, looks: Map<string, number>, text: string, context: { turnId?: string; signal: AbortSignal }): Promise<string | StructuredToolResult> {
  let saved: Record<string, unknown>;
  try { saved = JSON.parse(text) as Record<string, unknown>; } catch { return text; }
  if (typeof saved.kind !== "string" || !LOOKED_KINDS.has(saved.kind) || typeof saved.id !== "string") return text;
  const key = `${context.turnId ?? ""}:${saved.id}`, seen = looks.get(key) ?? 0;
  if (seen >= LOOKS_PER_TURN) return text;
  const artifact = store.getFoundryArtifact(saved.id);
  if (!artifact) return text;
  const result = await look({ kind: artifact.kind, source: artifact.source, title: artifact.title }, context.signal).catch(() => null);
  if (!result) return text;
  looks.set(key, seen + 1);
  if (looks.size > 200) looks.delete(looks.keys().next().value!);
  const report = lookReport(result, seen + 1 >= LOOKS_PER_TURN);
  return { text: JSON.stringify({ ...saved, look: report.look }), images: report.images };
}

/// A turn tries one artifact at most this many times: the first try, and
/// two more after fixes.
export const TRIES_PER_TURN = 3;
const TRY_STEPS = TRY_MAX_STEPS;

/// Foundry tries its own page (pass 164 E): clicks, typing and keys run for
/// real in an off-screen window, and the model hears after each step what
/// changed, or that the control was covered, disabled or missing, plus the
/// page's tree and a picture. Only where the desktop app can render pages.
export function foundryTryTool(store: DemesneStore, tryer: FoundryTry, tries = new Map<string, number>()): AgentTool {
  const tool: AgentTool = {
    definition: {
      name: "foundry_try",
      description: "Use a Foundry page the way a person would, to check that it works: run up to 12 steps on its latest version (or one you name) in a hidden window, with real clicks and typing. "
        + "After each step you hear what visibly changed, or that nothing did, or that the control is covered, disabled or not found; then the page's tree (every heading and control: name, place, size, state) and a picture. "
        + "Use it after making or changing a page that has controls: run its main path (add an item, switch a tab, open and close a dialog, submit the form), at phone width too when layout matters. "
        + "Steps: {click: name}, {type: text, into?: name}, {key: Enter|Tab|Escape|Backspace|Space|ArrowUp|ArrowDown|ArrowLeft|ArrowRight}, {scroll: px}, {hover: name}, {wait: ms}. "
        + "A name is a control's visible text, label, aria-label or placeholder (a CSS selector also works). Pages that remember start empty here.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          version: { type: "integer", minimum: 1 },
          width: { type: "string", enum: ["desktop", "phone"], description: "desktop is 1280px (default), phone is 390px." },
          steps: { type: "array", minItems: 1, maxItems: TRY_STEPS, items: { type: "object" } },
        },
        required: ["id", "steps"],
        additionalProperties: false,
      },
    },
    // Nothing leaves the page and nothing is saved: it runs like a look.
    permission: () => null,
    async execute() { throw new Error("[unavailable] foundry_try needs the desktop app"); },
    async executeWithArtifacts(input, context) {
      const args = isRecord(input) ? input : {};
      if (typeof args.id !== "string" || !args.id) throw new Error("[invalid] id is required. Hint: foundry_read without id lists the artifacts");
      let steps: TryStep[];
      try { steps = parseSteps(args.steps); } catch (error) { throw new Error(`[invalid] ${error instanceof Error ? error.message : String(error)}`); }
      const found = store.getFoundryArtifact(args.id, typeof args.version === "number" ? args.version : undefined);
      if (!found) throw new Error("[not_found] No such Foundry artifact or version. Hint: call foundry_read without id to list them");
      if (!LOOKED_KINDS.has(found.kind)) throw new Error(`[invalid] A ${found.kind} artifact has nothing to try; only pages, decks, docs and dashboards do`);
      const key = `${context.turnId ?? ""}:${found.id}`, seen = tries.get(key) ?? 0;
      if (seen >= TRIES_PER_TURN) throw new Error(`[limit] This page was tried ${TRIES_PER_TURN} times this turn; answer with what you found`);
      tries.set(key, seen + 1);
      if (tries.size > 200) tries.delete(tries.keys().next().value!);
      const result = await tryer({ kind: found.kind, source: found.source, title: found.title }, { width: args.width === "phone" ? 390 : 1280, steps }, context.signal);
      if (!result) throw new Error("[unavailable] The page could not be tried just now");
      if (!result.steps.length && result.errors.length) throw new Error(`[unavailable] ${result.errors.join("; ")}`);
      const report = tryReport(result);
      return { text: JSON.stringify({ id: found.id, version: found.version, title: found.title, ...report.report }), images: report.images };
    },
  };
  return tool;
}
