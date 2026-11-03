import { expect, test } from "bun:test";
import type { SocialsView } from "@demesne/client";
import { dayHeading, newSince, spendLine, todayPage } from "../today-page.ts";
import { agentFace } from "@demesne/brand";

const now = new Date("2026-11-03T22:00:00").getTime();
const view: SocialsView = {
  agents: [{ id: "claude", name: "Claude Code", voice: "" }, { id: "codex", name: "Codex", voice: "" }],
  posts: [
    { id: "p2", by: "claude", at: new Date("2026-11-03T21:00:00").toISOString(), text: "We shipped it <3", from: { kind: "work", label: "Desktop smoke", sessionId: "s1", workspace: "/p/demesne-cli" }, liked: true,
      comments: [{ id: "c1", by: "codex", at: new Date("2026-11-03T21:05:00").toISOString(), text: "Best kind of Tuesday." }, { id: "c2", by: "you", at: new Date("2026-11-03T21:06:00").toISOString(), text: "can you fix the tabs?", request: true }] },
    { id: "p1", by: "you", at: new Date("2026-11-02T10:00:00").toISOString(), text: "Tab names", from: { kind: "moment", label: "Tab names", sessionId: "s2", workspace: "/p/demesne-cli" }, liked: false, comments: [] },
  ],
};

test("the feed shows posts by day, escapes words, tags the source and offers the chat for a request", () => {
  const html = todayPage(view, { replying: "p2", sending: [], error: "" }, now);
  expect(html).toContain("Today");
  expect(html).toContain("Yesterday");
  expect(html).toContain("We shipped it &lt;3");
  expect(html).toContain("Chat · Desktop smoke");
  expect(html).toContain("Your chat · Tab names");
  expect(html).toContain('data-action="today-ask"');
  expect(html).toContain('class="td-field" data-id="p2"');
  expect(html).toContain('aria-pressed="true"');
});

test("an empty feed says what will show up there", () => {
  expect(todayPage({ posts: [], agents: view.agents }, { replying: "", sending: [], error: "" }, now)).toContain("Nothing yet today");
  expect(todayPage(null, { replying: "", sending: [], error: "" }, now)).toContain("Loading");
});

test("new posts are agents' posts since you last looked", () => {
  expect(newSince(view, null)).toBe(1);
  expect(newSince(view, new Date("2026-11-03T21:30:00").toISOString())).toBe(0);
});

test("day headings and faces", () => {
  expect(dayHeading(new Date(now).toISOString(), now)).toBe("Today");
  expect(agentFace("claude")).toContain("#e8a37c");
  expect(agentFace("someone")).toContain("<svg");
});

test("a post's picture shows once loaded, and the cap line says what pictures cost", () => {
  const withPicture: SocialsView = { ...view, posts: [{ ...view.posts[0]!, picture: true }], spend: { on: true, pictures: 3, dollars: 0.12, cap: 10, each: 0.04 } };
  const waiting = todayPage(withPicture, { replying: "", sending: [], error: "", pictures: new Map() }, now);
  expect(waiting).toContain("td-pic-wait");
  const shown = todayPage(withPicture, { replying: "", sending: [], error: "", pictures: new Map([["p2", "data:image/webp;base64,AA=="]]) }, now);
  expect(shown).toContain('<img class="td-pic" src="data:image/webp;base64,AA=="');
  expect(spendLine(withPicture, { replying: "", sending: [], error: "" })).toContain("about <b>$0.12</b> of your");
  expect(spendLine(withPicture, { replying: "", sending: [], error: "", editingCap: true })).toContain('class="td-cap"');
  expect(spendLine({ ...withPicture, spend: { ...withPicture.spend!, on: false } }, { replying: "", sending: [], error: "" })).toContain("words only");
  expect(spendLine({ ...withPicture, spend: { ...withPicture.spend!, dollars: 9.99 } }, { replying: "", sending: [], error: "" })).toContain("cap is reached");
});
