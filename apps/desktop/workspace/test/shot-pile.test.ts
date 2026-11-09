import { expect, test } from "bun:test";
import { chatPile, pileHTML } from "../shot-pile.ts";

const id = (n: number) => `6b1d2c3e-0000-4000-8000-00000000000${n}`;
const tool = (name: string, input: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ type: "tool", name, state: "done", input, ...extra });
const runs = [
  { attachments: [{ id: id(1), filename: "Safari.png" }], entries: [
    tool("capture_window", {}, { message: JSON.stringify({ app: "Figma", title: "Checkout", picture: { id: id(2) } }) }),
    tool("look_at_page", { url: "http://localhost:5173/login" }, { message: JSON.stringify({ url: "http://localhost:5173/login", title: "Login", pictures: [{ id: id(3), width: 1280, height: 800, label: "on opening" }, { id: id(2), width: 1, height: 1, label: "again" }] }) }),
    tool("list_files", { path: "/work/app/research" }),
    tool("web_fetch", { url: "https://www.kaggle.com/datasets/stocks" }),
    tool("write_file", { path: "/work/app/notes/Review.md" }, { phase: "change", created: true }),
    tool("edit_file", { path: "/work/app/a.ts" }, { phase: "change", changes: [{ path: "/work/app/a.ts", beforeExists: true, afterExists: true }] }),
  ] },
  { entries: [
    tool("capture_window", {}, { state: "failed", message: JSON.stringify({ picture: { id: id(4) } }) }),
    tool("web_fetch", { url: "https://www.kaggle.com/datasets/stocks" }),
    tool("list_files", { path: "." }),
  ] },
];

test("a chat's pile holds what you sent and what it took, oldest first, each once", () => {
  const pile = chatPile(runs);
  expect(pile.map((shot) => [shot.id, shot.by])).toEqual([[id(1), "you"], [id(2), "chat"], [id(3), "chat"]]);
  expect(pile.map((shot) => shot.caption)).toEqual(["Safari", "Checkout", "Opening · localhost:5173/login"]);
  expect(chatPile(runs, new Set([id(2)])).map((shot) => shot.id)).toEqual([id(1), id(3)]);
});

test("the pile shows up to three pictures, newest on top, with a count, and marks one that just landed", () => {
  const pile = chatPile(runs);
  const html = pileHTML(pile, (one) => one === id(1) ? "data:image/png;base64,AA==" : undefined, id(3));
  expect(html.match(/class="pile-shot/g)).toHaveLength(3);
  expect(html).toContain('<span class="pile-n">3</span>');
  expect(html).not.toContain("screenshots<");
  expect(html).not.toContain("pile-cap");
  expect(html).toContain('data-action="pile-open" data-args=\'{"index":2}\'');
  expect(html).toMatch(/class="pile-shot landing" style="[^"]*z-index:10" data-picture="6b1d2c3e-0000-4000-8000-000000000003"/);
  expect(html).toContain('src="data:image/png;base64,AA=="');
  expect(pileHTML([], () => undefined)).toBe("");
  expect(pileHTML([{ id: id(1), caption: "<b>", by: "you" }], () => undefined)).not.toContain("<b>");
});
