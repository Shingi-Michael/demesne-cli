import { expect, test } from "bun:test";
import { htmlToText, isPrivateAddress, parseSearchResults, webFetchTool, webSearchTool } from "../src/web.ts";

const context = () => ({ workspaceRoot: "", signal: new AbortController().signal });
const publicHost = async () => ["93.184.216.34"];

const DDG = `<div class="results">
<div class="result results_links results_links_deep web-result ">
  <h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fbun.sh%2Fdocs%2Fapi%2Ffetch&amp;rut=abc">Fetch &ndash; <b>Bun</b> Docs</a></h2>
  <a class="result__snippet" href="//duckduckgo.com/l/?uddg=x">Bun implements the <b>fetch</b> API &amp; proxies.</a>
</div>
<div class="result result--ad results_links"><a class="result__a" href="https://duckduckgo.com/y.js?ad=1">Ad</a></div>
<div class="result results_links web-result ">
  <h2 class="result__title"><a rel="nofollow" class="result__a" href="https://example.com/page">Example</a></h2>
</div>
</div>`;

test("search results come out of DuckDuckGo's page with their real addresses", () => {
  expect(parseSearchResults(DDG)).toEqual([
    { title: "Fetch – Bun Docs", url: "https://bun.sh/docs/api/fetch", snippet: "Bun implements the fetch API & proxies." },
    { title: "Example", url: "https://example.com/page", snippet: "" },
  ]);
});

test("web_search asks DuckDuckGo and returns the results", async () => {
  const asked: string[] = [];
  const tool = webSearchTool({ fetcher: (async (url: string) => { asked.push(url); return new Response(DDG, { headers: { "content-type": "text/html" } }); }) as unknown as typeof fetch });
  expect(tool.permission({ query: "x" })).toBeNull();
  const result = JSON.parse(await tool.execute({ query: "bun fetch proxy", limit: 1 }, context()));
  expect(asked[0]).toBe("https://html.duckduckgo.com/html/?q=bun%20fetch%20proxy");
  expect(result.results).toEqual([{ title: "Fetch – Bun Docs", url: "https://bun.sh/docs/api/fetch", snippet: "Bun implements the fetch API & proxies." }]);
});

test("a page reads as text: headings, lists, code and links, without the chrome", () => {
  const text = htmlToText(`<html><head><title>T</title><style>.a{}</style></head><body>
    <nav><a href="/">Home</a></nav>
    <h1>Fetch</h1><p>Use <code>fetch()</code> &mdash; see <a href="/docs/proxy">the proxy page</a>.</p>
    <ul><li>one</li><li>two</li></ul>
    <pre><code>const r = await fetch(url);
console.log(r.status);</code></pre>
    <script>alert(1)</script><footer>© 2026</footer></body></html>`, new URL("https://bun.sh/docs/fetch"));
  expect(text).toBe("# Fetch\n\nUse `fetch()` — see the proxy page (https://bun.sh/docs/proxy).\n\n- one\n- two\n\n```\nconst r = await fetch(url);\nconsole.log(r.status);\n```");
});

test("web_fetch reads a page in slices and follows redirects", async () => {
  const pages: Record<string, Response | (() => Response)> = {
    "https://example.com/old": () => new Response(null, { status: 301, headers: { location: "/new" } }),
    "https://example.com/new": () => new Response(`<title>New</title><p>${"word ".repeat(600)}</p>`, { headers: { "content-type": "text/html; charset=utf-8" } }),
  };
  const fetcher = (async (url: string) => (pages[url] as () => Response)()) as unknown as typeof fetch;
  const tool = webFetchTool({ fetcher, resolve: publicHost });
  const first = JSON.parse(await tool.execute({ url: "https://example.com/old", maxChars: 1000 }, context()));
  expect(first).toMatchObject({ url: "https://example.com/new", title: "New", nextOffset: 1000 });
  expect(first.content.length).toBe(1000);
  const rest = JSON.parse(await tool.execute({ url: "https://example.com/new", offset: first.nextOffset, maxChars: 5000 }, context()));
  expect(rest.nextOffset).toBeUndefined();
  expect(rest.content.length).toBe(first.length - 1000);
});

test("web_fetch refuses this machine and its local network, even after a redirect", async () => {
  const fetcher = (async () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1:8080/v1/sessions" } })) as unknown as typeof fetch;
  const tool = webFetchTool({ fetcher, resolve: async (host) => host === "router.example" ? ["192.168.1.1"] : ["93.184.216.34"] });
  await expect(tool.execute({ url: "http://localhost:3000" }, context())).rejects.toThrow("LOCAL_ADDRESS");
  await expect(tool.execute({ url: "http://router.example/admin" }, context())).rejects.toThrow("LOCAL_ADDRESS");
  await expect(tool.execute({ url: "https://example.com/go" }, context())).rejects.toThrow("LOCAL_ADDRESS");
  await expect(tool.execute({ url: "file:///etc/passwd" }, context())).rejects.toThrow("BAD_URL");
});

test("private addresses", () => {
  for (const address of ["127.0.0.1", "10.2.3.4", "172.20.0.1", "192.168.0.10", "169.254.169.254", "100.100.1.1", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "0.0.0.0"])
    expect(isPrivateAddress(address)).toBe(true);
  for (const address of ["93.184.216.34", "8.8.8.8", "172.32.0.1", "2606:4700::1111"]) expect(isPrivateAddress(address)).toBe(false);
});

test("web_fetch says a PDF or image isn't text", async () => {
  const tool = webFetchTool({ fetcher: (async () => new Response("%PDF", { headers: { "content-type": "application/pdf" } })) as unknown as typeof fetch, resolve: publicHost });
  await expect(tool.execute({ url: "https://example.com/a.pdf" }, context())).rejects.toThrow("NOT_TEXT");
});
