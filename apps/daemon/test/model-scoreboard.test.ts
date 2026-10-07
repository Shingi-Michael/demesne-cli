import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DemesneStore } from "../../../packages/storage/src/index.ts";
import { modelScoreboard } from "../src/model-scoreboard.ts";
import type { CalibrationRecord } from "../src/drive-calibration.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function seeded() {
  const root = mkdtempSync(join(tmpdir(), "scoreboard-")); roots.push(root);
  const store = new DemesneStore(join(root, "state.sqlite"));
  const here = store.createSession("Here", "/work/here").session.id, there = store.createSession("There", "/work/there").session.id;
  const now = new Date().toISOString();
  let n = 0;
  const turn = (session: string, status: string) => {
    const id = `t${++n}`;
    store.database.query("INSERT INTO turns (id, session_id, content, status, created_at) VALUES (?, ?, 'ask', ?, ?)").run(id, session, status, now);
    return id;
  };
  const call = (turnId: string, provider: string, model: string, output: number, duration: number, first: number, at = now) => {
    const id = `c${++n}`;
    store.database.query("INSERT INTO provider_calls (id, turn_id, provider, model, status, started_at, output_tokens, duration_ms, time_to_first_token_ms) VALUES (?, ?, ?, ?, 'completed', ?, ?, ?, ?)")
      .run(id, turnId, provider, model, at, output, duration, first);
    return id;
  };
  const tool = (turnId: string, callId: string, status: string) =>
    store.database.query("INSERT INTO tool_calls (id, turn_id, provider_call_id, provider_tool_call_id, name, arguments_json, status, permission_status, created_at) VALUES (?, ?, ?, 'x', 'read_file', '{}', ?, 'allowed', ?)")
      .run(`k${++n}`, turnId, callId, status, now);
  const check = (session: string, turnId: string, status: string, at: string) =>
    store.database.query("INSERT INTO command_runs (id, session_id, turn_id, created_at, data_json) VALUES (?, ?, ?, ?, ?)").run(`r${++n}`, session, turnId, at, JSON.stringify({ check: true, status }));

  // A local model: two turns, one failed; a tool error; a check that failed, then passed.
  const a = turn(here, "completed"), a1 = call(a, "ollama", "qwen3-coder", 400, 11_000, 1_000);
  tool(a, a1, "completed"); tool(a, a1, "failed");
  call(a, "ollama", "qwen3-coder", 200, 6_000, 1_000);
  check(here, a, "failed", "2026-10-07T00:00:01Z"); check(here, a, "completed", "2026-10-07T00:00:02Z");
  const b = turn(here, "failed"); call(b, "ollama", "qwen3-coder", 8, 500, 400);
  check(here, b, "failed", "2026-10-07T00:00:03Z");
  // A hosted model in another project; a turn you stopped counts as neither.
  const c = turn(there, "completed"); tool(c, call(c, "openrouter", "big-model", 1000, 10_500, 500), "completed");
  const stopped = turn(there, "cancelled"); call(stopped, "openrouter", "big-model", 0, 0, 0);
  // Out of the window.
  call(turn(there, "completed"), "openrouter", "big-model", 100, 1000, 100, "2020-01-01T00:00:00Z");
  return store;
}

const drive = (model: string, outcome: CalibrationRecord["outcome"]): CalibrationRecord =>
  ({ at: new Date().toISOString(), workspace: "/work/here", proposalId: "p", kind: "fix", confidence: "high", minutes: 10, actualMinutes: 5, outcome, provider: "ollama", model });

test("the scoreboard scores each model from its own turns, tool calls, speed, checks and Drive runs", () => {
  const store = seeded();
  try {
    const [local, hosted, ...rest] = modelScoreboard(store.database, { days: 30, drive: [drive("qwen3-coder", "landed"), drive("qwen3-coder", "discarded")] });
    expect(rest).toEqual([]);
    expect(local).toMatchObject({ provider: "ollama", model: "qwen3-coder", local: true, turns: 2, finished: 1, failed: 1, toolCalls: 2, toolErrors: 1,
      // 400 tokens in 10 s and 200 in 5 s are both 40 tok/s; an 8-token reply is too short to time.
      tokensPerSecond: 40, firstTokenMs: 1000, checkedTurns: 2, passingTurns: 1, driveRuns: 2, driveLanded: 1 });
    expect(hosted).toMatchObject({ provider: "openrouter", model: "big-model", local: false, turns: 2, finished: 1, failed: 0, toolCalls: 1, toolErrors: 0, tokensPerSecond: 100, checkedTurns: 0 });
    // A provider the daemon knows is on your own machine counts as local, whatever its id.
    expect(modelScoreboard(store.database, { days: 30, localProviders: ["OpenRouter"] })[1]!.local).toBe(true);
    // One project only.
    const here = modelScoreboard(store.database, { days: 30, workspace: "/work/here" });
    expect(here.map((score) => score.model)).toEqual(["qwen3-coder"]);
    expect(modelScoreboard(store.database, { days: 30, workspace: "/nowhere" })).toEqual([]);
  } finally { store.close(); }
});
