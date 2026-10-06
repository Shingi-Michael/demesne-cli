import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { fixture } from "../../graphics/test/fixture.ts";

test("CLI can enable, inspect and disable automatic approval for one session", async () => {
  const f = await fixture();
  const { session } = await f.client.createSession({ workspacePath: f.workspace, trustWorkspace: true });
  const other = (await f.client.createSession({ workspacePath: f.workspace, trustWorkspace: true })).session;
  const run = async (mode: string) => {
    const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../src/main.ts"), "--server", f.server.url.href,
      "session", "auto-approve", session.id, mode], { env: f.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [status, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { status, output, error };
  };
  try {
    expect((await run("status")).output).toContain("Auto-approve all: off");
    const enabled = await run("on");
    expect(enabled.status).toBe(0);
    expect((await f.client.getSessionState(session.id)).session.autoApprove).toBe(true);
    expect((await f.client.getSessionState(other.id)).session.autoApprove).toBe(false);
    expect((await run("status")).output).toContain("Auto-approve all: on");
    expect((await run("off")).status).toBe(0);
    expect((await f.client.getSessionState(session.id)).session.autoApprove).toBe(false);
    const invalid = await run("anything");
    expect(invalid.status).toBe(1);
    expect(invalid.error).toContain("on|off|status");
    expect((await f.client.getSessionState(session.id)).session.autoApprove).toBe(false);
  } finally { await f.close(); }
});
