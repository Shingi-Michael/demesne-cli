import { createHash } from "node:crypto";
import { join } from "node:path";
import type { DriveMemoryEntry } from "@demesne/protocol";
import { AgentDrive } from "@demesne/drive/agent-drive.ts";
import { ProjectMemory } from "@demesne/drive/drive-memory.ts";
import { parseDriveStart } from "@demesne/drive/drive-tasks.ts";
import { loadWorkflows, runWorkflowCheck, workflowMission, workflowRun } from "@demesne/drive/workflows.ts";
import { DirectDriveControl } from "./drive-direct.ts";
import type { WorkspaceHost } from "./host.ts";

/// Where a workspace's mission journal lives (one per daemon and project).
export function driveJournalPath(dataDirectory: string, server: string, workspace: string) {
  const key = createHash("sha256").update(`${server}\n${workspace}`).digest("hex");
  return join(dataDirectory, "drive", `${key}.json`);
}

/** Drive works the daemon directly (recorded session state in, API
 * submissions out); the UI only shows it. It cannot approve permissions. */
export class WorkspaceDrive {
  readonly agent: AgentDrive;
  /// This workspace's project memory, and its entries for the UI.
  readonly memory: ProjectMemory;
  memoryEntries: DriveMemoryEntry[] = [];
  readonly journalPath: string;
  constructor(
    private host: WorkspaceHost,
  ) {
    const key = createHash("sha256").update(`${host.api.server}\n${host.workspace}`).digest("hex");
    this.memory = new ProjectMemory(join(host.settings.dataDirectory, "drive", `${key}.memory.jsonl`));
    this.journalPath = driveJournalPath(host.settings.dataDirectory, host.api.server, host.workspace);
    this.refreshMemory(false);
    const direct = new DirectDriveControl(host);
    this.agent = new AgentDrive({
      observe: () => direct.observe(),
      perform: (action, observation, signal) => direct.perform(action, observation, signal),
      checkpointReviews:true,
      facts: (sessionId, turnId, paths, signal) =>
        host.api.driveFacts(
          sessionId,
          turnId === "start" ? undefined : turnId,
          paths,
          signal,
        ),
      limits: host.settings.loaded.config.drive,
      path: this.journalPath,
      memory: {
        forPlanner: () => this.memory.forPlanner(),
        add: (entry) => {
          const saved = this.memory.add(entry);
          this.refreshMemory();
          return saved;
        },
      },
      decide: (request, signal, progress) =>
        host.api.decideDrive(request, signal, progress),
      changed: (state) => {
        host.driveState = state;
        // A mission restored in another chat (the app restarted) is followed
        // there again, not in the chat you're in.
        if (state && ["running", "waiting"].includes(state.status) && state.homeSessionId !== host.current?.session.id && host.driveSession?.session.id !== state.homeSessionId)
          void host.followDriveSession(state.homeSessionId).catch(() => {});
        host.missionChanged(state);
        host.publish();
      },
      cancelWorker: async (turnId, signal, review) => {
        if(review)return host.api.cancelDriveReview(review,signal);
        signal.throwIfAborted();
        return (await host.api.cancelTurn(turnId)).turn.status === "cancelled";
      },
      runCheck: (command, cwd, signal) => runWorkflowCheck(command, cwd, signal),
      inspect: (action, observation, signal, activity) =>
        direct.inspect(action, observation, signal, activity),
    });
  }
  async handle(method: string, args: Record<string, unknown>) {
    if (method === "manual") {
      this.agent.intervene();
      return;
    }
    if (method === "drive") {
      if (typeof args.text !== "string") throw new Error("Enter a mission");
      if (typeof args.workflow === "string") {
        await this.startWorkflow(args.workflow, args.text);
        return;
      }
      const value = args.text.trim();
      if (["pause", "resume", "stop"].includes(value)) {
        await this.control(value as "pause" | "resume" | "stop");
      } else if (/^remember\s/.test(value)) {
        // /drive remember <text>: a standing preference or decision.
        this.memory.add({ kind: "preference", text: value.replace(/^remember\s+/, ""), source: "you" });
        this.refreshMemory();
      } else if (/^forget\s/.test(value)) {
        this.memory.forget(value.replace(/^forget\s+/, ""));
        this.refreshMemory();
      } else if (value.startsWith("reopen ")) {
        const [, id, ...reason] = value.split(/\s+/);
        this.agent.reopen(id ?? "", reason.join(" "));
      } else if (value !== "status") await this.startMission(value);
      return;
    }
    // A note from your chat. A blocked mission takes it as the answer and
    // goes again.
    if (method === "drive-tell") {
      this.agent.tell(String(args.text ?? ""));
      if (this.agent.state?.status === "blocked") this.agent.control("resume");
      return;
    }
    if (method === "drive-control") {
      if (!["pause", "resume", "stop"].includes(String(args.control)))
        throw new Error("Unknown Drive control");
      await this.control(args.control as "pause" | "resume" | "stop");
      return;
    }
    throw new Error(`Unsupported action: ${method}`);
  }
  private async control(control: "pause" | "resume" | "stop") {
    const missionSession = this.agent.state?.homeSessionId;
    if (control !== "stop" || !missionSession || ["completed", "stopped"].includes(this.agent.state!.status)) {
      this.agent.control(control);
      return;
    }
    // Halt planning first; settle the worktree only after its coder is cancelled.
    this.agent.control("pause");
    // Reading another chat must never redirect Stop to that chat's coder.
    if (missionSession === this.host.current?.session.id) await this.host.interrupt();
    else {
      const session = await this.host.api.getSessionState(missionSession);
      const turn = session.session.turns.findLast(turn => turn.status === "running" || turn.status === "queued");
      if (turn) await this.host.api.cancelTurn(turn.id);
    }
    this.agent.control("stop");
  }
  /// A new mission works in its own git worktree and session, so your
  /// checkout stays as it is until you apply the result. `--here` (or no git
  /// repository with commits) keeps it in the current session.
  private async startMission(value: string, workflow?: import("@demesne/protocol").DriveWorkflowRun) {
    const here = /(^|\s)--here(?=\s|$)/.test(value);
    const text = value.replace(/(^|\s)--here(?=\s|$)/g, " ").trim();
    if (!here && this.host.breakage.supported) {
      const mission = workflow ? text : parseDriveStart(text).mission;
      if (!mission.trim() || mission.length > 8000) throw new Error("Use /drive <mission> (up to 8,000 characters).");
      try { await this.host.openMissionWorktree(mission); }
      catch (error) {
        if (!/needs a git repository|no commits yet/.test(error instanceof Error ? error.message : "")) throw error;
      }
    }
    this.agent.start(text, workflow);
  }
  /// `/<workflow> [goal]`: the workflow file's steps as one bounded mission.
  /// Read from the project you're in, before any worktree is made.
  async startWorkflow(name: string, argument: string) {
    const workflow = loadWorkflows(this.host.workspace).find((item) => item.name.toLowerCase() === name.toLowerCase());
    if (!workflow) throw new Error(`No workflow named ${name}. Add .demesne/workflows/${name}.md.`);
    const here = /(^|\s)--here(?=\s|$)/.test(argument);
    const goal = argument.replace(/(^|\s)--here(?=\s|$)/g, " ").trim();
    if (!goal && workflow.steps.some((step) => step.prompt.includes("$ARGUMENTS")))
      throw new Error(`Say what it's for: /${workflow.name} <goal>.`);
    const run = workflowRun(workflow, goal);
    await this.startMission(`${here ? "--here " : ""}${workflowMission(workflow, run, goal)}`, run);
  }
  /// Adds to project memory and shows it.
  addMemory(entry: Pick<DriveMemoryEntry, "kind" | "text" | "source">) {
    const saved = this.memory.add(entry);
    this.refreshMemory();
    return saved;
  }
  private refreshMemory(publish = true) {
    try {
      this.memoryEntries = this.memory.list();
    } catch {
      this.memoryEntries = [];
    }
    if (publish) this.host.publish();
  }
  dispose() {
    this.agent.dispose();
  }
}
