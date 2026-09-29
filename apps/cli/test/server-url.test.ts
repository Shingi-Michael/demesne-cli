import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { isolatedCliEnv } from "./isolated-env.ts";

const cliPath = join(import.meta.dir, "../src/main.ts");

describe("daemon server URL", () => {
  test("rejects cleartext non-loopback endpoints before sending a token", async () => {
    const child = Bun.spawn([process.execPath, cliPath, "--server", "http://example.com", "models"], {
      env: isolatedCliEnv({ DEMESNE_DAEMON_TOKEN: "secret" }),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(code).not.toBe(0);
    expect(stderr).toContain("Remote daemon connections require HTTPS");
  });

  test("allows loopback HTTP endpoints", async () => {
    const server = Bun.serve({ port: 0, fetch: () => Response.json({ models: [] }) });
    try {
      const child = Bun.spawn([process.execPath, cliPath, "--server", server.url.href, "models"], {
        env: isolatedCliEnv(),
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      expect(code, stderr).toBe(0);
    } finally {
      await server.stop(true);
    }
  });
});
