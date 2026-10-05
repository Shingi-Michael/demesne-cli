/** The Files panel's tree through the same pixel transport used by Ghostty:
 * changes first (a folder of new files is one row), folders that open and
 * close, search grouped by folder, and an opened file's highlighting and
 * change marks. */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fixture, eventually } from "./test/fixture.ts";
import { TerminalHarness } from "./test/terminal-harness.ts";
const output = resolve(process.argv[2] ?? "/tmp/demesne-files-tree-check");
mkdirSync(output, { recursive: true });
const f = await fixture();
const git = (...args: string[]) => Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: f.workspace, env: process.env });
mkdirSync(join(f.workspace, "src", "lib"), { recursive: true });
writeFileSync(join(f.workspace, "src", "app.ts"), ["export function start() {", "  return 1;", "}", ""].join("\n"));
writeFileSync(join(f.workspace, "src", "lib", "util.ts"), "export const util = true;\n");
git("init", "-q"); git("add", "-A"); git("commit", "-qm", "init");
writeFileSync(join(f.workspace, "src", "app.ts"), ["export function start() {", "  return 2;", "}", "export const extra = 3;", ""].join("\n"));
mkdirSync(join(f.workspace, "scratch"));
for (const name of ["a.ts", "b.ts", "c.ts"]) writeFileSync(join(f.workspace, "scratch", name), "// new\n");
writeFileSync(join(f.workspace, "notes.md"), "draft\n");
const app = new TerminalHarness({ env: f.env, entry: resolve(import.meta.dir, "terminal.ts"), args: ["--live", `--server=${f.server.url}`, `--workspace=${f.workspace}`, `--capture-dir=${output}`] });
let state: any;
async function wait(check: (s: any) => boolean, label: string) {
  try { await eventually(() => { try { state = JSON.parse(readFileSync(join(output, "state.json"), "utf8")); return check(state); } catch { return false; } }, 15000); }
  catch { throw new Error(`${label} did not settle: ${JSON.stringify(state?.live?.fileView)}`); }
}
async function click(find: (c: any) => boolean, label: string) {
  await wait((s) => s.live?.controls.some(find), label);
  const c = state.live.controls.find(find);
  assert.notEqual(c.hit, false, `${label} is reachable`);
  app.click(Math.round(c.x), Math.round(c.y));
}
const rows = () => state.live.fileView.rows as string[];
async function shot(name: string) { await Bun.sleep(400); await app.png(join(output, `${name}.png`)); console.log(`✓ ${name}`); }
try {
  await app.after(0);
  await wait((s) => s.live?.connection === "online", "online");
  await Bun.sleep(300);
  app.write("\x1bo");
  await wait((s) => s.live.pane === "files" && s.live.fileView.rows?.includes("# All files"), "files");
  // Changes first: the edited file with its counts, the new folder as one row.
  assert.deepEqual(rows().slice(0, 4), ["# Changed", "src/app.ts +2 −1", "notes.md new", "▸ scratch/ (3 new files)"]);
  assert(rows().includes("▸ src (2)"), "folders start closed");
  await shot("tree");
  await click((c) => c.action === "file-toggle" && JSON.parse(c.args).key === "tree:src", "src folder");
  await wait((s) => s.live.fileView.rows.includes("▾ src (2)") && s.live.fileView.rows.includes("▸ lib (1)"), "src opens");
  assert.equal(rows().filter((row) => row.startsWith("src/app.ts")).length, 2, "its files show beneath it");
  await click((c) => c.action === "file-toggle" && JSON.parse(c.args).key === "changed:scratch", "new folder group");
  await wait((s) => s.live.fileView.rows.includes("scratch/a.ts new"), "the group opens");
  await shot("tree-open");
  // Search: matches grouped under their folder.
  await click((c) => c.id === "file-search", "search");
  app.paste("ts");
  await wait((s) => s.live.fileView.query === "ts" && s.live.fileView.rows[0]?.startsWith("# "), "search groups");
  assert(rows().includes("# scratch") && rows().includes("# src/lib"), "grouped by folder");
  await shot("search");
  await click((c) => c.action === "read-file" && JSON.parse(c.args).path === "src/app.ts", "app.ts");
  await wait((s) => s.live.fileView.path === "src/app.ts" && s.live.fileView.highlighted, "file open");
  // Line 2 changed, line 4 added since the last commit.
  assert.deepEqual(state.live.fileView.changeMarks, { "2": "mod", "4": "add" });
  assert(state.live.text.includes("+2 −1 since last commit"));
  await shot("file");
  app.write("\x11"); assert.equal(await app.child.exited, 0);
  console.log(JSON.stringify({ result: "passed", screenshots: output, checked: ["changes first", "new folder grouped", "folders open and close", "search grouped", "highlighting", "change marks"] }));
} finally { app.kill(); await f.close(); }
