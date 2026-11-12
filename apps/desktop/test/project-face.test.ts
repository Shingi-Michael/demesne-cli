import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectFace } from "../workspace/project-face.ts";
import { projectTone } from "../workspace/project-tone.ts";

const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>';

describe("projectFace", () => {
  test("finds an icon at the root", () => {
    const root = mkdtempSync(join(tmpdir(), "face-"));
    writeFileSync(join(root, "icon.svg"), svg);
    expect(projectFace(root)).toStartWith("data:image/svg+xml;base64,");
  });
  test("finds a monorepo app's icon", () => {
    const root = mkdtempSync(join(tmpdir(), "face-"));
    mkdirSync(join(root, "apps", "desktop"), { recursive: true });
    writeFileSync(join(root, "apps", "desktop", "icon.svg"), svg);
    expect(projectFace(root)).toStartWith("data:image/svg+xml;base64,");
  });
  test("skips files that are not what they say", () => {
    const root = mkdtempSync(join(tmpdir(), "face-"));
    writeFileSync(join(root, "icon.svg"), "not an svg");
    writeFileSync(join(root, "icon.png"), "not a png");
    expect(projectFace(root)).toBeNull();
  });
  test("is null without an icon", () => {
    expect(projectFace(mkdtempSync(join(tmpdir(), "face-")))).toBeNull();
  });
});

describe("projectTone", () => {
  test("is steady for a name", () => {
    expect(projectTone("website")).toBe(projectTone("Website"));
    expect(projectTone("website")).toMatch(/^#[0-9a-f]{6}$/);
  });
});
