import { expect, test } from "bun:test";
import {
  StateEncoder,
  StateReceiver,
  type GraphicsSnapshot,
  type StateUpdate,
} from "../state-wire.ts";
import { GraphicsHost } from "../host.ts";
import { fixture } from "./fixture.ts";
import type { GraphicsRun } from "../session-model.ts";
const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const run = (id: string, text: string): GraphicsRun => ({
  id,
  number: 1,
  content: "Check the parser",
  status: "running",
  createdAt: "2026-10-01T00:00:00Z",
  completedAt: null,
  planOnly: false,
  entries: [
    { id: 1, type: "assistant", raw: text, streaming: false, revision: 1 },
  ],
});
async function withState(
  body: (state: GraphicsSnapshot) => Promise<void> | void,
) {
  const f = await fixture(),
    host = new GraphicsHost({
      client: f.client,
      settings: f.settings,
      workspace: f.workspace,
      changed: () => {},
    });
  try {
    await host.connect();
    await body(wire(host.snapshot()));
  } finally {
    host.dispose();
    await f.close();
  }
}

test("long history stays local while only appended text crosses the wire", () =>
  withState((base) => {
    const encoder = new StateEncoder(),
      receiver = new StateReceiver();
    let state = {
      ...base,
      revision: 1,
      runs: Array.from({ length: 100 }, (_, i) => ({
        ...run(String(i), "x".repeat(10000)),
        status: i === 99 ? ("running" as const) : ("completed" as const),
      })),
    };
    receiver.apply(wire(encoder.encode(state)));
    const saved = receiver.state!.runs[0];
    for (let i = 0; i < 12; i++) {
      const last = state.runs.at(-1)!,
        entry = last.entries[0]!;
      if (entry.type !== "assistant") throw new Error("fixture");
      const next = {
        ...last,
        entries: [
          {
            ...entry,
            raw: entry.raw + " new text",
            revision: entry.revision + 1,
          },
        ],
      };
      state = {
        ...state,
        revision: state.revision + 1,
        runs: [...state.runs.slice(0, -1), next],
      };
      const patch = wire(encoder.encode(state));
      expect(JSON.stringify(patch).length).toBeLessThan(600);
      receiver.apply(patch);
      expect(wire(receiver.state)).toEqual(wire(state));
      expect(receiver.state!.runs[0]).toBe(saved);
    }
  }));

test("snapshot fields, removed optional fields, reordered entries, and turn transitions round trip", () =>
  withState((base) => {
    const encoder = new StateEncoder(),
      receiver = new StateReceiver();
    let revision = 0;
    const apply = (state: GraphicsSnapshot) => {
      state = { ...state, revision: ++revision };
      receiver.apply(wire(encoder.encode(state)));
      expect(receiver.needsReset).toBe(false);
      expect(wire(receiver.state)).toEqual(wire(state));
      return state;
    };
    let state = apply({ ...base, runs: [run("one", "before")] });
    // In-place host fields must be noticed even when object identity is unchanged.
    state.model.id = "another model";
    state = apply(state);
    const first = state.runs[0]!;
    state = apply({
      ...state,
      runs: [
        {
          ...first,
          entries: [
            {
              id: 3,
              type: "reasoning",
              raw: "Think",
              streaming: false,
              startedAt: 1,
              durationMs: null,
            },
            first.entries[0]!,
          ],
        },
      ],
    });
    state = apply({
      ...state,
      approvals: [
        {
          id: "p",
          turnId: "one",
          toolCallId: "tool",
          name: "write_file",
          summary: "Write file",
          input: { path: "one.ts" },
          rule: null,
        },
      ],
      runs: [
        {
          ...first,
          entries: [{ ...first.entries[0]!, raw: "replacement" } as never],
        },
      ],
    });
    state = apply({
      ...state,
      approvals: [],
      runs: [
        {
          ...first,
          status: "completed",
          completedAt: "2026-10-01T00:00:02Z",
          receipt: {
            mode: "Build",
            model: "test",
            durationMs: 2000,
            tokensPerSecond: 20,
          },
        },
      ],
    });
    state = apply({
      ...state,
      runs: [{ ...first, receipt: undefined }, run("two", "")],
    });
    state = apply({ ...state, runs: [state.runs[1]!] });
    const old = receiver.state!.runs;
    state = apply({ ...state, queue: "follow-up" });
    expect(receiver.state!.runs).toBe(old);
    apply({
      ...state,
      session: { ...state.session!, id: "new-session" },
      runs: [],
    });
  }));

test("out-of-order or missing deltas never partially update the UI and recover with bootstrap", () =>
  withState((base) => {
    const encoder = new StateEncoder(),
      receiver = new StateReceiver();
    const start = { ...base, revision: 1, runs: [run("one", "hello")] };
    const first = wire(encoder.encode(start));
    receiver.apply(first);
    const second = { ...start, revision: 2, runs: [run("one", "hello there")] };
    const patch = wire(encoder.encode(second));
    encoder.encode({ ...second, revision: 3, draft: "skipped" });
    const gap = wire(encoder.encode({ ...second, revision: 4, draft: "new" }));
    const before = receiver.state;
    expect(receiver.apply(gap)).toBeNull();
    expect(receiver.needsReset).toBe(true);
    expect(receiver.state).toBe(before);
    receiver.apply(patch);
    expect(wire(receiver.state)).toEqual(wire(second));
    expect(receiver.apply(first)).toBeNull();
    const next = { ...second, revision: 5, draft: "recovered" };
    encoder.reset(next);
    receiver.seed(wire(next));
    receiver.apply(
      wire(encoder.encode({ ...next, revision: 6, queue: "queued" })),
    );
    expect(receiver.state!.queue).toBe("queued");
    const corrupt: StateUpdate = {
      kind: "patch",
      base: 6,
      revision: 7,
      fields: { set: { draft: "must not apply" }, unset: [] },
      runs: [
        {
          id: "one",
          fields: { set: {}, unset: [] },
          entries: [
            {
              id: 1,
              fields: { set: {}, unset: [] },
              append: { offset: 0, text: "bad" },
            },
          ],
        },
      ],
    };
    expect(receiver.apply(corrupt)).toBeNull();
    expect(receiver.needsReset).toBe(true);
    expect(receiver.state!.draft).toBe("recovered");
  }));

test("updates arriving ahead of an in-flight bootstrap survive until its base arrives", () =>
  withState((base) => {
    const encoder = new StateEncoder(),
      receiver = new StateReceiver();
    const start = { ...base, revision: 1, runs: [run("one", "a")] };
    receiver.apply(wire(encoder.encode(start)));
    const bootstrap = { ...start, revision: 2, runs: [run("one", "ab")] };
    encoder.reset(bootstrap);
    const third = { ...bootstrap, revision: 3, runs: [run("one", "abc")] };
    const three = wire(encoder.encode(third));
    const fourth = { ...third, revision: 4, runs: [run("one", "abcd")] };
    const four = wire(encoder.encode(fourth));
    receiver.apply(four);
    receiver.apply(three);
    expect(receiver.needsReset).toBe(true);
    receiver.seed(wire(bootstrap));
    expect(wire(receiver.state)).toEqual(wire(fourth));
    expect(receiver.needsReset).toBe(false);
  }));
