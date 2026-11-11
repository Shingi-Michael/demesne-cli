import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as nodeModule from "node:module";
import { Script } from "node:vm";
import { ChatDOM, ComposerHeight, isWindowsDesktopChat, threadConversationKey } from "../windows-chat-redraw.ts";

test("changed renderer sources and the extracted browser fixture compile without app artifacts", () => {
  // Syntax/fixture checks only, not a substitute for tsc or browser execution.
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const live = read("../live.ts"), fixture = read("./windows-chat-redraw.dom.test.ts");
  const transpile = (code: string) => typeof Bun === "undefined" ? nodeModule.stripTypeScriptTypes(code, { mode: "transform" }) : new Bun.Transpiler({ loader: "ts" }).transformSync(code);
  for (const path of ["../live.ts", "../markdown.ts", "../windows-chat-redraw.ts", "../markdown-reconcile.ts", "./windows-chat-redraw.dom.test.ts", "./markdown-redraw.dom.test.ts"])
    assert.doesNotThrow(() => transpile(read(path)), path);
  const section = (start: string, end: string) => {
    const from = live.indexOf(start), to = live.indexOf(end, from);
    assert.ok(from >= 0 && to > from, start);
    return live.slice(from, to);
  };
  const assignment = fixture.slice(fixture.indexOf("const fixtureScript ="), fixture.indexOf("// Opt-in real DOM/layout"));
  const script = new Script(assignment + "\nfixtureScript;").runInNewContext({
    section,
    Bun: { Transpiler: class { transformSync(code: string) { return transpile(code); } } },
  });
  assert.doesNotThrow(() => new Script(script));
  assert.match(script, /function renderComposer\(/);
  assert.match(script, /function renderThreadPane\(/);
});

test("the renderer fix requires both desktop mode and a Windows platform", () => {
  for (const platform of ["Win32", "Win64", "Windows", "WinCE", "win32"]) {
    assert.equal(isWindowsDesktopChat("desktop", { platform }), true);
    assert.equal(isWindowsDesktopChat(undefined, { platform }), false);
  }
  for (const platform of ["MacIntel", "Darwin", "Linux x86_64", "iPhone", "NotWindows"]) {
    assert.equal(isWindowsDesktopChat("desktop", { platform, userAgent: "Windows NT 10.0" }), false);
  }
  assert.equal(isWindowsDesktopChat("desktop", { userAgentData: { platform: "Windows" }, platform: "" }), true);
  assert.equal(isWindowsDesktopChat("desktop", { userAgentData: { platform: "Linux" }, platform: "Win32" }), false);
  assert.equal(isWindowsDesktopChat("desktop", { platform: "", userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }), true);
  assert.equal(isWindowsDesktopChat("desktop", {}), false);
});

test("Windows setters skip identical writes, including browser-normalized HTML", () => {
  let html = "", text = "", hidden = false, writes = 0;
  const attributes = new Map<string, string>(), classes = new Set<string>();
  const node = {
    get innerHTML() { return html; }, set innerHTML(value: string) { writes++; html = value.replace(/&#39;/g, "'"); },
    get textContent() { return text; }, set textContent(value: string) { writes++; text = value; },
    get hidden() { return hidden; }, set hidden(value: boolean) { writes++; hidden = value; },
    getAttribute: (name: string) => attributes.get(name) ?? null,
    setAttribute(name: string, value: string) { writes++; attributes.set(name, value); },
    classList: { contains: (name: string) => classes.has(name), toggle(name: string, on: boolean) { writes++; if (on) classes.add(name); else classes.delete(name); } },
  } as unknown as HTMLElement;
  const dom = new ChatDOM(true);
  const draw = () => {
    dom.html(node, "<span>It&#39;s unchanged</span>");
    dom.text(node, "same");
    dom.property(node, "hidden", true);
    dom.attribute(node, "aria-label", "Send");
    dom.toggle(node, "has-draft", true);
  };
  draw();
  assert.equal(writes, 5);
  draw();
  assert.equal(writes, 5);
  dom.html(node, "<b>changed</b>");
  dom.property(node, "hidden", false);
  dom.toggle(node, "has-draft", false);
  assert.equal(writes, 8);
  const legacy = new ChatDOM(false);
  legacy.html(node, "<b>changed</b>");
  legacy.text(node, "same");
  legacy.property(node, "hidden", false);
  legacy.attribute(node, "aria-label", "Send");
  legacy.toggle(node, "has-draft", false);
  assert.equal(writes, 13, "non-Windows still performs the original writes");
});

test("offscreen measurement only writes a changed final height, never the live baseline", () => {
  let height = "66px", measured = 66, measurements = 0, mirrors = 0;
  const writes: string[] = [];
  const metrics = new Map([["width", "300px"], ["line-height", "22px"], ["min-height", "22px"]]);
  const mirror = {
    setAttribute() {}, tabIndex: 0, wrap: "", placeholder: "", value: "",
    style: { cssText: "", setProperty() {} },
    get scrollHeight() { measurements++; return measured; },
  };
  const editor = {
    clientWidth: 300, value: "three\nshort\nlines", placeholder: "Message…", wrap: "soft",
    scrollTop: 17, selectionStart: 4, selectionEnd: 9, selectionDirection: "backward",
    style: { get height() { return height; }, set height(value: string) { writes.push(value); height = value; } },
    ownerDocument: {
      defaultView: { getComputedStyle: () => ({ getPropertyValue: (name: string) => metrics.get(name) ?? "" }) },
      createElement() { mirrors++; return mirror; }, body: { append() {} },
    },
  } as unknown as HTMLTextAreaElement;
  const sizing = new ComposerHeight();
  const position = () => [editor.scrollTop, editor.selectionStart, editor.selectionEnd, editor.selectionDirection];
  const before = position();
  assert.equal(sizing.resize(editor), false);
  editor.value += "!";
  assert.equal(sizing.resize(editor), false);
  assert.deepEqual(writes, []);
  assert.deepEqual(position(), before);
  assert.equal(mirrors, 1);
  sizing.resize(editor);
  assert.equal(measurements, 2, "identical inputs need no new layout measurement");
  measured = 264; editor.value += "\nmore";
  assert.equal(sizing.resize(editor), true);
  assert.deepEqual(writes, ["132px"]);
  measured = 22; editor.value = "short";
  assert.equal(sizing.resize(editor), true);
  assert.deepEqual(writes, ["132px", "22px"]);
  measured = 44; metrics.set("width", "100px");
  assert.equal(sizing.resize(editor), true, "width and typography participate in the measurement key");
  assert.deepEqual(writes, ["132px", "22px", "44px"]);
  Object.assign(editor, { clientWidth: 0, value: "hidden draft" });
  assert.equal(sizing.resize(editor), false);
  assert.equal(measurements, 5, "hidden editors wait for a nonzero width");
});

test("thread turns exclude draft bookkeeping but include rendered state and folds", () => {
  const chat = { id: "thread", runs: [{ id: "turn", text: "hello" }], activeTurnId: null as string | null, approvals: [] as unknown[], questions: [] as unknown[], model: "model", provider: "provider", draft: "", draftVersion: 0, revision: 1 };
  const key = threadConversationKey(chat, ["fix", []]);
  assert.equal(threadConversationKey({ ...chat, draft: "typing", draftVersion: 2, revision: 2 }, ["fix", []]), key);
  for (const patch of [
    { id: "other" }, { runs: [{ id: "turn", text: "hello world" }] }, { activeTurnId: "turn" },
    { approvals: [{ id: "approval" }] }, { questions: [{ id: "question" }] }, { model: "other" }, { provider: "other" },
  ]) assert.notEqual(threadConversationKey({ ...chat, ...patch }, ["fix", []]), key);
  assert.notEqual(threadConversationKey(chat, ["fix", ["open-step"]]), key);
  assert.notEqual(threadConversationKey(null, ["fix", []]), key);
});
