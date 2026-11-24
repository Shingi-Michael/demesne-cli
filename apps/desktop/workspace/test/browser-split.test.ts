import { expect, test } from "bun:test";
import { downloadWords, findWords, outsideDoing, handOverAsk, keyInputs, localPage, pagePoint, openableOutside, ringSpot, splitDoing, splitOpen, splitWidth, tabName, zoomWords } from "../browser-split.ts";

// Pass 248 D: the chat's browser beside the chat. When it opens, where a click
// lands on the page, and which keys reach a page that is yours.

const step = (action: string, state = "done", more: Record<string, unknown> = {}, id = action) => ({ type: "tool", name: "browser", input: { action, ...more }, state, toolCallId: id });
const run = (id: string, ...entries: ReturnType<typeof step>[]) => ({ id, entries: [{ type: "text" }, ...entries] });
const closed = { open: false, openedTurn: null, closedTurn: null, closedAsk: null };

test("the first browser step of a turn opens the split once, and closing keeps it closed for that turn", () => {
  expect(splitOpen(closed, run("t1"))).toEqual({ open: false, openedTurn: null });
  expect(splitOpen(closed, run("t1", step("open")))).toEqual({ open: true, openedTurn: "t1" });
  // You closed it during t1: it stays closed for t1, and the next turn that browses opens it again.
  expect(splitOpen({ ...closed, openedTurn: "t1", closedTurn: "t1" }, run("t1", step("open"), step("click")))).toEqual({ open: false, openedTurn: "t1" });
  expect(splitOpen({ ...closed, openedTurn: "t1", closedTurn: "t1" }, run("t2", step("open")))).toEqual({ open: true, openedTurn: "t2" });
  // No turn running: it stays as it is, so the last page stays until you close it.
  expect(splitOpen({ ...closed, open: true, openedTurn: "t1" }, undefined)).toEqual({ open: true, openedTurn: "t1" });
  expect(splitOpen(closed, run("t1", step("close")))).toEqual({ open: false, openedTurn: null });
});

test("a hand-over opens it again, unless you closed it while that one was asking", () => {
  const asking = run("t1", step("open"), step("hand_over", "running", { reason: "Sign in to the admin" }, "call-9"));
  expect(handOverAsk(asking)).toEqual({ reason: "Sign in to the admin", toolCallId: "call-9" });
  expect(handOverAsk(run("t1", step("hand_over", "done", { reason: "x" })))).toBeNull();
  expect(splitOpen({ ...closed, openedTurn: "t1", closedTurn: "t1" }, asking).open).toBe(true);
  expect(splitOpen({ ...closed, openedTurn: "t1", closedTurn: "t1", closedAsk: "call-9" }, asking).open).toBe(false);
});

test("a click on the picture lands on the same spot of the page", () => {
  const box = { left: 100, top: 50, width: 640, height: 400 }, page = { width: 1280, height: 800 };
  expect(pagePoint(420, 250, box, page)).toEqual({ x: 640, y: 400 });
  expect(pagePoint(100, 50, box, page)).toEqual({ x: 0, y: 0 });
  expect(pagePoint(2000, -10, box, page)).toEqual({ x: 1280, y: 0 });
});

test("keys become the page's own key events; a paste comes as text instead", () => {
  expect(keyInputs({ key: "a" })).toEqual([{ type: "keyDown", keyCode: "a" }, { type: "char", keyCode: "a" }, { type: "keyUp", keyCode: "a" }]);
  expect(keyInputs({ key: "A", shiftKey: true })).toEqual([{ type: "keyDown", keyCode: "A", modifiers: ["shift"] }, { type: "char", keyCode: "A", modifiers: ["shift"] }, { type: "keyUp", keyCode: "A", modifiers: ["shift"] }]);
  expect(keyInputs({ key: "Enter" })).toEqual([{ type: "keyDown", keyCode: "Enter" }, { type: "char", keyCode: "\r" }, { type: "keyUp", keyCode: "Enter" }]);
  expect(keyInputs({ key: "ArrowLeft" }).map((e) => e.keyCode)).toEqual(["Left", "Left"]);
  expect(keyInputs({ key: " " })).toEqual([{ type: "keyDown", keyCode: "Space" }, { type: "char", keyCode: " " }, { type: "keyUp", keyCode: "Space" }]);
  expect(keyInputs({ key: "a", metaKey: true })).toEqual([{ type: "keyDown", keyCode: "a", modifiers: ["meta"] }, { type: "keyUp", keyCode: "a", modifiers: ["meta"] }]);
  expect(keyInputs({ key: "v", metaKey: true })).toEqual([]);
  expect(keyInputs({ key: "Shift", shiftKey: true })).toEqual([]);
});

test("the browser side keeps room for a page and for the chat", () => {
  expect(splitWidth(200, 1400)).toBe(360);
  expect(splitWidth(1300, 1400)).toBe(1020);
  expect(splitWidth(700, 1400)).toBe(700);
});

test("the bar says what the model is doing at the end of the address, and nothing once it is done", () => {
  expect(splitDoing({ reason: "Sign in to the admin" }, null)).toEqual({ tone: "ask", words: "Sign in to the admin, then go back to the chat" });
  expect(splitDoing(null, "Clicked “Pay”")).toEqual({ tone: "now", words: "Clicked “Pay”" });
  expect(splitDoing(null, null)).toBeNull();
  // A page you took yourself: the model waits for you.
  expect(splitDoing(null, "Clicked “Pay”", true)).toEqual({ tone: "mine", words: "Yours · the model waits" });
});

test("only a web address opens in your own browser", () => {
  expect(openableOutside("https://slowpour.test/checkout")).toBe(true);
  expect(openableOutside("http://localhost:5173/")).toBe(true);
  expect(openableOutside("about:blank")).toBe(false);
  expect(openableOutside("")).toBe(false);
  expect(openableOutside(undefined)).toBe(false);
});

test("a ring shows where the model clicked, only while fresh", () => {
  const page = { width: 1280, height: 800 };
  expect(ringSpot({ x: 640, y: 200, ago: 100 }, page)).toEqual({ left: 50, top: 25 });
  expect(ringSpot({ x: 9000, y: -4, ago: 0 }, page)).toEqual({ left: 100, top: 0 });
  expect(ringSpot({ x: 640, y: 200, ago: 5000 }, page)).toBeNull();
  expect(ringSpot(undefined, page)).toBeNull();
});


test("tab chips are named by title, else by site", () => {
  expect(tabName({ n: 1, url: "https://accounts.example/o/auth", title: "" })).toBe("accounts.example");
  expect(tabName({ n: 2, url: "x", title: "Sign in with your account to continue shopping" })).toBe("Sign in with your account t…");
});

test("the find bar counts where you are in the matches, and says when there are none", () => {
  expect(findWords("", { matches: 3, at: 1 })).toBe("");
  expect(findWords("price", null)).toBe("");
  expect(findWords("price", { matches: 12, at: 3 })).toBe("3 of 12");
  expect(findWords("price", { matches: 2, at: 0 })).toBe("1 of 2");
  expect(findWords("zzz", { matches: 0, at: 0 })).toBe("No matches");
});

test("the zoom chip shows only when the page is not at its own size", () => {
  expect(zoomWords(undefined)).toBe("");
  expect(zoomWords(1)).toBe("");
  expect(zoomWords(1.25)).toBe("125%");
  expect(zoomWords(0.67)).toBe("67%");
});

test("a page on this computer is looked up in the project's code; a public one is not", () => {
  for (const url of ["http://localhost:5173/", "http://127.0.0.1:3000/a", "http://app.localhost/", "http://[::1]:8080/"]) expect(localPage(url)).toBe(true);
  for (const url of ["https://example.com/", "https://localhost.example.com/", "about:blank", "nonsense"]) expect(localPage(url)).toBe(false);
});

test("the bar's download chip shows the newest file, how many more, and each in its tooltip", () => {
  expect(downloadWords([])).toBeNull();
  const one = downloadWords([{ name: "report.csv", path: "/p/.demesne/downloads/report.csv", bytes: 2048 }])!;
  expect(one.text).toBe("report.csv");
  expect(one.more).toBe(0);
  expect(one.title).toStartWith("report.csv · 2 KB\n");
  const two = downloadWords([{ name: "report.csv", path: "/a", bytes: 2048 }, { name: "a-very-long-invoice-name-2026.pdf", path: "/b", bytes: 3 * 1024 * 1024 }])!;
  expect(two.text).toBe("a-very-long-invoice-n…");
  expect(two.more).toBe(1);
  expect(two.title.split("\n").slice(0, 2)).toEqual(["a-very-long-invoice-name-2026.pdf · 3.0 MB", "report.csv · 2 KB"]);
});

test("a Google sign-in sent to your own browser says so in the bar, amber while it waits on you", () => {
  expect(outsideDoing(null)).toBeNull();
  expect(outsideDoing({ site: "figma.com", state: "waiting" })).toEqual({ tone: "ask", words: "Google signs in only in your own browser: sign in to figma.com there, and it comes back here" });
  expect(outsideDoing({ site: "figma.com", state: "done", from: "Chrome" })).toEqual({ tone: "now", words: "Signed in to figma.com from Chrome" });
  expect(outsideDoing({ site: "figma.com", state: "failed", said: "No sign-in for figma.com in Chrome yet" })!.words).toBe("figma.com: No sign-in for figma.com in Chrome yet");
  expect(outsideDoing({ site: "youtube.com", state: "never" })!.tone).toBe("ask");
});
