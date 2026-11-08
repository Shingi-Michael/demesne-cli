import { expect, test } from "bun:test";
import { captureWindowTool } from "../src/window-capture.ts";
import type { ShotWindow } from "../../../packages/screen/src/index.ts";

const windows: ShotWindow[] = [
  { id: "11", app: "Ghostty", title: "demesne" },
  { id: "12", app: "Ghostty", title: "another terminal" },
  { id: "13", app: "Chrome", title: "demesne docs" },
  { id: "14", app: "Ghostty", title: "~/projects/demesne-cli" },
];
const context = { workspaceRoot: "/", signal: new AbortController().signal };
const shooter = (captured: string[], text = "") => ({ list: async () => windows,
  capture: async (window: ShotWindow) => { captured.push(window.id); return { ...window, png: new Uint8Array([1, 2]), text }; } });

test("native capture selects the terminal window and returns an image through the artifact contract", async () => {
  const captured: string[] = [];
  const tool = captureWindowTool(shooter(captured));
  const output = await tool.executeWithArtifacts!({ application: "Ghostty", title: "demesne" }, context);
  expect(captured).toEqual(["11"]);
  if (typeof output === "string") throw new Error("Missing image");
  expect(output.images[0]!.mimeType).toBe("image/png");
  expect(output.text).toContain("Ghostty — demesne");
  expect(tool.permission({})).toMatchObject({ kind: "execute" });
});

test("with no input it takes the window the user is in, past Demesne, with its text", async () => {
  const captured: string[] = [];
  const tool = captureWindowTool({ ...shooter(captured, "Settings\nSave"), list: async () => [{ id: "9", app: "Demesne", title: "Chat" }, ...windows] });
  const output = await tool.executeWithArtifacts!({}, context);
  expect(captured).toEqual(["11"]);
  if (typeof output === "string") throw new Error("Missing image");
  expect(output.text).toContain("Text in the window:\nSettings\nSave");
});

test("ambiguous, absent and mismatched windows never fall back to a desktop or another application", async () => {
  const captured: string[] = [];
  const tool = captureWindowTool(shooter(captured));
  expect(await tool.executeWithArtifacts!({ application: "Ghostty" }, context)).toContain("Specify a windowId");
  expect(await tool.executeWithArtifacts!({ application: "Ghostty", windowId: 13 }, context)).toContain("No unique matching window");
  expect(await tool.executeWithArtifacts!({ application: "Ghostty", title: "missing" }, context)).toContain("make its window visible");
  expect(captured).toEqual([]);
  await tool.executeWithArtifacts!({ application: "ghostty", windowId: 12 }, context);
  expect(captured).toEqual(["12"]);
  await expect(tool.executeWithArtifacts!({ application: "Ghostty", windowId: "11;command" }, context)).rejects.toThrow("windowId");
});

test("native capture preserves cancellation and permission errors", async () => {
  const captured: string[] = [];
  const tool = captureWindowTool(shooter(captured));
  await expect(tool.executeWithArtifacts!({ application: "Ghostty", title: "demesne" }, { ...context, signal: AbortSignal.abort() })).rejects.toThrow();
  expect(captured).toEqual([]);
  const denied = captureWindowTool({ list: async () => { throw new Error("Screen & System Audio Recording"); }, capture: async (window) => ({ ...window, png: new Uint8Array(), text: "" }) });
  await expect(denied.executeWithArtifacts!({ application: "Ghostty" }, context)).rejects.toThrow("Screen");
});
