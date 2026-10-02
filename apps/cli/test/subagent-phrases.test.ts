import { expect, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { createPainter } from "@demesne/brand";
import { Workbench } from "../src/workbench/controller.ts";
import { CliContextRail } from "../src/context-rail.ts";
import { SUBAGENT_PHRASE_MS, subagentPhrase, subagentStatus } from "../src/workbench/subagent-phrases.ts";

test("phrases mix bad intentions and gremlin energy with pokes at the sub-agent's model", () => {
  const cycle = (model: string) => new Set(Array.from({ length: 40 }, (_, tick) => subagentPhrase(0, tick * SUBAGENT_PHRASE_MS, model)));
  const qwen = cycle("qwen3.8-27b"), astra = cycle("gpt-6-astra"), other = cycle("llama-3");
  expect(qwen.has("Dreaming about rm -rf") && qwen.has("Licking the semicolons") && qwen.has("Qwen-ing it")).toBe(true);
  expect(qwen.has("Burning plan credits")).toBe(false);
  expect(astra.has("Consulting the stars") && !astra.has("Heating up your PC")).toBe(true);
  expect([...other].some((phrase) => /Qwen|stars|plan credits/.test(phrase))).toBe(false);
  // A phrase holds for a tick, and parallel cards never say the same thing.
  expect(subagentPhrase(0, 10, "qwen")).toBe(subagentPhrase(0, SUBAGENT_PHRASE_MS - 10, "qwen"));
  for (let tick = 0; tick < 60; tick++) {
    const now = tick * SUBAGENT_PHRASE_MS + 5;
    expect(new Set([0, 1, 2, 3, 4].map((slot) => subagentPhrase(slot, now, "qwen3.8-27b"))).size).toBe(5);
  }
});

test("status-only progress lines are told apart from real steps", () => {
  expect(subagentStatus("starting")).toEqual({});
  expect(subagentStatus("qwen3.8-27b · thinking · 3 tool calls")).toEqual({ model: "qwen3.8-27b" });
  expect(subagentStatus("writing report")).toEqual({});
  expect(subagentStatus("read src/app.ts")).toBeNull();
  expect(subagentStatus("qwen3.8-27b · read src/app.ts")).toBeNull();
});

test("a running sub-agent's phrase stays on its card through its steps; steps count, and show on the working line", () => {
  const ui = new Workbench({ paint: createPainter(false), contextRail: new CliContextRail({ id: "t", provider: "t" }, "/project"), sessionTitle: "S", version: "t",
    onExit() {}, onInterrupt() {}, queue: { get: () => "", set() {} } });
  (ui as unknown as { sessionId: string }).sessionId = "home";
  const rows = () => ui.frame(120, 20).rows.map((row) => stripVTControlCharacters(row));
  const card = () => rows().find((row) => row.includes("Agent"))!.trim();
  const real = Date.now;
  try {
    const start = 1_000_000_000_000;
    Date.now = () => start;
    ui.beginTurn({ userText: "Investigate", at: "now" });
    ui.toolRequested({ toolCallId: "a", name: "subagent", arguments: { description: "Find restore", prompt: "x" } });
    // The phrase is there from the start, before any progress arrives.
    expect(card()).toContain(`Find restore · ${subagentPhrase(0, start, "")}`);
    ui.toolProgress({ toolCallId: "a", text: "qwen3.8-27b · starting" });
    expect(card()).toContain(`Find restore · ${subagentPhrase(0, start, "qwen3.8-27b")}`);
    // A real step: the phrase stays, the counter ticks, the working line names it.
    ui.toolProgress({ toolCallId: "a", text: "qwen3.8-27b · read history.ts" });
    expect(card()).toContain(`Find restore · ${subagentPhrase(0, start, "qwen3.8-27b")}`);
    expect(card()).toContain("1 step");
    expect(card()).not.toContain("read history.ts");
    expect(rows().some((row) => row.includes("Find restore · qwen3.8-27b · read history.ts…"))).toBe(true);
    ui.toolProgress({ toolCallId: "a", text: "qwen3.8-27b · search \"restore\"" });
    expect(card()).toContain("2 steps");
    Date.now = () => start + SUBAGENT_PHRASE_MS;
    expect(card()).toContain(`Find restore · ${subagentPhrase(0, start + SUBAGENT_PHRASE_MS, "qwen3.8-27b")}`);
    ui.toolFinished({ toolCallId: "a", name: "subagent", state: "done", message: "Report" });
    expect(card()).toMatch(/Agent +Find restore(?! ·)/);
    expect(card()).not.toContain("steps");
  } finally { Date.now = real; }
});

test("the phrase reads apart from the task: dim separator, then blue italic", () => {
  const real = Date.now, fixed = 1_000_000_001_000;
  Date.now = () => fixed;
  try {
  const paint = createPainter(true);
  const ui = new Workbench({ paint, contextRail: new CliContextRail({ id: "t", provider: "t" }, "/project"), sessionTitle: "S", version: "t",
    onExit() {}, onInterrupt() {}, queue: { get: () => "", set() {} } });
  (ui as unknown as { sessionId: string }).sessionId = "home";
  ui.beginTurn({ userText: "Investigate", at: "now" });
  ui.toolRequested({ toolCallId: "a", name: "subagent", arguments: { description: "Find restore", prompt: "x" } });
  ui.toolProgress({ toolCallId: "a", text: "starting" });
  const row = ui.frame(120, 20).rows.find((line) => stripVTControlCharacters(line).includes("Find restore"))!;
  const phrase = subagentPhrase(0, fixed, "");
  expect(row).toContain(paint.italic(phrase, "electric"));
  expect(row).toContain(paint.text(" · ", "muted"));
  expect(row).not.toContain(paint.text(`Find restore · ${phrase}`, "paper"));
  } finally { Date.now = real; }
});
