import { expect, test } from "bun:test";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { fixture, eventually } from "./fixture.ts";
import { GraphicsHost } from "../host.ts";
import {
  validateDriveDecisionContext,
  type DriveDecision,
  type DriveRequest,
} from "@demesne/protocol";

test("daemon facts ignore summaries and clocks, track content revisions, protect secrets and enforce turn ownership", async () => {
  const f = await fixture();
  try {
    const session = (
      await f.client.createSession({ workspacePath: f.workspace, trustWorkspace: true })
    ).session;
    const facts = () =>
      f.client.driveFacts(session.id, undefined, [
        "README.md",
        ".env",
        "../outside.txt",
      ]);
    const first = await facts();
    const turn = await f.client.submitTurn(session.id, {
      content: "Explain the already finished work",
      permissionMode: "deny",
    });
    await eventually(
      async () =>
        (await f.client.getSessionState(session.id)).session.turns.at(-1)
          ?.status === "completed",
    );
    const second = await facts();
    expect(second.progress).toBe(first.progress);
    expect(second.latestTurn?.id).toBe(turn.turn.id);
    expect(second.files[0]?.revision).toBe(first.files[0]?.revision);
    writeFileSync(join(f.workspace, ".env"), "SECRET=never expose");
    expect((await facts()).progress).toBe(second.progress);
    expect(
      (await facts()).files.find((file) => file.path === ".env")?.revision,
    ).toBeNull();
    writeFileSync(join(f.workspace, "README.md"), "Changed contents");
    const changed = await facts();
    expect(changed.progress).not.toBe(second.progress);
    expect(changed.files[0]?.revision).not.toBe(second.files[0]?.revision);
    unlinkSync(join(f.workspace, "README.md"));
    expect((await facts()).files[0]?.revision).toBe("missing");
    const other = (await f.client.createSession({ workspacePath: f.workspace, trustWorkspace: true }))
      .session;
    await expect(
      f.client.driveFacts(other.id, turn.turn.id, []),
    ).rejects.toThrow("does not belong");
  } finally {
    await f.close();
  }
});

test("real command facts distinguish failed, passing and outdated checks", async () => {
  let toolIssued = false;
  const f = await fixture({
    providerId: "test",
    modelId: "test",
    async listModels() {
      return [];
    },
    async *stream() {
      if (!toolIssued) {
        toolIssued = true;
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
  const host = new GraphicsHost({
    workspace: f.workspace,
    settings: f.settings,
    client: f.client,
    changed() {},
  });
  try {
    writeFileSync(
      join(f.workspace, "package.json"),
      JSON.stringify({ scripts: { check: "bun -e 'process.exit(1)'" } }),
    );
    await host.connect();
    await host.submit("Run the regression check");
    await eventually(() => host.current!.approvals.size === 1);
    await host.handle("permission", {
      sessionId: host.current!.session.id,
      id: [...host.current!.approvals.keys()][0],
      decision: "allow_once",
    });
    await eventually(() => host.current!.runs().at(-1)?.status === "completed");
    const sessionId = host.current!.session.id,
      facts = await f.client.driveFacts(sessionId, undefined, []);
    expect(facts.checks[0]).toMatchObject({
      status: "failed",
      freshness: "current",
    });
    const request: DriveRequest = {
      mission: "Fix check",
      homeSessionId: sessionId,
      facts,
      memory: {
        notes: "",
        completed: [],
        remaining: [],
        steps: [],
        evidence: [],
      },
      observation: {
        id: "screen",
        sessionId,
        workspace: f.workspace,
        title: "Test",
        mode: "input",
        ready: true,
        draft: "",
        surface: "log",
        rows: ["Done"],
        width: 80,
        height: 24,
        controls: [],
      },
    };
    const decision: DriveDecision = {
      action: { kind: "complete" },
      note: "Done",
      notes: "",
      remaining: [],
      completed: [],
      evidence: [{ observationId: "screen", quote: "Done" }],
    };
    expect(() => validateDriveDecisionContext(decision, request)).toThrow(
      "failed, running or outdated",
    );
    writeFileSync(
      join(f.workspace, "package.json"),
      JSON.stringify({ scripts: { check: "bun -e 'process.exit(0)'" } }),
    );
    const rerun = await f.client.rerunCommand(sessionId, facts.checks[0]!.id);
    await eventually(
      async () =>
        (await f.client.commands(sessionId)).commands.find(
          (command) => command.id === rerun.id,
        )?.status === "completed",
    );
    const passed = await f.client.driveFacts(sessionId, undefined, []);
    expect(passed.checks[0]).toMatchObject({
      status: "completed",
      freshness: "current",
    });
    request.facts = passed;
    expect(() => validateDriveDecisionContext(decision, request)).not.toThrow();
    writeFileSync(join(f.workspace, "README.md"), "Changes after verification");
    request.facts = await f.client.driveFacts(sessionId, undefined, []);
    expect(request.facts.checks[0]?.freshness).toBe("outdated");
    expect(() => validateDriveDecisionContext(decision, request)).toThrow(
      "outdated",
    );
  } finally {
    host.dispose();
    await f.close();
  }
});

test("planner replaces caller-provided facts with daemon records", async () => {
  let received: any;
  const f = await fixture({
    providerId: "test",
    modelId: "test",
    async listModels() {
      return [];
    },
    async *stream(messages, tools) {
      if (tools.some((tool) => tool.name === "drive_ui")) {
        received = JSON.parse(messages[1]!.content!);
        yield {
          type: "tool_call_delta",
          index: 0,
          idDelta: "drive",
          nameDelta: "drive_ui",
          argumentsDelta: JSON.stringify({
            action: { kind: "wait" },
            note: "Inspect",
            notes: "",
            completed: [],
            remaining: [],
            evidence: [],
          }),
        };
        yield { type: "finish", reason: "tool_calls" };
      } else {
        yield { type: "text_delta", delta: "Ready" };
        yield { type: "finish", reason: "stop" };
      }
    },
  });
  try {
    const session = (
      await f.client.createSession({ workspacePath: f.workspace, trustWorkspace: true })
    ).session;
    const facts = await f.client.driveFacts(session.id, undefined, []);
    const now = new Date().toISOString(),
      task = {
        id: "task",
        title: "Inspect",
        criteria: ["Inspect"],
        status: "active" as const,
        createdAt: now,
        workerTurns: [],
        completions: [],
      };
    await f.client.decideDrive({
      mission: "Inspect",
      mode: "bounded",
      homeSessionId: session.id,
      ledger: { version: 1, currentTaskId: "task", tasks: [task] },
      facts: { ...facts, progress: "forged", workspaceRevision: "forged" },
      memory: {
        notes: "",
        completed: [],
        remaining: [],
        steps: [],
        evidence: [],
      },
      observation: {
        id: "screen",
        sessionId: session.id,
        workspace: f.workspace,
        title: "Test",
        mode: "input",
        ready: true,
        draft: "",
        surface: "response",
        rows: [],
        controls: [],
        width: 80,
        height: 24,
      },
    });
    expect(received.facts.progress).toBe(facts.progress);
    expect(received.facts.workspaceRevision).toBe(facts.workspaceRevision);
  } finally {
    await f.close();
  }
});
