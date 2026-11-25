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
import { APP_WINDOW, LOOKS_PER_TURN, lookReport, tryReport, type FoundryLook, type FoundryTry, type Judged } from "./foundry-look.ts";
import { readArtifact, type StructuredToolResult } from "./artifacts.ts";
import { knobProblem } from "@demesne/protocol";
import { BUILT_PAGE, DEMO_MAX_STEPS, demoControls, FOUNDRY_BACKDROPS, FOUNDRY_FRAMES, FOUNDRY_KINDS, FOUNDRY_MAX_SOURCE_BYTES, FOUNDRY_REACT_IMPORTS, MERMAID_TYPES, mermaidType, isRecord, parseStage, picturesOf, FOUNDRY_FILE_NAME, FOUNDRY_MAX_FILES, withFoundryFiles, parseSteps, REVIEW_PAGE, reviewOf, reviewProblem, shotBox, shotsOf, STYLE_NEEDS, STYLES_PAGE, styleNames, stylesProblem, cleanWalk, walkProblem, optionNames, sheetProblem, boardProblem, boardWords, FOUNDRY_MAX_VARIANTS, FOUNDRY_MAX_WALK_PARTS, TRY_MAX_STEPS, type FoundryArtifactDetail, type ImageArtifact, type FoundryKind, type FoundryStage, type FoundryWhy, type ModelMessage, type TryStep } from "@demesne/protocol";
import type { AgentTool, ToolContext } from "./tools.ts";
import { seenIn } from "./foundry-seen.ts";
import { learnedIn } from "./design-guide.ts";
import { loadProjectLook, nearest, offLook } from "./project-look.ts";
import { called, rewriteCalled } from "./tool-search.ts";

// Foundry stores artifacts in Demesne, so these tools need no project folder.
export const FOUNDRY_TOOL_NAMES = new Set(["foundry_read", "foundry_save", "foundry_edit", "foundry_try"]);
/// foundry_built (foundry-built.ts) is left out: it follows a build, so it needs a project.

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
Demesne itself, drawn with the app's own markup and stylesheet, so it starts out identical to the app and your change is the only difference:
- <d-demesne tabs="Settings|Fix sidebar" chats="Tidy the sidebar|Drive picks" chat="Tidy the sidebar" project="demesne-cli" branch="main" page="Scheduled|Foundry" theme="dark|light" model="GPT-6.1" drive="3 ideas" height="620">main content</d-demesne>. Children with slot="cards" join the app's own card in the right column: <d-card slot="cards" icon="file" title="2 files changed" note="+8 −3"><d-row title="live.ts" note="+2"></d-row></d-card> (cards="none" leaves the column out). Designed at 1100 wide. It is a desktop window: in a narrower page it is drawn smaller. Write no phone-width rules (@media) for it or for what is inside it. Its tabs, sidebar items and chats are buttons: clicking one lights it and shows the child with data-view of the same name (<div data-view="Settings">…</div>), and the open tab takes a clicked chat's name.
- Change it by its real names; your CSS always wins over the app's: #desktop-sidebar, .sidebar-nav > button, .sidebar-new, .sidebar-search, .sidebar-project, .project-face, .sidebar-session (.selected), .sidebar-release, .sidebar-foot, #desktop-toolbar, .bar-tab (.on), #drive-pill, #app (the panel), #conversation, .turn .request, .answer .markdown, .turn-receipt, #composer .composer-box, .composer-bar, #cards .card. Colours and sizes are the app's tokens: var(--t1) to var(--t4) text, --acc, --ok, --bad, --hair, --tone, --tone2, --surface, --r-sm --r --r-lg. To add or move a piece, do it in a script after load: document.querySelector("d-app .sidebar-nav").append(node).
- Inside the window the kit does not apply. A plain button (.primary, .danger), input, h1 to h3 and .muted take Demesne's tokens; style anything else from the tokens above.
Places: any elements marked data-view="Name" are places (siblings; the first shows); anything with data-go="Name" goes there. Give every tab and chat you name a view, so nothing you click is dead.
- <d-flow><section data-view="Find a time">… <button data-go="Your details">Book 10:30</button></section><section data-view="Your details">…</section>…</d-flow> a whole flow, for an ask that spans screens (sign-up, checkout, onboarding, booking): two to twelve screens as places, in the order a person meets them, each drawn in full at real size. Foundry draws the map above them (every screen by name, the one you are on, where its controls lead), so draw no steps bar of your own unless the product has one. Every screen's main control has a data-go to the next; give the last one a way back or on. Walk it in why.walkthrough screen by screen.
- Knobs (no tag to draw): <meta name="knob" content="Room | --pad | 8 | 24 | px"> in the head, two to four per html mockup, for the values a person is likeliest to nudge: room, corners, type size, a hue (<meta name="knob" content="Warmth | --hue | 150 | 200 | "> with :root{--hue:175} and hsl(var(--hue) 70% 26%)). Each names a custom property the page declares as a number in :root, inside the knob's range, and uses with var(). Over the opened mockup Foundry draws a slider for each that changes the page at once; when the person sends their settings you get the values: foundry_edit only those declarations and keep the knobs.
- <d-message from="you">text</d-message>, <d-message meta="gpt-6.1 · 4s" files="1 file changed" checks="checks passed" steps="2 steps">answer</d-message> (the d. mark and the receipt under it), <d-composer placeholder="Ask anything" mode="Ask" model="GPT-6.1" reply="first answer|second answer">: a real input; Enter puts the message above it, then the next reply (or answer it yourself: on its "send" event, event.detail.text, call event.preventDefault()).
- <d-card title="Changes" icon="git-branch">…</d-card>, <d-row title="Keep awake" note="While it works"><d-toggle on></d-toggle></d-row> (a settings row; group rows in a box), <d-seg options="Home|Last chat" value="Home">, <d-tabs items="Week|Month">.
Anywhere:
- <d-icon name="search" size="18">: plus x check chevron-right chevron-left chevron-down arrow-right arrow-up search menu home settings sliders user users bell mail chat calendar clock star heart bolt folder file code terminal git-branch image camera play pause trash edit copy download upload link lock eye sun moon cart tag chart trending-up pin globe sparkles drive foundry archive filter more info alert check-circle send mic sidebar phone laptop coffee leaf.
- <d-avatar name="Amara Okafor" size="28"> initials on a steady colour. demesne.sample.people(n) gives 12 names; demesne.sample.series(n, start, drift, seed) a believable number series.
- <d-chart type="line|area|bar|donut" values="4,6,5,8" labels="Mon,Tue,Wed,Thu" height="200"> in --accent.
- <d-stat label="This week" value="32.4 km" delta="+12%">.
- <d-compare recommended="A"><section data-option="A · Pills" note="calm">…</section>…</d-compare> two to five variants to choose between, each a different shape: on the Foundry page they are tabs over one stage, each with its walkthrough (why.walkthrough) under it, so nothing is drawn inside the options; the person answers in the chat. layout="side" puts small options (a button, a card) side by side instead.
- <d-styles recommended="Clean counter"><d-style name="Clean counter" made="Inter throughout · 8px corners · hairlines" vars="${STYLE_NEEDS.map((name) => `${name}:…`).join("; ")}"></d-style>…</d-styles> a range of styles, for when they ask for styles or looks: write the page ONCE on those variables (the kit already is: --paper background, --ink text, --accent the one thing to press, --font body type, --radius corners; --head is the heading type), then two or three styles, each a name, one plain line on what it is made of, and its values (add your own variables, the same set in every style). Foundry draws the page in each: a row of small ones, then each at full size under its name, colours and that line. The styles must be told apart at a glance: different paper, type and corners, not one look three times. No <d-compare> on such a page. Typefaces a machine has: Inter and JetBrains Mono (the kit's), Georgia, Times New Roman, Helvetica, Arial, Courier New, system-ui, ui-serif, ui-rounded. When the project has a look already (its Style in the design guide, or the real thing you looked at), that look is one of the styles, named for what it is. What they taught you about words and order holds in every style; what they taught you about colour and type holds only in the style that is theirs today. When they choose one, keep it: remember {design: true, style_of: "<this mockup's id>", rule: "<style name>"}.
- <d-mark>1</d-mark> a numbered call-out dot.
A review of something that exists ("look at this and show me what needs work"), one page:
- <d-review><section data-today><d-shot src="IMAGE_ID" marks="12,40,1416,52 | 0,92,260,808"></d-shot></section><section data-part="Top bar" why="Three tabs, the Drive pill and the menu compete in one row."><d-compare recommended="Fewer"><section data-option="Today"><d-shot src="IMAGE_ID" box="12,40,1416,52"></d-shot></section><section data-option="Fewer things">…</section><section data-option="Two rows">…</section></d-compare></section>…</d-review>. A review starts from a real picture: capture_window (application "Demesne" for Demesne itself), the browser's picture, or a picture the person attached; IMAGE_ID is the image artifact id it gave. marks: one box per part, in order, x,y,w,h in the picture's own pixels (its size is in the capture's result); Foundry outlines and numbers them, names each part and option, and puts your pick beside Today. Each part's Today is that piece cut from the picture (<d-shot box>), shown at its own size; only the options are drawn. Two or three parts (one only when nothing else comes close), each the smallest piece that holds the problem, with Today and two or three options that show that piece alone (<d-crop> cuts it out of a drawn window). why is one plain line on what is wrong. Write <d-review> and every <section> as plain markup in the page, never from a script (a script may fill or change what is inside a section). Write no headings, numbers or captions yourself. Its why needs only starts_from: each part's own why says the rest.
- <d-shot src="IMAGE_ID" box="x,y,w,h"> a real picture from this chat (a capture, the browser's picture, one the person attached), kept with the mockup; marks="x,y,w,h | …" boxes pieces of it, box shows one piece alone.
- <d-crop to="#desktop-toolbar" width="1100">…a whole window or screen…</d-crop> shows only the piece the selector names, at its own size: inside a part, draw the screen once per option and crop each to the piece, so every option is the real piece with one change.
The parts are the frame; the idea inside is yours to design.`;

const FILE_RULES = `HTML is one document that starts with <link rel="stylesheet" href="${FOUNDRY_KIT_STYLE}"> (the kit: light and dark from the system, Inter at 14px, `
  + "one ink with --secondary/--muted/--hair/--tone tints, --accent, radii 8 and 12; plain elements styled; classes .container(.narrow) .card(.outlined/.raised) .row(.between) .stack .grid(.two/.three) "
  + `.pill(.accent/.ok/.warn/.bad) .tabs .list .eyebrow .muted .secondary .sp; buttons .primary .quiet .danger .small) and, when it moves, <script src="${FOUNDRY_KIT_SCRIPT}"></script> (anime.js 4 as window.anime). `
  + "Other outside loads: pinned scripts from " + FOUNDRY_LIBRARY_HOSTS.join(", ") + " (react@18.3.1, never react@18) and Google Fonts; everything else is blocked, so images are inline SVG or data URIs. "
  + `Mockups build on the parts (<script src="${FOUNDRY_PARTS_SCRIPT}"></script>: <d-demesne> for Demesne itself, <d-window> <d-browser> <d-phone> frames, <d-icon> <d-avatar> <d-chart> <d-stat> <d-compare>, <d-review> for a review of what exists); foundry_read id "kit:parts" lists them. `
  + "A bigger page may split into files: pass files {\"styles.css\": …, \"app.js\": …, \"data.json\": …} and link them by name (<link rel=\"stylesheet\" href=\"styles.css\">, <script src=\"app.js\">, <script type=\"application/json\" id=\"data\" src=\"data.json\">). "
  + "Give an html mockup two to four knobs (kit:parts): <meta name=\"knob\" content=\"Room | --pad | 8 | 24 | px\">. "
  + "SVG is one <svg> with a viewBox. Under 512 KB in all.";

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
  + "(<!-- layout: title|statement|number|quote|split|chart|points --> overrides; <!-- notes: … --> are a slide's speaker notes). A dashboard's ## headings group its stats, charts and tables. Anything interactive or custom is html.";

/// More kinds (apps/desktop/electron/foundry-more-kinds.ts): what the model
/// would write anyway, drawn by Demesne with libraries from the app.
export const MORE_KINDS_RULES = "More kinds: an interactive app, tool or game in React is kind react: one component in JSX or TSX with export default, styled with Tailwind classes, importing only "
  + FOUNDRY_REACT_IMPORTS.filter((name) => name !== "react-dom/client").join(", ") + " (icons, charts). A diagram (flow, sequence, states, gantt, mind map…) is kind mermaid: Mermaid source only. "
  + "Code to read is kind code: the code only, its file name in the title (orders.ts). "
  + "A table to sort, fill in and add up is kind sheet: CSV, first row the column names. A whiteboard is kind board: JSON notes, arrows, groups. Anything else interactive is html.";

/// Pages that remember (apps/desktop/foundry-kit/remember.js): Demesne puts
/// the runtime in front of any page that calls it, so the page needs no tag.
export const REMEMBER_RULES = "Pages can remember and ask, with no script tag: await demesne.save(name, jsonValue) and await demesne.load(name, fallback) keep what the person enters with the artifact (across closing, reloads and new versions; 256 KB; localStorage does not work here); "
  + "await demesne.ask(question) returns the chat model's answer as text, for a button the person presses (never on load or in a loop; a few a minute); await demesne.pick({accept}) lets them choose a file ({name, type, text} or {name, type, dataURL}). "
  + "Use them when the page is a tool to keep (a tracker, checklist, planner, journal, quiz): load on start, save on every change, show a saved state. "
  + "Real data: await demesne.read(path) returns a file in this project as text (a CSV, JSON or log to chart; never .env or keys), await demesne.list(folder) its names (folders end in /), "
  + "await demesne.fetch(httpsUrl) live public data ({ok, status, type, text, json()}; the person allows each site once, so fetch on load is fine and a refusal comes back as an error). "
  + "Use them when the person asks for their real numbers or files; show a quiet loading state, and on an error say what was missing in the page (your own look sees the error, not the data).";

/// Step 6: pictures from the chat in any mockup (picture:IMAGE_ID).
export const PICTURE_RULES = "Pictures the person attached or dropped on a mockup go in any kind as picture:IMAGE_ID where an address goes (<img src>, CSS url(), a Markdown image ![Logo](picture:IMAGE_ID)), with the id the message gave; use them instead of a drawn stand-in.";

/// Pass 221 A: Foundry draws the surface and plays the demo, so the page
/// holds only the thing being made.
export const STAGE_RULES = "The page holds only the thing, with only the controls the real thing has. "
  + "surface says where it sits; Foundry draws that frame and backdrop around the page (part and page grow to fit), so draw neither. "
  + "demo says how it moves: foundry_try steps, each with a short say; Foundry plays them with a pointer, the words under the page. A page with something to press always gets one, of its main path. "
  + "So never put Replay, Play demo, Next step, an option switcher or a state switcher (Empty · Loading · Error, Show error, Simulate) in the page.";

const GUIDE = READY_KINDS_RULES + " " + MORE_KINDS_RULES + " " + FILE_RULES + " " + STAGE_RULES + " " + REMEMBER_RULES + " " + PICTURE_RULES + " " + DESIGN_POINTER;

/// What stands in for a page's source once its turn is old.
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

/// How much page source these messages carry, roughly: what forgetting it
/// would take off (a save's arguments and a read's result are mostly source).
export function foundrySourceChars(messages: readonly ModelMessage[]): number {
  const reads = new Set<string>();
  let total = 0;
  for (const message of messages) {
    if (message.role === "assistant") for (const call of message.toolCalls ?? []) {
      const inner = called(call);
      if (inner.name === "foundry_save") total += inner.arguments.length;
      if (inner.name === "foundry_read") reads.add(call.id);
    }
    if (message.role === "tool" && reads.has(message.toolCallId)) total += message.content.length;
  }
  return total;
}

/// An old turn's messages without the page sources in them: the source the
/// agent sent to foundry_save and the one foundry_read gave back, in the tool
/// calls, their results and the retained Responses items alike. The artifact
/// itself is kept, so the agent reads it again when it needs the text; what
/// stays is the title, kind, version and note. Which turns count as old is
/// decided with the old reads (forget-reads.ts): only when the provider's
/// cache has gone cold, because rewriting a turn the cache still holds makes
/// the provider read everything after it again.
export function forgetFoundrySources<T extends ModelMessage>(messages: T[]): T[] {
  const names = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const call of message.toolCalls ?? []) names.set(call.id, called(call).name);
  }
  return messages.map((message) => {
    // A Foundry tool called through use_tool (a small window) counts too.
    if (message.role === "assistant" && message.toolCalls?.some((call) => FOUNDRY_TOOL_NAMES.has(called(call).name))) {
      const toolCalls = message.toolCalls.map((call) => {
        const forgotten = rewriteCalled(call.name, call.arguments, (name, args) => forgetJSON(args, name));
        return forgotten ? { ...call, arguments: forgotten } : call;
      });
      const responses = message.responses
        ? { ...message.responses, output: message.responses.output.map((item) => {
          if (item.type !== "function_call" || typeof item.arguments !== "string") return item;
          const forgotten = rewriteCalled(message.toolCalls!.find((call) => call.id === String(item.call_id))?.name ?? "", item.arguments, (name, args) => forgetJSON(args, name));
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

/// Pass 240 A: every picture a page shows (<d-shot src>) is one this chat has,
/// or one the mockup already keeps, and every box lies inside it. Returns the
/// pictures, to keep with the mockup once it is saved.
/// The chat's newest pictures, for a hint: "; this chat's pictures: id (name, w×h), …".
export function chatPictures(store: DemesneStore, sessionId: string | undefined): string {
  if (!sessionId) return "";
  let page; try { page = store.listImageArtifacts(sessionId, 0, 100); } catch { return ""; }
  const recent = page.artifacts.slice(-6).reverse();
  return recent.length ? `; this chat's pictures: ${recent.map((image) => `${image.id} (${image.filename}, ${image.width}×${image.height})`).join(", ")}` : "; this chat has no picture yet, so capture one first";
}

export function checkShots(store: DemesneStore, id: string | undefined, source: string, sessionId: string | undefined): ImageArtifact[] {
  const uses = shotsOf(source), named = picturesOf(source);
  if (!uses.length && !named.length) return [];
  const found = new Map<string, ImageArtifact>();
  const pictures = () => chatPictures(store, sessionId);
  // Step 6: picture:IMAGE_ID, a picture from this chat anywhere in any mockup.
  for (const src of named) {
    const image = (sessionId ? store.getImageArtifact(sessionId, src) : null) ?? (id ? store.getFoundryShot(id, src) : null);
    if (!image) throw new Error(`[picture] "picture:${src}" is not a picture this chat has. Hint: picture:IMAGE_ID takes the image artifact id an attached or dropped picture gave${pictures()}`);
    found.set(src, image);
  }
  for (const use of uses) {
    const image = found.get(use.src) ?? (use.src && sessionId ? store.getImageArtifact(sessionId, use.src) : null) ?? (use.src && id ? store.getFoundryShot(id, use.src) : null);
    if (!image) throw new Error(`[review_shot] ${use.src ? `"${use.src}" is not a picture this chat has.` : "A <d-shot> names no picture."} Hint: src is the image artifact id a capture or an attached picture gave${pictures()}`);
    found.set(use.src, image);
    for (const text of use.box === null ? use.marks : [...use.marks, use.box]) {
      const box = shotBox(text);
      if (!box) throw new Error(`[review_shot] "${text}" is not a box. Hint: x,y,w,h in the picture's own pixels, from its top left corner`);
      if (box.x < 0 || box.y < 0 || box.x + box.width > image.width + 2 || box.y + box.height > image.height + 2) throw new Error(`[review_shot] The box "${text}" falls outside the picture, which is ${image.width}×${image.height}. Hint: boxes are in the picture's own pixels, from its top left corner`);
    }
  }
  return [...found.values()];
}

/// The pictures a page shows, as the off-screen look gets them: each one's bytes, size and scale.
export interface LookShot { data: string; mimeType: string; width: number; height: number; scale: number }
export async function lookShots(store: DemesneStore, id: string): Promise<Record<string, LookShot> | undefined> {
  const kept = store.getFoundryArtifact(id)?.shots ?? [];
  if (!kept.length) return undefined;
  const shots: Record<string, LookShot> = {};
  for (const shot of kept) {
    const image = store.getFoundryShot(id, shot.id);
    if (!image) continue;
    try { shots[shot.id] = { data: (await readArtifact(store, image, false)).toString("base64"), mimeType: shot.mimeType, width: shot.width, height: shot.height, scale: shot.scale }; } catch {}
  }
  return Object.keys(shots).length ? shots : undefined;
}

/// At most five variants in a page (pass 197 A had three; pass 263 A shows them as tabs).
export const MAX_OPTIONS = FOUNDRY_MAX_VARIANTS;
function checkOptions(kind: string | undefined, source: string) {
  if (kind !== undefined && kind !== "html") return;
  // A review (pass 223 A) holds up to three parts, each with its own Today, options and pick.
  if (REVIEW_PAGE.test(source)) { const problem = reviewProblem(source); if (problem) throw new Error(problem); return; }
  // A range of styles (pass 246 A): one page, two or three styles a person tells apart, and a pick.
  if (STYLES_PAGE.test(source)) { const problem = stylesProblem(source); if (problem) throw new Error(problem); return; }
  // "Today", the screen as it is now, is the comparison and not one of the three.
  const count = (source.match(/\bdata-option\s*=/g)?.length ?? 0) - (/\bdata-option\s*=\s*["']today\b/i.test(source) ? 1 : 0);
  if (count > MAX_OPTIONS) throw new Error(`[too_many_options] This page has ${count} options; at most ${MAX_OPTIONS}. Hint: keep the best ${MAX_OPTIONS}, recommended first`);
  // Several options always come with the one you would use (pass 208 A).
  // (recommended="A" on the <d-compare>, or data-recommended on the option of a page drawn without it).
  if (count > 1 && !/<d-compare\b[^>]*\brecommended\s*=\s*["']?[^\s"'>]/i.test(source) && !/<[^>]*\bdata-recommended\b[^>]*>/i.test(source))
    throw new Error(`[no_recommendation] This page has ${count} options and no pick. Hint: set recommended="<option name>" on the <d-compare> (or data-recommended on that option), put it first, and say why in the chat`);
}

/// Pass 241 A: a build's record is Demesne's, written from foundry_built; nobody writes or edits one.
function checkNotBuilt(store: DemesneStore, id: string | undefined, source: string | undefined) {
  const found = id ? store.getFoundryArtifact(id) : null;
  if (found?.built) throw new Error(`[built] "${found.title}" is the record of a build. Hint: to change what was built, change the code, look at it again and call foundry_built${found.basedOn ? ` with the mockup it follows, id ${found.basedOn.id}` : ""}; to change the design, edit that mockup`);
  if (source !== undefined && BUILT_PAGE.test(source)) throw new Error("[built] <d-built> is Demesne's record of a build. Hint: call foundry_built after building a mockup; it writes the record");
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

/// The words a page shows: its markup without scripts, styles or tags (pass 273 A).
export function pageWords(kind: string, source: string): string {
  const text = kind === "board" ? boardWords(source) : kind === "markdown" || kind === "mermaid" || kind === "code" || kind === "sheet" ? source
    : source.replace(/<(script|style|svg)\b[\s\S]*?<\/\1>/gi, " ").replace(/<!--[\s\S]*?-->/g, " ").replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"');
  return text.replace(/\s+/g, " ").trim().slice(0, 20_000);
}

/// Every word of the query, in a mockup's name, description, version names,
/// whys, the asks that made it, or (pass 273 A) the words on its newest page.
export function searchFoundry(store: DemesneStore, query: string) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const text = new Map<string, string[]>();
  for (const version of store.listFoundryVersions(2000)) {
    const parts = text.get(version.artifactId) ?? [];
    parts.push(version.note, version.ask ?? "", version.why ? `${version.why.direction} ${version.why.look} ${version.why.dropped}` : "");
    text.set(version.artifactId, parts);
  }
  for (const page of store.foundryNewestSources()) (text.get(page.id) ?? (text.set(page.id, []), text.get(page.id)!)).push(pageWords(page.kind, page.source));
  return store.listFoundryArtifacts().filter((item) => {
    const haystack = [item.title, item.description, ...(text.get(item.id) ?? [])].join(" ").toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

const savedResult = (saved: FoundryArtifactDetail) => {
  const current = saved.versions.find((item) => item.version === saved.version);
  return { id: saved.id, title: saved.title, kind: saved.kind, version: saved.version, description: saved.description,
    note: current?.note ?? "", ...(current?.recommended ? { recommended: true } : {}), ...(current?.why ? { why: current.why } : {}),
    ...(current?.stage?.surface ? { surface: current.stage.surface } : {}), ...(current?.stage?.demo ? { demo: current.stage.demo } : {}) };
};

/// Pass 221 A: where it sits and how its demo goes.
const SURFACE_SCHEMA = {
  type: "object",
  description: "Where it sits. Kept until changed.",
  properties: {
    frame: { type: "string", enum: [...FOUNDRY_FRAMES] },
    width: { type: "integer", minimum: 120, maximum: 2400 },
    height: { type: "integer", minimum: 0, maximum: 2400, description: "0: fits content." },
    backdrop: { type: "string", enum: [...FOUNDRY_BACKDROPS] },
    title: { type: "string", maxLength: 80, description: "Window title or browser address." },
  },
  required: ["frame"],
  additionalProperties: false,
} as const;
const DEMO_STEP = 'one of {click: "Choose Plus"}, {hover: "Pin"}, {type: "Milk", into: "Item"}, {key: "Enter"}, {scroll: 400}, {wait: 300}, plus say: "what it shows"';
const DEMO_SCHEMA = {
  type: "array", maxItems: DEMO_MAX_STEPS,
  description: `The main path as steps, each ${DEMO_STEP}. A control is named by its text or label, or a CSS selector. Kept until changed.`,
  items: { type: "object", properties: {
    click: { type: "string" }, hover: { type: "string" }, type: { type: "string" }, into: { type: "string" },
    key: { type: "string" }, scroll: { type: "number" }, wait: { type: "number" }, say: { type: "string" } } },
} as const;

const stageError = (error: unknown) => `${error instanceof Error ? error.message : String(error)}. Hint: surface is {frame: "phone"}; a demo step is ${DEMO_STEP}`;
function stageOf(input: Record<string, unknown>): FoundryStage | null {
  try { return parseStage({ surface: input.surface, demo: input.demo }); }
  catch (error) { throw new Error(`[invalid_input] ${stageError(error)}`); }
}
/// With a page: a demo that does not read is left off and said, never a
/// reason to send the whole page again.
function stageWithPage(input: Record<string, unknown>): { stage: FoundryStage | null; dropped: string } {
  try { return { stage: parseStage({ surface: input.surface, demo: input.demo }), dropped: "" }; }
  catch (error) {
    if (input.demo === undefined || input.demo === null) throw new Error(`[invalid_input] ${stageError(error)}`);
    let surface: FoundryStage | null;
    try { surface = parseStage({ surface: input.surface }); } catch (bad) { throw new Error(`[invalid_input] ${stageError(bad)}`); }
    return { stage: surface, dropped: ` The page is saved but its demo was not kept: ${stageError(error)}. Give the demo again with foundry_edit {id, demo: [...]} and no edits.` };
  }
}

/// A review is one sheet that grows with its parts, whatever surface was named.
const reviewStage = (stage: FoundryStage | null, source: string): FoundryStage | null =>
  REVIEW_PAGE.test(source) ? { ...(stage ?? {}), surface: { frame: "page" } } : stage;
/// What a saved review is told: its answer is the parts and the picks.
const REVIEW_ANSWER = "In your answer, name the parts in order, your pick for each and why, in a few lines; the person answers there.";
/// A real model kept one part per review (pass 223 run); the ask is for the parts that matter. Said once, on the first save.
const ONE_PART = "This review shows one part. Unless the ask named that piece, add the next one or two that need work nearly as much with foundry_edit before you answer; if nothing else comes close, say so in your answer.";
const reviewSaid = (source: string, first: boolean) => `${first && reviewOf(source)?.parts.length === 1 ? ` ${ONE_PART}` : ""} ${REVIEW_ANSWER}`;

/// A page that draws a button only a demo needs (Replay, Play demo, Next
/// step) is sent back once per ask: the demo belongs to Foundry. A second
/// save goes through, for the page whose real design has one.
/// A react, mermaid, code, sheet or board artifact that won't draw says why at save, so
/// the model fixes it before the person sees a broken page.
const tsx = new Bun.Transpiler({ loader: "tsx" });
export function checkKindSource(kind: FoundryKind | undefined, source: string) {
  if (kind === "react") {
    let scanned: { imports: { path: string }[]; exports: string[] };
    try { scanned = tsx.scan(source); } catch (error) {
      throw new Error(`[invalid_input] This component doesn't compile: ${error instanceof Error ? error.message : String(error)}. Hint: one JSX or TSX file`);
    }
    const other = scanned.imports.find((one) => !(FOUNDRY_REACT_IMPORTS as readonly string[]).includes(one.path));
    if (other) throw new Error(`[invalid_input] "${other.path}" can't be imported in a react artifact. Hint: only ${FOUNDRY_REACT_IMPORTS.filter((name) => name !== "react-dom/client").join(", ")}; write anything else in the file`);
    if (!scanned.exports.includes("default")) throw new Error("[invalid_input] The component needs an export default. Hint: export default function App() { … }");
  }
  if (kind === "board") {
    const problem = boardProblem(source);
    if (problem) throw new Error(`[invalid_input] ${problem}`);
  }
  if (kind === "sheet") {
    const problem = sheetProblem(source);
    if (problem) throw new Error(`[invalid_input] ${problem}`);
  }
  if (kind === "mermaid") {
    const type = mermaidType(source);
    if (!type || !MERMAID_TYPES.includes(type)) throw new Error(`[invalid_input] A mermaid artifact starts with its diagram type${type ? `, not "${type}"` : ""}. Hint: flowchart LR, sequenceDiagram, stateDiagram-v2, erDiagram, gantt, mindmap, timeline…; Mermaid source only, no fences`);
  }
}

function checkControls(kind: FoundryKind | undefined, source: string) {
  if (kind !== "html") return;
  const found = demoControls(source);
  if (!found.length) return;
  throw new Error(`[demo_control] The page draws ${found.map((text) => `“${text}”`).join(", ")}, which only runs a demo or fakes a state; the real thing would not have it, and Foundry does not keep a page that does. `
    + "Hint: take it out. Give the steps as demo (foundry_try steps with say) and Foundry plays them under the page; reach a state the way the real thing does (an empty list by removing its last item), or make it its own option in <d-compare>. A real control with one of these words gets the words the real product uses (\"Continue\", not \"Next step\")");
}

/// Something to press, in the page's own markup or the kit's parts.
const HAS_CONTROLS = /<(?:button|a|input|select|textarea|details|d-tabs|d-seg|d-toggle)\b|<d-demesne\b(?![^>]*\binert\b)|\bonclick\s*=|\brole\s*=\s*["']?(?:button|tab|switch)/i;
/// What a save says about the demo: how to check one, or, for a page with
/// controls and none, to write it (a real model otherwise never does).
const stageSaid = (stage: FoundryStage | null | undefined, page?: { kind: FoundryKind; source: string; id: string }) => stage?.demo
  ? " Foundry plays its demo under the page; check every step changes something with foundry_try {id, demo: true}."
  : page && page.kind === "html" && !REVIEW_PAGE.test(page.source) && HAS_CONTROLS.test(page.source.replace(/<script\b[\s\S]*?<\/script>/gi, ""))
    ? ` It has controls and no demo, so on Foundry it sits still. Give it one now: foundry_edit {id: "${page.id}", demo: [...]} with no edits, its main path in 2 to 6 steps (click, type, hover by the control's name), each with a short say.`
    : "";

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
    followed: { type: "string", maxLength: 300, description: "Which of their learned likes (design guide) this follows, a few words each; \"none\" when none apply." },
    walkthrough: {
      type: "array", maxItems: FOUNDRY_MAX_VARIANTS,
      description: "Required on html mockups: one entry per variant (per data-option; one entry when there is a single page), shown under it on Foundry. Omit on a fix to keep the one before.",
      items: {
        type: "object",
        properties: {
          option: { type: "string", description: "The variant's name (its data-option)." },
          what: { type: "string", maxLength: 500, description: "What it is and who it is for, a sentence or two." },
          parts: { type: "array", minItems: 2, maxItems: FOUNDRY_MAX_WALK_PARTS, items: { type: "object", properties: {
            name: { type: "string", maxLength: 80 }, says: { type: "string", maxLength: 300, description: "What it does and why it is there." },
            at: { type: "string", maxLength: 200, description: "CSS selector of that piece, inside the variant; Foundry numbers it on the page." } }, required: ["name", "says"], additionalProperties: false } },
          why: { type: "string", maxLength: 500, description: "Why it is shaped this way." },
          differs: { type: "string", maxLength: 400, description: "How it differs from the other variants (several variants)." },
          next: { type: "string", maxLength: 400, description: "What you would do next with it." },
        },
        required: ["what", "parts", "why"],
        additionalProperties: false,
      },
    },
  },
  required: ["direction", "look_at"],
  additionalProperties: false,
} as const;

const WHY_ANSWER = "Foundry shows the walkthrough under each variant. In your answer, hand the work over in full: what you made and who it is for, each variant in a line with how it differs, your pick and why, what you dropped, and what they should decide next.";

function whyOf(value: unknown): FoundryWhy | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("[invalid_input] why is an object: {direction, look_at, dropped}");
  const text = (key: string) => typeof value[key] === "string" ? (value[key] as string).trim().slice(0, 300) : "";
  const from = text("starts_from"), followed = text("followed");
  const walk = cleanWalk(value.walkthrough);
  const why = { direction: text("direction"), look: text("look_at"), dropped: text("dropped"), ...(from ? { from } : {}), ...(followed ? { followed } : {}), ...(walk ? { walk } : {}) };
  return why.direction || why.look || why.dropped || walk ? why : undefined;
}

/// Pass 263 A: an html mockup comes with a walkthrough of each variant. A
/// save or edit that gives none keeps the one the version before had, as
/// long as it still covers the variants; otherwise it is refused, with what
/// is missing. A review (pass 223 A) explains itself part by part instead.
function withWalk(store: DemesneStore, kind: FoundryKind | undefined, id: string | undefined, why: FoundryWhy | undefined, source: string): FoundryWhy | undefined {
  if (kind !== "html" || REVIEW_PAGE.test(source)) return why;
  const before = id ? store.getFoundryArtifact(id) : null;
  const kept = before?.versions.find((item) => item.version === before.version)?.why?.walk;
  // A page of styles is one page in two or three looks: one walkthrough explains it.
  const variants = STYLES_PAGE.test(source) ? [] : optionNames(source);
  if (!why?.walk && kept && !walkProblem(kept, variants)) return why ? { ...why, walk: kept } : why;
  const problem = walkProblem(why?.walk ?? kept, variants);
  if (problem) throw new Error(problem);
  return why;
}

/// A review says why part by part, on the sheet: of the save's own why only
/// what it started from is kept, so no Direction or Look at line sits above it.
function whyFor(value: unknown, source: string): FoundryWhy | undefined {
  if (!REVIEW_PAGE.test(source)) return whyOf(value);
  if (!isRecord(value)) return undefined;
  const from = typeof value.starts_from === "string" ? value.starts_from.trim().slice(0, 300) : "";
  return { direction: "", look: "", dropped: "", ...(from ? { from } : {}) };
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

/// Pass 245 A, taste that carries over: when the project's design guide holds
/// lines learned from the person's notes, a new version says which of them it
/// follows (why.followed, or "none"), so the page shows it and the model has
/// looked at them. Asked once per ask; a fix of this ask's own version is not asked.
const tasteAsked = new Set<string>();
export const NO_TASTE = /^none\b/i;
function checkTaste(store: DemesneStore, kind: FoundryKind | undefined, id: string | undefined, why: FoundryWhy | undefined, context: ToolContext) {
  if (kind !== "html" && kind !== "svg") return;
  if (why?.followed || !context.turnId) return;
  if (id) {
    const found = store.getFoundryArtifact(id);
    if (found?.versions.find((item) => item.version === found.version)?.turnId === context.turnId) return;
  }
  const learned = learnedIn(context.workspaceRoot);
  if (!learned.length || tasteAsked.has(context.turnId)) return;
  tasteAsked.add(context.turnId);
  if (tasteAsked.size > 300) tasteAsked.delete(tasteAsked.values().next().value!);
  throw new Error(`[taste] This person's design guide holds ${learned.length} ${learned.length === 1 ? "line" : "lines"} learned from their notes on earlier mockups here:\n${learned.map((line) => `- ${line}`).join("\n")}\n`
    + "Hint: make the page follow each one that applies, then save again with why.followed naming those in a few words each (\"none\" when none apply), and say in your answer which you followed");
}

/// Piece 2 of pass 274, whole flows: a <d-flow> holds two to twelve screens,
/// each named once, and every data-go on the page leads to a screen that
/// exists, so nothing you press in a flow is dead.
export const FLOW_MAX_SCREENS = 12;
const checkFlow = (source: string) => { const problem = flowProblem(source); if (problem) throw new Error(problem); };
/// Piece 5 of pass 274: a page's knobs turn something real (knobProblem in @demesne/protocol), or go back to be fixed.
const checkKnobs = (kind: string | undefined, source: string) => { if (kind !== "html") return; const problem = knobProblem(source); if (problem) throw new Error(problem); };
export function flowProblem(source: string): string | null {
  const flow = /<d-flow\b[^>]*>([\s\S]*?)<\/d-flow>/i.exec(source);
  if (!flow) return /<d-flow\b/i.test(source) ? "[invalid_input] <d-flow> is not closed. Hint: end it with </d-flow>" : null;
  const attribute = (text: string, name: string) => [...text.matchAll(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "gi"))].map((match) => (match[1] ?? match[2] ?? "").trim());
  const screens = attribute(flow[1]!, "data-view").filter(Boolean);
  if (screens.length < 2) return `[invalid_input] A flow needs at least two screens, and this has ${screens.length}. Hint: each screen is a child of <d-flow> with data-view="Its name"; one screen alone is a plain page`;
  if (screens.length > FLOW_MAX_SCREENS) return `[invalid_input] A flow holds up to ${FLOW_MAX_SCREENS} screens, not ${screens.length}. Hint: keep the screens the ask is about, or split it into two flows`;
  const lower = screens.map((name) => name.toLowerCase());
  const twice = lower.find((name, at) => lower.indexOf(name) !== at);
  if (twice) return `[invalid_input] Two screens of the flow are called "${screens[lower.indexOf(twice)]}". Hint: each screen needs its own name`;
  const everywhere = new Set(attribute(source, "data-view").map((name) => name.toLowerCase()));
  const dead = attribute(flow[1]!, "data-go").find((name) => !everywhere.has(name.toLowerCase()));
  if (dead !== undefined) return `[invalid_input] Something in the flow goes to "${dead}", which is not a screen. Hint: its screens are ${screens.join(", ")}`;
  if (!/\bdata-go\s*=/.test(flow[1]!)) return "[invalid_input] Nothing in the flow leads anywhere. Hint: give each screen's main control data-go=\"The next screen's name\"";
  return null;
}

/// Piece 1 of pass 274, your project's look: a page for a project whose code
/// names its colours and type is checked against them before it is shown.
/// What is off (a colour far from every hue of the palette, a font the project
/// doesn't use) goes back to the model once per ask with what to use instead;
/// the version then says how it sits with the look, on its "Project look" line.
const lookOff = new Map<string, number>();
const LOOK_KINDS: readonly FoundryKind[] = ["html", "svg", "react"];
function withLook(store: DemesneStore, kind: FoundryKind | undefined, id: string | undefined, why: FoundryWhy | undefined, source: string, context: ToolContext): FoundryWhy | undefined {
  if (!kind || !LOOK_KINDS.includes(kind) || REVIEW_PAGE.test(source) || STYLES_PAGE.test(source) || /<d-demesne\b/i.test(source)) return why;
  const look = loadProjectLook(context.workspaceRoot);
  if (!look) return why;
  const problems = offLook(source, look);
  const asked = context.turnId ? lookOff.get(context.turnId) : undefined;
  const from = look.from.join(", ") || "its components";
  if (problems.length && asked === undefined && context.turnId) {
    lookOff.set(context.turnId, problems.length);
    if (lookOff.size > 300) lookOff.delete(lookOff.keys().next().value!);
    const lines = problems.map((problem) => {
      if (problem.what === "font") return `- font ${problem.value} is not one of the project's (${look.fonts.join(", ")})`;
      const near = nearest(problem.value, look);
      return `- colour ${problem.value} is far from every colour of its palette${near ? ` (nearest: ${near.name} ${near.value})` : ""}`;
    });
    throw new Error(`[look] This page is off the project's own look, read from ${from}:\n${lines.join("\n")}\n`
      + "Hint: draw it in the project's colours and fonts (the design guide lists them) and save again; if the ask is for a new look, save again as it is");
  }
  const things = (count: number) => `${count} ${count === 1 ? "thing" : "things"}`;
  const onLook = problems.length ? `${things(problems.length)} off the project's look, kept on purpose`
    : asked ? `Checked against ${from}: ${things(asked)} fixed before you saw it`
    : `Drawn in the project's own look, read from ${from}`;
  const before = id ? store.getFoundryArtifact(id) : null;
  const base = why ?? before?.versions.find((item) => item.version === before.version)?.why ?? { direction: "", look: "", dropped: "" };
  return { ...base, onLook };
}

/// A page of styles (pass 246 A): the answer names them, and the pick becomes the project's style.
export const STYLES_ANSWER = "Name each style in your answer in a few words, and say which you would pick and why.";
export const stylesKeep = (id: string) => `When they choose a style, keep it as the project's style: remember {design: true, style_of: "${id}", rule: "<style name>"}.`;
const stylesSaid = (source: string, id: string) => STYLES_PAGE.test(source) ? ` ${STYLES_ANSWER} ${stylesKeep(id)}` : "";

/// The page shows a "Your taste" line for what it followed; the answer says it too, in a sentence.
export const TASTE_ANSWER = "It follows their taste from earlier mockups: say which of their likes in one sentence of your answer.";
const tasteSaid = (why: FoundryWhy) => why.followed && !NO_TASTE.test(why.followed) ? ` ${TASTE_ANSWER}` : "";

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
  // A review is of something that exists, whatever starts_from says.
  const demesne = /<d-demesne\b/i.test(source), review = REVIEW_PAGE.test(source);
  if (/^new\b/i.test(from) && !demesne && !review) return;
  if (based || COULD_NOT.test(from) || !context.turnId || !context.sessionId) return;
  // A capture or a look at the running app kept with the chat counts too, so a restart does not ask for another.
  if (seenIn(context.sessionId).length || store.windowCaptures(context.sessionId).length || store.lookedAtPage(context.sessionId)) return;
  if (store.getSession(context.sessionId)?.turns.some((turn) => turn.attachments?.some((file) => file.kind !== "file"))) return;
  if (lookAsked.has(context.turnId)) return;
  lookAsked.add(context.turnId);
  if (lookAsked.size > 300) lookAsked.delete(lookAsked.values().next().value!);
  throw new Error(`[look_first] ${demesne ? "This draws Demesne, which exists" : review ? "This reviews something that exists" : "This starts from something that exists"}, and this chat has not looked at it, so it would be drawn from memory. `
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

/// Step 6: the files a page keeps beside it, as given to a save: undefined when
/// not given (a new version keeps the ones before), {} to drop them.
export function filesOf(value: unknown, kind: string | undefined): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error('[invalid_input] files is an object of file name to text. Hint: {"styles.css": "…", "app.js": "…"}');
  const entries = Object.entries(value);
  if (entries.length && kind !== "html") throw new Error("[invalid_input] Only an html page keeps other files. Hint: put everything in the source");
  if (entries.length > FOUNDRY_MAX_FILES) throw new Error(`[invalid_input] A page keeps up to ${FOUNDRY_MAX_FILES} files. Hint: join the small ones`);
  for (const [name, text] of entries) {
    if (!FOUNDRY_FILE_NAME.test(name)) throw new Error(`[invalid_input] "${name}" can't be a file of a page. Hint: a plain name with .css, .js, .mjs, .json, .svg, .csv, .txt or .md, no folders`);
    if (typeof text !== "string") throw new Error(`[invalid_input] The file "${name}" needs its text`);
  }
  return Object.fromEntries(entries) as Record<string, string>;
}
const bytesOf = (source: string, files: Record<string, string> | undefined) => Buffer.byteLength(source) + Object.entries(files ?? {}).reduce((sum, [name, text]) => sum + Buffer.byteLength(name) + Buffer.byteLength(text), 0);

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
          kind: { type: "string", enum: [...FOUNDRY_KINDS], description: "Required when creating: deck, doc or dashboard (content Demesne designs), html (a page you design), react (one component), mermaid (a diagram), code (a file of code), svg, or markdown (plain notes)." },
          source: { type: "string", description: "The complete source." },
          base_version: { type: "integer", minimum: 1, description: "When revising: the version you read." },
          note: { type: "string", maxLength: 300, description: "This version's name, a few words." },
          description: { type: "string", maxLength: 600, description: "Required when creating: one or two sentences, what it is and what to look at." },
          based_on: { type: "string", description: "Made from another mockup: its id." },
          recommended: { type: "boolean", description: "True on the one you would use when an ask makes several." },
          why: WHY_SCHEMA,
          surface: SURFACE_SCHEMA,
          demo: DEMO_SCHEMA,
          files: { type: "object", additionalProperties: { type: "string" }, description: "An html page's other files by name (styles.css, app.js, data.json), linked from the page. Omit to keep the ones before." },
        },
        required: ["source"],
        additionalProperties: false,
      },
    },
    permission: () => null,
    async execute(input, context) {
      if (!isRecord(input) || typeof input.source !== "string" || !input.source.trim()) throw new Error("[invalid_input] foundry_save needs the complete source. Hint: send the whole file as source");
      const id = typeof input.id === "string" && input.id ? input.id : undefined;
      const kind = typeof input.kind === "string" ? input.kind as FoundryKind : undefined;
      const files = filesOf(input.files, id ? store.getFoundryArtifact(id)?.kind : kind);
      if (bytesOf(input.source, files) > FOUNDRY_MAX_SOURCE_BYTES) throw new Error("[too_large] Source is over 512 KB. Hint: simplify or split it");
      if (!id && (!kind || !FOUNDRY_KINDS.includes(kind))) throw new Error(`[invalid_input] kind must be one of ${FOUNDRY_KINDS.join(", ")} when creating. Hint: deck, doc or dashboard for slides, a report or numbers; html for anything else`);
      if (!id && (typeof input.title !== "string" || !input.title.trim())) throw new Error("[invalid_input] A new artifact needs a title. Hint: name it in a few words");
      if (!id && (typeof input.description !== "string" || !input.description.trim())) throw new Error("[invalid_input] A new artifact needs a description. Hint: one or two sentences on what it is and what to look at");
      checkName(input.title);
      checkNotBuilt(store, id, input.source);
      checkOptions(id ? store.getFoundryArtifact(id)?.kind : kind, input.source);
      // Made right after reading another mockup in this ask: based on it, unless said otherwise.
      const read = !id && input.based_on === undefined && context.turnId ? readInTurn.get(context.turnId) : undefined;
      const basedOn = id ? null : read && store.getFoundryArtifact(read.id) ? read : basedOnOf(store, input.based_on);
      const recommended = typeof input.recommended === "boolean" ? input.recommended : undefined;
      if (!id) checkPick(store, context.turnId, recommended);
      const said = whyFor(input.why, input.source);
      if (!(said && REVIEW_PAGE.test(input.source))) checkWhy(store, id ? store.getFoundryArtifact(id)?.kind : kind, id, context.turnId, said);
      if (!id) checkStart(store, kind, input.source, said, !!basedOn, context);
      if (!REVIEW_PAGE.test(input.source)) checkTaste(store, id ? store.getFoundryArtifact(id)?.kind : kind, id, said, context);
      const why = withLook(store, id ? store.getFoundryArtifact(id)?.kind : kind, id, withWalk(store, id ? store.getFoundryArtifact(id)?.kind : kind, id, said, input.source), input.source, context);
      checkCritique(id, context.turnId, undefined, "foundry_edit");
      const { stage: given, dropped } = stageWithPage(input);
      const stage = reviewStage(given, input.source);
      checkControls(id ? store.getFoundryArtifact(id)?.kind : kind, input.source);
      checkKindSource(id ? store.getFoundryArtifact(id)?.kind : kind, input.source);
      checkFlow(input.source);
      checkKnobs(id ? store.getFoundryArtifact(id)?.kind ?? kind : kind, input.source);
      const shots = checkShots(store, id, input.source, context.sessionId);
      const baseVersion = id ? baseVersionOf(input) : undefined;
      const session = context.sessionId ? store.getSession(context.sessionId) : undefined;
      context.signal.throwIfAborted();
      let saved;
      try {
        saved = store.saveFoundryArtifact({ id, kind, title: clean(input.title, 200), source: input.source, note: clean(input.note, 300) ?? "", baseVersion, ...(files !== undefined ? { files } : {}),
          description: clean(input.description, 600), basedOn, ...(recommended !== undefined ? { recommended } : {}), why, stage,
          sessionId: context.sessionId ?? null, turnId: context.turnId ?? null, workspace: session?.workspace?.root ?? null });
      } catch (error) { conflict(error); }
      for (const shot of shots) store.keepFoundryShot(saved.id, shot);
      return JSON.stringify({ ...savedResult(saved),
        message: `Saved as version ${saved.version}. Its preview appears automatically in this chat and is kept in Foundry.${dropped || stageSaid(savedResult(saved).demo ? { demo: savedResult(saved).demo } : null, { kind: saved.kind, source: input.source, id: saved.id })}${REVIEW_PAGE.test(input.source) ? reviewSaid(input.source, true) : why ? ` ${WHY_ANSWER}${tasteSaid(why)}` : ""}${stylesSaid(input.source, saved.id)}` });
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
        + "With no edits it only changes title, note, description, recommended, why, surface or demo, with no new version.",
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
                file: { type: "string", description: "One of the page's files to edit instead of the page (styles.css)." },
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
          surface: SURFACE_SCHEMA,
          demo: DEMO_SCHEMA,
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
      checkNotBuilt(store, input.id, undefined);
      const recommended = typeof input.recommended === "boolean" ? input.recommended : undefined;
      // Names and words only: no new version, no look.
      if (input.edits === undefined || (Array.isArray(input.edits) && input.edits.length === 0)) {
        const newWhy = whyOf(input.why), kept = newWhy && !newWhy.walk ? store.getFoundryArtifact(input.id)?.versions[0]?.why?.walk : undefined;
        const words = { title: clean(input.title, 200), description: clean(input.description, 600), note: clean(input.note, 300), recommended, why: kept ? { ...newWhy!, walk: kept } : newWhy, stage: stageOf(input) };
        if (!words.title?.trim() && !words.description?.trim() && !words.note?.trim() && recommended === undefined && !words.why && !words.stage) throw new Error("[invalid_input] foundry_edit needs edits, or a title, note, description, recommended, why, surface or demo to change. Hint: pass edits to change the page");
        if (!store.getFoundryArtifact(input.id)) throw new Error("[not_found] No such Foundry artifact. Hint: call foundry_read without id to list them");
        const saved = store.describeFoundryArtifact(input.id, words);
        return JSON.stringify({ ...savedResult(saved), message: `Updated its ${[words.title && "name", words.note && "version name", words.description && "description", recommended !== undefined && (recommended ? "pick" : "unpick"), words.why && "why", words.stage?.surface && "surface", words.stage?.demo && "demo"].filter(Boolean).join(", ")}; the page itself is unchanged.${stageSaid(words.stage)}` });
      }
      const baseVersion = baseVersionOf(input);
      if (baseVersion === undefined) throw new Error("[invalid_input] foundry_edit needs base_version. Hint: pass the version you read");
      if (!Array.isArray(input.edits) || input.edits.length > 50) throw new Error("[invalid_input] edits must be 1 to 50 {find, replace} items");
      const edits: (FoundryEdit & { file?: string })[] = input.edits.map((edit, index) => {
        if (!isRecord(edit) || typeof edit.find !== "string" || !edit.find || typeof edit.replace !== "string") throw new Error(`[invalid_input] Edit ${index + 1} needs find (non-empty) and replace strings`);
        return { find: edit.find, replace: edit.replace, all: edit.all === true, ...(typeof edit.file === "string" && edit.file ? { file: edit.file } : {}) };
      });
      const current = store.getFoundryArtifact(input.id);
      if (!current) throw new Error("[not_found] No such Foundry artifact. Hint: call foundry_read without id to list them");
      if (current.version !== baseVersion) conflict(new Error(`Foundry artifact is at version ${current.version}, not ${baseVersion}`));
      // Step 6: an edit may name one of the page's files; the rest change the page.
      const source = applyFoundryEdits(current.source, edits.filter((edit) => !edit.file));
      let files: Record<string, string> | undefined;
      for (const name of new Set(edits.flatMap((edit) => edit.file ? [edit.file] : []))) {
        if (!current.files || !Object.hasOwn(current.files, name)) throw new Error(`[no_match] "${name}" is not one of this page's files. Hint: ${current.files ? `its files are ${Object.keys(current.files).join(", ")}` : "it has none; edit the page"}`);
        files = { ...(files ?? current.files), [name]: applyFoundryEdits(current.files[name]!, edits.filter((edit) => edit.file === name)) };
      }
      checkNotBuilt(store, undefined, source);
      if (bytesOf(source, files ?? current.files) > FOUNDRY_MAX_SOURCE_BYTES) throw new Error("[too_large] The edited source is over 512 KB. Hint: simplify it");
      checkOptions(current.kind, source);
      const said = whyFor(input.why, source);
      if (!(said && REVIEW_PAGE.test(source))) checkWhy(store, current.kind, input.id, context.turnId, said);
      if (!REVIEW_PAGE.test(source)) checkTaste(store, current.kind, input.id, said, context);
      const why = withLook(store, current.kind, input.id, withWalk(store, current.kind, input.id, said, source), source, context);
      checkCritique(input.id, context.turnId, input.critique);
      const { stage: given, dropped } = stageWithPage(input);
      const stage = given?.surface ? reviewStage(given, source) : given;
      checkControls(current.kind, source);
      checkKindSource(current.kind, source);
      checkFlow(source);
      checkKnobs(current.kind, source);
      const shots = checkShots(store, input.id, source, context.sessionId);
      const session = context.sessionId ? store.getSession(context.sessionId) : undefined;
      context.signal.throwIfAborted();
      let saved;
      try {
        saved = store.saveFoundryArtifact({ id: input.id, title: clean(input.title, 200), source, note: clean(input.note, 300) ?? "", baseVersion, ...(files ? { files } : {}),
          description: clean(input.description, 600), ...(recommended !== undefined ? { recommended } : {}), why, stage,
          sessionId: context.sessionId ?? null, turnId: context.turnId ?? null, workspace: session?.workspace?.root ?? null });
      } catch (error) { conflict(error); }
      for (const shot of shots) store.keepFoundryShot(saved.id, shot);
      return JSON.stringify({ ...savedResult(saved), edits: edits.length,
        message: `Saved as version ${saved.version} with ${edits.length} edit${edits.length === 1 ? "" : "s"}. The preview in this chat updates by itself.${dropped || stageSaid(savedResult(saved).demo ? { demo: savedResult(saved).demo } : null, { kind: saved.kind, source, id: saved.id })}${REVIEW_PAGE.test(source) ? reviewSaid(source, false) : why ? ` ${WHY_ANSWER}${tasteSaid(why)}` : ""}${stylesSaid(source, saved.id)}` });
    },
  };
  if (look) tool.executeWithArtifacts = async (input, context) => lookAfter(store, look, looks, await tool.execute(input, context), context);
  return tool;
}

/// The course a mockup has been on, handed back with its source so a later
/// ask stays on it: what the person asked each time, the direction taken,
/// what leads and what was dropped. One entry per ask (its last version),
/// the first ask and the newest five. Sources are forgotten between turns;
/// this is not.
export const BRIEF_KEEP = "Stay on this course. The next version answers the newest ask and keeps every earlier decision the person did not change; never bring back what was dropped unless they ask for it.";
export function briefOf(found: FoundryArtifactDetail): { brief?: Record<string, unknown>[]; keep?: string } {
  const asks = new Map<string, FoundryArtifactDetail["versions"][number]>();
  for (const item of [...found.versions].sort((a, b) => a.version - b.version)) {
    if (item.version > found.version || !(item.ask || item.why)) continue;
    asks.set(item.turnId ?? `v${item.version}`, item);
  }
  const all = [...asks.values()];
  const kept = all.length > 6 ? [all[0]!, ...all.slice(-5)] : all;
  if (!kept.length) return {};
  return { brief: kept.map(({ version, ask, why }) => ({ version, ...(ask ? { asked: ask.slice(0, 300) } : {}),
    ...(why?.direction ? { direction: why.direction } : {}), ...(why?.look ? { look_at: why.look } : {}),
    ...(why?.dropped ? { dropped: why.dropped } : {}), ...(why?.from ? { starts_from: why.from } : {}), ...(why?.followed && !NO_TASTE.test(why.followed) ? { followed: why.followed } : {}) })), keep: BRIEF_KEEP };
}

/// Pass 263 A: the shown version's walkthrough, as the model gave it, so a change keeps it true (or sends a new one).
function walkRead(found: FoundryArtifactDetail) {
  const walk = found.versions.find((item) => item.version === found.version)?.why?.walk;
  return walk ? { walkthrough: walk, walkthrough_rule: "Kept with the next version while it still holds; when the change makes it wrong, send why.walkthrough again." } : {};
}

/// Pass 242 A: what the person pinned as liked on this mockup, kept across
/// asks so a later version does not lose it.
export const LIKED_KEEP = "The person said they like these: keep each as it is unless a later note changes it.";
const likedOf = (store: DemesneStore, id: string): { liked?: string[]; liked_rule?: string } => {
  const liked = store.foundryLikes(id);
  return liked.length ? { liked, liked_rule: LIKED_KEEP } : {};
};

/// Pass 245 A: what teaches Foundry this person's taste. What they like on this
/// mockup, and the changes they asked for on other mockups of the project: a
/// change that comes back is taste too. The model words the rule; the design
/// guide keeps it (remember with learned_from).
export const TASTE_RULE = "Their taste carries over to later mockups in this project. Each thing they like here (liked), and each change in the notes you are handling now that asks for the same kind of thing as one in changes_elsewhere, is taste: "
  + "keep it as one short general rule with remember {design: true, learned_from}, where learned_from is \"♥ on <mockup>\" or \"noted twice: <mockup>, <mockup>\", unless their design guide already says it. "
  + "A note that goes against a learned line replaces it (replaces: some of its words). A change asked once, about one place, is not taste.";
const tasteOf = (store: DemesneStore, id: string, liked: boolean): { changes_elsewhere?: { on: string; note: string }[]; taste_rule?: string } => {
  const elsewhere = store.foundryChangesElsewhere(id);
  return elsewhere.length || liked ? { ...(elsewhere.length ? { changes_elsewhere: elsewhere } : {}), taste_rule: TASTE_RULE } : {};
};

/// Notes the person pinned on this mockup on Foundry and has not sent yet.
/// Their next message carries them; until then the model can still read them,
/// so "my comments" never points at nothing.
export const WAITING_RULE = "The person pinned these notes on this mockup in Foundry and has not sent them yet. When they speak of their comments or notes, these are them: a note marked keep is something they like and want kept, any other is a change.";
const waitingOf = (store: DemesneStore, id: string): { waiting_notes?: { on: string; note: string; keep?: true; version: number; selector?: string }[]; waiting_rule?: string } => {
  const waiting = store.waitingFoundryNotes(id)[0];
  if (!waiting) return {};
  const text = (value: unknown, most: number) => typeof value === "string" ? value.slice(0, most) : "";
  const notes = waiting.notes.map((note) => {
    const part = note.part && typeof note.part === "object" ? note.part as Record<string, unknown> : {};
    return { on: text(note.name, 80) || "the page", note: text(note.text, 600), ...(note.keep === true ? { keep: true as const } : {}), version: waiting.version, ...(text(part.selector, 400) ? { selector: text(part.selector, 400) } : {}) };
  }).filter((note) => note.note);
  return notes.length ? { waiting_notes: notes, waiting_rule: WAITING_RULE } : {};
};

const stageRead = (found: FoundryArtifactDetail) => {
  const stage = found.versions.find((item) => item.version === found.version)?.stage;
  return { ...(stage?.surface ? { surface: stage.surface } : {}), ...(stage?.demo ? { demo: stage.demo } : {}) };
};

/// Pass 241 A: what a read says about building the mockup it returns.
export const BUILD_CHECK = "Once it runs in the project, look at it (look_at_page, capture_window) and compare with foundry_built before you answer.";
const BUILT_READ = "The record of a build, written by foundry_built: the pick beside what was built. It is not edited.";

export function foundryReadTool(store: DemesneStore): AgentTool {
  return {
    definition: {
      name: "foundry_read",
      description: "List Foundry artifacts (no id; query searches), the parts catalogue (id \"kit:parts\"), or read one's current source (or a version) with the version number you pass as base_version to foundry_edit or foundry_save. A read also gives the notes the person pinned on it in Foundry and has not sent yet (their comments).",
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
        ...(found.basedOn ? { basedOn: found.basedOn } : {}), ...(found.built ? { built: BUILT_READ } : found.kind !== "markdown" ? { if_you_build_it: BUILD_CHECK } : {}),
        ...briefOf(found), ...(STYLES_PAGE.test(found.source) ? { styles: styleNames(found.source), styles_rule: stylesKeep(found.id) } : {}), ...likedOf(store, found.id), ...(found.built ? {} : tasteOf(store, found.id, store.foundryLikes(found.id).length > 0)), ...waitingOf(store, found.id), ...stageRead(found), ...walkRead(found), source: found.source, ...(found.files ? { files: found.files } : {}),
        versions: found.versions.map(({ version, note, createdAt, recommended }) => ({ version, note, createdAt, ...(recommended ? { recommended } : {}) })) });
    },
  };
}

/// The kinds that render as a page, so the look can see them.
const LOOKED_KINDS = new Set(["html", "deck", "doc", "dashboard", "react", "mermaid"]);

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

/// Which design targets judge a page: an app window and a part are not posters (foundry-look.ts designReport).
const judgedAs = (source: string, surface: unknown): Judged =>
  APP_WINDOW.test(source) || REVIEW_PAGE.test(source) ? "app" : (surface as { frame?: unknown } | undefined)?.frame === "part" ? "part" : "page";

/// After a page is saved: render it, and hand the model the faults
/// found and a picture. Twice per artifact per turn at most.
async function lookAfter(store: DemesneStore, look: FoundryLook, looks: Map<string, number>, text: string, context: { turnId?: string; signal: AbortSignal }): Promise<string | StructuredToolResult> {
  let saved: Record<string, unknown>;
  try { saved = JSON.parse(text) as Record<string, unknown>; } catch { return text; }
  if (typeof saved.kind !== "string" || !LOOKED_KINDS.has(saved.kind) || typeof saved.id !== "string") return text;
  const key = `${context.turnId ?? ""}:${saved.id}`, seen = looks.get(key) ?? 0;
  if (seen >= LOOKS_PER_TURN) return text;
  const artifact = store.getFoundryArtifact(saved.id);
  if (!artifact) return text;
  const phone = (saved.surface as { frame?: unknown } | undefined)?.frame === "phone";
  const shots = await lookShots(store, artifact.id);
  const result = await look({ kind: artifact.kind, source: withFoundryFiles(artifact.source, artifact.files), title: artifact.title, ...(phone ? { phone } : {}), ...(shots ? { shots } : {}) }, context.signal).catch(() => null);
  if (!result) return text;
  looks.set(key, seen + 1);
  if (looks.size > 200) looks.delete(looks.keys().next().value!);
  const report = lookReport(result, seen + 1 >= LOOKS_PER_TURN, artifact.kind === "html", judgedAs(artifact.source, saved.surface));
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
        + "Use it after making or changing a page that has controls: run the path the ask is about (switch the tab, add the item). "
        + "Steps: {click: name}, {type: text, into?: name}, {key: Enter|Tab|Escape|Backspace|Space|ArrowUp|ArrowDown|ArrowLeft|ArrowRight}, {scroll: px}, {hover: name}, {wait: ms}. "
        + "A name is a control's visible text, label, aria-label or placeholder (a CSS selector also works). Pages that remember start empty here. "
        + "demo: true runs the version's saved demo instead of steps.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          version: { type: "integer", minimum: 1 },
          steps: { type: "array", minItems: 1, maxItems: TRY_STEPS, items: { type: "object" } },
          demo: { type: "boolean", description: "Run the saved demo instead of steps." },
        },
        required: ["id"],
        additionalProperties: false,
      },
    },
    // Nothing leaves the page and nothing is saved: it runs like a look.
    permission: () => null,
    async execute() { throw new Error("[unavailable] foundry_try needs the desktop app"); },
    async executeWithArtifacts(input, context) {
      const args = isRecord(input) ? input : {};
      if (typeof args.id !== "string" || !args.id) throw new Error("[invalid] id is required. Hint: foundry_read without id lists the artifacts");
      const found = store.getFoundryArtifact(args.id, typeof args.version === "number" ? args.version : undefined);
      if (!found) throw new Error("[not_found] No such Foundry artifact or version. Hint: call foundry_read without id to list them");
      let steps: TryStep[];
      if (args.demo === true && args.steps === undefined) {
        const demo = found.versions.find((item) => item.version === found.version)?.stage?.demo;
        if (!demo?.length) throw new Error("[invalid] This version has no demo. Hint: save one with foundry_edit {id, demo}, or pass steps");
        steps = demo.map(({ say: _say, ...step }) => step as TryStep);
      } else {
        try { steps = parseSteps(args.steps); } catch (error) { throw new Error(`[invalid] ${error instanceof Error ? error.message : String(error)}`); }
      }
      if (!LOOKED_KINDS.has(found.kind)) throw new Error(`[invalid] A ${found.kind} artifact has nothing to try; only pages, apps, diagrams, decks, docs and dashboards do`);
      const key = `${context.turnId ?? ""}:${found.id}`, seen = tries.get(key) ?? 0;
      if (seen >= TRIES_PER_TURN) throw new Error(`[limit] This page was tried ${TRIES_PER_TURN} times this turn; answer with what you found`);
      tries.set(key, seen + 1);
      if (tries.size > 200) tries.delete(tries.keys().next().value!);
      // Tried at the size it is drawn for: a phone screen at a phone's width, everything else at the desktop's.
      const phone = found.versions.find((item) => item.version === found.version)?.stage?.surface?.frame === "phone";
      const shots = await lookShots(store, found.id);
      const result = await tryer({ kind: found.kind, source: withFoundryFiles(found.source, found.files), title: found.title, ...(shots ? { shots } : {}) }, { width: phone ? 390 : 1280, steps }, context.signal);
      if (!result) throw new Error("[unavailable] The page could not be tried just now");
      if (!result.steps.length && result.errors.length) throw new Error(`[unavailable] ${result.errors.join("; ")}`);
      const report = tryReport(result);
      return { text: JSON.stringify({ id: found.id, version: found.version, title: found.title, ...report.report }), images: report.images };
    },
  };
  return tool;
}
