import { expect, test } from "bun:test";
import { linkMockups, mentionedMockups, mockupRefs, splitMockupRefs, type MockupName } from "../foundry-mention.ts";

const names: MockupName[] = [
  { id: "a1", title: "Roaster pricing", version: 2, description: "", kind: "html" },
  { id: "p2", title: "Roaster pricing, phone", version: 1, description: "", kind: "html" },
  { id: "z9", title: "Logo", version: 4, description: "", kind: "svg" },
];

test("@ a mockup: the message names it by id for the model, and the bubble links it (pass 208 A)", () => {
  const text = "Build @Roaster pricing, phone like @Roaster pricing";
  const named = mentionedMockups(text, names);
  expect(named.map((item) => item.id)).toEqual(["p2", "a1"]);
  expect(mentionedMockups("not @Logos, but @Logo.", names).map((item) => item.id)).toEqual(["z9"]);
  expect(mentionedMockups("only @Logos", names)).toEqual([]);
  const sent = `${text}\n\n${mockupRefs(named)}`;
  expect(sent).toContain('- "Roaster pricing" id a1 (v2)');
  const back = splitMockupRefs(sent);
  expect(back.text).toBe(text);
  expect(back.refs).toEqual([{ title: "Roaster pricing, phone", id: "p2", version: 1 }, { title: "Roaster pricing", id: "a1", version: 2 }]);
  const html = linkMockups(back.text, back.refs);
  expect(html.match(/data-action="foundry-open"/g)?.length).toBe(2);
  expect(html).toContain('>@Roaster pricing, phone</button>');
  expect(html).toContain('>@Roaster pricing</button>');
  // A message with no mockups, or a look-alike line, stays as written.
  expect(splitMockupRefs("hello")).toEqual({ text: "hello", refs: [] });
  expect(mockupRefs([])).toBe("");
});
