import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixture, eventually } from "../../graphics/test/fixture.ts";
import type {
  DriveRequest,
  DriveReview,
  DriveProgress,
} from "@demesne/protocol";
const request = (
  sessionId: string,
  workspace: string,
  turnId: string,
): DriveRequest => ({
  mission: "Inspect the worker's current direction",
  homeSessionId: sessionId,
  checkIn: {
    turnId,
    cursor: 0,
    freshEvidence: true,
    reason: "check_completed",
  },
  memory: { notes: "", remaining: [], completed: [], evidence: [], steps: [] },
  observation: {
    id: "old-screen",
    sessionId,
    workspace,
    title: "Test",
    mode: "streaming",
    ready: false,
    draft: "",
    surface: "response",
    rows: ["OUTDATED_UI_CLAIM"],
    width: 80,
    height: 24,
    controls: [],
  },
});

test("a queued review receives fresh recorded activity after the slot handoff, not old UI rows", async () => {
  const release = Promise.withResolvers<void>(),
    finish = Promise.withResolvers<void>(),
    reviewEntered = Promise.withResolvers<void>(),
    finishReview = Promise.withResolvers<void>();
  let round = 0,
    seen: any;
  const f = await fixture({
    providerId: "test",
    modelId: "test",
    async listModels() {
      return [];
    },
    async *stream(messages, tools, signal) {
      if (tools.some((tool) => tool.name === "drive_ui")) {
        seen = JSON.parse(messages[1]!.content!);
        reviewEntered.resolve();
        await finishReview.promise;
        yield {
          type: "tool_call_delta",
          index: 0,
          idDelta: "review",
          nameDelta: "drive_ui",
          argumentsDelta: JSON.stringify({
            action: { kind: "keep_working" },
            note: "Current action is aligned",
            notes: "",
            remaining: [],
            completed: [],
            evidence: [],
          }),
        };
        yield { type: "finish", reason: "tool_calls" };
        return;
      }
      if (++round === 1) {
        await release.promise;
        yield {
          type: "tool_call_delta",
          index: 0,
          idDelta: "read",
          nameDelta: "read_file",
          argumentsDelta: JSON.stringify({ path: "fresh.txt" }),
        };
        yield { type: "finish", reason: "tool_calls" };
      } else {
        await finish.promise;
        yield { type: "text_delta", delta: "Done" };
        yield { type: "finish", reason: "stop" };
      }
    },
  });
  try {
    writeFileSync(join(f.workspace, "fresh.txt"), "CURRENT_SOURCE_EVIDENCE");
    const session = (
      await f.client.createSession({ workspacePath: f.workspace, trustWorkspace: true })
    ).session;
    const turn = await f.client.submitTurn(session.id, {
      content: "Read the file",
      permissionMode: "deny",
    });
    await eventually(() => round === 1);
    const progress: DriveProgress[] = [];
    const reviewing = f.client.decideDrive(
      request(session.id, f.workspace, turn.turn.id),
      undefined,
      (event) => progress.push(event),
    );
    void reviewing.catch(() => {});
    await eventually(
      async () => (await f.client.status()).queuedInferences === 1,
    );
    release.resolve();
    await reviewEntered.promise;
    expect(seen.observation.rows).toEqual([]);
    expect(seen.review.rows.join("\n")).toContain("fresh.txt");
    expect(seen.review.rows.join("\n")).not.toContain("OUTDATED_UI_CLAIM");
    expect(seen.review.turnId).toBe(turn.turn.id);
    expect(round).toBe(1);
    await eventually(() =>
      progress.some((event) => event.type === "review.ready"),
    );
    finishReview.resolve();
    const result = await reviewing;
    expect(result.review?.revision).toBe(seen.review.revision);
    finish.resolve();
    await eventually(
      async () =>
        (await f.client.getSessionState(session.id)).session.turns.at(-1)
          ?.status === "completed",
    );
  } finally {
    release.resolve();
    finish.resolve();
    finishReview.resolve();
    await f.close();
  }
}, 10000);

test("a worker that finishes while its check-in waits is skipped without a model review", async () => {
  const release = Promise.withResolvers<void>();
  let started = false,
    reviews = 0;
  const f = await fixture({
    providerId: "test",
    modelId: "test",
    async listModels() {
      return [];
    },
    async *stream(_messages, tools) {
      if (tools.some((tool) => tool.name === "drive_ui")) {
        reviews++;
        throw new Error("Review must not run");
      }
      started = true;
      await release.promise;
      yield { type: "text_delta", delta: "Done" };
      yield { type: "finish", reason: "stop" };
    },
  });
  try {
    const session = (
      await f.client.createSession({ workspacePath: f.workspace, trustWorkspace: true })
    ).session;
    const turn = await f.client.submitTurn(session.id, {
      content: "Finish",
      permissionMode: "deny",
    });
    await eventually(() => started);
    const reviewing = f.client.decideDrive(
      request(session.id, f.workspace, turn.turn.id),
    );
    await eventually(
      async () => (await f.client.status()).queuedInferences === 1,
    );
    release.resolve();
    const result = await reviewing;
    expect(result.skipped).toContain("settled");
    expect(reviews).toBe(0);
    expect(result.review?.status).toBe("completed");
  } finally {
    release.resolve();
    await f.close();
  }
});

test.each([false, true])(
  "guarded correction checks current source and turn ownership before cancellation (stale=%s)",
  async (stale) => {
    let issued = false;
    const f = await fixture({
      providerId: "test",
      modelId: "test",
      async listModels() {
        return [];
      },
      async *stream(messages, tools) {
        if (tools.some((tool) => tool.name === "drive_ui")) {
          const data = JSON.parse(messages[1]!.content!);
          yield {
            type: "tool_call_delta",
            index: 0,
            idDelta: "review",
            nameDelta: "drive_ui",
            argumentsDelta: JSON.stringify({
              action: {
                kind: "redirect",
                text: "Stop the held test and inspect the result",
              },
              note: "Specific checkpoint correction",
              notes: "",
              completed: [],
              remaining: [],
              evidence: [
                { observationId: data.review.id, quote: data.review.rows[0] },
              ],
            }),
          };
          yield { type: "finish", reason: "tool_calls" };
          return;
        }
        if (!issued) {
          issued = true;
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
    try {
      writeFileSync(
        join(f.workspace, "package.json"),
        JSON.stringify({ scripts: { check: "bun check.ts" } }),
      );
      writeFileSync(
        join(f.workspace, "check.ts"),
        "import{existsSync}from'node:fs';while(!existsSync('release'))await Bun.sleep(20);\n",
      );
      const session = (
        await f.client.createSession({ workspacePath: f.workspace, trustWorkspace: true })
      ).session;
      const turn = await f.client.submitTurn(session.id, {
        content: "Run check",
        permissionMode: "ask",
      });
      await eventually(
        async () =>
          (await f.client.getSessionState(session.id)).pendingPermissions
            .length === 1,
      );
      // A client cannot bypass the operator's approval using a forged streaming observation.
      const skipped = await f.client.decideDrive(
        request(session.id, f.workspace, turn.turn.id),
      );
      expect(skipped.skipped).toContain("human input");
      const permission = (await f.client.getSessionState(session.id))
        .pendingPermissions[0]!;
      await f.client.resolvePermission(permission.id, "allow_once");
      await eventually(async () =>
        (await f.client.commands(session.id)).commands.some(
          (command) => command.status === "running",
        ),
      );
      const result = await f.client.decideDrive(
        request(session.id, f.workspace, turn.turn.id),
      );
      expect(result.review?.rows.length).toBeGreaterThan(0);
      const review = result.review!;
      const other = (
        await f.client.createSession({ workspacePath: f.workspace, trustWorkspace: true })
      ).session;
      await expect(
        f.client.cancelDriveReview({ ...review, sessionId: other.id }),
      ).rejects.toThrow("not found");
      if (stale)
        writeFileSync(
          join(f.workspace, "README.md"),
          "Changed after the review",
        );
      expect(await f.client.cancelDriveReview(review)).toBe(!stale);
      const status = (
        await f.client.getSessionState(session.id)
      ).session.turns.at(-1)?.status;
      expect(status).toBe(stale ? "running" : "cancelled");
      if (stale) await f.client.cancelTurn(turn.turn.id);
    } finally {
      await f.close();
    }
  },
  10000,
);

test.each(["keep_working", "redirect", "stale_redirect"] as const)(
  "controller checkpoint performs one fresh %s review through the real API",
  async (verdict) => {
    const { AgentDrive } = await import("../../cli/src/agent-drive.ts");
    let issued = false,
      drive: InstanceType<typeof AgentDrive> | undefined,
      eventsTask: Promise<void> | undefined;
    const sent: string[] = [];
    let screen: DriveRequest["observation"] = {
      id: "screen",
      sessionId: "",
      workspace: "",
      title: "Test",
      mode: "input",
      ready: true,
      draft: "",
      surface: "response",
      rows: [],
      controls: [],
      width: 80,
      height: 24,
    };
    const f = await fixture({
      providerId: "test",
      modelId: "test",
      async listModels() {
        return [];
      },
      async *stream(messages, tools) {
        if (tools.some((tool) => tool.name === "drive_ui")) {
          const input = JSON.parse(messages[1]!.content!);
          const review = input.review;
          yield {
            type: "tool_call_delta",
            index: 0,
            idDelta: "drive",
            nameDelta: "drive_ui",
            argumentsDelta: JSON.stringify({
              action: input.checkIn
                ? verdict === "keep_working"
                  ? { kind: "keep_working" }
                  : {
                      kind: "redirect",
                      text: "Stop the held command and inspect the completed check",
                    }
                : { kind: "compose", text: "Run checks and hold" },
              note: "Review checkpoint",
              notes: "",
              remaining: [],
              completed: [],
              evidence:
                input.checkIn && verdict !== "keep_working"
                  ? [{ observationId: review.id, quote: review.rows[0] }]
                  : [],
            }),
          };
          yield { type: "finish", reason: "tool_calls" };
          return;
        }
        if (!issued) {
          issued = true;
          for (const [index, args] of [
            { argv: [process.execPath, "run", "check"] },
            { argv: [process.execPath, "-e", "setInterval(()=>{},1000)"] },
          ].entries())
            yield {
              type: "tool_call_delta",
              index,
              idDelta: `cmd-${index}`,
              nameDelta: "run_command",
              argumentsDelta: JSON.stringify(args),
            };
          yield { type: "finish", reason: "tool_calls" };
        } else {
          yield { type: "text_delta", delta: "Done" };
          yield { type: "finish", reason: "stop" };
        }
      },
    });
    try {
      writeFileSync(
        join(f.workspace, "package.json"),
        JSON.stringify({
          scripts: { check: "bun -e 'console.log(\"CHECK_OK\")'" },
        }),
      );
      const session = (
        await f.client.createSession({ workspacePath: f.workspace, trustWorkspace: true })
      ).session;
      screen = { ...screen, sessionId: session.id, workspace: f.workspace };
      drive = new AgentDrive({
        checkpointReviews: true,
        delayMs: 60000,
        observe: () => screen,
        changed() {},
        decide: async (r, s, p) => {
          const result = await f.client.decideDrive(r, s, p);
          if (r.checkIn && verdict === "stale_redirect")
            writeFileSync(
              join(f.workspace, "README.md"),
              "A source change after the model review",
            );
          return result;
        },
        cancelWorker: async (_turn, signal, review) => {
          expect(review).toBeDefined();
          return f.client.cancelDriveReview(review!, signal);
        },
        perform: async (action) => {
          if (action.kind === "compose") {
            sent.push(action.text);
            if (sent.length === 1) {
              const submitted = await f.client.submitTurn(session.id, {
                content: action.text,
                permissionMode: "ask",
              });
              drive!.workerStarted(session.id, action.text, submitted.turn.id);
              screen = { ...screen, mode: "streaming", ready: false };
              eventsTask = (async () => {
                for await (const event of f.client.streamEvents(
                  session.id,
                  submitted.eventId,
                  AbortSignal.timeout(7000),
                )) {
                  drive!.workerEvent(event);
                  if (event.type === "permission.requested")
                    await f.client.resolvePermission(
                      String(event.payload.permissionId),
                      "allow_once",
                    );
                  if (
                    /^turn\.(completed|cancelled|failed|interrupted)$/.test(
                      event.type,
                    )
                  ) {
                    screen = { ...screen, mode: "input", ready: true };
                    break;
                  }
                }
              })();
            }
            return `Sent through the visible composer: ${action.text}`;
          }
          return "Viewed";
        },
      });
      drive.start("Inspect check results");
      await drive.step();
      await eventually(async () => {
        const c = (await f.client.commands(session.id)).commands;
        return (
          c.some((c) => c.check && c.status === "completed") &&
          c.some((c) => !c.check && c.status === "running")
        );
      });
      await eventually(() =>
        Boolean(drive!.state?.protection?.worker?.checkpoint),
      );
      await drive.step();
      expect(drive.state?.steps.at(-1)?.result).toContain("Queue");
      expect(drive.state?.protection?.used.checkIns).toBe(1);
      const turn = (
        await f.client.getSessionState(session.id)
      ).session.turns.at(-1)!;
      if (verdict === "redirect") {
        await eventsTask;
        expect(turn.status).toBe("cancelled");
        await drive.step();
        expect(sent).toHaveLength(2);
        expect(sent[1]).toContain("held command");
      } else {
        expect(turn.status).toBe("running");
        expect(sent).toHaveLength(1);
        expect(drive.state?.protection?.used.redirects).toBe(0);
        await f.client.cancelTurn(turn.id);
        await eventsTask;
      }
    } finally {
      drive?.dispose();
      await f.close();
      await eventsTask?.catch(() => {});
    }
  },
  10000,
);
