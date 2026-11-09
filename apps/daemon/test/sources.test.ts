import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { linkName, readSource, sizeWord, SourceError, sourcesContext, SourceStore } from "../src/sources.ts";
import { webFetchTool } from "../src/web.ts";

const temp = () => mkdtempSync(join(tmpdir(), "demesne-sources-"));
const signal = new AbortController().signal;

test("a file in the project stays put and says where it is", () => {
  const root = temp(), store = new SourceStore(join(temp(), "sources"));
  mkdirSync(join(root, "db"));
  writeFileSync(join(root, "db", "schema.sql"), "create table orders(id int);");
  const source = store.addPath("s1", join(root, "db", "schema.sql"), root);
  expect(source).toMatchObject({ kind: "file", name: "schema.sql", detail: "in this project · db/", inProject: "db/schema.sql" });
  expect(source.copied).toBeUndefined();
  expect(store.list("s1")).toHaveLength(1);
});

test("a file from elsewhere is copied into the chat, and goes when taken off", () => {
  const away = temp(), store = new SourceStore(join(temp(), "sources"));
  writeFileSync(join(away, "orders.csv"), "a,b\n1,2\n");
  const source = store.addPath("s1", join(away, "orders.csv"), temp());
  expect(source.copied).toBe(true);
  expect(source.detail).toBe("copied into the chat · 8 B");
  expect(readFileSync(source.target, "utf8")).toBe("a,b\n1,2\n");
  expect(store.remove("s1", source.id)).toEqual([]);
  expect(existsSync(source.target)).toBe(false);
});

test("a folder counts its files; the same one again moves to the top", () => {
  const root = temp(), store = new SourceStore(join(temp(), "sources"));
  mkdirSync(join(root, "docs"));
  for (const name of ["a.md", "b.md"]) writeFileSync(join(root, "docs", name), "x");
  writeFileSync(join(root, "notes.md"), "n");
  const folder = store.addPath("s1", join(root, "docs"), root);
  expect(folder).toMatchObject({ kind: "folder", name: "docs/", detail: "in this project · 2 files" });
  store.addPath("s1", join(root, "notes.md"), root);
  const again = store.addPath("s1", join(root, "docs"), root);
  expect(again.id).toBe(folder.id);
  expect(store.list("s1").map((source) => source.name)).toEqual(["docs/", "notes.md"]);
});

test("secrets and missing files are refused", () => {
  const root = temp(), store = new SourceStore(join(temp(), "sources"));
  writeFileSync(join(root, ".env"), "KEY=1");
  expect(() => store.addPath("s1", join(root, ".env"), root)).toThrow(SourceError);
  expect(() => store.addPath("s1", join(root, "gone.txt"), root)).toThrow("isn't there");
  expect(() => store.addPath("s1", "relative.txt", root)).toThrow(SourceError);
  expect(() => store.list("../x")).toThrow();
});

test("links: only http(s), named by address, titled when the page says", async () => {
  const store = new SourceStore(join(temp(), "sources"));
  await expect(store.addLink("s1", "checkout is slow on mobile")).rejects.toThrow("That isn't a link");
  await expect(store.addLink("s1", "file:///etc/passwd")).rejects.toThrow("That isn't a link");
  const link = await store.addLink("s1", "https://docs.stripe.com/checkout/#top", async () => "Checkout");
  expect(link).toMatchObject({ kind: "link", target: "https://docs.stripe.com/checkout/", name: "docs.stripe.com/checkout", detail: "Checkout · Stripe" });
  const bare = await store.addLink("s1", "https://www.kaggle.com/", async () => { throw new Error("offline"); });
  expect(bare).toMatchObject({ name: "kaggle.com", detail: "Kaggle" });
  expect(linkName(new URL("https://example.com/a/"))).toBe("example.com/a");
});

test("the model gets one line per source, and none without sources", () => {
  expect(sourcesContext([])).toBeNull();
  const text = sourcesContext([
    { id: "a1", kind: "file", target: "/p/db/schema.sql", name: "schema.sql", detail: "in this project · db/", inProject: "db/schema.sql", addedAt: "" },
    { id: "b2", kind: "link", target: "https://docs.stripe.com/checkout", name: "docs.stripe.com/checkout", detail: "Checkout · Stripe", addedAt: "" },
  ])!;
  expect(text).toContain("read_source");
  expect(text).toContain("- a1: file schema.sql (in the project at db/schema.sql)");
  expect(text).toContain("- b2: link docs.stripe.com/checkout (https://docs.stripe.com/checkout) · Checkout · Stripe");
});

test("read_source reads a file, lists a folder and reads a file in it", async () => {
  const root = temp(), store = new SourceStore(join(temp(), "sources"));
  mkdirSync(join(root, "docs"));
  writeFileSync(join(root, "docs", "a.md"), "# Hello");
  writeFileSync(join(root, "schema.sql"), "create table t(id int);");
  const file = store.addPath("s1", join(root, "schema.sql"), root);
  const folder = store.addPath("s1", join(root, "docs"), root);
  const list = store.list("s1");
  expect(JSON.parse(await readSource(list, { id: file.id }, signal)).content).toBe("create table t(id int);");
  expect(JSON.parse(await readSource(list, { id: folder.id }, signal)).files).toEqual(["a.md"]);
  expect(JSON.parse(await readSource(list, { id: folder.id, path: "a.md" }, signal)).content).toBe("# Hello");
  await expect(readSource(list, { id: folder.id, path: "../schema.sql" }, signal)).rejects.toThrow();
  await expect(readSource(list, { id: "nope" }, signal)).rejects.toThrow("No source nope");
});

test("read_source reads a link through web_fetch", async () => {
  const fetchPage = webFetchTool({ resolve: async () => ["93.184.216.34"], fetcher: (async () => new Response("<title>Hi</title><p>Body text</p>", { headers: { "content-type": "text/html" } })) as unknown as typeof fetch });
  const store = new SourceStore(join(temp(), "sources"));
  const link = await store.addLink("s1", "https://example.com/page");
  const value = JSON.parse(await readSource(store.list("s1"), { id: link.id }, signal, fetchPage));
  expect(value.title).toBe("Hi");
  expect(value.content).toContain("Body text");
});

test("sizes read like people say them", () => {
  expect(sizeWord(4_000)).toBe("4 KB");
  expect(sizeWord(2.1 * 1024 * 1024)).toBe("2.1 MB");
});
