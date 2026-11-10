import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { derivePersistedRule, openAppKey } from "@demesne/protocol";
import { allowRulesCover, parseAllowRule } from "../src/allowlist.ts";
import { openCommand, openTool, showTool, SHOWN_FILE, type OpenDependencies } from "../src/open-show.ts";
import { PermissionBroker } from "../src/permissions.ts";
import { shownMetadata } from "../../../packages/storage/src/index.ts";
import type { ShotWindow } from "../../../packages/screen/src/index.ts";

const root = mkdtempSync(join(tmpdir(), "open-show-"));
writeFileSync(join(root, "report.pdf"), "%PDF");
writeFileSync(join(root, "design.png"), "png");
mkdirSync(join(root, "assets"));
const context = { workspaceRoot: root, signal: new AbortController().signal };

function fake(platform: NodeJS.Platform, windows?: { before: ShotWindow[]; after: ShotWindow[] }) {
  const ran: string[][] = [], captured: string[] = [];
  let lists = 0;
  const deps: OpenDependencies = {
    platform, settleMs: 1,
    run: async (argv) => { ran.push(argv); return { code: 0, stderr: "" }; },
    ...(windows ? { windows: {
      list: async () => lists++ === 0 ? windows.before : windows.after,
      capture: async (window: ShotWindow) => { captured.push(window.id); return { ...window, png: new Uint8Array([1]), text: "" }; },
    } } : {}),
  };
  return { deps, ran, captured };
}

test("opens behind Demesne on a Mac: an app, a file in an app, a link", () => {
  expect(openCommand("darwin", "Figma", undefined)).toEqual(["open", "-g", "-a", "Figma"]);
  expect(openCommand("darwin", "Preview", "/a/report.pdf")).toEqual(["open", "-g", "-a", "Preview", "/a/report.pdf"]);
  expect(openCommand("darwin", undefined, "https://example.com/")).toEqual(["open", "-g", "https://example.com/"]);
  expect(openCommand("linux", undefined, "/a/report.pdf")).toEqual(["xdg-open", "/a/report.pdf"]);
  expect(openCommand("win32", undefined, "https://example.com/")).toEqual(["explorer.exe", "https://example.com/"]);
});

test("open pictures the window that opened, never Demesne's own", async () => {
  const { deps, ran, captured } = fake("darwin", {
    before: [{ id: "1", app: "Demesne", title: "Chat" }, { id: "2", app: "Safari", title: "Docs" }],
    after: [{ id: "1", app: "Demesne", title: "Chat" }, { id: "2", app: "Safari", title: "Docs" }, { id: "3", app: "Figma", title: "Roaster" }],
  });
  const out = await openTool(deps).executeWithArtifacts!({ app: "Figma" }, context);
  if (typeof out === "string") throw new Error("expected a structured result");
  expect(ran).toEqual([["open", "-g", "-a", "Figma"]]);
  expect(captured).toEqual(["3"]);
  expect(out.images[0]!.filename).toBe(SHOWN_FILE);
  expect(JSON.parse(out.text)).toMatchObject({ opened: true, app: "Figma", title: "Roaster", kind: "app" });
});

test("open resolves files in the project and refuses what can't be opened", async () => {
  const { deps, ran } = fake("linux");
  const out = await openTool(deps).executeWithArtifacts!({ target: "report.pdf" }, context);
  if (typeof out === "string") throw new Error("expected a structured result");
  expect(ran[0]).toEqual(["xdg-open", join(root, "report.pdf")]);
  expect(out.images).toEqual([]);
  expect(JSON.parse(out.text)).toMatchObject({ opened: true, name: "report.pdf", kind: "file" });
  const tool = openTool(deps);
  await expect(tool.executeWithArtifacts!({ target: "missing.txt" }, context)).rejects.toThrow("NOT_FOUND");
  await expect(tool.executeWithArtifacts!({ target: "file:///etc/passwd" }, context)).rejects.toThrow("can't be opened");
  await expect(tool.executeWithArtifacts!({ app: "../bin/sh" }, context)).rejects.toThrow("INVALID_APP");
  await expect(tool.executeWithArtifacts!({}, context)).rejects.toThrow("needs an app or a target");
  expect(tool.permission({ app: "Figma" })).toEqual({ kind: "execute", summary: "Open Figma" });
});

test("opening asks once per app: Always is the app, not the file", async () => {
  expect(openAppKey({ app: "Figma" })).toBe("figma");
  expect(openAppKey({ app: "Preview", target: "a.pdf" })).toBe("preview");
  expect(openAppKey({ target: "https://github.com/x" })).toBe("web links");
  expect(openAppKey({ target: "figma://file/1" })).toBe("figma links");
  expect(openAppKey({ target: "docs/report.PDF" })).toBe(".pdf files");
  expect(openAppKey({ target: "assets" })).toBe("folders");
  expect(derivePersistedRule("open", JSON.stringify({ app: "Figma" }))).toBe("open:figma");
  const rules = [parseAllowRule("open:figma")!];
  expect(allowRulesCover(rules, "open", { app: "Figma" })).toBe(true);
  expect(allowRulesCover(rules, "open", { app: "Figma", target: "x.fig" })).toBe(true);
  expect(allowRulesCover(rules, "open", { app: "Terminal" })).toBe(false);
  expect(allowRulesCover(rules, "open", { target: "https://x.com" })).toBe(false);

  const broker = new PermissionBroker();
  const waiter = broker.wait("p", "t", "s", "open", JSON.stringify({ app: "Figma" }), new AbortController().signal);
  broker.resolve("p", "allow_session");
  await waiter;
  expect(broker.preapproved("s", "open", { app: "figma" })).toBe(true);
  expect(broker.preapproved("s", "open", { app: "Terminal" })).toBe(false);
});

test("show never asks: a file, the app live, a page as a picture", async () => {
  const pictures: string[] = [];
  const tool = showTool(async (url) => { pictures.push(url); return { width: 1280, title: "Example Domain", url, steps: [], tree: [], errors: [], pictures: [{ after: "opening", png: "AQ==" }] }; });
  expect(tool.permission({ path: "design.png" })).toBeNull();
  const file = await tool.executeWithArtifacts!({ path: "design.png" }, context);
  if (typeof file === "string") throw new Error("expected a structured result");
  expect(JSON.parse(file.text)).toMatchObject({ shown: "file", name: "design.png", path: "design.png" });
  const live = await tool.executeWithArtifacts!({ url: "localhost:5173/settings" }, context);
  if (typeof live === "string") throw new Error("expected a structured result");
  expect(JSON.parse(live.text)).toMatchObject({ shown: "app", url: "http://localhost:5173/settings", live: true });
  expect(pictures).toEqual([]);
  const page = await tool.executeWithArtifacts!({ url: "https://example.com" }, context);
  if (typeof page === "string") throw new Error("expected a structured result");
  expect(pictures).toEqual(["https://example.com/"]);
  expect(JSON.parse(page.text)).toMatchObject({ shown: "page", name: "Example Domain" });
  expect(page.images[0]!.filename).toBe(SHOWN_FILE);
  await expect(tool.executeWithArtifacts!({ path: "assets" }, context)).rejects.toThrow("is a folder");
  await expect(tool.executeWithArtifacts!({ path: "a", url: "https://x" }, context)).rejects.toThrow("path or a url");
});

test("the step keeps what the card needs", () => {
  const id = "0f8fad5b-d9cb-469f-a165-70867728950e";
  expect(JSON.parse(String(shownMetadata(`${JSON.stringify({ opened: true, name: "Figma", app: "Figma", title: "Roaster", kind: "app" })}\nImage artifact ${id}: ${SHOWN_FILE} (800×600)`).message)))
    .toEqual({ shown: "window", name: "Figma", app: "Figma", title: "Roaster", kind: "app", picture: { id, width: 800, height: 600 } });
  expect(JSON.parse(String(shownMetadata(JSON.stringify({ shown: "app", name: "localhost:5173", url: "http://localhost:5173/", live: true })).message)))
    .toEqual({ shown: "app", name: "localhost:5173", url: "http://localhost:5173/", live: true });
  expect(shownMetadata("not json")).toEqual({});
});
