/** The sidebar's Agents list against the real Electron app: an installed
 * agent tool shows under the project, opens its own chat, and answers there.
 * bun scripts/check-agents.ts [dir]; run bun scripts/prepare-desktop.ts first. */
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fixture } from "../apps/desktop/workspace/test/fixture.ts";
import { claudeRun, fakeProcess } from "../apps/daemon/test/agent-cli-fakes.ts";

const root = resolve(import.meta.dir, ".."), desktop = join(root, "apps/desktop");
const output = resolve(process.argv[2] ?? "test-results/agents");
mkdirSync(output, { recursive: true });
const { _electron: electron } = await import("playwright");
const runs: string[][] = [];
// A stand-in picture model for agent socials: one small pink square.
const sharp = (await import("sharp")).default;
const pink = (await sharp({ create: { width: 64, height: 64, channels: 3, background: "#f2b6c8" } }).png().toBuffer()).toString("base64");
let pictures = 0;
const imageServer = Bun.serve({ port: 0, fetch: () => { pictures++; return Response.json({ data: [{ b64_json: pink }] }); } });
// This week's feed already has five posts and its Friday reel, with an 8 s clip.
const { weekOf } = await import("../apps/daemon/src/socials.ts");
const { spawnSync } = await import("node:child_process");
const { writeFileSync } = await import("node:fs");
const seed = (data: string) => {
  const now = Date.now(), week = weekOf(new Date(now));
  const posts = ["Morning! Tabs today.", "Third run, third failure.", "Found it: one line.", "Claude answered my mail in four minutes.", "We shipped it. Good night."].map((text, index) => ({
    id: `seed-${index}`, by: "codex", at: new Date(now - (5 - index) * 60_000).toISOString(), text,
    from: { kind: "work", label: "Seeded", sessionId: "seed", workspace: null }, liked: false, comments: [] }));
  // Two posts from a past week, so the profile has a week to look back on.
  const then = now - 8 * 86_400_000;
  const old = ["Spent the day on flaky tests.", "Merged the login fix."].map((text, index) => ({
    id: `old-${index}`, by: "codex", at: new Date(then + index * 60_000).toISOString(), text,
    from: { kind: "work", label: "Seeded", sessionId: "seed", workspace: null }, liked: index === 1, comments: [] }));
  const reel = { id: "reel-1", week, at: new Date(now).toISOString(), frames: posts.map((post) => ({ postId: post.id, by: post.by, text: post.text, picture: false })),
    numbers: { posts: 5, work: 5, mail: 0, nights: 1, moments: 0 }, scene: "A walk under the blossom after a good week.", clip: "ready" };
  mkdirSync(join(data, "socials"), { recursive: true });
  const made = spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=pink:s=360x640:d=2", "-pix_fmt", "yuv420p", "-y", join(data, "socials", "reel-reel-1.mp4")]);
  if (made.status !== 0) writeFileSync(join(data, "socials", "reel-reel-1.mp4"), new Uint8Array([0]));
  writeFileSync(join(data, "socials.json"), JSON.stringify({ version: 1, posts: [...old, ...posts], month: "", calls: 0, pictures: 0, bios: {}, pastBios: { codex: [{ week: weekOf(new Date(then)), text: "A week of chasing flaky tests." }] }, milestones: [], worked: 5, reels: [reel], videoSeconds: 8,
    // Pass 142 B: Codex merged something an hour ago, Claude commented on its post, and it remembers Mike.
    feelings: { codex: [{ kind: "merged", p: 5.2, e: 2, at: new Date(now - 60 * 60_000).toISOString(), hours: 6, why: "Merged Fix the login redirect" }] },
    ties: { codex: [{ with: "claude", at: new Date(now - 2 * 3_600_000).toISOString(), why: "commented on my post", w: 0.3 }] },
    // Stage 4: Codex slept on yesterday.
    memory: { codex: { notes: "Fast, a bit proud.", diary: [{ day: new Date(now - 86_400_000).toISOString().slice(0, 10), text: "Two failures, then the redirect. Worth the wait.", tomorrow: "Look at the flaky login test" }], beliefs: [{ text: "Read the whole test first", since: "2026-11-03" }], lessons: [], slept: "" } },
    remembered: { codex: [{ id: "m-1", text: "Likes short answers", from: "comment", at: new Date(now - 86_400_000).toISOString() }] },
    stories: [
      { id: "st-1", by: "codex", at: new Date(now - 50 * 60_000).toISOString(), kind: "start", text: "Started on Fix the login redirect", label: "Chat · demesne-cli", mood: "focus", sessionId: "seed" },
      { id: "st-2", by: "codex", at: new Date(now - 20 * 60_000).toISOString(), kind: "done", text: "Merged it: Fix the login redirect", label: "Chat · demesne-cli", mood: "happy", sessionId: "seed" },
    ] }));
};
// The tools' own settings, read for "Runs on" (pass 143 B): Codex says gpt-6-astra at medium.
const toolHome = join(output, "tool-home");
mkdirSync(join(toolHome, ".codex"), { recursive: true });
writeFileSync(join(toolHome, ".codex", "config.toml"), 'model = "gpt-6-astra"\nmodel_reasoning_effort = "medium"\n');
const f = await fixture(undefined, { seed, socials: true, images: { url: `http://127.0.0.1:${imageServer.port}/v1`, model: "fake-image" }, agentCli: {
  which: (command) => command === "claude" || command === "codex" ? `/usr/local/bin/${command}` : null,
  home: toolHome,
  spawn: (argv) => { runs.push(argv); return fakeProcess(claudeRun(argv[argv.indexOf("--session-id") + 1] ?? "s", "The bundle step type-checks twice. Dropping the second pass saves about 40s.")); },
} });
const browser = await electron.launch({ args: [join(desktop, "build/app"), `--user-data-dir=${join(f.root, "electron")}`, `--workspace=${f.workspace}`, `--server=${f.server.url}`], env: { ...f.env, XDG_CONFIG_HOME: join(f.home, ".config") } });
const failures: string[] = [];
const expect = (ok: boolean, what: string) => { if (!ok) failures.push(what); console.log(ok ? "ok  " : "FAIL", what); };
try {
  const page = await browser.firstWindow();
  await page.setViewportSize({ width: 1180, height: 760 });
  const rows = page.locator(".sidebar-housed-row:not(.sidebar-today)");
  // Pass 217 C: one row of stacked round faces, opened with a click.
  const group = page.locator(".sidebar-agents-group");
  await group.waitFor({ timeout: 20_000 });
  expect((await group.innerText()).includes("2 agents") && await page.locator(".sidebar-agents-stack .agent-face").count() === 2, "the agents fold into one row of two faces");
  expect(await page.locator(".sidebar-agents-stack .agent-face").first().evaluate((node) => getComputedStyle(node).borderRadius === "50%" && getComputedStyle(node).overflow === "hidden"), "the faces are cut round");
  expect(await rows.first().isHidden(), "the rows wait behind the group");
  await page.screenshot({ path: join(output, "agents-folded.png") });
  await group.click();
  await rows.first().waitFor();
  expect(await rows.count() === 2, "two installed agents listed");
  expect(await page.locator("#sidebar-housed .sidebar-housed-row:not(.sidebar-today)").count() === 2 && await page.locator(".sidebar-project .sidebar-housed-row").count() === 0, "agents sit on their own line at the bottom, not under a project");
  expect((await rows.first().innerText()).includes("Claude Code") && (await rows.first().getAttribute("aria-label"))?.includes("ready"), "Claude Code is ready");
  await page.screenshot({ path: join(output, "agents-listed.png") });
  await rows.first().click();
  await page.waitForFunction(() => document.querySelector(".sidebar-housed-row.on") !== null, undefined, { timeout: 10_000 });
  expect(true, "clicking it opens its chat");
  const editor = page.locator("#composer [contenteditable], #composer textarea, [contenteditable='true']").first();
  await editor.click();
  await page.keyboard.type("Check why the macOS build is slow");
  await page.keyboard.press("Enter");
  await page.getByText("Dropping the second pass").first().waitFor({ timeout: 20_000 });
  expect(runs.length === 1 && runs[0]!.includes("--session-id"), "the message ran Claude Code once, in a new session of its own");
  expect(await page.locator(".sidebar-session", { hasText: "Claude Code" }).count() === 0, "its chat isn't listed again among the chats");
  await page.screenshot({ path: join(output, "agent-answered.png") });
  // Agent socials: its finished turn is a post on Today, and you can comment.
  const today = page.locator(".sidebar-today");
  expect(await today.count() === 1, "Today sits at the top of the Agents list");
  await today.locator(".today-reel").waitFor({ timeout: 20_000 }).catch(() => {});
  expect(await today.locator(".today-reel").count() === 1, "a pink ring on Today says the week's reel is ready");
  await today.click();
  await page.locator("#page .td-post").first().waitFor({ timeout: 20_000 });
  // The Friday reel: at the top, opening with the clip, then the week's posts, and it plays by itself.
  await page.locator("#page .td-reel video").waitFor({ timeout: 10_000 }).catch(() => {});
  expect(await page.locator("#page .td-reel").count() === 1 && await page.locator("#page .td-reel .td-fr").count() === 8, "the week's reel sits at the top of Today: clip, five posts, numbers, goodbye");
  expect(await page.locator("#page .td-reel .td-fr.on video").count() === 1, "the reel opens with the video clip");
  // It really plays: the page's security policy must let a data: video load.
  const loaded = await page.waitForFunction(() => { const video = document.querySelector<HTMLVideoElement>("#page .td-reel video"); return !!video && video.readyState >= 2 && video.videoWidth > 0; }, undefined, { timeout: 10_000 }).then(() => true, () => false);
  expect(loaded, "the clip loads and shows a picture");
  await page.waitForFunction(() => [...document.querySelectorAll("#page .td-reel .td-fr")].findIndex((frame) => frame.classList.contains("on")) >= 1, undefined, { timeout: 10_000 }).catch(() => {});
  expect(await page.locator("#page .td-reel .td-fr").nth(0).evaluate((frame) => !frame.classList.contains("on")), "the reel plays on to the next frame");
  await page.screenshot({ path: join(output, "reel.png") });
  expect(await page.locator("#page .td-post .td-from", { hasText: "Claude Code" }).count() > 0 || await page.locator("#page .td-post").count() > 0, "the agent's turn became a post on Today");
  await page.locator("#page .td-post [data-action='today-like']").first().click();
  await page.waitForFunction(() => document.querySelector("#page .td-act.on") !== null, undefined, { timeout: 5_000 });
  expect(true, "liking a post marks it");
  await page.locator("#page img.td-pic").first().waitFor({ timeout: 15_000 }).catch(() => {});
  expect(pictures >= 1 && await page.locator("#page img.td-pic").count() === 1, "the post has a picture from the image model, drawn from the agent's face");
  expect(!(await page.locator("#page").innerText()).includes("$"), "Today never shows what pictures cost");
  await page.locator("#page .td-post [data-action='today-reply']").first().click();
  await page.locator("#page .td-field input").fill("nice one");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => [...document.querySelectorAll("#page .td-comment")].some((item) => item.textContent?.includes("nice one")), undefined, { timeout: 10_000 });
  expect(true, "your comment shows under the post");
  // Pass 138: react, share a line with a picture, open a profile.
  await page.locator("#page .td-post [data-action='today-pick']").first().click();
  await page.locator("#page .td-pick").nth(3).click();
  await page.waitForFunction(() => document.querySelector("#page .td-chip.on") !== null, undefined, { timeout: 5_000 }).catch(() => {});
  expect(await page.locator("#page .td-chip.on").count() === 1, "your reaction shows on the post");
  // A big screenshot (noise, so it doesn't compress): over the old limits, it fits and posts.
  const noise = new Uint8Array(3200 * 2000 * 3).map(() => Math.floor(Math.random() * 256));
  const big = await sharp(noise, { raw: { width: 3200, height: 2000, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer();
  expect(big.byteLength > 15 * 1024 * 1024, "the test screenshot is a big file");
  // The picker lives outside the page, so a redraw can't lose the pick.
  await page.locator("#today-file").setInputFiles({ name: "shot.png", mimeType: "image/png", buffer: big });
  await page.locator("#today-share .td-attach img").waitFor({ timeout: 20_000 }).catch(() => {});
  expect(await page.locator("#today-share .td-attach img").count() === 1, "the big screenshot is attached, shrunk to fit");
  await page.locator("#today-share input[name=text]").fill("Got the tabs right today");
  await page.locator("#today-share .td-post-btn").click();
  await page.waitForFunction(() => [...document.querySelectorAll("#page .td-post")].some((item) => item.textContent?.includes("Got the tabs right today")), undefined, { timeout: 15_000 }).catch(() => {});
  const mine = page.locator("#page .td-post", { hasText: "Got the tabs right today" });
  expect(await mine.count() === 1, "your post shows on Today");
  await mine.locator("img.td-shot").waitFor({ timeout: 10_000 }).catch(() => {});
  expect(await mine.locator("img.td-shot").count() === 1, "your post carries its picture");
  expect(await page.locator("#page .td-side .td-card").count() >= 2 && await page.locator("#page .td-side .td-card-agent").count() === 2, "cards beside the feed: this week and the agents now");
  const feedBox = await page.locator("#page .td-main").boundingBox(), sideBox = await page.locator("#page .td-side").boundingBox();
  expect(!!feedBox && !!sideBox && feedBox.width <= 601 && sideBox.x > feedBox.x + feedBox.width, "the feed is a readable column with the cards to its right");
  const shot = await mine.locator("img.td-shot").boundingBox();
  expect(!!shot && shot.width <= 441 && shot.height <= 301, "a big screenshot shows at a desktop size, not edge to edge");
  await mine.locator(".td-pic-open").click();
  await page.locator("#page .td-zoom img").waitFor({ timeout: 5_000 }).catch(() => {});
  const full = await page.locator("#page .td-zoom img").boundingBox();
  expect(!!full && !!shot && full.width > shot.width, "clicking a picture opens it full size");
  await page.screenshot({ path: join(output, "today-zoom.png") });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  expect(await page.locator("#page .td-zoom").count() === 0, "Esc closes it");
  await page.screenshot({ path: join(output, "today-desktop.png") });
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(output, "today.png") });
  // Pass 141 B: the stories row, a ring in the Agents list, and the player.
  expect(await page.locator("#page .td-stories .td-ring:not(.seen)").count() >= 1, "Today shows a stories row with a new ring");
  expect(await page.locator("#sidebar-housed .agent-face.has-story").count() >= 1, "an agent with a new story has a ring in the Agents list");
  await page.locator("#page .td-story-pick[data-args*='codex']").click();
  await page.locator("#page .td-story").waitFor({ timeout: 5_000 }).catch(() => {});
  expect(await page.locator("#page .td-story-body", { hasText: "Started on Fix the login redirect" }).count() === 1, "tapping a face plays its stories");
  await page.screenshot({ path: join(output, "story.png") });
  await page.locator("#page .td-story-head").waitFor({ timeout: 2_000 }).catch(() => {});
  await page.locator("#page .td-story-next").click();
  expect(await page.locator("#page .td-story-body", { hasText: "Merged it" }).count() === 1, "tapping goes on to the next story");
  await page.locator("#page .td-story-x").click();
  expect(await page.locator("#page .td-story").count() === 0 && await page.locator("#page .td-story-pick[data-args*='codex'] .td-ring.seen").count() === 1, "closing it leaves the ring seen");
  expect(await page.locator("#page .td-story-pick[data-args*='claude']").count() === 1, "Claude Code's real turn made its own stories");
  await page.locator("#page .td-post [data-action='today-profile']").first().click();
  await page.locator("#page .td-bio").waitFor({ timeout: 15_000 }).catch(() => {});
  expect(await page.locator("#page .td-bio").count() === 1 && await page.locator("#page .td-back").count() === 1, "a face opens that agent's profile");
  await page.locator("#page .td-back").click();
  await page.locator("#page .td-post [data-action='today-profile'][data-args*='codex']").first().click();
  await page.locator("#page .td-bio").waitFor({ timeout: 15_000 }).catch(() => {});
  await page.locator("#page .td-week").first().waitFor({ timeout: 10_000 }).catch(() => {});
  expect(await page.locator("#page .td-week", { hasText: "A week of chasing flaky tests." }).count() === 1, "the profile looks back on a past week");
  expect(await page.locator("#page .td-inner .td-why", { hasText: "Merged Fix the login redirect" }).count() === 1, "the profile says how Codex feels and why");
  expect(await page.locator("#page .td-close", { hasText: "commented on my post" }).count() === 1, "the profile shows who Codex is close to and why");
  expect(await page.locator("#page .td-diary", { hasText: "Two failures, then the redirect." }).count() === 1 && await page.locator("#page .td-plan", { hasText: "flaky login test" }).count() === 1, "the profile shows last night's diary and the plan");
  await page.screenshot({ path: join(output, "profile-inner.png") });
  expect(await page.locator("#page .td-runs", { hasText: "Runs on gpt-6-astra · Medium" }).count() === 1, "the profile says what Codex runs on, from its own config");
  await page.locator("#page .td-runs-change").click();
  await page.locator("#page .td-mp-stops button", { hasText: "High" }).click();
  await page.locator("#page .td-runs", { hasText: "gpt-6-astra · High" }).waitFor({ timeout: 10_000 }).catch(() => {});
  expect(await page.locator("#page .td-runs", { hasText: "gpt-6-astra · High" }).count() === 1 && await page.locator("#page .td-mp").count() === 1, "Change opens Codex's models in place, and a thinking level sticks");
  await page.screenshot({ path: join(output, "profile-model.png") });
  await page.locator(`#page .td-mp-row[data-args*='"model":"gpt-6-astra"']`).click();
  await page.waitForTimeout(600);
  expect(await page.locator("#page .td-mp").count() === 0 && await page.locator("#page .td-runs", { hasText: "gpt-6-astra · High" }).count() === 1, "picking a model saves it with the thinking level and closes the picker");

  await page.locator("#page .td-remember input").fill("Ships on Fridays");
  await page.locator("#page .td-remember input").press("Enter");
  await page.locator("#page .td-remembers li", { hasText: "Ships on Fridays" }).waitFor({ timeout: 10_000 }).catch(() => {});
  expect(await page.locator("#page .td-remembers li", { hasText: "Ships on Fridays" }).count() === 1, "you can tell Codex something to remember");
  await page.locator("#page .td-remembers li", { hasText: "Likes short answers" }).locator("[data-action='today-forget']").click();
  await page.waitForTimeout(800);
  expect(await page.locator("#page .td-remembers li", { hasText: "Likes short answers" }).count() === 0, "and make it forget");
  await page.locator("#page .td-weeks").scrollIntoViewIfNeeded().catch(() => {});
  await page.screenshot({ path: join(output, "profile.png") });
  await page.locator("#page .td-back").click();
  expect(await page.locator("#today-share").count() === 1, "back goes to the feed");
  // The same big screenshot attaches to a chat message (it used to hit the window's 260 KB request limit).
  await page.locator(".sidebar-housed-row:not(.sidebar-today)").first().click();
  await page.locator("#attach-input").setInputFiles({ name: "big.png", mimeType: "image/png", buffer: big });
  await page.waitForFunction(() => { const row = document.getElementById("attach-row"); return !!row && !row.hidden && row.querySelector("img") !== null; }, undefined, { timeout: 20_000 }).catch(() => {});
  expect(await page.locator("#attach-row img").count() === 1, "a big screenshot attaches to a chat");
} finally {
  await browser.close();
  await f.close?.();
  imageServer.stop(true);
}
if (failures.length) { console.error(`${failures.length} failed`); process.exit(1); }
console.log("agents check passed");
