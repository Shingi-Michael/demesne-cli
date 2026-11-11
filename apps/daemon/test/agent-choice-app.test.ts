import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDaemonApp, type DaemonApp } from "../src/app.ts";

const directories: string[] = [];
const apps: DaemonApp[] = [];
afterEach(() => {
  for (const app of apps.splice(0)) app.close?.();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test("Settings › Agents: off in a project leaves it out of that project's list and refuses to open it", async () => {
  const directory = mkdtempSync(join(tmpdir(), "demesne-choice-"));
  directories.push(directory);
  const one = join(realpathSync(directory), "one"), two = join(realpathSync(directory), "two");
  mkdirSync(one); mkdirSync(two);
  const app = createDaemonApp({ databasePath: join(directory, "data", "demesne.sqlite"), agentCli: {
    which: (command) => command === "claude" || command === "codex" ? `/usr/bin/${command}` : null,
    spawn: () => { throw new Error("not run"); },
  } });
  apps.push(app);
  const server = Bun.serve({ port: 0, fetch: app.fetch });
  const call = async (path: string, body?: unknown) => (await fetch(new URL(path, server.url), body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  const ids = async (root: string) => ((await (await call(`/v1/agents?workspace=${encodeURIComponent(root)}`)).json()) as { agents: { id: string }[] }).agents.map((agent) => agent.id);
  try {
    for (const root of [one, two]) await call("/v1/sessions", { title: "x", workspacePath: root, trustWorkspace: true });
    const listed = await (await call("/v1/agent-choice")).json() as { off: boolean; agents: { id: string; runs: { model: string | null; options: { id: string }[] } }[] };
    expect(listed).toMatchObject({ off: false, agents: [{ id: "claude", name: "Claude Code", mode: "every", projects: [] }, { id: "codex", name: "Codex", mode: "every", projects: [] }] });
    // Each agent says what it runs on, so Settings can change it there.
    expect(listed.agents[0]!.runs.model).toBeNull();
    expect(listed.agents[0]!.runs.options[0]!.id).toBe("");
    await call("/v1/socials/agents/claude/model", { model: "opus" });
    const picked = await (await call("/v1/agent-choice")).json() as typeof listed;
    expect(picked.agents[0]!.runs.model).toBe("opus");;
    await call("/v1/agent-choice", { agent: "codex", mode: "some", projects: [one] });
    expect(await ids(one)).toEqual(["claude", "codex"]);
    expect(await ids(two)).toEqual(["claude"]);
    const refused = await call("/v1/agents/open", { agent: "codex", workspacePath: two });
    expect(refused.status).toBe(403);
    const off = await (await call("/v1/agent-choice", { off: true })).json() as { off: boolean };
    expect(off.off).toBe(true);
    expect(await ids(one)).toEqual([]);
    expect((await call("/v1/agent-choice", { agent: "codex", mode: "sometimes" })).status).toBe(400);
  } finally {
    server.stop(true);
  }
});
