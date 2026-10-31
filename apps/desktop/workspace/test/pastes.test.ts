import { describe, expect, test } from "bun:test";
import { foldsUp, pasteLabel, splitPastes, withPastes } from "../pastes.ts";

const log = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");

describe("big pastes fold up", () => {
  test("only long pastes fold", () => {
    expect(foldsUp(log(29))).toBe(false);
    expect(foldsUp(log(30))).toBe(true);
    expect(foldsUp("x".repeat(3000))).toBe(true);
    expect(foldsUp("a short note")).toBe(false);
  });

  test("labels count lines", () => {
    expect(pasteLabel(log(40))).toBe("Pasted text · 40 lines");
    expect(pasteLabel(`${log(40)}\n`)).toBe("Pasted text · 40 lines");
    expect(pasteLabel("one")).toBe("Pasted text · 1 line");
  });

  test("a sent message splits back into its words and its pastes", () => {
    const sent = withPastes("why does this fail?", [{ id: "1", text: log(40) }, { id: "2", text: log(31) }]);
    expect(sent.startsWith("why does this fail?\n\n```paste\nline 1")).toBe(true);
    expect(splitPastes(sent)).toEqual([
      { kind: "text", text: "why does this fail?" },
      { kind: "paste", text: log(40) },
      { kind: "paste", text: log(31) },
    ]);
    expect(splitPastes(withPastes("", [{ id: "1", text: log(30) }]))).toEqual([{ kind: "paste", text: log(30) }]);
  });

  test("a paste holding fences gets a longer fence", () => {
    const text = `${log(30)}\n\`\`\`ts\nconst a = 1;\n\`\`\`\nmore`;
    const sent = withPastes("look", [{ id: "1", text }]);
    expect(sent).toContain("````paste\n");
    expect(splitPastes(sent)).toEqual([{ kind: "text", text: "look" }, { kind: "paste", text }]);
  });

  test("ordinary messages and code blocks are left alone", () => {
    expect(splitPastes("hello")).toEqual([{ kind: "text", text: "hello" }]);
    const code = "see\n\n```ts\nconst a = 1;\n```";
    expect(splitPastes(code)).toEqual([{ kind: "text", text: code }]);
  });
});
