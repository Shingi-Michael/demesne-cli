/** Session cleanup through the same pixel transport used by Ghostty: /cleanup
 * lists sessions worth deleting with their reasons, keeps real work unticked,
 * asks twice, and deletes the ticked ones for good. */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DemesneStore } from "../../packages/storage/src/index.ts";
import { fixture, eventually } from "./test/fixture.ts";
import { TerminalHarness } from "./test/terminal-harness.ts";
const output = resolve(process.argv[2] ?? "/tmp/demesne-cleanup-check");
mkdirSync(output, { recursive: true });
const f = await fixture();
// Sessions from weeks ago: one empty, one quick question, one with real work.
const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
const store = new DemesneStore(join(f.root, "data", "state.sqlite"));
const empty = store.createSession("Empty draft", f.workspace).session;
const quick = store.createSession("What does serve do?", f.workspace).session;
const work = store.createSession("Refactor the parser", f.workspace).session;
for (const [session, text] of [[quick, "what does serve do?"], [work, "refactor the parser"]] as const) {
  const { turn } = store.createTurn(session.id, text);
  store.startTurn(turn.id);
  if (session === work) store.recordSnapshot(turn.id, [{ path: "parser.ts", existed: true, data: new TextEncoder().encode("old") }]);
  store.appendMessageDelta(turn.id, "Done."); store.completeTurn(turn.id);
}
store.database.query("UPDATE sessions SET updated_at = ?").run(old);
store.close?.();

const app = new TerminalHarness({ env: f.env, entry: resolve(import.meta.dir, "terminal.ts"), args: ["--live", `--server=${f.server.url}`, `--workspace=${f.workspace}`, `--capture-dir=${output}`] });
let state: any;
async function wait(check: (s: any) => boolean, label: string) {
  try { await eventually(() => { try { state = JSON.parse(readFileSync(join(output, "state.json"), "utf8")); return check(state); } catch { return false; } }, 15000); }
  catch { throw new Error(`${label} did not settle: ${JSON.stringify(state?.live?.cleanup)}`); }
}
async function click(action: string, args: Record<string, unknown> = {}) {
  const find = (s: any) => s.live?.controls.find((c: any) => c.action === action && Object.entries(args).every(([k, v]) => JSON.parse(c.args ?? "{}")[k] === v));
  await wait((s) => Boolean(find(s)), `control ${action}`);
  const c = find(state);
  assert.notEqual(c.hit, false, `Control ${action} is reachable`);
  app.click(Math.round(c.x), Math.round(c.y));
}
async function shot(name: string) { await Bun.sleep(500); await app.png(join(output, `${name}.png`)); console.log(`✓ ${name}`); }
try {
  await app.after(0);
  await wait((s) => s.live?.connection === "online" && s.live?.sessionId, "online");
  await Bun.sleep(300);
  app.paste("/cleanup"); await Bun.sleep(80); app.write("\r");
  await wait((s) => s.live.cleanup?.candidates.length === 3 && !s.live.cleanup.loading, "candidates");
  const byTitle = Object.fromEntries(state.live.cleanup.candidates.map((item: any) => [item.title, item]));
  assert.equal(byTitle["Empty draft"].reason, "empty");
  assert.equal(byTitle["What does serve do?"].reason, "quick");
  assert.equal(byTitle["Refactor the parser"].reason, "stale");
  // Real work is listed but not ticked; the open session never is.
  assert.deepEqual([...state.live.cleanup.selected].sort(), [empty.id, quick.id].sort());
  assert(!state.live.cleanup.candidates.some((item: any) => item.id === state.live.sessionId));
  await shot("cleanup");

  await click("choose-row", { index: 0 });
  await wait((s) => s.live.cleanup.armed, "asks to confirm");
  await shot("confirm");
  await click("choose-row", { index: 0 });
  await wait((s) => /^Deleted 2 sessions/.test(s.live.cleanup.message ?? "") && !s.live.cleanup.loading, "deleted");
  await shot("deleted");
  const ids = (await f.client.listSessions()).map((session) => session.id);
  assert(!ids.includes(empty.id) && !ids.includes(quick.id), "the ticked sessions are gone");
  assert(ids.includes(work.id), "the session with real work stays");

  app.write("\x11"); assert.equal(await app.child.exited, 0);
  console.log(JSON.stringify({ result: "passed", screenshots: output, checked: ["reasons", "real work unticked", "asks twice", "deletes for good"] }));
} finally { app.kill(); await f.close(); }
