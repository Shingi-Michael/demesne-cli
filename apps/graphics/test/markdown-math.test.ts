import { expect, test } from "bun:test";
import { marked, type Token } from "marked";
import { options } from "../markdown.ts";

const math = (raw: string) => {
  const found: { text: string; display: boolean }[] = [];
  marked.walkTokens(marked.lexer(raw, options), (token: Token & { text?: string; display?: boolean }) => {
    if (token.type === "mathInline" || token.type === "mathBlock") found.push({ text: String(token.text).trim(), display: token.type === "mathBlock" || Boolean(token.display) });
  });
  return found;
};

test("math the way models write it: $…$ and \\(…\\) inline, $$…$$ and \\[…\\] displayed", () => {
  expect(math("consider \\(x,y>0\\) and $a^2$")).toEqual([{ text: "x,y>0", display: false }, { text: "a^2", display: false }]);
  expect(math("are\n\\[\n\\boxed{x=3}\n\\]\nwith signs")).toEqual([{ text: "\\boxed{x=3}", display: true }]);
  expect(math("$$\n\\sum_{i=1}^n i\n$$")).toEqual([{ text: "\\sum_{i=1}^n i", display: true }]);
  expect(math("1. If \\(y\\ge5\\), set\n   \\[\n   x'=8x-21y\n   \\]")).toEqual([{ text: "y\\ge5", display: false }, { text: "x'=8x-21y", display: true }]);
});

test("dollars that are prices, and anything in code, stay text", () => {
  expect(math("prices like $5 and $10 stay plain")).toEqual([]);
  expect(math("it costs $ 5 and $ 7")).toEqual([]);
  expect(math("run `echo $HOME $PATH` now")).toEqual([]);
  expect(math("```sh\necho $a $b\n\\[x\\]\n```")).toEqual([]);
});
