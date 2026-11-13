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
import { FOUNDRY_KINDS, FOUNDRY_MAX_SOURCE_BYTES, isRecord, parseSteps, TRY_MAX_STEPS, type FoundryArtifactDetail, type FoundryKind, type FoundryWhy, type ModelMessage, type TryStep } from "@demesne/protocol";
import type { AgentTool, ToolContext } from "./tools.ts";
import { seenIn } from "./foundry-seen.ts";

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

/// How a page should look is not here: the design guide (design-guide.ts)
/// rides in the system prompt with the person's own rules, and this
/// description keeps to how the tool is called.
const DESIGN_POINTER = "How it should look: follow the Design guide in your instructions, rule by rule, with the person's own rules first.";

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

const GUIDE = READY_KINDS_RULES + " " + FILE_RULES + " " + REMEMBER_RULES + " " + DESIGN_POINTER;

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

/// At most three options in a page (pass 197 A): best of three, not eight.
export const MAX_OPTIONS = 3;
function checkOptions(kind: string | undefined, source: string) {
  if (kind !== undefined && kind !== "html") return;
  // "Today", the screen as it is now, is the comparison and not one of the three.
  const count = (source.match(/\bdata-option\s*=/g)?.length ?? 0) - (/\bdata-option\s*=\s*["']today\b/i.test(source) ? 1 : 0);
  if (count > MAX_OPTIONS) throw new Error(`[too_many_options] This page has ${count} options; at most ${MAX_OPTIONS}. Hint: keep the best ${MAX_OPTIONS}, recommended first`);
  // Several options always come with the one you would use (pass 208 A).
  // (recommended="A" on the <d-compare>, or data-recommended on the option of a page drawn without it).
  if (count > 1 && !/<d-compare\b[^>]*\brecommended\s*=\s*["']?[^\s"'>]/i.test(source) && !/<[^>]*\bdata-recommended\b[^>]*>/i.test(source))
    throw new Error(`[no_recommendation] This page has ${count} options and no pick. Hint: set recommended="<option name>" on the <d-compare> (or data-recommended on that option), put it first, and say why in the chat`);
}

/// One ask that makes several mockups marks the one it would use (pass 208
/// A): a second new mockup in the same ask is refused until one is marked.
function checkPick(store: DemesneStore, turnId: string | undefined, recommended: boolean | undefined) {
  if (!turnId || recommended === true) return;
  const made = store.foundryInTurn(turnId).filter((item) => item.version === 1);
  if (!made.length || made.some((item) => item.recommended)) return;
  throw new Error(`[no_recommendation] This ask already made ${made.map((item) => `"${item.title}"`).join(", ")}; with this one that is ${made.length + 1} mockups and none is marked as the one you would use. Hint: save this with recommended: true, or first foundry_edit the one you would use with only id and recommended: true, and say why in the chat`);
}

/// What a mockup was made from: an id, optionally "id@version".
function basedOnOf(store: DemesneStore, value: unknown) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new Error("[invalid_input] based_on is the id of the mockup this one is made from");
  const [id, at] = value.split("@");
  const found = store.getFoundryArtifact(id!);
  if (!found) throw new Error("[not_found] based_on names no Foundry artifact. Hint: foundry_read without id lists them");
  const version = at ? Number(at) : found.version;
  if (!found.versions.some((item) => item.version === version)) throw new Error(`[not_found] ${found.title} has no version ${at}`);
  return { id: found.id, version };
}

/// Pass 219 A: one naming rule, checked on save. A name says what the
/// thing is, so it can be found again weeks later.
const GENERIC_NAME = /^(?:(?:a |the |new |my |untitled |simple |test )?(?:mock-?ups?|mocks?|pages?|designs?|drafts?|prototypes?|ideas?|screens?|layouts?|concepts?|untitled|test|options?|versions?|artifacts?|things?)(?: [a-z0-9]{1,2}| \d+)?|options? [a-z0-9]+|v\d+|[a-z0-9]{1,2})$/i;
function checkName(title: unknown) {
  if (typeof title !== "string" || !title.trim()) return;
  const name = title.trim().replace(/[.!?]+$/, "");
  const words = name.split(/\s+/).length;
  if (GENERIC_NAME.test(name)) throw new Error(`[invalid_input] "${name}" doesn't say what it is. Hint: name it by what it shows, in two to four words, like "Roastery pricing" or "Invoice dashboard"; put an option's letter in note`);
  if (words > 6) throw new Error(`[invalid_input] "${name}" is ${words} words. Hint: name it in two to four words; the rest goes in description`);
}

/// The mockups each ask read (turn → the last one), so one made right after
/// says what it was based on even when the model doesn't (pass 219 A).
const readInTurn = new Map<string, { id: string; version: number }>();
function remember(turnId: string | undefined, id: string, version: number) {
  if (!turnId) return;
  readInTurn.delete(turnId);
  readInTurn.set(turnId, { id, version });
  if (readInTurn.size > 200) readInTurn.delete(readInTurn.keys().next().value!);
}

/// Every word of the query, in a mockup's name, description, version names,
/// whys or the asks that made it.
export function searchFoundry(store: DemesneStore, query: string) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const text = new Map<string, string[]>();
  for (const version of store.listFoundryVersions(2000)) {
    const parts = text.get(version.artifactId) ?? [];
    parts.push(version.note, version.ask ?? "", version.why ? `${version.why.direction} ${version.why.look} ${version.why.dropped}` : "");
    text.set(version.artifactId, parts);
  }
  return store.listFoundryArtifacts().filter((item) => {
    const haystack = [item.title, item.description, ...(text.get(item.id) ?? [])].join(" ").toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

const savedResult = (saved: FoundryArtifactDetail) => {
  const current = saved.versions.find((item) => item.version === saved.version);
  return { id: saved.id, title: saved.title, kind: saved.kind, version: saved.version, description: saved.description,
    note: current?.note ?? "", ...(current?.recommended ? { recommended: true } : {}), ...(current?.why ? { why: current.why } : {}) };
};

const clean = (value: unknown, max: number) => typeof value === "string" ? value.slice(0, max) : undefined;

/// Pass 218 A: every designed version says why it looks the way it does.
/// The person sees it as three quiet lines on the Foundry page, and the
/// answer in the chat says the same.
const WHY_SCHEMA = {
  type: "object",
  description: "Why it looks so; required on new html/svg versions.",
  properties: {
    direction: { type: "string", maxLength: 300, description: "Who it is for, the mood." },
    look_at: { type: "string", maxLength: 300, description: "What leads." },
    dropped: { type: "string", maxLength: 300, description: "What you left out, and why." },
    starts_from: { type: "string", maxLength: 300, description: "New mockups: the real thing you looked at (window, files), or \"new\"." },
  },
  required: ["direction", "look_at"],
  additionalProperties: false,
} as const;

const WHY_ANSWER = "In your answer, say the same why in plain words: the direction, what to look at first, and what you dropped.";

function whyOf(value: unknown): FoundryWhy | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("[invalid_input] why is an object: {direction, look_at, dropped}");
  const text = (key: string) => typeof value[key] === "string" ? (value[key] as string).trim().slice(0, 300) : "";
  const from = text("starts_from");
  const why = { direction: text("direction"), look: text("look_at"), dropped: text("dropped"), ...(from ? { from } : {}) };
  return why.direction || why.look || why.dropped ? why : undefined;
}

/// A save that makes a new html or svg version needs its why; fixing the
/// version this same ask made (after a look or a try) keeps the one it has.
function checkWhy(store: DemesneStore, kind: FoundryKind | undefined, id: string | undefined, turnId: string | undefined, why: FoundryWhy | undefined) {
  if (kind !== "html" && kind !== "svg") return;
  if (why?.direction && why.look) return;
  if (id && turnId) {
    const found = store.getFoundryArtifact(id);
    const latest = found?.versions.find((item) => item.version === found.version);
    if (latest?.turnId === turnId && latest.why) return;
  }
  throw new Error("[invalid_input] Say why it looks this way: why {direction, look_at, dropped}. Hint: a sentence each; direction is who it is for and the mood, look_at is what leads, dropped is what you left out");
}

/// A new mockup of something that exists starts from the real thing, not
/// from memory: it says what it starts from, and when that is something real
/// (or the page draws Demesne itself) the chat has looked at it first: a
/// window capture, the project's interface files, a page in the browser, or
/// a picture the person attached. Refused once per ask, so a chat that
/// cannot look is never stuck.
const lookAsked = new Set<string>();
const COULD_NOT = /^could not look/i;
function checkStart(store: DemesneStore, kind: FoundryKind | undefined, source: string, why: FoundryWhy | undefined, based: boolean, context: ToolContext) {
  if (kind !== "html" && kind !== "svg") return;
  const from = why?.from ?? "";
  if (!from) throw new Error("[invalid_input] Say what it starts from: why.starts_from. Hint: the real thing you looked at (\"a capture of the Settings window; src/settings.css\"), or \"new\" when nothing like it exists yet");
  const demesne = /<d-demesne\b/i.test(source);
  if (/^new\b/i.test(from) && !demesne) return;
  if (based || COULD_NOT.test(from) || !context.turnId || !context.sessionId) return;
  if (seenIn(context.sessionId).length) return;
  if (store.getSession(context.sessionId)?.turns.some((turn) => turn.attachments?.some((file) => file.kind !== "file"))) return;
  if (lookAsked.has(context.turnId)) return;
  lookAsked.add(context.turnId);
  if (lookAsked.size > 300) lookAsked.delete(lookAsked.values().next().value!);
  throw new Error(`[look_first] ${demesne ? "This draws Demesne, which exists" : "This starts from something that exists"}, and this chat has not looked at it, so it would be drawn from memory. `
    + "Hint: look first. Load and call capture_window (application Demesne for Demesne itself), or read the real stylesheet and that screen's markup in the project. "
    + "Then draw the screen as it is today, with its real colours, sizes, spacing and words, and change only what was asked: \"Today\" as the first option, your change as the next. "
    + "If you cannot look, save again with starts_from beginning \"could not look:\" and say so in your answer");
}

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
          note: { type: "string", maxLength: 300, description: "This version's name, a few words." },
          description: { type: "string", maxLength: 600, description: "Required when creating: one or two sentences, what it is and what to look at." },
          based_on: { type: "string", description: "Made from another mockup: its id." },
          recommended: { type: "boolean", description: "True on the one you would use when an ask makes several." },
          why: WHY_SCHEMA,
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
      if (!id && (typeof input.description !== "string" || !input.description.trim())) throw new Error("[invalid_input] A new artifact needs a description. Hint: one or two sentences on what it is and what to look at");
      checkName(input.title);
      checkOptions(id ? store.getFoundryArtifact(id)?.kind : kind, input.source);
      // Made right after reading another mockup in this ask: based on it, unless said otherwise.
      const read = !id && input.based_on === undefined && context.turnId ? readInTurn.get(context.turnId) : undefined;
      const basedOn = id ? null : read && store.getFoundryArtifact(read.id) ? read : basedOnOf(store, input.based_on);
      const recommended = typeof input.recommended === "boolean" ? input.recommended : undefined;
      if (!id) checkPick(store, context.turnId, recommended);
      const why = whyOf(input.why);
      checkWhy(store, id ? store.getFoundryArtifact(id)?.kind : kind, id, context.turnId, why);
      if (!id) checkStart(store, kind, input.source, why, !!basedOn, context);
      checkCritique(id, context.turnId, undefined, "foundry_edit");
      const baseVersion = id ? baseVersionOf(input) : undefined;
      const session = context.sessionId ? store.getSession(context.sessionId) : undefined;
      context.signal.throwIfAborted();
      let saved;
      try {
        saved = store.saveFoundryArtifact({ id, kind, title: clean(input.title, 200), source: input.source, note: clean(input.note, 300) ?? "", baseVersion,
          description: clean(input.description, 600), basedOn, ...(recommended !== undefined ? { recommended } : {}), why,
          sessionId: context.sessionId ?? null, turnId: context.turnId ?? null, workspace: session?.workspace?.root ?? null });
      } catch (error) { conflict(error); }
      return JSON.stringify({ ...savedResult(saved),
        message: `Saved as version ${saved.version}. Its preview appears automatically in this chat and is kept in Foundry.${why ? ` ${WHY_ANSWER}` : ""}` });
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
        + "Each find must match exactly once (all: true replaces every occurrence). Refused if the artifact moved past base_version. "
        + "With no edits it only changes title, note, description, recommended or why, with no new version.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          base_version: { type: "integer", minimum: 1, description: "The version you read." },
          edits: {
            type: "array", maxItems: 50,
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
          note: { type: "string", maxLength: 300, description: "This version's name, a few words." },
          description: { type: "string", maxLength: 600, description: "What it is and what to look at." },
          recommended: { type: "boolean", description: "True on the one you would use." },
          why: WHY_SCHEMA,
          critique: { type: "string", maxLength: 1200, description: "After a look found problems: rules broken, by number, and the fix." },
        },
        required: ["id"],
        additionalProperties: false,
      },
    },
    permission: () => null,
    async execute(input, context) {
      if (!isRecord(input) || typeof input.id !== "string" || !input.id) throw new Error("[invalid_input] foundry_edit needs the artifact id. Hint: foundry_read lists them");
      checkName(input.title);
      const recommended = typeof input.recommended === "boolean" ? input.recommended : undefined;
      // Names and words only: no new version, no look.
      if (input.edits === undefined || (Array.isArray(input.edits) && input.edits.length === 0)) {
        const words = { title: clean(input.title, 200), description: clean(input.description, 600), note: clean(input.note, 300), recommended, why: whyOf(input.why) };
        if (!words.title?.trim() && !words.description?.trim() && !words.note?.trim() && recommended === undefined && !words.why) throw new Error("[invalid_input] foundry_edit needs edits, or a title, note, description, recommended or why to change. Hint: pass edits to change the page");
        if (!store.getFoundryArtifact(input.id)) throw new Error("[not_found] No such Foundry artifact. Hint: call foundry_read without id to list them");
        const saved = store.describeFoundryArtifact(input.id, words);
        return JSON.stringify({ ...savedResult(saved), message: `Updated its ${[words.title && "name", words.note && "version name", words.description && "description", recommended !== undefined && (recommended ? "pick" : "unpick"), words.why && "why"].filter(Boolean).join(", ")}; the page itself is unchanged.` });
      }
      const baseVersion = baseVersionOf(input);
      if (baseVersion === undefined) throw new Error("[invalid_input] foundry_edit needs base_version. Hint: pass the version you read");
      if (!Array.isArray(input.edits) || input.edits.length > 50) throw new Error("[invalid_input] edits must be 1 to 50 {find, replace} items");
      const edits: FoundryEdit[] = input.edits.map((edit, index) => {
        if (!isRecord(edit) || typeof edit.find !== "string" || !edit.find || typeof edit.replace !== "string") throw new Error(`[invalid_input] Edit ${index + 1} needs find (non-empty) and replace strings`);
        return { find: edit.find, replace: edit.replace, all: edit.all === true };
      });
      const current = store.getFoundryArtifact(input.id);
      if (!current) throw new Error("[not_found] No such Foundry artifact. Hint: call foundry_read without id to list them");
      if (current.version !== baseVersion) conflict(new Error(`Foundry artifact is at version ${current.version}, not ${baseVersion}`));
      const source = applyFoundryEdits(current.source, edits);
      if (Buffer.byteLength(source) > FOUNDRY_MAX_SOURCE_BYTES) throw new Error("[too_large] The edited source is over 512 KB. Hint: simplify it");
      checkOptions(current.kind, source);
      const why = whyOf(input.why);
      checkWhy(store, current.kind, input.id, context.turnId, why);
      checkCritique(input.id, context.turnId, input.critique);
      const session = context.sessionId ? store.getSession(context.sessionId) : undefined;
      context.signal.throwIfAborted();
      let saved;
      try {
        saved = store.saveFoundryArtifact({ id: input.id, title: clean(input.title, 200), source, note: clean(input.note, 300) ?? "", baseVersion,
          description: clean(input.description, 600), ...(recommended !== undefined ? { recommended } : {}), why,
          sessionId: context.sessionId ?? null, turnId: context.turnId ?? null, workspace: session?.workspace?.root ?? null });
      } catch (error) { conflict(error); }
      return JSON.stringify({ ...savedResult(saved), edits: edits.length,
        message: `Saved as version ${saved.version} with ${edits.length} edit${edits.length === 1 ? "" : "s"}. The preview in this chat updates by itself.${why ? ` ${WHY_ANSWER}` : ""}` });
    },
  };
  if (look) tool.executeWithArtifacts = async (input, context) => lookAfter(store, look, looks, await tool.execute(input, context), context);
  return tool;
}

export function foundryReadTool(store: DemesneStore): AgentTool {
  return {
    definition: {
      name: "foundry_read",
      description: "List Foundry artifacts (no id; query searches), the parts catalogue (id \"kit:parts\"), or read one's current source (or a version) with the version number you pass as base_version to foundry_edit or foundry_save.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" }, version: { type: "integer", minimum: 1 }, query: { type: "string" } },
        additionalProperties: false,
      },
    },
    permission: () => null,
    async execute(input, context) {
      const args = isRecord(input) ? input : {};
      if (args.id === "kit:parts") return PARTS_GUIDE;
      if (typeof args.id !== "string" || !args.id) {
        const query = typeof args.query === "string" ? args.query.trim() : "";
        return JSON.stringify((query ? searchFoundry(store, query) : store.listFoundryArtifacts()).slice(0, 50).map(({ id, title, kind, version, updatedAt, workspace, description }) => ({ id, title, kind, version, updatedAt, workspace, ...(description ? { description } : {}) })));
      }
      const found = store.getFoundryArtifact(args.id, typeof args.version === "number" ? args.version : undefined);
      if (!found) throw new Error("[not_found] No such Foundry artifact or version. Hint: call foundry_read without id to list them");
      remember(context.turnId, found.id, found.version);
      return JSON.stringify({ id: found.id, title: found.title, kind: found.kind, version: found.version, description: found.description,
        ...(found.basedOn ? { basedOn: found.basedOn } : {}), source: found.source,
        versions: found.versions.map(({ version, note, createdAt, recommended }) => ({ version, note, createdAt, ...(recommended ? { recommended } : {}) })) });
    },
  };
}

/// The kinds that render as a page, so the look can see them.
const LOOKED_KINDS = new Set(["html", "deck", "doc", "dashboard"]);

/// Pages whose last look found something: their next save in the same ask
/// carries a critique first (step 3), keyed by turn and artifact.
const critiqueOwed = new Set<string>();

/// A fix after a look that found problems says what it is fixing, by rule,
/// before it is saved. The critique is the model's own: it is not kept or shown.
function checkCritique(id: string | undefined, turnId: string | undefined, critique: unknown, through = "") {
  if (!id || !turnId || !critiqueOwed.has(`${turnId}:${id}`)) return;
  if (typeof critique === "string" && critique.trim().length >= 20) { critiqueOwed.delete(`${turnId}:${id}`); return; }
  throw new Error(`[invalid_input] Critique before you fix: ${through ? "fix it with foundry_edit and pass" : "pass"} critique, the Design guide rules the page breaks (by number) and the numbers off target, with what you will change. Hint: a few lines; it is not shown to the person`);
}

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
  const report = lookReport(result, seen + 1 >= LOOKS_PER_TURN, artifact.kind === "html");
  if (report.found) critiqueOwed.add(key); else critiqueOwed.delete(key);
  if (critiqueOwed.size > 200) critiqueOwed.delete(critiqueOwed.values().next().value!);
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
