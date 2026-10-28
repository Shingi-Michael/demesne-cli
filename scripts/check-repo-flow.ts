/** Real Electron check: a chat commits on a branch, then merges it into main,
 * and the tree draws itself under each step from real git: the branch, the
 * files flowing in, the commit, the bend back into main. Labels sit beside
 * the tree, never on it. */
import { _electron as electron, type Page } from "playwright";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fixture, eventually } from "../apps/desktop/workspace/test/fixture.ts";

const f = await fixture({
  providerId: "fixture", modelId: "git-chat",
  async listModels() { return [{ id: "git-chat", provider: "fixture", contextWindow: 262144 }]; },
  async *stream(messages) {
    const at = messages.findLastIndex(message => message.role === "user");
    const request = messages[at]?.content ?? "";
    const done = messages.slice(at + 1).filter(message => message.role === "tool").length;
    const steps = /merge/i.test(request)
      ? [["git", "switch", "-q", "main"], ["git", "merge", "--no-ff", "-m", "Grow the garden (#7)", "feature"]]
      : [["git", "commit", "-m", "Grow the garden"]];
    if (done < steps.length) {
      yield { type: "tool_call_delta" as const, index: 0, idDelta: `run-${at}-${done}`, nameDelta: "run_command", argumentsDelta: JSON.stringify({ argv: steps[done] }) };
      yield { type: "finish", reason: "tool_calls" }; return;
    }
    yield { type: "text_delta", delta: /merge/i.test(request) ? "Merged into main." : "Committed." };
    yield { type: "finish", reason: "stop" };
  },
}, { workspaceName: "garden" });

const git = async (...args: string[]) => {
  const child = Bun.spawn(["git", "-C", f.workspace, ...args], { stdout: "pipe", stderr: "pipe" });
  if (await child.exited !== 0) throw new Error(`git ${args.join(" ")}: ${await new Response(child.stderr).text()}`);
};
// A project with history on main, Drive's branch beside it, and your
// branch with two files staged.
await git("init", "-q", "-b", "main");
await git("config", "user.name", "Smoke"); await git("config", "user.email", "smoke@example.com");
await git("add", "-A"); await git("commit", "-qm", "Start the garden (#5)");
writeFileSync(join(f.workspace, "beds.ts"), "export const beds = 1;\n");
await git("add", "-A"); await git("commit", "-qm", "Add beds (#6)");
await git("switch", "-qc", "drive/fix-paths-1a2b");
writeFileSync(join(f.workspace, "paths.ts"), "export const paths = 2;\n");
await git("add", "-A"); await git("commit", "-qm", "Fix paths");
await git("switch", "-q", "main");
await git("switch", "-qc", "feature");
writeFileSync(join(f.workspace, "seeds.ts"), "export const seeds = ['rose', 'fern', 'moss'];\nexport const count = seeds.length;\n");
writeFileSync(join(f.workspace, "beds.ts"), "export const beds = 3;\n");
await git("add", "-A");

let desktop: Awaited<ReturnType<typeof electron.launch>> | undefined, page: Page | undefined;
const output = resolve("test-results/desktop");
mkdirSync(output, { recursive: true });
try {
  const executable = process.argv[2];
  desktop = await electron.launch({ ...(executable ? { executablePath: resolve(executable) } : {}),
    args: [...(executable ? [] : [resolve("apps/desktop/build/app")]), `--user-data-dir=${join(f.root, "electron-repo-flow")}`, `--server=${f.server.url}`],
    env: { ...f.env, DEMESNE_BUN: process.execPath, XDG_CONFIG_HOME: join(f.home, ".config"), XDG_CACHE_HOME: join(f.home, ".cache") }, timeout: 30000 });
  page = await desktop.firstWindow();
  page.setDefaultTimeout(10000);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.getByRole("heading", { name: "Make room for your next idea." }).waitFor({ timeout: 30000 });
  await desktop.evaluate(({ dialog }, workspace) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [workspace] }); }, f.workspace);
  await page.getByRole("button", { name: "Open a project", exact: false }).click();
  await page.waitForFunction(() => document.getElementById("sidebar-sessions")?.dataset.workspace);
  const editor = page.locator("textarea");
  const send = async (text: string) => {
    // Right after a project opens the composer can still be settling; send again until the message shows.
    await eventually(async () => {
      if (await page!.locator("#conversation").getByText(text).count()) return true;
      if (!(await editor.inputValue())) { await editor.fill(text); await editor.press("Enter"); }
      await page!.waitForTimeout(300);
      return (await page!.locator("#conversation").getByText(text).count()) > 0;
    }, 10000);
  };
  const allow = async () => {
    const button = page!.locator('#approval [data-action="permission"]', { hasText: "Allow" }).first();
    // Trusted projects run commands without asking; click Allow only when asked.
    if (await button.waitFor({ timeout: 2500 }).then(() => true, () => false)) await button.click();
  };
  await send("Commit what's staged");
  await allow();
  // The commit step draws its tree: main, Drive's branch, yours, the files.
  const tree = page.locator("#conversation .repo-flow").first();
  await tree.waitFor({ timeout: 20000 }).catch(async (error) => {
    const sessions = await f.client.listSessions();
    const session = sessions.find(item => item.workspace);
    console.log("conversation:", await page!.locator("#conversation").innerText()); await page!.screenshot({ path: join(output, "repo-flow-debug.png") });
    for (const s of sessions) console.log("session", s.id, s.title, s.workspace);
    if (session) { const replay = await f.client.replayPage(session.id, 0, 10000); console.log(JSON.stringify(replay).slice(0, 6000)); }
    throw error;
  });
  const rows = await tree.locator(".rf-row:not(.rf-new)").evaluateAll(nodes => nodes.map(node => node.innerHTML));
  assert.deepEqual(rows.map(row => row.trim()), ["main", "feature", "Drive · fix-paths-1a2b"], "one row per line: main, your branch nearest, Drive below");
  await eventually(async () => (await tree.locator(".rf-file").count()) === 2);
  await page.waitForTimeout(1500);
  await tree.screenshot({ path: join(output, "repo-flow-commit-files.png") });
  await eventually(async () => (await tree.locator(".rf-caption span").last().evaluate(node => getComputedStyle(node).opacity)) === "1", 8000);
  assert.equal(await tree.locator(".rf-caption span").last().innerText(), "Committed 2 files to feature · +3 −1");
  assert.equal(await tree.locator(".rf-new").innerHTML(), "feature · Grow the garden", "the branch's row says what landed");
  // The files are in: the rows they waited on close up.
  await eventually(async () => (await tree.locator(".rf-file").count()) === 0, 5000);
  // Text never sits on the tree: every label starts right of every pipe.
  const clear = await tree.evaluate(root => {
    const right = Math.max(...[...root.querySelectorAll(".rf-pipe, .rf-node")].map(node => node.getBoundingClientRect().right));
    return [...root.querySelectorAll("svg text")].every(node => node.getBoundingClientRect().left >= right + 4 || node.classList.contains("rf-older"));
  });
  assert(clear, "labels never overlap the tree");
  await tree.screenshot({ path: join(output, "repo-flow-commit.png") });
  console.log("Commit tree passed.");

  await send("Now merge it into main");
  await allow();
  await allow();
  const merged = page.locator("#conversation .repo-flow").last();
  await eventually(async () => (await page!.locator("#conversation .repo-flow").count()) === 2, 15000);
  await eventually(async () => (await merged.locator(".rf-caption span").last().evaluate(node => getComputedStyle(node).opacity)) === "1", 8000);
  assert.equal(await merged.locator(".rf-caption span").last().innerText(), "Merged feature into main");
  assert.equal(await merged.locator(".rf-new").innerHTML(), "main · #7 Grow the garden", "main's row names the merge");
  assert.equal(await merged.locator(".rf-pipe[data-part=join]").count(), 1, "the branch bends back into main");
  await eventually(async () => Number(await merged.locator('.rf-pipe[data-part="join"]').evaluate(node => getComputedStyle(node).opacity)) < .3);
  await merged.screenshot({ path: join(output, "repo-flow-merge.png") });
  await page.screenshot({ path: join(output, "repo-flow-chat.png") });
  console.log("Merge tree passed.");

  // A reload shows both trees finished, with nothing playing.
  await page.reload();
  await page.locator("#conversation .repo-flow").first().waitFor({ timeout: 20000 }).catch(async () => {
    await page!.locator(".sidebar-session").first().click();
    await page!.locator("#conversation .repo-flow").first().waitFor();
  });
  assert.equal(await page.locator("#conversation .repo-flow .rf-caption span:last-child").first().evaluate(node => getComputedStyle(node).opacity), "1", "history shows the finished tree");
  assert.deepEqual(errors, []);
  console.log("Repo flow check passed.");
} finally {
  await desktop?.close().catch(() => {});
  await f.close();
}
