/// Built like the mockup (pass 241 A). After building a mockup (or one of its
/// options) into the project, the chat looks at the result the way it looks
/// at anything it built: a web page through its local server or file
/// (look_at_page), an app through its window (capture_window: a desktop app,
/// a phone simulator, Demesne itself), or the browser. foundry_built then
/// puts that picture beside the option the person picked:
///  - without differences it shows the model the pick, drawn by Foundry the
///    way the long page stages that option, to compare with;
///  - with differences it records the look on Foundry: the pick beside the
///    result, at most three differences ringed and numbered, the rest counted.
/// A turn records three looks of one build at most (the first and two after
/// fixes); every look in one turn lands on the same record, so the first
/// look's rings stay beside the fixed result. The record is a page Demesne
/// writes (protocol foundry-built.ts) and nobody edits.
import type { DemesneStore } from "@demesne/storage";
import { BUILT_LOOKS, builtMatches, builtOf, builtPage, builtVerdict, isRecord, isToday, MAX_BUILT_DIFFERENCES, optionNames, pickOption, shotBox, STYLES_PAGE, withFoundryFiles,
  type BuiltDifference, type BuiltRecord, type FoundryStage, type ImageArtifact } from "@demesne/protocol";
import { ingestImage, readArtifact, type ImageOutput, type StructuredToolResult } from "./artifacts.ts";
import { FOUNDRY_LOOK_PREFIX, type FoundryLook } from "./foundry-look.ts";
import { chatPictures, lookShots } from "./foundry.ts";
import type { AgentTool, ToolContext } from "./tools.ts";
import { pngSize } from "./window-capture.ts";

export const FOUNDRY_BUILT = "foundry_built";
/// The pick, as the model sees it.
export const PICK_FILE = `${FOUNDRY_LOOK_PREFIX}pick.png`;
/// Kinds Foundry can draw a pick of.
const DRAWN = new Set(["html", "deck", "doc", "dashboard"]);
const RECORD_STAGE: FoundryStage = { surface: { frame: "page" } };

const clean = (value: unknown, max: number) => typeof value === "string" ? value.trim().slice(0, max) : "";

export interface BuiltState {
  /// Looks recorded, by turn and mockup.
  looks: Map<string, number>;
  /// Picks shown without a record, by turn and mockup.
  shown: Map<string, number>;
  /// The pick drawn this turn, by turn, mockup, version and option.
  picks: Map<string, ImageArtifact>;
}
const newState = (): BuiltState => ({ looks: new Map(), shown: new Map(), picks: new Map() });
const bump = (map: Map<string, unknown>, key: string, value: unknown) => {
  map.set(key, value);
  if (map.size > 200) map.delete(map.keys().next().value!);
};

/// The option a build follows: the one named, else the page's only one.
function chosenOption(source: string, kind: string, asked: string, title: string): { option: string | null; index?: number } {
  const all = kind === "html" ? optionNames(source) : [];
  const offered = all.filter((name) => !isToday(name));
  if (!offered.length) return { option: asked || null };
  if (offered.length === 1 && !asked) return { option: offered[0]!, index: all.indexOf(offered[0]!) };
  const at = pickOption(all, asked);
  if (at < 0) throw new Error(`[built_option] ${asked ? `"${asked}" is not an option of ${title}` : `${title} has ${offered.length} options`}. Hint: option is the one you built: ${offered.map((name) => `"${name}"`).join(", ")}`);
  return { option: all[at]!, index: at };
}

function differencesOf(value: unknown, picture: ImageArtifact): BuiltDifference[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new Error("[invalid_input] differences is a list of {box, what}, or [] when it matches");
  if (value.length > MAX_BUILT_DIFFERENCES) throw new Error(`[too_many] That is ${value.length} differences. Hint: name the ${MAX_BUILT_DIFFERENCES} that matter most, biggest first, and count the rest in more`);
  return value.map((item, index) => {
    if (!isRecord(item) || typeof item.box !== "string" || typeof item.what !== "string" || !item.what.trim()) throw new Error(`[invalid_input] Difference ${index + 1} needs box and what`);
    const box = shotBox(item.box);
    if (!box) throw new Error(`[invalid_input] "${item.box}" is not a box. Hint: x,y,w,h in the picture's own pixels, from its top left corner`);
    if (box.x < 0 || box.y < 0 || box.x + box.width > picture.width + 2 || box.y + box.height > picture.height + 2)
      throw new Error(`[invalid_input] The box "${item.box}" falls outside the picture, which is ${picture.width}×${picture.height}. Hint: boxes are in the picture's own pixels`);
    return { box: [box.x, box.y, box.width, box.height].map(Math.round).join(","), what: item.what.trim().slice(0, 240) };
  });
}

/// The pick, drawn the way Foundry's long page stages that option, and kept as a picture of this chat.
async function drawPick(store: DemesneStore, look: FoundryLook | undefined, mockup: NonNullable<ReturnType<DemesneStore["getFoundryArtifact"]>>, index: number | undefined,
  context: ToolContext & { sessionId: string; turnId: string }, state: BuiltState): Promise<ImageArtifact | null> {
  const key = `${context.turnId}:${mockup.id}:${mockup.version}:${index ?? "page"}`;
  const kept = state.picks.get(key);
  if (kept) return kept;
  if (!look || !DRAWN.has(mockup.kind)) return null;
  const phone = mockup.versions.find((item) => item.version === mockup.version)?.stage?.surface?.frame === "phone";
  const shots = await lookShots(store, mockup.id);
  const result = await look({ kind: mockup.kind, source: withFoundryFiles(mockup.source, mockup.files), title: mockup.title, ...(phone ? { phone } : {}), ...(index !== undefined ? { option: index } : {}), ...(shots ? { shots } : {}) }, context.signal).catch(() => null);
  const page = result?.pages[0];
  if (!page) return null;
  const data = Buffer.from(page.png, "base64"), size = pngSize(data);
  const viewport = size && page.width > 0 ? { width: page.width, height: Math.round(size.height * page.width / size.width), deviceScaleFactor: Math.round(size.width / page.width * 100) / 100 } : undefined;
  const pick = await ingestImage(store, { data, mimeType: "image/png", filename: PICK_FILE, ...(viewport ? { viewport } : {}) },
    { sessionId: context.sessionId, turnId: context.turnId, toolCallId: `foundry-pick:${key}`, name: FOUNDRY_BUILT }, 0).catch(() => null);
  if (pick) bump(state.picks, key, pick);
  return pick;
}

const pictureOf = async (store: DemesneStore, image: ImageArtifact): Promise<ImageOutput | null> => {
  try { return { data: await readArtifact(store, image, false), mimeType: image.mimeType, filename: image.filename === PICK_FILE ? PICK_FILE : `${FOUNDRY_LOOK_PREFIX}built.png` }; } catch { return null; }
};

/// Pass 245 A: what they chose to build is taste that carries over to later mockups here.
const tasteOfBuild = (title: string, option: string | null | undefined) => ` ${option ? `They chose “${option}” to build` : "They had this one built"}: if that says something general about their taste here, keep it as one short rule with remember {design: true, learned_from: "${option ? "picked on" : "built from"} ${title.slice(0, 60)}"}, unless their design guide already says it.`;

export function foundryBuiltTool(store: DemesneStore, look?: FoundryLook, state: BuiltState = newState()): AgentTool {
  return {
    definition: {
      name: FOUNDRY_BUILT,
      description: "After building a mockup or one of its options, compare the result with it before you answer. Look at the result first (look_at_page, capture_window, the browser), then pass that picture: "
        + `without differences it shows you the pick beside it; with differences (at most ${MAX_BUILT_DIFFERENCES}, biggest first, boxed on your picture; [] when it matches) it records the look on Foundry. Fix, look again, call again: ${BUILT_LOOKS} looks at most.`,
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "The mockup." },
          version: { type: "integer", minimum: 1 },
          option: { type: "string", maxLength: 200, description: "The option built." },
          picture: { type: "string", description: "Image artifact id of your look." },
          where: { type: "string", maxLength: 200, description: "localhost:5173/pricing, a file, or an app's window." },
          differences: {
            type: "array", maxItems: MAX_BUILT_DIFFERENCES,
            items: {
              type: "object",
              properties: {
                box: { type: "string", description: "x,y,w,h in the picture's pixels." },
                what: { type: "string", maxLength: 240, description: "\"Opens on Monthly; the pick opens on Yearly.\"" },
              },
              required: ["box", "what"],
              additionalProperties: false,
            },
          },
          more: { type: "integer", minimum: 0, maximum: 50, description: "Smaller ones left off." },
          left: { type: "string", maxLength: 300, description: "What you leave different, and why." },
        },
        required: ["id", "picture", "where"],
        additionalProperties: false,
      },
    },
    // It reads and keeps pictures of this chat, like a Foundry save.
    permission: () => null,
    async execute() { throw new Error("[unavailable] foundry_built keeps pictures, so it runs with them"); },
    async executeWithArtifacts(input, context): Promise<string | StructuredToolResult> {
      const args = isRecord(input) ? input : {};
      const { sessionId, turnId } = context;
      if (!sessionId || !turnId) throw new Error("[unavailable] foundry_built works in a chat");
      if (typeof args.id !== "string" || !args.id) throw new Error("[invalid_input] id is the mockup you built from. Hint: the @ line in the message gives its id; foundry_read without id lists them");
      const mockup = store.getFoundryArtifact(args.id, typeof args.version === "number" ? args.version : undefined);
      if (!mockup) throw new Error("[not_found] No such mockup or version. Hint: foundry_read without id lists them");
      if (mockup.built) throw new Error(`[built] "${mockup.title}" is the record of a build.${mockup.basedOn ? ` Hint: pass the mockup it was built from, id ${mockup.basedOn.id}` : ""}`);
      if (mockup.kind === "markdown") throw new Error("[invalid_input] A Markdown note is not something to build. Hint: pass the mockup you built from");
      const { option, index } = chosenOption(mockup.source, mockup.kind, clean(args.option, 200), mockup.title);
      const picture = typeof args.picture === "string" && args.picture ? store.getImageArtifact(sessionId, args.picture) : null;
      if (!picture) throw new Error(`[built_picture] ${typeof args.picture === "string" && args.picture ? `"${args.picture}" is not a picture this chat has.` : "picture is missing."} Hint: look at what you built first (look_at_page, capture_window or the browser) and pass the image artifact id it gave${chatPictures(store, sessionId)}`);
      const where = clean(args.where, 200);
      if (!where) throw new Error("[invalid_input] where says where you looked. Hint: the local address, the file, or the app's window");
      const differences = differencesOf(args.differences, picture);
      const key = `${turnId}:${mockup.id}`;
      const pick = await drawPick(store, look, mockup, index, { ...context, sessionId, turnId }, state);
      context.signal.throwIfAborted();
      const from = { id: mockup.id, version: mockup.version, title: mockup.title };

      // Shown, not recorded: the pick beside the model's own picture.
      if (!differences) {
        const shown = state.shown.get(key) ?? 0;
        if (shown >= BUILT_LOOKS) throw new Error("[limit] You have seen the pick beside your build enough this turn. Hint: call with differences ([] when it matches)");
        bump(state.shown, key, shown + 1);
        const images = (await Promise.all([pick, picture].map((image) => image ? pictureOf(store, image) : null))).filter((image): image is ImageOutput => !!image);
        return { text: JSON.stringify({ mockup: from, option, picture: picture.id, pictures: pick ? ["your pick, drawn by Foundry", "what you built"] : ["what you built"],
          next: `${pick ? "Compare the two pictures" : "Foundry could not draw the pick here: compare your picture with the mockup's source (foundry_read)"}, piece by piece: what shows first, the order, the words, sizes and colours. `
            + `Then call ${FOUNDRY_BUILT} again with differences, at most ${MAX_BUILT_DIFFERENCES}, biggest first, each boxed on your picture ([] when it matches). `
            + "Leave out what is meant to differ (sample words, made-up numbers)." }), images };
      }

      const seen = state.looks.get(key) ?? 0;
      if (seen >= BUILT_LOOKS) throw new Error(`[limit] This build was looked at ${BUILT_LOOKS} times this turn. Hint: answer with what still differs and why`);
      // Every look in this turn lands on the same record, after the ones before it.
      const builtId = store.foundryBuiltFor(mockup.id);
      const existing = builtId ? store.getFoundryArtifact(builtId) : null;
      const thisTurn = existing && existing.versions.find((item) => item.version === existing.version)?.turnId === turnId ? builtOf(existing.source) : null;
      const before = thisTurn && thisTurn.from.version === from.version && thisTurn.option === option ? thisTurn : null;
      const more = typeof args.more === "number" && Number.isSafeInteger(args.more) && args.more > 0 ? Math.min(args.more, 50) : 0;
      const record: BuiltRecord = { from, option, where, pick: pick?.id ?? before?.pick ?? null,
        looks: [...(before?.looks ?? []), { picture: picture.id, differences, more }], left: clean(args.left, 300) };
      const verdict = builtVerdict(record), matches = builtMatches(record);
      const description = `What was built from ${mockup.title}${option ? `, “${option}”` : ""}, beside the pick.`;
      const session = store.getSession(sessionId);
      let saved = store.saveFoundryArtifact({ ...(existing ? { id: existing.id } : { kind: "html" as const, title: `${mockup.title.slice(0, 190)}, built` }),
        source: builtPage(record), note: verdict, description, basedOn: { id: mockup.id, version: mockup.version }, built: true, stage: RECORD_STAGE,
        sessionId, turnId, workspace: session?.workspace?.root ?? null });
      // The version's name is the verdict of its latest look.
      saved = store.describeFoundryArtifact(saved.id, { note: verdict });
      store.keepFoundryShot(saved.id, picture);
      if (pick) store.keepFoundryShot(saved.id, pick);
      bump(state.looks, key, seen + 1);
      const last = seen + 1 >= BUILT_LOOKS;
      const next = matches ? `It matches your pick: answer, and say it was built like the mockup.${STYLES_PAGE.test(mockup.source) && option ? ` They chose the style “${option}” to build: keep it as the project's style with remember {design: true, style_of: "${mockup.id}", rule: "${option}"}, unless it already is.` : tasteOfBuild(mockup.title, option)}`
        : last ? "That was the last look this turn: answer, naming what still differs and why."
        : `Fix what differs in the code, look at the result again, and call ${FOUNDRY_BUILT} with the new picture.`;
      // The pick, once a turn, so the model checks its list against it.
      const first = !state.shown.has(key) && seen === 0 && pick ? await pictureOf(store, pick) : null;
      return { text: JSON.stringify({ id: saved.id, title: saved.title, kind: saved.kind, version: saved.version, description, note: verdict, built: true,
        from, option, looks: record.looks.length, verdict, message: `Recorded on Foundry, the pick beside what you built. ${next}${first ? " The picture is your pick, drawn by Foundry: if it shows a difference you did not list, fix that too." : ""}` }),
        images: first ? [first] : [] };
    },
  };
}
