import { expect, test } from "bun:test";
import { cardNews } from "../card-light";

test("a card that says something new laps once", () => {
  expect(cardNews("changes", "1 file changed +1 −1", "2 files changed +3 −1")).toBe(true);
  expect(cardNews("agents", "Codex here", "2 agents here")).toBe(true);
});

test("a new card, an unchanged card and the quiet cards don't", () => {
  expect(cardNews("changes", undefined, "1 file changed +1 −1")).toBe(false);
  expect(cardNews("changes", "1 file changed +1 −1", "1 file changed +1 −1")).toBe(false);
  expect(cardNews("context", "41% context", "42% context")).toBe(false);
  expect(cardNews("where", "This computer master 1 uncommitted", "This computer master 2 uncommitted")).toBe(false);
});
