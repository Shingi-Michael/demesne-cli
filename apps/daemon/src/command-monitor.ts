import { randomUUID } from "node:crypto";
import { relative } from "node:path";
import type {
  CommandRecord,
  CommandsResponse,
  WorkspaceFingerprint,
} from "@demesne/protocol";
import type { DemesneStore } from "@demesne/storage";
import type { AgentTool } from "./tools.ts";
import { workspaceFingerprint } from "./workspace-review.ts";
const LIMIT = 64 * 1024;
export interface CommandObserver {
  started(pid: number, stop: () => void): void;
  output(stream: "stdout" | "stderr", text: string): void;
  finished(exitCode: number | null, timedOut?: boolean, error?: string): void;
}
export interface CommandReporter {
  begin(argv: string[], cwd: string, background: boolean): CommandObserver;
}
interface Live {
  record: CommandRecord;
  stop?: () => void;
  done: Promise<void>;
  resolve: () => void;
}
const isCheck = (argv: string[]) =>
  /(^|\s)(test|typecheck|check|lint|build)(?=[:_-]|\s|$)/i.test(
    argv.join(" "),
  ) || /(^|[\s/])(pytest|xcodebuild|tsc|eslint)(\s|$)/i.test(argv.join(" "));
/** Only process handles created by this daemon can be stopped. Persisted PIDs
 * are never used as authority after restart. Records are scoped to a session. */
export class CommandMonitor {
  private live = new Map<string, Live>();
  private revision = 0;
  private fingerprints = new Map<
    string,
    { at: number; value: WorkspaceFingerprint }
  >();
  private reruns = new Set<Promise<unknown>>();
  private rerunControllers = new Set<AbortController>();
  constructor(private store: DemesneStore) {}
  fingerprint(root: string, fresh = false) {
    const cached = this.fingerprints.get(root);
    if (!fresh && cached && Date.now() - cached.at < 1500) return cached.value;
    const value = {
      ...workspaceFingerprint(root),
      checkedAt: new Date().toISOString(),
    };
    this.fingerprints.set(root, { at: Date.now(), value });
    return value;
  }
  invalidate(root: string) {
    this.fingerprints.delete(root);
  }
  reporter(
    sessionId: string,
    turnId: string,
    toolCallId: string | null,
    root: string,
    rerunOf: string | null = null,
  ): CommandReporter {
    return {
      begin: (argv, cwd, background) => {
        const check = !background && isCheck(argv),
          record: CommandRecord = {
            id: randomUUID(),
            sessionId,
            turnId,
            toolCallId,
            rerunOf,
            argv: [...argv],
            cwd,
            background,
            check,
            pid: null,
            status: "running",
            startedAt: new Date().toISOString(),
            completedAt: null,
            lastOutputAt: null,
            exitCode: null,
            timedOut: false,
            stdout: "",
            stderr: "",
            truncated: false,
            fingerprint: check ? this.fingerprint(root, true) : null,
            freshness: "unknown",
          };
        const completion = Promise.withResolvers<void>();
        const live: Live = {
          record,
          done: completion.promise,
          resolve: completion.resolve,
        };
        this.live.set(record.id, live);
        this.revision++;
        try {
          this.store.saveCommand(record);
        } catch (error) {
          this.live.delete(record.id);
          live.resolve();
          throw error;
        }
        return {
          started: (pid, stop) => {
            record.pid = pid;
            live.stop = stop;
            this.revision++;
          },
          output: (stream, text) => {
            if (!text) return;
            record[stream] += text;
            if (record[stream].length > LIMIT) {
              record[stream] = record[stream].slice(-LIMIT);
              record.truncated = true;
            }
            record.lastOutputAt = new Date().toISOString();
            this.revision++;
          },
          finished: (exitCode, timedOut = false, error) => {
            if (record.completedAt) return;
            record.exitCode = exitCode;
            record.timedOut = timedOut;
            record.completedAt = new Date().toISOString();
            record.status =
              record.status === "stopping" || error === "Turn cancelled"
                ? "stopped"
                : error || timedOut || exitCode !== 0
                  ? "failed"
                  : "completed";
            if (error)
              record.stderr = (record.stderr + "\n" + error).slice(-LIMIT);
            this.revision++;
            this.fingerprints.delete(root);
            try {
              this.store.saveCommand(record);
            } finally {
              live.stop = undefined;
              this.live.delete(record.id);
              live.resolve();
            }
          },
        };
      },
    };
  }
  list(sessionId: string, root: string, output = "all"): CommandsResponse {
    const fingerprint = this.fingerprint(root);
    const saved = this.store.commandsForSession(sessionId);
    const records = new Map(saved.map((record) => [record.id, record]));
    for (const { record } of this.live.values())
      if (record.sessionId === sessionId) records.set(record.id, record);
    const commands = [...records.values()]
      .sort(
        (a, b) =>
          Number(this.live.has(b.id)) - Number(this.live.has(a.id)) ||
          b.startedAt.localeCompare(a.startedAt),
      )
      .slice(0, 200)
      .map((original) => {
        const record = { ...original };
        if (
          !this.live.has(record.id) &&
          ["running", "stopping"].includes(record.status)
        ) {
          record.status = "interrupted";
          record.freshnessReason =
            "Daemon restarted before this command settled";
        }
        if (record.check) {
          record.freshness =
            record.fingerprint?.value && fingerprint.value
              ? record.fingerprint.value === fingerprint.value
                ? "current"
                : "outdated"
              : "unknown";
          record.freshnessReason =
            record.freshness === "outdated"
              ? "Source files changed since this command started"
              : record.freshness === "unknown"
                ? (fingerprint.reason ??
                  record.fingerprint?.reason ??
                  "No source fingerprint was recorded")
                : undefined;
        }
        if (output !== "all" && record.id !== output) {
          record.stdout = record.stderr = "";
          record.outputLoaded = false;
        } else record.outputLoaded = true;
        return record;
      });
    // Freshness is returned independently of the process-output revision.
    const revision = this.revision;
    return {
      revision,
      commands,
      capturedAt: new Date().toISOString(),
      fingerprint,
    };
  }
  stop(sessionId: string, id: string) {
    const live = this.live.get(id);
    if (!live || live.record.sessionId !== sessionId || !live.stop)
      return false;
    live.record.status = "stopping";
    this.revision++;
    live.stop();
    return true;
  }
  runningInWorkspace(root: string) {
    return [...this.live.values()].some(
      (live) =>
        this.store.getSession(live.record.sessionId)?.workspace?.root === root,
    );
  }
  async rerun(sessionId: string, id: string, tool: AgentTool): Promise<string> {
    const session = this.store.getSession(sessionId),
      source = this.store
        .commandsForSession(sessionId)
        .find((record) => record.id === id);
    if (!session?.workspace || !source?.check || source.background)
      throw new Error(
        "Only a recorded verification command from this session can be rerun",
      );
    if (
      session.turns.some(
        (turn) => turn.status === "queued" || turn.status === "running",
      ) ||
      this.runningInWorkspace(session.workspace.root)
    )
      throw new Error("Wait for running work before rerunning checks");
    const controller = new AbortController();
    this.rerunControllers.add(controller);
    let commandId = "";
    const reporter = this.reporter(
      sessionId,
      source.turnId,
      null,
      session.workspace.root,
      id,
    );
    const run = tool.execute(
      {
        argv: source.argv,
        cwd: relative(session.workspace.root, source.cwd) || ".",
        timeoutMs: 120000,
      },
      {
        workspaceRoot: session.workspace.root,
        sessionId,
        signal: controller.signal,
        commands: {
          begin: (...args) => {
            const observer = reporter.begin(...args);
            commandId = [...this.live.values()].findLast(
              (live) => live.record.rerunOf === id,
            )!.record.id;
            return observer;
          },
        },
      },
    );
    // run_command registers the handle synchronously before starting to read output.
    const task = run
      .catch(() => {})
      .finally(() => {
        this.rerunControllers.delete(controller);
        this.reruns.delete(task);
      });
    this.reruns.add(task);
    if (!commandId) {
      await run;
      throw new Error("Command did not start");
    }
    return commandId;
  }
  async close() {
    for (const controller of this.rerunControllers) controller.abort();
    const running = [...this.live.values()];
    for (const live of running) {
      live.record.status = "stopping";
      live.stop?.();
    }
    await Promise.allSettled([
      ...this.reruns,
      ...running.map((live) => live.done),
    ]);
  }
}
