import { expect, test } from "bun:test";
import { cleanLook, lookFailure, pageLookGroup, pageLookRow, pageName } from "../page-look-row.ts";

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

test("a look that failed names the real cause, not the server, when the server isn't it", () => {
  const viewer = "Error: [VIEWER_MISSING] the page viewer isn't there (/x/Demesne), so no page can be opened. Hint: …";
  const row = pageLookRow({ state: "failed", input: { url: "test-results/look/view.html" }, message: viewer }, () => undefined);
  expect([row.verb, row.meta]).toEqual(["Couldn't open", "the page viewer is missing"]);
  expect(lookFailure("localhost:5173", viewer)).toBe("the page viewer is missing");
  expect(lookFailure("site/index.html", "Error: [UNAVAILABLE] the page could not be opened just now")).toBe("the page didn't load");
  expect(lookFailure("site/missing.html", "Error: [NOT_FOUND] site/missing.html does not exist")).toBe("no such file");
  expect(lookFailure("http://localhost:5173", "Error: [UNREACHABLE] net::ERR_CONNECTION_REFUSED")).toBe("is it running?");
});

test("page checks in a row are one line with every picture in one strip", () => {
  const look = (ids: string, n: string) => ({ name: "look_at_page", state: "done", durationMs: 3000, input: { url: `localhost:56639?ids=${ids}` },
    message: JSON.stringify({ url: `http://localhost:56639/?ids=${ids}`, title: "Settings", width: "1280px", steps: [], errors: [], errorCount: 0,
      pictures: [{ id: `0b0b0b0b-1111-4222-8333-${n.padStart(12, "0")}`, width: 960, height: 600, label: "on opening" }] }) });
  const tools = [look("overview,general", "1"), look("keys,models", "2"), look("permissions,drive", "3")];
  expect(tools.every(cleanLook)).toBe(true);
  const group = pageLookGroup(tools, () => undefined);
  expect([group.verb, group.files, group.durationMs]).toEqual(["Opened 3 pages", "localhost:56639", 9000]);
  expect(group.below.match(/class="pl-shots"/g)?.length).toBe(1);
  expect(group.below.match(/class="pl-shot"/g)?.length).toBe(3);
  expect(group.below).toContain("<span>?ids=keys,models</span>");
  expect(group.below).not.toContain("Opened localhost");
});

test("a look that failed or found errors keeps its own row", () => {
  const ok = { url: "http://localhost:5173/", title: "", width: "", errors: [], pictures: [] };
  expect(cleanLook({ name: "look_at_page", state: "done", input: {}, message: JSON.stringify({ ...ok, steps: ["✕ click “Save”: nothing matches"], errorCount: 0 }) })).toBe(false);
  expect(cleanLook({ name: "look_at_page", state: "done", input: {}, message: JSON.stringify({ ...ok, steps: [], errorCount: 2 }) })).toBe(false);
  expect(cleanLook({ name: "look_at_page", state: "running", input: {} })).toBe(false);
  expect(cleanLook({ name: "look_at_page", state: "failed", input: {} })).toBe(false);
});
