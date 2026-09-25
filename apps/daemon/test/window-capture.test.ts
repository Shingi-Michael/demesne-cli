import { expect, test } from "bun:test";
import { captureWindowTool } from "../src/window-capture.ts";

const windows = [
  { id: 11, application: "Ghostty", title: "demesne" },
  { id: 12, application: "Ghostty", title: "another terminal" },
  { id: 13, application: "Chrome", title: "demesne docs" },
  { id: 14, application: "Ghostty", title: "~/projects/demesne-cli" },
];
const context = { workspaceRoot: "/", signal: new AbortController().signal };

test("native capture selects the terminal window and returns an image through the artifact contract", async () => {
  const captured: number[] = [];
  const tool = captureWindowTool({ list: async () => windows, capture: async (id) => { captured.push(id); return new Uint8Array([1, 2]); } });
  const output = await tool.executeWithArtifacts!({ application: "Ghostty", title: "demesne" }, context);
  expect(captured).toEqual([11]);
  expect(typeof output).toBe("object");
  if (typeof output === "string") throw new Error("Missing image");
  expect(output.images[0]!.mimeType).toBe("image/png");
  expect(output.text).toContain("Ghostty — demesne");
  expect(tool.permission({})).toMatchObject({ kind: "execute" });
});

test("ambiguous, absent and mismatched windows never fall back to a desktop or another application", async () => {
  const captured: number[] = [];
  const tool = captureWindowTool({ list: async () => windows, capture: async (id) => { captured.push(id); return new Uint8Array(); } });
  expect(await tool.executeWithArtifacts!({ application: "Ghostty" }, context)).toContain("Specify a windowId");
  expect(await tool.executeWithArtifacts!({ application: "Ghostty", windowId: 13 }, context)).toContain("No unique matching window");
  expect(await tool.executeWithArtifacts!({ application: "Ghostty", title: "missing" }, context)).toContain("make its terminal window visible");
  expect(captured).toEqual([]);
  await tool.executeWithArtifacts!({ application: "ghostty", windowId: 12 }, context);
  expect(captured).toEqual([12]);
  await expect(tool.executeWithArtifacts!({ application: "Ghostty", windowId: "11;command" }, context)).rejects.toThrow("positive windowId");
});

test("native capture preserves cancellation and permission errors", async () => {
  let captures = 0;
  const tool = captureWindowTool({ list: async () => windows, capture: async () => { captures++; return new Uint8Array(); } });
  await expect(tool.executeWithArtifacts!({ application: "Ghostty", title: "demesne" }, { ...context, signal: AbortSignal.abort() })).rejects.toThrow();
  expect(captures).toBe(0);
  const denied = captureWindowTool({ list: async () => { throw new Error("Screen Recording access is required"); }, capture: async () => new Uint8Array() });
  await expect(denied.executeWithArtifacts!({ application: "Ghostty" }, context)).rejects.toThrow("Screen Recording");
});
