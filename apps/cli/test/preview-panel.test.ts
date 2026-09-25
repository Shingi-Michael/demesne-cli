import { expect, test } from "bun:test";
import { ArtifactPreview } from "../src/workbench/preview-panel.ts";
import type { ImageArtifact } from "@demesne/protocol";
import { createPainter } from "@demesne/brand";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const image = (id: string): ImageArtifact => ({ id, kind: "image", sessionId: "session", turnId: "turn", toolCallId: "call", createdAt: id,
  filename: `${id}.png`, mimeType: "image/png", width: 20, height: 10, byteLength: 10, sha256: id, source: { kind: "tool", name: "test", modelId: null }, revisionOf: null });

test("manual selection and dismissal resist incoming images and stale loads", async () => {
  const loads: (() => void)[] = [];
  const preview = new ArtifactPreview({ content: () => new Promise((resolve) => loads.push(() => resolve(new Uint8Array([1])))), open: async () => {} }, () => {});
  preview.reset("session"); preview.add(image("a"), true); preview.add(image("b"));
  preview.select(-1); expect(preview.selectedId).toBe("a");
  preview.add(image("c")); expect(preview.selectedId).toBe("a");
  loads.forEach((resolve) => resolve()); await Promise.resolve(); await Promise.resolve();
  expect(preview.selectedId).toBe("a");
  preview.close(); preview.add(image("d"), true); expect(preview.open).toBe(false);
  preview.reset("other"); preview.add(image("e"), true); expect(preview.artifacts).toHaveLength(0);
});

test("compact controls stay visible as keyboard selection changes", () => {
  const preview = new ArtifactPreview({ content: async () => new Uint8Array([1]), open: async () => {} }, () => {});
  preview.reset("session"); preview.add(image("a")); preview.toggle();
  for (let i = 0; i < 8; i++) {
    const frame = preview.render(36, 5, 0, createPainter(false), null);
    expect(frame.rows).toHaveLength(5);
    expect(frame.zones).toHaveLength(1);
    expect(frame.rows[4]).toContain("›");
    preview.key("tab");
  }
});

test("a pinned selection and dismissal survive a new client instance", () => {
  const root = mkdtempSync(join(tmpdir(), "demesne-preview-preferences-"));
  const services = { content: async () => new Uint8Array([1]), open: async () => {}, preferences: join(root, "preview.json") };
  try {
    const preview = new ArtifactPreview(services, () => {});
    preview.reset("session"); preview.add(image("a")); preview.toggle();
    const frame = preview.render(42, 36, 0, createPainter(false), null);
    frame.zones.find((zone) => frame.rows[zone.row]?.slice(zone.column, zone.column + zone.width) === "Pin")!.run();
    preview.add(image("b")); expect(preview.selectedId).toBe("a");
    preview.close();
    const restored = new ArtifactPreview(services, () => {});
    restored.reset("session"); restored.add(image("a"), true); restored.add(image("b"), true);
    expect(restored.mode).toBe("pinned"); expect(restored.selectedId).toBe("a"); expect(restored.open).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
