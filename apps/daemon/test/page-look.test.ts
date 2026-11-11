import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pageLookMetadata } from "@demesne/storage";
import { lookAtPageTool, pageAddress, PAGE_LOOK_PREFIX, type PageLook } from "../src/page-look.ts";
import { canonicalWorkspace } from "../src/tools.ts";

const root = canonicalWorkspace(mkdtempSync(join(tmpdir(), "demesne-page-look-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));
mkdirSync(join(root, "site"));
writeFileSync(join(root, "site", "index.html"), "<h1>Hi</h1>");
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64").toString("base64");

test("look_at_page opens only this computer's apps and project files", () => {
  expect(pageAddress("http://localhost:5173/login", root)).toBe("http://localhost:5173/login");
  expect(pageAddress("localhost:3000", root)).toBe("http://localhost:3000/");
  expect(pageAddress("http://0.0.0.0:8080/", root)).toBe("http://127.0.0.1:8080/");
  expect(pageAddress("http://app.localhost:4000/", root)).toBe("http://app.localhost:4000/");
  expect(pageAddress("site/index.html", root)).toMatch(/^file:\/\/.*\/site\/index\.html$/);
  expect(() => pageAddress("https://example.com", root)).toThrow("NOT_LOCAL");
  expect(() => pageAddress("file:///etc/passwd", root)).toThrow("NOT_LOCAL");
  expect(() => pageAddress("../outside.html", root)).toThrow();
  expect(() => pageAddress("site/missing.html", root)).toThrow("NOT_FOUND");
  expect(() => pageAddress("README.md", root)).toThrow("INVALID_URL");
});

test("look_at_page reports the steps, errors and pictures the window saw", async () => {
  let asked: { url: string; width: number; steps: unknown[] } | null = null;
  const look: PageLook = async (url, plan) => {
    asked = { url, ...plan };
    return { width: plan.width, title: "Sign in", url: "http://localhost:5173/home", errors: ["Uncaught TypeError: x is undefined"], tree: ["heading “Welcome”"],
      steps: [{ step: "click “Sign in”", ok: true, said: "button “Sign in” → went to /home" }],
      pictures: [{ after: "opening", png }, { after: "click “Sign in”", png }] };
  };
  const tool = lookAtPageTool(look);
  expect(tool.permission({})).toBeNull();
  const output = await tool.executeWithArtifacts!({ url: "localhost:5173/login", width: "phone", steps: [{ click: "Sign in" }] }, { workspaceRoot: root, signal: new AbortController().signal, turnId: "t1" });
  expect(asked!).toEqual({ url: "http://localhost:5173/login", width: 390, steps: [{ click: "Sign in" }] });
  if (typeof output === "string") throw new Error("expected pictures");
  const report = JSON.parse(output.text);
  expect(report.steps).toEqual(["✓ click “Sign in”: button “Sign in” → went to /home"]);
  expect(report.console_errors).toEqual(["Uncaught TypeError: x is undefined"]);
  expect(report.pictures).toEqual(["on opening", "after click “Sign in”"]);
  expect(output.images.map((image) => image.filename)).toEqual([`${PAGE_LOOK_PREFIX}1.png`, `${PAGE_LOOK_PREFIX}2.png`]);
  // What the chat records for the row: the engine lists each picture after the report.
  const recorded = pageLookMetadata(`${output.text}\nImage artifact 0b0b0b0b-1111-4222-8333-444444444444: page-look-1.png (390×844)\nImage artifact 0b0b0b0b-1111-4222-8333-555555555555: page-look-2.png (390×844)`);
  const message = JSON.parse(String(recorded.message));
  expect(message.url).toBe("http://localhost:5173/home");
  expect(message.errorCount).toBe(1);
  expect(message.pictures).toEqual([
    { id: "0b0b0b0b-1111-4222-8333-444444444444", width: 390, height: 844, label: "on opening" },
    { id: "0b0b0b0b-1111-4222-8333-555555555555", width: 390, height: 844, label: "after click “Sign in”" },
  ]);
});

test("look_at_page says when the app isn't running, and stops after a few looks a turn", async () => {
  const down = lookAtPageTool(async () => ({ width: 1280, title: "", url: "", steps: [], tree: [], errors: ["Could not try the page: ERR_CONNECTION_REFUSED (-102)"], pictures: [] }));
  const context = { workspaceRoot: root, signal: new AbortController().signal, turnId: "t2" };
  await expect(down.executeWithArtifacts!({ url: "http://localhost:9" }, context)).rejects.toThrow("is the dev server running?");
  for (let i = 0; i < 5; i++) await down.executeWithArtifacts!({ url: "http://localhost:9" }, context).catch(() => {});
  await expect(down.executeWithArtifacts!({ url: "http://localhost:9" }, context)).rejects.toThrow("LIMIT");
  await expect(down.executeWithArtifacts!({ url: "http://localhost:9", steps: [{ jump: 1 }] }, { ...context, turnId: "t3" })).rejects.toThrow("INVALID_STEPS");
});
