import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  parseDriveRequest,
  type DriveAction,
  type DriveMemoryEntry,
  type DriveObservation,
} from "@demesne/protocol";
import { AgentDrive } from "../cli/src/agent-drive.ts";
import { ProjectMemory } from "../cli/src/drive-memory.ts";
import { inspectDrive } from "../cli/src/drive-inspection.ts";
import { parseDriveStart } from "../cli/src/drive-tasks.ts";
import { loadWorkflows, runWorkflowCheck, workflowMission, workflowRun } from "../cli/src/workflows.ts";
import { DirectDriveControl } from "./drive-direct.ts";
import type { GraphicsHost } from "./host.ts";

export interface GraphicsUICommand {
  id: string;
  observationId: string;
  action: DriveAction;
}
/// Where a workspace's mission journal lives (one per daemon and project).
export function driveJournalPath(dataDirectory: string, server: string, workspace: string) {
  const key = createHash("sha256").update(`${server}\n${workspace}`).digest("hex");
  return join(dataDirectory, "drive", `${key}.json`);
}

/** Drive works the daemon directly by default (recorded session state in,
 * API submissions out); the UI only shows it. DEMESNE_DRIVE_CONTROL=ui keeps
 * the original route: clipped, visible DOM observations and authored UI
 * controls. Either way it cannot approve permissions. */
export class GraphicsDrive {
  readonly agent: AgentDrive;
  /// This workspace's project memory, and its entries for the UI.
  readonly memory: ProjectMemory;
  memoryEntries: DriveMemoryEntry[] = [];
  /// Direct control (the default) can move a mission into its own worktree
  /// session, and needs no screen, so it can carry on with the window closed.
  direct = false;
  readonly journalPath: string;
  private observed: DriveObservation | null = null;
  private pending = new Map<
    string,
    {
      resolve: (value: string) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
      sessionId: string;
      compose?: string;
    }
  >();
  constructor(
    private host: GraphicsHost,
    private send: (command: GraphicsUICommand) => void,
  ) {
    const key = createHash("sha256").update(`${host.api.server}\n${host.workspace}`).digest("hex");
    this.memory = new ProjectMemory(join(host.settings.dataDirectory, "drive", `${key}.memory.jsonl`));
    this.journalPath = driveJournalPath(host.settings.dataDirectory, host.api.server, host.workspace);
    this.refreshMemory(false);
    const direct =
      process.env.DEMESNE_DRIVE_CONTROL === "ui"
        ? null
        : new DirectDriveControl(host);
    this.direct = Boolean(direct);
    const ui = direct
      ? {
          observe: () => direct.observe(),
          perform: (
            action: DriveAction,
            observation: DriveObservation,
            signal: AbortSignal,
          ) => direct.perform(action, observation, signal),
        }
      : {
          observe: () => this.observe(),
          perform: (
            action: DriveAction,
            observation: DriveObservation,
            signal: AbortSignal,
          ) => this.perform(action, observation, signal),
        };
    this.agent = new AgentDrive({
      ...ui,
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
        direct
          ? direct.inspect(action, observation, signal, activity)
          : inspectDrive(ui, action, observation, signal, activity),
    });
  }
  report(raw: unknown) {
    const observation = parseDriveRequest({
      mission: "UI observation",
      homeSessionId: this.host.current?.session.id ?? "none",
      memory: {
        notes: "",
        completed: [],
        remaining: [],
        evidence: [],
        steps: [],
      },
      observation: raw,
    }).observation;
    if (observation.sessionId !== this.host.current?.session.id)
      throw new Error("Stale UI observation");
    this.observed = observation;
  }
  observe() {
    if (
      !this.observed ||
      this.observed.sessionId !== this.host.current?.session.id
    )
      throw new Error("Wait for the session to render before starting Drive.");
    const mode =
      this.host.current?.approvals.size || this.host.current?.questions.size
        ? "approval"
        : this.host.setup
          ? "dialog"
          : this.host.active
            ? "streaming"
            : this.observed.mode;
    return {
      ...this.observed,
      mode,
      ready:
        mode === "input" &&
        !this.host.busy &&
        this.host.connection === "online" &&
        this.observed.ready,
    } as DriveObservation;
  }
  authorize(method: string, args: Record<string, unknown>) {
    if (typeof args.driveCommand !== "string") return false;
    const pending = this.pending.get(args.driveCommand);
    if (
      !pending ||
      pending.sessionId !== this.host.current?.session.id ||
      pending.compose === undefined ||
      !["draft", "submit", "plan-submit"].includes(method) ||
      args.text !== pending.compose
    )
      throw new Error("Stale Drive input");
    if (
      this.host.active ||
      this.host.current?.approvals.size ||
      this.host.current?.questions.size ||
      this.host.setup
    )
      throw new Error("UI changed before Drive input");
    // The capability authorizes only the exact text selected for this action.
    if (method !== "draft") pending.compose = undefined;
    return true;
  }
  private perform(
    action: DriveAction,
    observation: DriveObservation,
    signal: AbortSignal,
  ): Promise<string> {
    signal.throwIfAborted();
    const current = this.observe();
    if (
      current.id !== observation.id ||
      current.sessionId !== observation.sessionId ||
      current.mode !== "input" ||
      !current.ready
    )
      return Promise.resolve("UI changed; observe again.");
    if (action.kind === "compose" && current.draft)
      return Promise.resolve("Input changed; draft left untouched.");
    if (
      action.kind === "compose" &&
      action.text.startsWith("/") &&
      !/^\/plan\s+\S/.test(action.text)
    )
      throw new Error("Drive may compose requests or /plan prompts only.");
    if (
      action.kind === "click" &&
      !current.controls.some((item) => item.id === action.target)
    )
      return Promise.resolve("Control moved; observe again.");
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.pending.delete(id);
        signal.removeEventListener("abort", abort);
      };
      const abort = () => {
        cleanup();
        reject(new Error("Drive action cancelled"));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("The interface did not acknowledge the Drive action"));
      }, 10000);
      this.pending.set(id, {
        resolve: (value) => {
          cleanup();
          resolve(value);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
        timer,
        sessionId: current.sessionId,
        ...(action.kind === "compose" ? { compose: action.text } : {}),
      });
      signal.addEventListener("abort", abort, { once: true });
      this.send({ id, observationId: current.id, action });
    });
  }
  result(args: Record<string, unknown>) {
    const pending = this.pending.get(String(args.id));
    if (!pending) return;
    try {
      if (args.observation) this.report(args.observation);
      if (typeof args.error === "string") pending.reject(new Error(args.error));
      else
        pending.resolve(
          typeof args.result === "string"
            ? args.result.slice(0, 2000)
            : "UI action finished.",
        );
    } catch (error) {
      pending.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }
  async handle(method: string, args: Record<string, unknown>) {
    if (method === "observe") {
      this.report(args.observation);
      return;
    }
    if (method === "ui-result") {
      this.result(args);
      return;
    }
    if (method === "manual") {
      this.agent.intervene();
      return;
    }
    if (method === "drive") {
      if (typeof args.text !== "string") throw new Error("Enter a mission");
      if (args.observation) this.report(args.observation);
      if (typeof args.workflow === "string") {
        await this.startWorkflow(args.workflow, args.text);
        return;
      }
      const value = args.text.trim();
      if (["pause", "resume", "stop"].includes(value)) {
        this.agent.control(value as "pause" | "resume" | "stop");
        if (value === "stop") await this.host.interrupt();
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
    if (method === "drive-control") {
      if (!["pause", "resume", "stop"].includes(String(args.control)))
        throw new Error("Unknown Drive control");
      if (args.observation) this.report(args.observation);
      this.agent.control(args.control as "pause" | "resume" | "stop");
      if (args.control === "stop") await this.host.interrupt();
      return;
    }
    throw new Error(`Unsupported action: ${method}`);
  }
  /// A new mission works in its own git worktree and session, so your
  /// checkout stays as it is until you apply the result. `--here` (or no git
  /// repository with commits) keeps it in the current session.
  private async startMission(value: string, workflow?: import("@demesne/protocol").DriveWorkflowRun) {
    const here = /(^|\s)--here(?=\s|$)/.test(value);
    const text = value.replace(/(^|\s)--here(?=\s|$)/g, " ").trim();
    if (!here && this.direct && this.host.breakage.supported) {
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
    for (const pending of [...this.pending.values()])
      pending.reject(new Error("UI closed"));
  }
}
