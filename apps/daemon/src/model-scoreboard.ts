import type { Database } from "bun:sqlite";
import type { ModelScore } from "@demesne/protocol";
import type { CalibrationRecord } from "./drive-calibration.ts";

/// The model scoreboard: how each model has done on this machine's real work,
/// from what the daemon already records. A turn belongs to the model that
/// answered its first request; tool calls and speed to the request that made
/// them. Nothing here is a benchmark: it is your own projects, your own asks.

/// Local servers by their usual provider ids, for providers the daemon
/// wasn't told about (a model you used under an earlier config).
const LOCAL = new Set(["ollama", "lmstudio", "llama.cpp", "llamacpp", "vllm"]);

const median = (values: number[]) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

export function modelScoreboard(database: Database, options: { days: number; workspace?: string | null; drive?: CalibrationRecord[]; localProviders?: string[]; now?: number }): ModelScore[] {
  const local = new Set([...LOCAL, ...(options.localProviders ?? []).map((id) => id.toLowerCase())]);
  const since = new Date((options.now ?? Date.now()) - options.days * 86_400_000).toISOString();
  // Turns in the window (and workspace), with the model of their first request.
  const scope = options.workspace ? "AND s.workspace_id = (SELECT id FROM workspaces WHERE root = ?)" : "";
  const params = options.workspace ? [since, options.workspace] : [since];
  const calls = database.query(`
    SELECT p.id, p.turn_id, p.provider, p.model, p.status, p.started_at, p.output_tokens, p.duration_ms, p.time_to_first_token_ms, t.status AS turn_status
    FROM provider_calls p JOIN turns t ON t.id = p.turn_id JOIN sessions s ON s.id = t.session_id
    WHERE p.started_at >= ? ${scope} ORDER BY p.rowid`).all(...params) as {
      id: string; turn_id: string; provider: string; model: string; status: string; started_at: string;
      output_tokens: number | null; duration_ms: number | null; time_to_first_token_ms: number | null; turn_status: string }[];
  if (!calls.length && !options.drive?.length) return [];

  type Tally = ModelScore & { speeds: number[]; firsts: number[] };
  const scores = new Map<string, Tally>();
  const tally = (provider: string, model: string, at: string) => {
    const key = `${provider}\u0000${model}`;
    let score = scores.get(key);
    if (!score) scores.set(key, score = { provider, model, local: local.has(provider.toLowerCase()), turns: 0, finished: 0, failed: 0, toolCalls: 0, toolErrors: 0,
      tokensPerSecond: null, firstTokenMs: null, checkedTurns: 0, passingTurns: 0, driveRuns: 0, driveLanded: 0, lastUsed: at, speeds: [], firsts: [] });
    if (at > score.lastUsed) score.lastUsed = at;
    return score;
  };

  const callModel = new Map<string, Tally>(), turnModel = new Map<string, Tally>();
  for (const call of calls) {
    const score = tally(call.provider, call.model, call.started_at);
    callModel.set(call.id, score);
    if (!turnModel.has(call.turn_id)) {
      turnModel.set(call.turn_id, score);
      score.turns++;
      if (call.turn_status === "completed") score.finished++;
      else if (call.turn_status === "failed" || call.turn_status === "interrupted") score.failed++;
    }
    if (call.status !== "completed") continue;
    if (call.time_to_first_token_ms !== null) score.firsts.push(call.time_to_first_token_ms);
    // Speed needs enough output to mean something.
    const generating = (call.duration_ms ?? 0) - (call.time_to_first_token_ms ?? 0);
    if ((call.output_tokens ?? 0) >= 16 && generating > 0) score.speeds.push((call.output_tokens! * 1000) / generating);
  }

  if (calls.length) {
    const turnIds = [...turnModel.keys()];
    for (let start = 0; start < turnIds.length; start += 500) {
      const chunk = turnIds.slice(start, start + 500), marks = chunk.map(() => "?").join(",");
      for (const row of database.query(`SELECT provider_call_id, status FROM tool_calls WHERE turn_id IN (${marks})`).all(...chunk) as { provider_call_id: string; status: string }[]) {
        const score = callModel.get(row.provider_call_id);
        if (!score) continue;
        score.toolCalls++;
        if (row.status === "failed") score.toolErrors++;
      }
      // The last check each turn ran decides whether it ended verified.
      const last = new Map<string, string>();
      for (const row of database.query(`SELECT turn_id, data_json FROM command_runs WHERE turn_id IN (${marks}) ORDER BY created_at, rowid`).all(...chunk) as { turn_id: string; data_json: string }[]) {
        try { const run = JSON.parse(row.data_json) as { check?: boolean; status?: string }; if (run.check) last.set(row.turn_id, String(run.status)); } catch { /* a torn record */ }
      }
      for (const [turnId, status] of last) {
        const score = turnModel.get(turnId)!;
        score.checkedTurns++;
        if (status === "completed") score.passingTurns++;
      }
    }
  }

  for (const record of options.drive ?? []) {
    if (!record.provider || !record.model || record.at < since) continue;
    const score = tally(record.provider, record.model, record.at);
    score.driveRuns++;
    if (record.outcome === "landed") score.driveLanded++;
  }

  return [...scores.values()].map(({ speeds, firsts, ...score }) => ({
    ...score,
    tokensPerSecond: speeds.length ? Math.round(median(speeds)! * 10) / 10 : null,
    firstTokenMs: firsts.length ? Math.round(median(firsts)!) : null,
  })).sort((a, b) => b.turns - a.turns || b.lastUsed.localeCompare(a.lastUsed));
}
