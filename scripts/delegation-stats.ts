/** How much a chat delegates, from the daemon's own record: per turn that
 * used tools, how many sub-agents it sent, how many files the chat read
 * itself, and how many input tokens its own model calls took. Pass a date to
 * compare the turns before and after it (e.g. when "How often" changed).
 *
 *   bun scripts/delegation-stats.ts <demesne.sqlite> [--split 2026-11-06T02:00Z] [--since 2026-10-30]
 *
 * Read-only: the database is opened read-only. */
import { Database } from "bun:sqlite";

const args = process.argv.slice(2);
const path = args.find((arg) => !arg.startsWith("--") && !/^\d{4}-/.test(arg));
const flag = (name: string) => { const index = args.indexOf(`--${name}`); return index >= 0 ? args[index + 1] : undefined; };
if (!path) { console.error("usage: bun scripts/delegation-stats.ts <demesne.sqlite> [--split <iso time>] [--since <iso time>]"); process.exit(2); }
const split = flag("split"), since = flag("since") ?? "0000";

const db = new Database(path, { readonly: true });
interface Turn { id: string; created_at: string }
const turns = db.query<Turn, [string]>("SELECT id, created_at FROM turns WHERE created_at >= ? ORDER BY created_at").all(since);
const calls = db.query<{ name: string; arguments_json: string }, [string]>("SELECT name, arguments_json FROM tool_calls WHERE turn_id = ?");
const tokens = db.query<{ input: number | null }, [string]>("SELECT SUM(input_tokens) AS input FROM provider_calls WHERE turn_id = ?");

interface Tally { turns: number; withAgents: number; agents: number; files: number; input: number }
const empty = (): Tally => ({ turns: 0, withAgents: 0, agents: 0, files: 0, input: 0 });
const before = empty(), after = empty();
for (const turn of turns) {
  const used = calls.all(turn.id);
  if (!used.length) continue;
  let agents = 0, files = 0;
  for (const call of used) {
    if (call.name === "subagent") agents++;
    else if (call.name === "read_file") files++;
    else if (call.name === "read_files") {
      try { const parsed = JSON.parse(call.arguments_json); files += Array.isArray(parsed.paths) ? parsed.paths.length : Array.isArray(parsed.files) ? parsed.files.length : 1; } catch { files++; }
    }
  }
  const tally = split && turn.created_at >= split ? after : before;
  tally.turns++; tally.agents += agents; tally.files += files; tally.input += tokens.get(turn.id)?.input ?? 0;
  if (agents) tally.withAgents++;
}
const line = (name: string, t: Tally) => t.turns
  ? `${name}: ${t.turns} turns with tools · ${Math.round(100 * t.withAgents / t.turns)}% sent sub-agents · ${(t.agents / t.turns).toFixed(2)} sub-agents/turn · ${(t.files / t.turns).toFixed(1)} files read by the chat/turn · ${Math.round(t.input / t.turns).toLocaleString("en-US")} input tokens/turn`
  : `${name}: no turns with tools`;
console.log(line(split ? `Before ${split}` : "All", before));
if (split) console.log(line(`After ${split}`, after));
