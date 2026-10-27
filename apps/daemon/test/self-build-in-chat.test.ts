import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDemesneCheckout, selfBuildContext } from "../src/self-build-in-chat.ts";

test("only a Demesne checkout with its page builder is told to stop at the edit", () => {
  const root = mkdtempSync(join(tmpdir(), "demesne-chat-"));
  expect(selfBuildContext(root)).toBeNull();
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "demesne-cli" }));
  expect(isDemesneCheckout(root)).toBe(false);
  mkdirSync(join(root, "scripts"));
  writeFileSync(join(root, "scripts/prepare-ui.ts"), "");
  expect(isDemesneCheckout(root)).toBe(true);
  const words = selfBuildContext(root)!;
  expect(words).toContain("never run `bun run desktop`");
  expect(words).toContain("Try it here");
  expect(words).toContain("Keep");
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "other" }));
  expect(selfBuildContext(root)).toBeNull();
});
