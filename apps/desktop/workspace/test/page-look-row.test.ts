import { expect, test } from "bun:test";
import { pageLookRow, pageName } from "../page-look-row.ts";

const message = JSON.stringify({ url: "http://localhost:5173/home", title: "Home", width: "1280px", errors: [], errorCount: 0,
  steps: ["✓ click “Sign in”: button “Sign in” → went to /home", "✕ click “Save”: nothing matches"],
  pictures: [{ id: "0b0b0b0b-1111-4222-8333-444444444444", width: 960, height: 600, label: "on opening" }, { id: "0b0b0b0b-1111-4222-8333-555555555555", width: 960, height: 600, label: "after click “Save”" }] });

test("a look names the page the way a person would", () => {
  expect(pageName("http://localhost:5173/")).toBe("localhost:5173");
  expect(pageName("localhost:5173/login?next=1")).toBe("localhost:5173/login?next=1");
  expect(pageName("file:///home/me/app/site/index.html")).toBe("site/index.html");
  expect(pageName(undefined)).toBe("the app");
});

test("a running look says what it opens", () => {
  const row = pageLookRow({ state: "running", input: { url: "localhost:5173/login", steps: [{ click: "Sign in" }] } }, () => undefined);
  expect([row.verb, row.target, row.meta, row.tone]).toEqual(["Trying", "localhost:5173/login", "1 step", "running"]);
});

test("a finished look shows its steps and pictures, red when a step didn't work", () => {
  const row = pageLookRow({ state: "done", input: { url: "localhost:5173/login" }, message }, (id) => id.endsWith("444") ? "data:image/png;base64,AAAA" : undefined);
  expect(row.verb).toBe("Tried");
  expect(row.target).toBe("localhost:5173/home");
  expect(row.meta).toContain("1 of 2 steps didn't work");
  expect(row.tone).toBe("failed");
  expect(row.below).toContain("went to /home");
  expect(row.below.match(/class="pl-shot"/g)?.length).toBe(2);
  expect(row.below).toContain('src="data:image/png;base64,AAAA"');
  expect(row.below).toContain("After click “Save” · localhost:5173/home");
});

test("a look that couldn't open says so", () => {
  const row = pageLookRow({ state: "failed", input: { url: "http://localhost:9" } }, () => undefined);
  expect([row.verb, row.meta, row.tone]).toEqual(["Couldn't open", "is it running?", "failed"]);
});
