/// Step 8: share outside Demesne, on your GitHub Pages.
import { expect, test } from "bun:test";
import { newSlug, readShares, sharedPage, sharePage, unsharePage, SHARE_REPO, type GitHubCall } from "../electron/foundry-share.ts";

/// A stand-in GitHub: a user, repositories, Pages and files, and every call it was asked.
function github() {
  const calls: string[] = [], repos = new Set<string>(), pages = new Set<string>(), files = new Map<string, { sha: string; content: string }>();
  let n = 0;
  const call: GitHubCall = async (method, path, body: any) => {
    calls.push(`${method} ${path.replace(/\?.*$/, "")}`);
    const file = /^\/repos\/Mike-K\/demesne-shares\/contents\/(.+)$/.exec(path.replace(/\?.*$/, ""))?.[1];
    if (method === "GET" && path === "/user") return { status: 200, json: { login: "Mike-K" } };
    if (method === "GET" && path === `/repos/Mike-K/${SHARE_REPO}`) return repos.has(SHARE_REPO) ? { status: 200, json: { default_branch: "main" } } : { status: 404, json: { message: "Not Found" } };
    if (method === "POST" && path === "/user/repos") { repos.add(body.name); return { status: 201, json: { default_branch: "main" } }; }
    if (method === "GET" && path.endsWith("/pages")) return pages.size ? { status: 200, json: {} } : { status: 404, json: {} };
    if (method === "POST" && path.endsWith("/pages")) { pages.add("on"); return { status: 201, json: {} }; }
    if (file && method === "GET") { const one = files.get(file); return one ? { status: 200, json: { sha: one.sha } } : { status: 404, json: {} }; }
    if (file && method === "PUT") { if (files.has(file) && body.sha !== files.get(file)!.sha) return { status: 409, json: { message: "sha" } }; const had = files.has(file); files.set(file, { sha: `s${++n}`, content: Buffer.from(body.content, "base64").toString("utf8") }); return { status: had ? 200 : 201, json: {} }; }
    if (file && method === "DELETE") { files.delete(file); return { status: 200, json: {} }; }
    return { status: 500, json: { message: `unexpected ${method} ${path}` } };
  };
  return { call, calls, files, repos, pages };
}

test("the first share makes the repository, turns on Pages and publishes at a link nobody can guess", async () => {
  const hub = github();
  const shared = await sharePage(hub.call, { html: "<!doctype html><html><head><title>A</title></head><body>v1</body></html>", title: "Orders", version: 1 });
  expect(shared.slug).toMatch(/^[a-z0-9]{20}$/);
  expect(shared.url).toBe(`https://mike-k.github.io/demesne-shares/${shared.slug}/`);
  expect(hub.repos.has("demesne-shares") && hub.pages.size).toBeTruthy();
  const page = hub.files.get(`${shared.slug}/index.html`)!.content;
  expect(page).toContain('<head><meta name="robots" content="noindex, nofollow"><title>A</title>');
  // Shared again: the same link, the file replaced (with its sha), nothing made twice.
  hub.calls.length = 0;
  const again = await sharePage(hub.call, { html: "<p>v2</p>", title: "Orders", version: 2, slug: shared.slug });
  expect(again.url).toBe(shared.url);
  expect(hub.files.get(`${shared.slug}/index.html`)!.content).toContain("<p>v2</p>");
  expect(hub.calls).not.toContain("POST /user/repos");
  // Stop sharing takes it down; already gone is fine.
  await unsharePage(hub.call, shared.slug);
  expect(hub.files.size).toBe(0);
  await unsharePage(hub.call, shared.slug);
});

test("GitHub's refusal is said plainly", async () => {
  const call: GitHubCall = async () => ({ status: 401, json: { message: "Bad credentials" } });
  await expect(sharePage(call, { html: "x", title: "A", version: 1 })).rejects.toThrow("Couldn't read your GitHub login (GitHub said 401: Bad credentials)");
});

test("what is shared comes back from disk checked; slugs are long and random; the page is kept out of search", () => {
  expect(readShares(JSON.stringify({ a1: { slug: "abcdefghij0123456789", url: "https://me.github.io/demesne-shares/abcdefghij0123456789/", version: 2 }, bad: { slug: "x", url: "http://evil", version: 1 } })))
    .toEqual({ a1: { slug: "abcdefghij0123456789", url: "https://me.github.io/demesne-shares/abcdefghij0123456789/", version: 2 } });
  expect(readShares("nonsense")).toEqual({});
  expect(newSlug()).not.toBe(newSlug());
  expect(newSlug(() => new Uint8Array(20))).toBe("a".repeat(20));
  expect(sharedPage("<!doctype html><p>hi</p>")).toBe('<!doctype html><meta name="robots" content="noindex, nofollow"><p>hi</p>');
});

test("pass 273 A: pins are kept as ids, once each, and anything else is dropped", async () => {
  const { readPins } = await import("../electron/foundry-share.ts");
  expect(readPins(JSON.stringify(["a", "b", "a", 3, "../x", null]))).toEqual(["a", "b"]);
  expect(readPins("{}")).toEqual([]);
  expect(readPins("not json")).toEqual([]);
  expect(readPins(null)).toEqual([]);
});
