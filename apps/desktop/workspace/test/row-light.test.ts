import { expect, test } from "bun:test";
import { ROW_LIGHT_MS, lightRows } from "../row-light.ts";

// Pass 260 A: another chat's news lights its own row.

const tones = (entries: Record<string, string>) => new Map(Object.entries(entries));

test("a chat that finishes or asks while you are elsewhere lights its row for six seconds", () => {
  const lit = lightRows(tones({ a: "working", b: "working", c: "" }), tones({ a: "acc", b: "warn", c: "" }), "c", new Map(), 1000);
  expect([...lit]).toEqual([["a", 1000 + ROW_LIGHT_MS], ["b", 1000 + ROW_LIGHT_MS]]);
});

test("nothing lights on the first draw, for the chat you are in, or for a state that is not news", () => {
  expect(lightRows(new Map(), tones({ a: "acc" }), null, new Map(), 0).size).toBe(0);
  expect(lightRows(tones({ a: "working" }), tones({ a: "acc" }), "a", new Map(), 0).size).toBe(0);
  expect(lightRows(tones({ a: "" }), tones({ a: "working" }), null, new Map(), 0).size).toBe(0);
  expect(lightRows(tones({ a: "working" }), tones({ a: "bad" }), null, new Map(), 0).size).toBe(0);
  // A chat that was not in the list before has no change to speak of.
  expect(lightRows(tones({ a: "" }), tones({ a: "", b: "warn" }), null, new Map(), 0).size).toBe(0);
});

test("a lit row stays lit until its time, and goes dark when you open it or its news is gone", () => {
  const lit = new Map([["a", 5000]]);
  const same = tones({ a: "acc" });
  expect([...lightRows(same, same, null, lit, 4000)]).toEqual([["a", 5000]]);
  expect(lightRows(same, same, null, lit, 5000).size).toBe(0);
  expect(lightRows(same, same, "a", lit, 4000).size).toBe(0);
  expect(lightRows(same, tones({ a: "" }), null, lit, 4000).size).toBe(0);
});
