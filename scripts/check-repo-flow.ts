/** Real Electron check: a chat commits on a branch, then merges it into main,
 * and the tree draws itself under each step from real git: the branch, the
 * commit and the bend back into main. Labels have their own bands; files
 * are an expandable receipt below the graph. */
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
await git("switch", "-qc", "drive/investigate-long-branch-names-and-overlap-free-repository-animation-1a2b");
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
    const svg = root.querySelector(".rf-body svg")!;
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
  const rows = await tree.locator(".rf-row").allTextContents();
  assert.deepEqual(rows, ["main", "feature", "drive/investigate-long-branch-names-and-overlap-free-repository-animation-1a2b"]);
  const settled = async (view: typeof tree) => eventually(async () => await view.getAttribute("data-playing") === "false", 8000);
  const noOverlap = async (view: typeof tree, duration = 0) => view.evaluate(async (root, duration) => {
    const failures = new Set<string>();
    const until = performance.now() + duration;
    do {
      const svg = root.querySelector<SVGSVGElement>(".rf-body svg")!;
      const visible = (node: Element) => { let at: Element | null = node; while (at && at !== root) { if (Number(getComputedStyle(at).opacity) < .1) return false; at = at.parentElement; } return true; };
      const texts = [...svg.querySelectorAll("text")].filter(visible);
      const boxes = texts.map(node => node.getBoundingClientRect());
      for (let i = 0; i < boxes.length; i++) {
        const a = boxes[i]!;
        for (let j = i + 1; j < boxes.length; j++) { const b = boxes[j]!; if (a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top) failures.add("text overlap"); }
        for (const path of [...svg.querySelectorAll("path")].filter(visible)) {
          const length = path.getTotalLength(), matrix = path.getScreenCTM()!;
          for (let n = 0; n <= 60; n++) {
            const point = path.getPointAtLength(length * n / 60).matrixTransform(matrix);
            if (point.x > a.left - 2 && point.x < a.right + 2 && point.y > a.top - 2 && point.y < a.bottom + 2) failures.add("path crosses text");
          }
        }
      }
      if (root.querySelector('.rf-legend')!.getBoundingClientRect().top < svg.getBoundingClientRect().bottom - 1) failures.add("legend overlaps graph");
      if (root.scrollWidth > root.clientWidth + 1) failures.add("horizontal overflow");
      if (!duration) break;
      await new Promise(resolve => setTimeout(resolve, 65));
    } while (performance.now() < until);
    return [...failures];
  }, duration);
  assert(await fillsWidth(tree), "playing commit fills the chat width");
  assert.equal(await tree.locator('.rf-file, .rf-spark, .rf-wait').count(), 0, "no waiting or flying files");
  assert.equal(await tree.getAttribute("data-playing"), "true", "new commit plays its scene");
  assert.deepEqual(await noOverlap(tree, 3400), []);
  await settled(tree);
  assert.equal(await tree.locator('.rf-title').textContent(), "Grow the garden");
  assert.equal(await tree.locator('.rf-outcome').textContent(), "Committed 6 files to feature  +7 −1");
  assert.equal(await tree.locator('.rf-files > summary').textContent(), "6 files changed · +7 −1");
  assert.equal(await tree.locator('.rf-repo').textContent(), "garden");
  const tip = async () => {
    const child = Bun.spawn(["git", "-C", f.workspace, "rev-parse", "HEAD"], { stdout: "pipe", stderr: "pipe" });
    const value = (await new Response(child.stdout).text()).trim();
    assert.equal(await child.exited, 0); return value;
  };
  const committed = await tip();
  assert((await tree.locator('.rf-meta').textContent())!.startsWith(committed.slice(0, 7)));
  assert.equal(await tree.locator(`[data-sha="${committed}"]`).count(), 1);
  await tree.locator('.rf-files > summary').click();
  assert.equal(await tree.locator('.rf-file-entry').count(), 6, "all six real files are listed");
  assert((await tree.locator('.rf-file-path').allTextContents()).includes("seeds.ts"));
  await tree.locator('.rf-lane > summary').last().click();
  assert.equal(await tree.locator('.rf-lane-log').last().getByText("Fix paths").count(), 1);
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1600, 950));
  await eventually(async () => await fillsWidth(tree));
  await tree.screenshot({ path: join(output, "repo-flow-commit.png") });
  for (const width of [900, 1600]) {
    await desktop.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0]!.setSize(width, 900), width);
    await eventually(async () => await fillsWidth(tree));
    assert.equal(await tree.locator('.rf-files').evaluate(el => (el as HTMLDetailsElement).open), true, "file disclosure survives resizing");
    assert.equal(await tree.locator('.rf-lane').last().evaluate(el => (el as HTMLDetailsElement).open), true, "branch disclosure survives resizing");
    await tree.locator('.rf-replay').focus();
    await page.keyboard.press('Enter');
    assert.equal(await tree.getAttribute('data-playing'), 'true');
    assert(await tree.locator('.rf-replay').isDisabled());
    assert.deepEqual(await noOverlap(tree, 3400), [], `clear labels throughout replay at ${width}px`);
    await settled(tree);
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await tree.locator('.rf-replay').click();
  assert.equal(await tree.getAttribute('data-playing'), 'false');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  console.log("Commit, real files, replay, resize and reduced motion passed.");

  await send("Now merge it into main");
  await allow(); await allow();
  await eventually(async () => await page!.locator('#conversation .repo-flow').count() === 2, 3000);
  const merged = page.locator('#conversation .repo-flow').last();
  assert(!(await page.locator('#conversation').getByText('the branch is in.').count()), "tree appears before answer completes");
  assert.deepEqual(await noOverlap(merged, 3400), []);
  await settled(merged);
  assert.equal(await merged.locator('.rf-outcome').textContent(), 'Merged feature into main');
  assert.equal(await merged.locator('.rf-title').textContent(), 'Grow the garden (#7)');
  assert.equal(await merged.locator('.rf-files > summary').textContent(), '6 files changed · +7 −1');
  assert.equal(await merged.locator('.rf-pipe[data-part="join"]').count(), 1);
  assert((await merged.locator('.rf-meta').textContent())!.startsWith((await tip()).slice(0, 7)));
  assert(await fillsWidth(merged));
  await merged.screenshot({ path: join(output, 'repo-flow-merge.png') });
  await page.screenshot({ path: join(output, 'repo-flow-chat.png') });
  console.log("Merge into main passed.");

  await eventually(async () => (await page!.locator('#conversation').innerText()).includes('the branch is in.'), 10000);
  writeFileSync(join(f.workspace, 'watering.ts'), 'export const water = true;\n');
  await git('add', '-A'); await git('commit', '-qm', 'Water the garden');
  await send('Merge main into feature');
  await allow(); await allow();
  await eventually(async () => await page!.locator('#conversation .repo-flow').count() === 3, 10000);
  const branchMerge = page.locator('#conversation .repo-flow').last();
  await settled(branchMerge);
  assert.equal(await branchMerge.locator('.rf-outcome').textContent(), 'Merged into feature');
  assert.equal(await branchMerge.locator('.rf-title').textContent(), 'Bring main into feature');
  assert.equal(await branchMerge.locator('.rf-pipe[data-part="join"]').count(), 1, "real main parent joins the feature commit");
  assert.equal(await branchMerge.locator('.rf-files > summary').textContent(), '1 file changed · +1 −0');
  assert.deepEqual(await noOverlap(branchMerge), []);
  await branchMerge.screenshot({ path: join(output, 'repo-flow-feature-merge.png') });
  console.log("Merge into feature passed.");

  await page.reload();
  await page.locator('#conversation .repo-flow').first().waitFor({ timeout: 20000 }).catch(async () => {
    await page!.locator('.sidebar-session').first().click();
    await page!.locator('#conversation .repo-flow').first().waitFor();
  });
  const history = page.locator('#conversation .repo-flow').first();
  assert.equal(await history.getAttribute('data-playing'), 'false');
  assert.equal(await history.locator('.rf-details').evaluate(node => getComputedStyle(node).opacity), '1');
  assert.equal(await history.locator('.rf-file-entry').count(), 6, "file evidence survives reload");
  await eventually(async () => await fillsWidth(history));
  assert.deepEqual(errors, []);
  console.log("Repo flow check passed.");
} finally {
  await desktop?.close().catch(() => {});
  await f.close();
}
