import { expect, test } from "bun:test";
import { effortDots, runsOn, tint, whereCard } from "../where-card";

const view = {
  root: "/Users/mike/projects/demesne-cli",
  branch: "main",
  model: { id: "codex/gpt-6.1-sol", displayName: "GPT-6.1 Sol", provider: "Codex" },
  reasoning: "high",
  connection: "online" as const,
  server: "http://127.0.0.1:7337",
  changed: 3,
  context: { percentage: 41, used: 82_000, capacity: 200_000 },
};

test("the head is the project's monogram, name, folder and model", () => {
  const card = whereCard(view);
  expect(card.head).toContain('class="wh-tile wh-');
  expect(card.head).toContain(">D</span>");
  expect(card.head).toContain('<span class="wh-name">demesne-cli</span>');
  expect(card.head).toContain("<em>~/projects/</em>demesne-cli");
  expect(card.head).toContain("GPT-6.1 Sol");
  expect(card.head).toMatch(/<i class="on"><\/i><i class="on"><\/i><i class="on"><\/i>/);
  expect(card.head).toContain("Codex");
  expect(card.summary).toBe("demesne-cli · main");
  expect(card.title).toBe("~/projects/demesne-cli\nProvider Codex\nDaemon http://127.0.0.1:7337");
});

test("the lines say the branch with what changed, the context and where it runs", () => {
  const card = whereCard(view);
  expect(card.state).toBe("");
  expect(card.body).not.toContain("wh-note");
  expect(card.body).toContain('<span class="wh-chip">main</span>');
  expect(card.body).toContain("3 changed");
  expect(card.body).toContain("41%");
  expect(card.body).toContain("82k of 200k");
  expect(card.body).toContain("This computer");
  expect(card.body).toContain('<span class="wh-r">online</span>');
});

test("the daemon only speaks up when it isn't fine", () => {
  const off = whereCard({ ...view, connection: "offline" });
  expect(off.state).toBe("off");
  expect(off.body).toContain("Daemon is offline");
  expect(off.body).toContain('data-action="start-daemon"');
  const wait = whereCard({ ...view, connection: "connecting" });
  expect(wait.state).toBe("wait");
  expect(wait.body).toContain("Connecting to the daemon…");
  expect(wait.body).not.toContain("start-daemon");
});

test("a plain chat, a model with no name, and a remote daemon", () => {
  const plain = whereCard({ ...view, root: "", branch: null, model: { id: "qwen/qwen3-4b" }, reasoning: null, context: null, changed: 0, server: "http://studio.local:7337" });
  expect(plain.head).toContain(">J</span>");
  expect(plain.head).toContain("Just a chat");
  expect(plain.head).toContain("No project folder");
  expect(plain.head).toContain("Qwen3 4B");
  expect(plain.head).not.toContain("wh-eff");
  expect(plain.body).not.toContain("Branch");
  expect(plain.body).not.toContain("Context");
  expect(plain.body).toContain("studio.local");
  expect(plain.summary).toBe("Just a chat");
  expect(whereCard({ ...view, branch: undefined }).body).toContain("not a git checkout");
  expect(whereCard({ ...view, root: "C:\\Users\\shing\\demesne-cli" }).head).toContain("<em>~\\</em>demesne-cli");
});

test("tint, effort dots and runs on", () => {
  expect(tint("demesne-cli")).toBe(tint("demesne-cli"));
  expect(["pink", "blue", "green", "amber", "lilac"]).toContain(tint("anything"));
  expect(effortDots("low")).toBe(1);
  expect(effortDots("medium")).toBe(2);
  expect(effortDots("xhigh")).toBe(3);
  expect(effortDots("")).toBe(0);
  expect(runsOn("http://localhost:7337")).toBe("This computer");
  expect(runsOn("https://box.tail.net")).toBe("box.tail.net");
  expect(runsOn("")).toBe("This computer");
});
