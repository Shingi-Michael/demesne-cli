import { expect, test } from "bun:test";
import { effortDots, runsOn, whereCard } from "../where-card";

const view = {
  root: "/Users/mike/projects/demesne-cli",
  branch: "main",
  ahead: 2,
  behind: 0,
  uncommitted: 4,
  model: { id: "codex/gpt-6.1-sol", displayName: "GPT-6.1 Sol", provider: "Codex" },
  reasoning: "high",
  capacity: 272_000,
  connection: "online" as const,
  server: "http://127.0.0.1:7337",
};

test("three facts and no greeting: machine, branch, model", () => {
  const card = whereCard(view);
  expect(card.state).toBe("");
  expect(card.rows.match(/class="env-row"/g)?.length).toBe(3);
  expect(card.rows).toContain("This computer");
  expect(card.rows).toContain('class="env-dot on"');
  expect(card.rows).toContain('<span class="env-v">main</span>');
  expect(card.rows).toContain("↑2 · 4 uncommitted");
  expect(card.rows).toContain('title="2 commits to push"');
  expect(card.rows).toContain("GPT-6.1 Sol");
  expect(card.rows).toMatch(/<i class="on"><\/i><i class="on"><\/i><i class="on"><\/i>/);
  expect(card.rows).toContain("272k");
  // No tile and no big project name.
  expect(card.rows).not.toContain("demesne-cli");
  expect(card.rows).not.toContain("wh-tile");
});

test("hover holds the folder, provider and daemon", () => {
  const card = whereCard(view);
  expect(card.more).toContain("~/projects/demesne-cli");
  expect(card.more).toContain("Codex");
  expect(card.more).toContain("127.0.0.1:7337");
  expect(whereCard({ ...view, root: "C:\\Users\\shing\\demesne-cli" }).more).toContain("~\\demesne-cli");
});

test("the branch says what's behind, and nothing when in step", () => {
  expect(whereCard({ ...view, ahead: 1, behind: 3, uncommitted: 0 }).rows).toContain("↑1 ↓3");
  const even = whereCard({ ...view, ahead: 0, behind: 0, uncommitted: 0 }).rows;
  expect(even).not.toContain("↑");
  expect(even).not.toContain("uncommitted");
  expect(whereCard({ ...view, branch: undefined }).rows).toContain("Not a git checkout");
});

test("the daemon only speaks up when it isn't fine", () => {
  const off = whereCard({ ...view, connection: "offline" });
  expect(off.state).toBe("off");
  expect(off.rows).toContain("Daemon is offline");
  expect(off.rows).toContain('class="env-dot off"');
  const wait = whereCard({ ...view, connection: "connecting" });
  expect(wait.state).toBe("wait");
  expect(wait.rows).toContain("Connecting to the daemon…");
});

test("a plain chat, a model with no name, and a remote daemon", () => {
  const plain = whereCard({ ...view, root: "", branch: null, model: { id: "qwen/qwen3-4b" }, reasoning: null, capacity: null, uncommitted: 0, server: "http://studio.local:7337" });
  expect(plain.rows.match(/class="env-row"/g)?.length).toBe(2);
  expect(plain.rows).toContain("Qwen3 4B");
  expect(plain.rows).not.toContain("env-eff");
  expect(plain.rows).toContain("studio.local");
  expect(plain.more).not.toContain("Folder");
});

test("effort dots and runs on", () => {
  expect(effortDots("low")).toBe(1);
  expect(effortDots("medium")).toBe(2);
  expect(effortDots("xhigh")).toBe(3);
  expect(effortDots("")).toBe(0);
  expect(runsOn("http://localhost:7337")).toBe("This computer");
  expect(runsOn("https://box.tail.net")).toBe("box.tail.net");
  expect(runsOn("")).toBe("This computer");
});
