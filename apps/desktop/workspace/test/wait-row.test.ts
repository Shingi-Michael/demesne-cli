import { expect, test } from "bun:test";
import { waitingFor, waitOutcome, waitRow } from "../wait-row.ts";

const done = (result: Record<string, unknown>) => JSON.stringify({ command: "bun run dev", afterMs: 6200, line: null, exitCode: null, tail: "", ...result });

test("what it waits for reads as words", () => {
  expect(waitingFor("ready|Local:")).toBe("“ready” or “Local:”");
  expect(waitingFor("\\d+ pass")).toBe("“d+ pass”");
  expect(waitingFor(undefined)).toBe("it to finish");
});

test("while it waits, then ready with the address it printed", () => {
  expect(waitRow({ state: "running", pattern: "ready", command: "bun run dev", icon: "" })).toMatchObject({ verb: "Waiting for", target: "“ready”", meta: "bun run dev", tone: "running" });
  const ready = waitRow({ state: "done", pattern: "Local:", command: "", message: done({ status: "matched", line: "➜  Local:   http://localhost:5173/" }), icon: "" });
  expect(ready.verb).toBe("Ready after 0:06");
  expect(ready.target).toBe("localhost:5173");
  expect(ready.tone).toBe("");
  expect(waitRow({ state: "done", pattern: "ready", command: "", message: done({ status: "matched", line: "VITE v6 ready in 412 ms", tail: "VITE v6 ready in 412 ms\n➜ Local: http://localhost:5173/" }), icon: "" }).target).toBe("localhost:5173");
});

test("a command that exits first is red with its last lines", () => {
  const row = waitRow({ state: "done", pattern: "ready", command: "", message: done({ status: "exited", exitCode: 1, afterMs: 4000, tail: "$ vite\nerror: Cannot find module <x>" }), icon: "" });
  expect(row.verb).toBe("Exited 1 after 0:04");
  expect(row.tone).toBe("failed");
  expect(row.tail).toContain("Cannot find module &lt;x&gt;");
  expect(waitRow({ state: "done", pattern: "ready", command: "", message: done({ status: "timeout", afterMs: 60000 }), icon: "" }).verb).toBe("Gave up after 1:00");
  expect(waitRow({ state: "done", pattern: undefined, command: "", message: done({ status: "exited", exitCode: 0 }), icon: "" }).tone).toBe("");
  expect(waitOutcome("not json")).toBeNull();
});
