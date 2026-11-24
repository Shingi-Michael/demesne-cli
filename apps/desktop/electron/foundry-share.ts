/// Share outside Demesne (Foundry step 8, Mike picked GitHub Pages): a
/// mockup's page, standing on its own (as Save a copy makes it), published
/// to a repository named demesne-shares in your own GitHub account, served
/// by GitHub Pages at a link nobody can guess. Sharing the same mockup again
/// puts its new version at the same link; Stop sharing takes the page down.
/// The computer's own GitHub login is used (updater.ts githubToken).

export const SHARE_REPO = "demesne-shares";
export const SHARE_DESCRIPTION = "Mockups shared from Demesne. Each lives at a link only the people it was sent to have.";

/// A GitHub REST call: the answer's status and JSON (null when it has none).
export type GitHubCall = (method: string, path: string, body?: unknown) => Promise<{ status: number; json: any }>;

/// What is shared, as kept on disk: { [artifact id]: { slug, url, version } }.
export interface Shared { slug: string; url: string; version: number }
export type Shares = Record<string, Shared>;
/// Pass 273 A: the pinned mockups' ids, as kept; anything else in the file is dropped.
export function readPins(text: string | null): string[] {
  try {
    const parsed = JSON.parse(text ?? "[]") as unknown;
    return Array.isArray(parsed) ? [...new Set(parsed.filter((one): one is string => typeof one === "string" && /^[\w-]{1,200}$/.test(one)))].slice(0, 200) : [];
  } catch { return []; }
}
export function readShares(text: string | null): Shares {
  try {
    const parsed = JSON.parse(text ?? "{}") as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, Shared] => {
      const one = entry[1] as Partial<Shared> | null;
      return /^[\w-]{1,200}$/.test(entry[0]) && !!one && typeof one.slug === "string" && /^[a-z0-9]{16,40}$/.test(one.slug) && typeof one.url === "string" && /^https:\/\/[\w.-]+\.github\.io\//.test(one.url) && typeof one.version === "number";
    }));
  } catch { return {}; }
}

/// A link nobody can guess: 20 letters and digits from a random source.
export function newSlug(random: (bytes: number) => Uint8Array = (bytes) => crypto.getRandomValues(new Uint8Array(bytes))): string {
  const letters = "abcdefghijklmnopqrstuvwxyz0123456789";
  return [...random(20)].map((byte) => letters[byte % letters.length]).join("");
}

/// The page as it is published: kept out of search engines, and named.
export function sharedPage(html: string): string {
  const meta = '<meta name="robots" content="noindex, nofollow">';
  if (/<head\b[^>]*>/i.test(html)) return html.replace(/<head\b[^>]*>/i, (head) => `${head}${meta}`);
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  return doctype ? `${doctype[0]}${meta}${html.slice(doctype[0].length)}` : `${meta}${html}`;
}

const failed = (what: string, answer: { status: number; json: any }) =>
  new Error(`${what} (GitHub said ${answer.status}${typeof answer.json?.message === "string" ? `: ${answer.json.message}` : ""})`);

/// Your login, and the shares repository, made (public, with GitHub Pages on its main branch) the first time.
async function shareRepo(call: GitHubCall): Promise<{ owner: string; branch: string }> {
  const user = await call("GET", "/user");
  if (user.status !== 200 || typeof user.json?.login !== "string") throw failed("Couldn't read your GitHub login", user);
  const owner = user.json.login as string;
  let repo = await call("GET", `/repos/${owner}/${SHARE_REPO}`);
  if (repo.status === 404) {
    repo = await call("POST", "/user/repos", { name: SHARE_REPO, description: SHARE_DESCRIPTION, private: false, auto_init: true, has_issues: false, has_wiki: false, has_projects: false });
    if (repo.status !== 201) throw failed(`Couldn't make ${SHARE_REPO} in your GitHub account`, repo);
  } else if (repo.status !== 200) throw failed(`Couldn't read ${SHARE_REPO}`, repo);
  const branch = typeof repo.json?.default_branch === "string" ? repo.json.default_branch as string : "main";
  const pages = await call("GET", `/repos/${owner}/${SHARE_REPO}/pages`);
  if (pages.status === 404) {
    const on = await call("POST", `/repos/${owner}/${SHARE_REPO}/pages`, { source: { branch, path: "/" } });
    if (on.status !== 201 && on.status !== 409) throw failed("Couldn't turn on GitHub Pages for it", on);
  } else if (pages.status !== 200) throw failed("Couldn't read its GitHub Pages", pages);
  return { owner, branch };
}

const filePath = (owner: string, slug: string) => `/repos/${owner}/${SHARE_REPO}/contents/${slug}/index.html`;

/// Publishes a page at its link (a new one the first time): the link.
export async function sharePage(call: GitHubCall, page: { html: string; title: string; version: number; slug?: string }): Promise<{ slug: string; url: string }> {
  const { owner, branch } = await shareRepo(call);
  const slug = page.slug ?? newSlug();
  const path = filePath(owner, slug);
  const before = await call("GET", `${path}?ref=${encodeURIComponent(branch)}`);
  const sha = before.status === 200 && typeof before.json?.sha === "string" ? before.json.sha as string : undefined;
  const put = await call("PUT", path, { message: `${page.title} v${page.version}`, content: Buffer.from(sharedPage(page.html), "utf8").toString("base64"), branch, ...(sha ? { sha } : {}) });
  if (put.status !== 200 && put.status !== 201) throw failed("Couldn't publish the page", put);
  return { slug, url: `https://${owner.toLowerCase()}.github.io/${SHARE_REPO}/${slug}/` };
}

/// Takes a shared page down (already gone is fine).
export async function unsharePage(call: GitHubCall, slug: string): Promise<void> {
  const user = await call("GET", "/user");
  if (user.status !== 200 || typeof user.json?.login !== "string") throw failed("Couldn't read your GitHub login", user);
  const path = filePath(user.json.login, slug);
  const before = await call("GET", path);
  if (before.status === 404) return;
  if (before.status !== 200 || typeof before.json?.sha !== "string") throw failed("Couldn't find the shared page", before);
  const gone = await call("DELETE", path, { message: "Stop sharing", sha: before.json.sha });
  if (gone.status !== 200) throw failed("Couldn't take the page down", gone);
}
