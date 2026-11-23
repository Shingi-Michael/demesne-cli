import { expect, test } from "bun:test";
import { DemesneStore } from "@demesne/storage";
import { CAPTURES_PER_TURN, CHANGING_STEPS, captureWindowTool } from "../src/window-capture.ts";
import { foundrySaveTool } from "../src/foundry.ts";
import type { ShotWindow } from "../../../packages/screen/src/index.ts";

// Mike, 2026-11-20: Foundry screenshotted his window at every chance. A
// capture already in the chat is the screen: the same window again in one
// turn, with nothing changed since, is not captured, and a turn captures at
// most twice. The chat keeps its captures, so a restart forgets none.
const windows: ShotWindow[] = [{ id: "1", app: "Demesne", title: "Chat" }, { id: "2", app: "Safari", title: "Slow Pour" }, { id: "3", app: "Notes", title: "Plans" }];
const PICTURE = (n: number) => `0b7f2c1e-1111-4222-8333-44445555666${n}`;

function chat() {
  const store = new DemesneStore(":memory:");
  const { session } = store.createSession("Slow Pour", "/tmp");
  let running = "";
  const turn = (text: string) => {
    if (running) store.completeTurn(running);
    const { turn } = store.createTurn(session.id, text);
    store.startTurn(turn.id);
    running = turn.id;
    const { providerCallId } = store.startProviderCall(turn.id, "fixture", "fixture");
    let n = 0;
    const step = (name: string, result: string) => { const { toolCallId } = store.recordToolCall(turn.id, providerCallId, `c${n++}`, name, "{}"); store.settleToolCall(toolCallId, "completed", result); };
    return { id: turn.id, step };
  };
  const captured: string[] = [];
  let pictures = 0;
  const tool = captureWindowTool({ list: async () => windows, capture: async (window) => { captured.push(window.id); return { ...window, png: new Uint8Array([1, 2]), text: "" }; } },
    (sessionId) => store.windowCaptures(sessionId, CHANGING_STEPS));
  // What the engine does with a capture: runs it, then keeps it with its picture line.
  const capture = async (at: ReturnType<typeof turn>, application: string) => {
    const output = await tool.executeWithArtifacts!({ application }, { workspaceRoot: "/tmp", signal: new AbortController().signal, sessionId: session.id, turnId: at.id });
    if (typeof output === "string") { at.step("capture_window", output); return output; }
    at.step("capture_window", `${output.text}\nImage artifact ${PICTURE(++pictures)}: window-screenshot.png (1280×800)`);
    return output.text;
  };
  return { store, session, turn, capture, captured };
}

test("the same window again in one turn is the picture already there, unless something changed it", async () => {
  const { store, session, turn, capture, captured } = chat();
  try {
    const one = turn("make the chat calmer");
    expect(await capture(one, "Demesne")).toStartWith("Captured window 1");
    expect(await capture(one, "Demesne")).toBe(`Not captured again: this turn already has Demesne — Chat (image artifact ${PICTURE(1)}) and nothing that could change it ran since. Use that picture.`);
    expect(captured).toEqual(["1"]);
    // After an edit the screen may differ: a second look is fine.
    one.step("edit_file", "ok");
    expect(await capture(one, "Demesne")).toStartWith("Captured window 1");
    expect(captured).toEqual(["1", "1"]);
    // Two captures this turn: no third, of any window.
    await expect(capture(one, "Safari")).rejects.toThrow(`[limit] Windows were captured ${CAPTURES_PER_TURN} times this turn (image artifacts ${PICTURE(1)}, ${PICTURE(2)})`);
    // A new turn may look again (the person may have changed it).
    const two = turn("and now the plans page");
    expect(await capture(two, "Safari")).toStartWith("Captured window 2");
    expect(store.windowCaptures(session.id).map(({ turnId, app, picture }) => [turnId === one.id ? 1 : 2, app, picture])).toEqual([[1, "Demesne", PICTURE(1)], [1, "Demesne", PICTURE(2)], [2, "Safari", PICTURE(3)]]);
    expect(store.windowCaptures("nope")).toEqual([]);
  } finally { store.close(); }
});

test("a capture kept with the chat counts as looking first, even after a restart", async () => {
  const { store, session, turn, capture } = chat();
  try {
    await capture(turn("look at my plans page"), "Safari");
    const later = turn("now mock a calmer one");
    // A fresh session id was never seen by this daemon's memory: only the kept capture says it was looked at.
    await foundrySaveTool(store).execute({ title: "Calmer plans", kind: "html", description: "The plans page, calmer.", source: "<!doctype html><title>x</title><main>Plans</main>",
      why: { direction: "Calm.", look_at: "The cards.", starts_from: "a capture of the plans page", walkthrough: [{ what: "Plans.", parts: [{ name: "Cards", says: "The plans." }, { name: "Button", says: "Picks one." }], why: "Calm." }] } }, { workspaceRoot: "/tmp", signal: new AbortController().signal, sessionId: session.id, turnId: later.id });
    expect(store.listFoundryArtifacts().length).toBe(1);
  } finally { store.close(); }
});

test("a look at the person's running app, kept with the chat, counts as looking first too", async () => {
  const { store, session, turn } = chat();
  try {
    expect(store.lookedAtPage(session.id)).toBe(false);
    turn("check my plans page").step("look_at_page", "{}");
    expect(store.lookedAtPage(session.id)).toBe(true);
    const later = turn("now mock a calmer one");
    await foundrySaveTool(store).execute({ title: "Calmer plans", kind: "html", description: "The plans page, calmer.", source: "<!doctype html><title>x</title><main>Plans</main>",
      why: { direction: "Calm.", look_at: "The cards.", starts_from: "the plans page on localhost", walkthrough: [{ what: "Plans.", parts: [{ name: "Cards", says: "The plans." }, { name: "Button", says: "Picks one." }], why: "Calm." }] } }, { workspaceRoot: "/tmp", signal: new AbortController().signal, sessionId: session.id, turnId: later.id });
    expect(store.listFoundryArtifacts().length).toBe(1);
  } finally { store.close(); }
});
