import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// Exercise the actual delegated handlers without starting the workspace host.
const source = readFileSync(new URL("../live.ts", import.meta.url), "utf8");
function harness() {
  const handlers: Record<string, (event: any) => void> = {};
  const fill = { style: { width: "" } }, word = { textContent: "Low" };
  let captured = false, renders = 0;
  const calls: unknown[] = [], levels = new Map<string, string>();
  const groove = {
    dataset: { model: "test", levels: '["low","medium","high"]' },
    classList: { add() {}, remove() {} },
    getBoundingClientRect: () => ({ left: 0, width: 300 }),
    querySelector: (selector: string) => selector === ".mp-fill" ? fill : word,
    querySelectorAll: () => [], setAttribute() {},
    setPointerCapture() { captured = true; },
    hasPointerCapture: () => captured,
    releasePointerCapture() { captured = false; },
  };
  const block = source.slice(source.indexOf("let thinkingDrag:"), source.indexOf("// Pointing at a model"));
  const js = new Bun.Transpiler({ loader: "ts" }).transformSync(block);
  new Function("document", "el", "levelWord", "renderOverlay", "modelLevels", "act", "api", `let overlay = "models", overlaySignature = "same", state = {model:{id:"test"}}; ${js}`)(
    { addEventListener: (name: string, fn: any) => { handlers[name] = fn; } },
    () => ({ querySelector: () => groove }), (s: string) => s,
    () => { renders++; }, levels, (fn: () => unknown) => fn(),
    (...args: unknown[]) => { calls.push(args); },
  );
  const send = (type: string, x: number, pointerId = 1) => handlers[type]!({ type, clientX: x, pointerId, button: 0, preventDefault() {}, target: { closest: () => groove } });
  return { send, levels, calls, fill, captured: () => captured, renders: () => renders };
}

test("captures dragging and commits the nearest visible stop once", () => {
  const h = harness();
  h.send("pointerdown", 100);
  expect(h.captured()).toBe(true);
  h.send("pointermove", 205);
  h.send("pointerup", 205);
  expect(h.levels.get("test")).toBe("medium");
  expect(h.calls).toEqual([["model", { id: "test", reasoning: "medium" }]]);
  expect(h.captured()).toBe(false);
});

test("another pointer cannot commit; cancellation restores without applying", () => {
  const h = harness();
  h.send("pointerdown", 100);
  h.send("pointerup", 300, 2);
  expect(h.captured()).toBe(true);
  h.send("pointercancel", 300);
  expect(h.calls).toEqual([]);
  expect(h.levels.size).toBe(0);
  expect(h.renders()).toBe(1);
  expect(h.captured()).toBe(false);
});

test("dragging outside the track clamps to its endpoints", () => {
  for (const [x, expected] of [[-50, "low"], [450, "high"]] as const) {
    const h = harness();
    h.send("pointerdown", 100);
    h.send("pointerup", x);
    expect(h.levels.get("test")).toBe(expected);
  }
});
