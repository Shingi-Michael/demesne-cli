import { expect, test } from "bun:test";
import { OutsideSignins } from "../src/outside-signin.ts";

// Google refuses sign-in inside an app's browser: the page opens in your own browser, and this
// brings the site's sign-in back once you have signed in there.

const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));
function setup(over: { lastUsed?: () => number; bring?: () => Promise<number> } = {}) {
  let now = 1_000_000, used = 500;
  const brought: [string, string, string][] = [], reloaded: string[] = [];
  const watcher = new OutsideSignins({
    sources: () => [{ id: "chrome", browser: "chrome", label: "Chrome", state: "ready" }, { id: "safari", browser: "safari", label: "Safari", state: "disk" }],
    sites: () => [{ site: "figma.com", lastUsed: over.lastUsed?.() ?? used, cookies: 2 }],
    bring: async (from, site, profile) => { brought.push([from, site, profile]); return over.bring ? over.bring() : 2; },
    reload: async (chat) => { reloaded.push(chat); },
    now: () => now, every: 5, within: 1000,
  });
  return { watcher, brought, reloaded, use: () => { used += 1000; }, later: (ms: number) => { now += ms; } };
}

test("waits until you sign in to the site in your own browser, then brings it in and reloads the page", async () => {
  const { watcher, brought, reloaded, use } = setup();
  watcher.start("c1", "figma.com", "p1");
  await wait(30);
  expect(watcher.get("c1")).toMatchObject({ site: "figma.com", state: "waiting" });
  expect(brought).toEqual([]);
  use();
  await wait(30);
  expect(brought).toEqual([["chrome", "figma.com", "p1"]]);
  expect(reloaded).toEqual(["c1"]);
  expect(watcher.get("c1")).toMatchObject({ state: "done", from: "Chrome" });
  watcher.close();
});

test("the line goes once it has been shown, and the watch gives up after a while", async () => {
  const { watcher, use, later } = setup();
  watcher.start("c1", "figma.com", "p1");
  use(); await wait(30);
  later(20_000);
  expect(watcher.get("c1")).toBeUndefined();
  const quiet = setup();
  quiet.watcher.start("c2", "figma.com", "p1");
  quiet.later(5000); await wait(30);
  expect(quiet.watcher.get("c2")).toBeUndefined();
});

test("email and money sites stay out, a chat outside a project has nowhere to bring them, and a failure says why", async () => {
  const { watcher } = setup();
  watcher.start("c1", "mail.google.com", "p1");
  expect(watcher.get("c1")).toMatchObject({ state: "never" });
  watcher.start("c2", "figma.com", undefined);
  expect(watcher.get("c2")).toMatchObject({ state: "failed", said: "Sign-ins come in only for a project’s chats" });
  watcher.start("c3", undefined, "p1");
  expect(watcher.get("c3")).toBeUndefined();
  const failing = setup({ bring: async () => { throw new Error("The Mac didn't share Chrome's key"); } });
  failing.watcher.start("c4", "figma.com", "p1");
  failing.use(); await wait(30);
  expect(failing.watcher.get("c4")).toMatchObject({ state: "failed", from: "Chrome", said: "The Mac didn't share Chrome's key" });
  failing.watcher.close();
});
