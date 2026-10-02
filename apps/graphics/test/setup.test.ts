import { expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GraphicsSetup } from "../setup-controller.ts";
import { eventually } from "./fixture.ts";

test("setup checks URLs, edits review values, and writes only on explicit Review confirmation", async () => {
  const root = mkdtempSync(join(tmpdir(), "graphics-setup-")),
    path = join(root, "config.toml");
  const setup = new GraphicsSetup({
    configPath: path,
    changed: () => {},
    copy: async () => {},
    open: async () => {},
    finish: async () => {},
    env: {},
    fetch: (async () =>
      Response.json({
        data: [{ id: "fixture", context_length: 65536 }],
      })) as unknown as typeof fetch,
  });
  try {
    await setup.start();
    await setup.action({ index: 4, key: "return" });
    expect(setup.snapshot().step).toBe("custom");
    await setup.action({ field: "url", value: "http://remote.example/v1" });
    await setup.action({ key: "return" });
    expect(setup.snapshot().custom.error).toContain("HTTPS");
    expect(existsSync(path)).toBe(false);
    await setup.action({ field: "url", value: "https://remote.example/v1" });
    await setup.action({ key: "return" });
    expect(setup.snapshot().step).toBe("model");
    await setup.action({ key: "return" });
    await setup.action({ index: 2, key: "e" });
    await setup.action({ field: "review", value: "32768", key: "return" });
    expect(setup.snapshot().review.contextWindow).toBe(32768);
    expect(existsSync(path)).toBe(false);
    await setup.action({ key: "return" });
    expect(setup.snapshot().step).toBe("done");
    expect(readFileSync(path, "utf8")).toContain("fixture");
    expect(statSync(path).mode & 0o777).toBe(0o600);
  } finally {
    setup.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});
test("OpenRouter credential stays in the host until Review and never enters UI snapshots", async () => {
  const root = mkdtempSync(join(tmpdir(), "graphics-auth-")),
    path = join(root, "config.toml"),
    secret = "test-secret-key";
  let opened = 0;
  const setup = new GraphicsSetup({
    configPath: path,
    changed: () => {},
    copy: async () => {},
    open: async () => {
      opened++;
    },
    finish: async () => {},
    env: { OPENROUTER_API_KEY: secret },
    fetch: (async (url: unknown) =>
      String(url).endsWith("/key")
        ? Response.json({ data: {} })
        : Response.json({
            data: [{ id: "example/model", context_length: 65536 }],
          })) as unknown as typeof fetch,
  });
  try {
    await setup.start();
    await setup.action({ index: 3, key: "return" });
    await eventually(() => setup.snapshot().step === "model");
    expect(opened).toBe(0);
    expect(JSON.stringify(setup.snapshot())).not.toContain(secret);
    expect(existsSync(path)).toBe(false);
    await setup.action({ key: "return" });
    await setup.action({ key: "return" });
    expect(readFileSync(path, "utf8")).toContain(secret);
    expect(JSON.stringify(setup.snapshot())).not.toContain(secret);
  } finally {
    setup.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});
