import { expect, test } from "bun:test";
import type { ChatSource } from "@demesne/protocol";
import { droppedLink, fieldLink, sourceMark, sourceOfStep, sourcesCardHTML, usedSources } from "../sources-card.ts";

const source = (id: string, extra: Partial<ChatSource>): ChatSource => ({ id, kind: "file", target: `/p/${id}`, name: id, detail: "in this project", addedAt: "", ...extra });
const schema = source("s1", { name: "schema.sql", target: "/p/db/schema.sql", inProject: "db/schema.sql", detail: "in this project · db/" });
const docs = source("s2", { kind: "folder", name: "docs/", target: "/p/docs", inProject: "docs", detail: "in this project · 14 files" });
const kaggle = source("s3", { kind: "link", name: "kaggle.com/datasets/stocks", target: "https://www.kaggle.com/datasets/stocks", detail: "Stock prices · Kaggle" });
const view = { open: false, field: false, dragging: false };

test("marks: a link's letter on its colour, a file's kind, a folder's glyph", () => {
  expect(sourceMark(kaggle)).toMatchObject({ kind: "link", label: "K" });
  expect(sourceMark(kaggle).colour).toMatch(/^hsl\(/);
  expect(sourceMark(schema)).toEqual({ kind: "file", label: "SQL" });
  expect(sourceMark(docs)).toEqual({ kind: "folder", label: "" });
});

test("no sources, no card, unless something is being dragged", () => {
  expect(sourcesCardHTML([], new Set(), view)).toBe("");
  expect(sourcesCardHTML([], new Set(), { ...view, dragging: true })).toContain("Drop to keep it with this chat");
});

test("the line shows four marks then +N, six rows then and N more", () => {
  const many = Array.from({ length: 8 }, (_, i) => source(`f${i}`, { name: `f${i}.md` }));
  const html = sourcesCardHTML(many, new Set(), view);
  expect(html.match(/<i class="src-k/g)).toHaveLength(4);
  expect(html).toContain('<i class="src-more">+4</i>');
  expect(html.match(/class="src-row/g)).toHaveLength(6);
  expect(html).toContain("and 2 more");
  expect(html).not.toContain("src-field");
});

test("what the last answer used gets a ring and a dot; the field shows its hint or why not", () => {
  const html = sourcesCardHTML([schema, docs, kaggle], new Set(["s1"]), { ...view, field: true });
  expect(html).toContain('class="src-row used"');
  expect(html).toContain('src-k file used');
  expect(html).toContain("Return to keep it · or drop a file or folder here");
  expect(sourcesCardHTML([schema], new Set(), { ...view, field: true, error: "That isn’t a link." })).toContain('src-hint bad">That isn’t a link.');
  expect(sourcesCardHTML([schema], new Set(), { ...view, dragging: true })).toContain("src-card drop");
});

test("steps that used a source: read_source, a kept path or inside a kept folder, a kept link", () => {
  const sources = [schema, docs, kaggle];
  expect(sourceOfStep(sources, { name: "read_source", input: { id: "s3" } })).toBe(kaggle);
  expect(sourceOfStep(sources, { name: "read_file", input: { path: "./db/schema.sql" } })).toBe(schema);
  expect(sourceOfStep(sources, { name: "read_file", input: { path: "docs/intro.md" } })).toBe(docs);
  expect(sourceOfStep(sources, { name: "read_file", input: { path: "db/other.sql" } })).toBeUndefined();
  expect(sourceOfStep(sources, { name: "web_fetch", input: { url: "https://www.kaggle.com/datasets/stocks/" } })).toBe(kaggle);
  expect([...usedSources(sources, [{ name: "read_source", input: { id: "s1" } }, { name: "read_source", input: { id: "s2" }, state: "failed" }])]).toEqual(["s1"]);
});

test("the field keeps links and says when it isn't one", () => {
  expect(fieldLink("https://stripe.com/docs/checkout")).toEqual({ url: "https://stripe.com/docs/checkout" });
  expect(fieldLink("stripe.com/docs")).toEqual({ url: "https://stripe.com/docs" });
  expect(fieldLink("checkout is slow on mobile")).toEqual({ error: "That isn’t a link. Paste one starting with https://, or press Choose…" });
  expect(droppedLink("# comment\nhttps://example.com/a\n")).toBe("https://example.com/a");
  expect(droppedLink("javascript:alert(1)")).toBeUndefined();
});
