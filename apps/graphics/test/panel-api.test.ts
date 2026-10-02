import { expect, test } from "bun:test";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fixture, eventually } from "./fixture.ts";
import { GraphicsHost } from "../host.ts";
import { workspaceFingerprint } from "../../daemon/src/workspace-review.ts";
import sharp from "sharp";

const settings = (f: Awaited<ReturnType<typeof fixture>>) => ({
  workspace: f.workspace,
  settings: f.settings,
  client: f.client,
  changed: () => {},
});
test("live commands expose output before exit, persist results, detect external edits and rerun exact checks", async () => {
  let round = 0;
  const f = await fixture({
    providerId: "test",
    modelId: "test",
    async listModels() {
      return [];
    },
    async *stream() {
      if (++round === 1) {
        yield {
          type: "tool_call_delta",
          index: 0,
          idDelta: "check",
          nameDelta: "run_command",
          argumentsDelta: JSON.stringify({
            argv: [process.execPath, "run", "check"],
          }),
        };
        yield { type: "finish", reason: "tool_calls" };
      } else {
        yield { type: "text_delta", delta: "Done" };
        yield { type: "finish", reason: "stop" };
      }
    },
  });
  writeFileSync(
    join(f.workspace, "package.json"),
    JSON.stringify({ scripts: { check: "bun check.ts" } }),
  );
  writeFileSync(
    join(f.workspace, "check.ts"),
    "console.log('FIRST');await Bun.sleep(700);console.log('LAST');\n",
  );
  const host = new GraphicsHost(settings(f));
  try {
    await host.connect();
    const id = host.current!.session.id;
    await host.submit("Run checks");
    await eventually(() => host.current!.approvals.size === 1);
    await host.handle("permission", {
      sessionId: id,
      id: [...host.current!.approvals.keys()][0],
      decision: "allow_once",
    });
    let commands = await f.client.commands(id);
    await eventually(async () => {
      commands = await f.client.commands(id);
      return commands.commands.some(
        (c) => c.status === "running" && c.stdout.includes("FIRST"),
      );
    });
    const command = commands.commands[0]!;
    expect(command.completedAt).toBeNull();
    expect(command.cwd).toBe(f.workspace);
    expect(command.check).toBe(true);
    const other = (await f.client.createSession({ workspacePath: f.workspace }))
      .session;
    await expect(f.client.stopCommand(other.id, command.id)).rejects.toThrow(
      "No running command",
    );
    await eventually(() => host.current!.runs().at(-1)?.status === "completed");
    commands = await f.client.commands(id);
    expect(commands.commands[0]).toMatchObject({
      status: "completed",
      exitCode: 0,
      freshness: "current",
    });
    expect(commands.commands[0]!.stdout).toContain("LAST");
    writeFileSync(join(f.workspace, "README.md"), "Changed after check\n");
    await Bun.sleep(1550);
    commands = await f.client.commands(id);
    expect(commands.commands[0]!.freshness).toBe("outdated");
    const rerun = await f.client.rerunCommand(id, command.id);
    await eventually(async () => {
      commands = await f.client.commands(id);
      return (
        commands.commands.find((c) => c.id === rerun.id)?.status === "completed"
      );
    });
    expect(commands.commands.find((c) => c.id === rerun.id)).toMatchObject({
      rerunOf: command.id,
      freshness: "current",
      argv: command.argv,
    });
    const stop = await f.client.rerunCommand(id, command.id);
    await f.client.stopCommand(id, stop.id);
    await eventually(async () => {
      commands = await f.client.commands(id);
      return (
        commands.commands.find((c) => c.id === stop.id)?.status === "stopped"
      );
    });
  } finally {
    host.dispose();
    await f.close();
  }
}, 12000);

test("review scopes preserve recorded edits, include workspace changes and refuse undo after later edits", async () => {
  let round = 0;
  const f = await fixture({
    providerId: "test",
    modelId: "test",
    async listModels() {
      return [];
    },
    async *stream() {
      if (++round === 1) {
        yield {
          type: "tool_call_delta",
          index: 0,
          idDelta: "write",
          nameDelta: "write_file",
          argumentsDelta: JSON.stringify({
            path: "file.ts",
            content: "export const value=1;\n",
          }),
        };
        yield { type: "finish", reason: "tool_calls" };
      } else {
        yield { type: "text_delta", delta: "Done" };
        yield { type: "finish", reason: "stop" };
      }
    },
  });
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", f.workspace, ...args], { stdio: "pipe" });
  git("init", "-q");
  git("add", "README.md");
  git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-qm",
    "Initial",
  );
  const host = new GraphicsHost(settings(f));
  try {
    await host.connect();
    const id = host.current!.session.id;
    await host.submit("Create file");
    await eventually(() => host.current!.approvals.size === 1);
    await host.handle("permission", {
      sessionId: id,
      id: [...host.current!.approvals.keys()][0],
      decision: "allow_once",
    });
    await eventually(() => host.current!.runs().at(-1)?.status === "completed");
    const turn = host.current!.runs()[0]!.id;
    const review = await f.client.review(id, "turn", turn);
    expect(review.files[0]).toMatchObject({
      path: "file.ts",
      beforeExists: false,
      after: "export const value=1;\n",
      undo: { available: true, turnId: turn },
    });
    writeFileSync(join(f.workspace, "file.ts"), "Later user edit\n");
    writeFileSync(join(f.workspace, "README.md"), "Workspace edit\n");
    expect((await f.client.review(id, "turn", turn)).files[0]!.after).toBe(
      "export const value=1;\n",
    );
    expect(
      (await f.client.review(id, "session")).files[0]!.undo!.available,
    ).toBe(false);
    const workspace = await f.client.review(id, "workspace");
    expect(workspace.files.map((f) => f.path)).toEqual([
      "README.md",
      "file.ts",
    ]);
    expect(workspace.files.find((f) => f.path === "file.ts")!.after).toBe(
      "Later user edit\n",
    );
    await expect(
      f.client.undo(id, { turnId: turn, paths: ["file.ts"] }),
    ).rejects.toThrow("Workspace changed");
    expect(readFileSync(join(f.workspace, "file.ts"), "utf8")).toBe(
      "Later user edit\n",
    );
    writeFileSync(join(f.workspace, "file.ts"), "export const value=1;\n");
    await f.client.undo(id, { turnId: turn, paths: ["file.ts"] });
    expect(existsSync(join(f.workspace, "file.ts"))).toBe(false);
    expect((await f.client.review(id, "session")).files[0]!.state).toBe(
      "reverted",
    );
  } finally {
    host.dispose();
    await f.close();
  }
});

test("reference import stays inside the workspace and keeps original resolution", async () => {
  const f = await fixture();
  const host = new GraphicsHost(settings(f));
  try {
    await host.connect();
    await host.submit("Start session");
    await eventually(() => host.current!.runs().at(-1)?.status === "completed");
    await sharp({
      create: { width: 1800, height: 1000, channels: 3, background: "#5aa9e6" },
    })
      .png()
      .toFile(join(f.workspace, "reference.png"));
    const id = host.current!.session.id;
    const image = await f.client.importImage(id, "reference.png");
    expect(image).toMatchObject({
      width: 1800,
      height: 1000,
      source: { name: "reference_import" },
    });
    const original = await f.client.artifactContent(image, "original");
    expect((await sharp(original).metadata()).width).toBe(1800);
    await expect(f.client.importImage(id, "../outside.png")).rejects.toThrow();
  } finally {
    host.dispose();
    await f.close();
  }
});

test("source fingerprints include deletions and untracked files but ignore generated and protected paths", async () => {
  const f = await fixture();
  try {
    const first = workspaceFingerprint(f.workspace);
    expect(first.value).not.toBeNull();
    writeFileSync(join(f.workspace, ".env"), "PRIVATE=secret");
    mkdirSync(join(f.workspace, "node_modules"));
    writeFileSync(join(f.workspace, "node_modules", "ignored"), "generated");
    expect(workspaceFingerprint(f.workspace).value).toBe(first.value);
    writeFileSync(join(f.workspace, "extra.ts"), "1");
    expect(workspaceFingerprint(f.workspace).value).not.toBe(first.value);
  } finally {
    await f.close();
  }
});

test("command panels report the actual model queue position", async () => {
  const entered = Promise.withResolvers<void>();
  const f = await fixture({
    providerId: "test",
    modelId: "test",
    async listModels() {
      return [];
    },
    async *stream(_messages, _tools, signal) {
      entered.resolve();
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      signal.throwIfAborted();
    },
  });
  try {
    const a = (await f.client.createSession({ workspacePath: f.workspace }))
        .session,
      b = (await f.client.createSession({ workspacePath: f.workspace }))
        .session;
    await f.client.submitTurn(a.id, {
      content: "Hold model slot",
      permissionMode: "deny",
    });
    await entered.promise;
    await f.client.submitTurn(b.id, {
      content: "Wait for slot",
      permissionMode: "deny",
    });
    expect((await f.client.commands(b.id)).queuePosition).toBe(1);
    expect((await f.client.commands(a.id)).queuePosition).toBeNull();
  } finally {
    await f.close();
  }
});

test("failed checks rerun sequentially without another model request", async () => {
  let round = 0;
  const f = await fixture({
    providerId: "test",
    modelId: "test",
    async listModels() {
      return [];
    },
    async *stream() {
      if (round++ < 2) {
        yield {
          type: "tool_call_delta",
          index: 0,
          idDelta: `check-${round}`,
          nameDelta: "run_command",
          argumentsDelta: JSON.stringify({
            argv: [process.execPath, "run", "check", String(round)],
          }),
        };
        yield { type: "finish", reason: "tool_calls" };
      } else {
        yield { type: "text_delta", delta: "Checks failed" };
        yield { type: "finish", reason: "stop" };
      }
    },
  });
  writeFileSync(
    join(f.workspace, "package.json"),
    JSON.stringify({ scripts: { check: "bun check.ts" } }),
  );
  writeFileSync(join(f.workspace, "check.ts"), "process.exit(1);\n");
  const host = new GraphicsHost(settings(f));
  try {
    await host.connect();
    await host.submit("Run both checks");
    for (let i = 0; i < 2; i++) {
      await eventually(() => host.current!.approvals.size === 1);
      await host.handle("permission", {
        sessionId: host.current!.session.id,
        id: [...host.current!.approvals.keys()][0],
        decision: "allow_once",
      });
    }
    await eventually(() => host.current!.runs().at(-1)?.status === "completed");
    await host.refreshProcesses();
    const failed = host.processes.filter(
      (command) => command.check && command.status === "failed",
    );
    expect(failed).toHaveLength(2);
    writeFileSync(join(f.workspace, "check.ts"), "console.log('fixed');\n");
    await host.handle("rerun-checks", {
      sessionId: host.current!.session.id,
      ids: failed.map((command) => command.id),
    });
    await eventually(
      () =>
        host.processes.filter(
          (command) => command.rerunOf && command.status === "completed",
        ).length === 2,
    );
    expect(round).toBe(3);
  } finally {
    host.dispose();
    await f.close();
  }
});

test("background launch errors settle command telemetry rather than leaving a phantom process", async () => {
  const { ToolRegistry } = await import("../../daemon/src/tools.ts"),
    { backgroundProcesses } = await import("../../daemon/src/background.ts");
  const original = backgroundProcesses.spawn;
  let finished = false;
  backgroundProcesses.spawn = () => {
    throw new Error("Background process limit reached");
  };
  try {
    await expect(
      new ToolRegistry().get("run_command")!.execute(
        { argv: [process.execPath, "-e", "void 0"], background: true },
        {
          workspaceRoot: process.cwd(),
          signal: new AbortController().signal,
          commands: {
            begin: () => ({
              started: () => {},
              output: () => {},
              finished: () => {
                finished = true;
              },
            }),
          },
        },
      ),
    ).rejects.toThrow("process limit");
    expect(finished).toBe(true);
  } finally {
    backgroundProcesses.spawn = original;
  }
});
