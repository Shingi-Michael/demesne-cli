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
    const steps = /into feature/i.test(request)
      ? [["git", "switch", "-q", "feature"], ["git", "merge", "--no-ff", "-m", "Bring main into feature", "main"]]
      : /merge/i.test(request)
      ? [["git", "switch", "-q", "main"], ["git", "merge", "--no-ff", "-m", "Grow the garden (#7)", "feature"]]
      : [["git", "commit", "-m", "Grow the garden"]];
    if (done < steps.length) {
      yield { type: "tool_call_delta" as const, index: 0, idDelta: `run-${at}-${done}`, nameDelta: "run_command", argumentsDelta: JSON.stringify({ argv: steps[done] }) };
      yield { type: "finish", reason: "tool_calls" }; return;
    }
    // After the merge the answer takes its time, as a real model's does:
    // the tree must not wait for the turn to end.
    if (/merge/i.test(request)) for (const word of "Merged into main, and the branch is in.".split(" ")) { await Bun.sleep(700); yield { type: "text_delta", delta: `${word} ` }; }
    else yield { type: "text_delta", delta: "Committed." };
    yield { type: "finish", reason: "stop" };
  },
}, { workspaceName: "garden" });

const git = async (...args: string[]) => {
  const child = Bun.spawn(["git", "-C", f.workspace, ...args], { stdout: "pipe", stderr: "pipe" });
  if (await child.exited !== 0) throw new Error(`git ${args.join(" ")}: ${await new Response(child.stderr).text()}`);
};
// A project with history on main, Drive's branch beside it, and your
// branch with six files staged, including one beyond the drawing's limit.
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
for (let i = 1; i <= 4; i++) writeFileSync(join(f.workspace, `plant-${i}.ts`), `export const plant = ${i};\n`);
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
  const fillsWidth = async (view: typeof tree) => view.evaluate(root => {
    const svg = root.querySelector("svg")!;
    const style = getComputedStyle(root);
    const contentWidth = root.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    return Math.abs(svg.getBoundingClientRect().width - contentWidth) < 2;
  });
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
  await eventually(async () => (await tree.locator(".rf-file").count()) === 6);
  assert(await fillsWidth(tree), "playing commit fills the available chat width");
  assert(await tree.evaluate(root => {
    const style = getComputedStyle(root);
    return style.borderTopStyle === "solid" && style.borderTopWidth === "1px" && style.borderTopColor !== "rgba(0, 0, 0, 0)" && parseFloat(style.borderRadius) > 0;
  }), "tree has a visible subtle rounded frame");
  assert.equal(await tree.locator(".rf-caption span").last().evaluate(node => getComputedStyle(node).opacity), "0", "commit starts animated, not already settled");
  await page.waitForTimeout(1500);
  await tree.screenshot({ path: join(output, "repo-flow-commit-files.png") });
  await eventually(async () => (await tree.locator(".rf-caption span").last().evaluate(node => getComputedStyle(node).opacity)) === "1", 8000);
  assert.equal(await tree.locator(".rf-caption span").last().innerText(), "Committed 6 files to feature · +7 −1");
  assert.equal(await tree.locator(".rf-new").innerHTML(), "feature · Grow the garden", "the branch's row says what landed");
  // The files are in: the rows they waited on close up.
  await eventually(async () => (await tree.locator(".rf-file").count()) === 0, 5000);
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1600, 950));
  await eventually(async () => await fillsWidth(tree));
  const wideWidth = await tree.evaluate(root => root.clientWidth);
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(900, 850));
  await eventually(async () => await fillsWidth(tree) && await tree.evaluate(root => root.clientWidth) < wideWidth);
  assert.equal(await tree.locator(".rf-file").count(), 0, "resizing never replays the animation");
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1600, 950));
  await eventually(async () => await fillsWidth(tree) && await tree.evaluate(root => root.clientWidth) === wideWidth);
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
  // The tree draws while the answer is still being written.
  await eventually(async () => (await page!.locator("#conversation .repo-flow").count()) === 2, 3000);
  assert(!(await page.locator("#conversation").getByText("the branch is in.").count()), "the tree drew before the answer finished");
  assert(Number(await merged.locator('.rf-pipe[data-part="join"]').evaluate(node => getComputedStyle(node).opacity)) > .3, "merge branch is visible before it fades");
  await eventually(async () => (await merged.locator(".rf-caption span").last().evaluate(node => getComputedStyle(node).opacity)) === "1", 8000);
  assert.equal(await merged.locator(".rf-caption span").last().innerText(), "Merged feature into main");
  assert.equal(await merged.locator(".rf-new").innerHTML(), "main · #7 Grow the garden", "main's row names the merge");
  assert(await fillsWidth(merged), "merge fills the available chat width");
  assert.equal(await merged.locator(".rf-pipe[data-part=join]").count(), 1, "the branch bends back into main");
  await eventually(async () => Number(await merged.locator('.rf-pipe[data-part="join"]').evaluate(node => getComputedStyle(node).opacity)) < .3);
  await merged.screenshot({ path: join(output, "repo-flow-merge.png") });
  await page.screenshot({ path: join(output, "repo-flow-chat.png") });
  console.log("Merge tree passed.");

  // Merge main back into feature: its new merge belongs on feature's row.
  await eventually(async () => (await page!.locator("#conversation").innerText()).includes("the branch is in."), 10000);
  writeFileSync(join(f.workspace, "watering.ts"), "export const water = true;\n");
  await git("add", "-A"); await git("commit", "-qm", "Water the garden");
  await send("Merge main into feature");
  await allow(); await allow();
  await eventually(async () => (await page!.locator("#conversation .repo-flow").count()) === 3, 10000);
  const branchMerge = page.locator("#conversation .repo-flow").last();
  await eventually(async () => (await branchMerge.locator(".rf-caption span").last().evaluate(node => getComputedStyle(node).opacity)) === "1", 8000);
  assert.equal(await branchMerge.locator(".rf-caption span").last().innerText(), "Merged into feature");
  assert.equal(await branchMerge.locator(".rf-new").textContent(), "feature · Bring main into feature");
  assert(await fillsWidth(branchMerge), "feature merge fills the available chat width");
  assert.equal(await branchMerge.locator('.rf-pipe[data-part="join"]').count(), 0, "feature merge does not bend into main");
  await branchMerge.screenshot({ path: join(output, "repo-flow-feature-merge.png") });
  console.log("Feature merge tree passed.");

  // A reload shows both trees finished, with nothing playing.
  await page.reload();
  await page.locator("#conversation .repo-flow").first().waitFor({ timeout: 20000 }).catch(async () => {
    await page!.locator(".sidebar-session").first().click();
    await page!.locator("#conversation .repo-flow").first().waitFor();
  });
  assert.equal(await page.locator("#conversation .repo-flow .rf-caption span:last-child").first().evaluate(node => getComputedStyle(node).opacity), "1", "history shows the finished tree");
  await eventually(async () => await fillsWidth(page!.locator("#conversation .repo-flow").first()));
  assert.deepEqual(errors, []);
  console.log("Repo flow check passed.");
} finally {
  await desktop?.close().catch(() => {});
  await f.close();
}
