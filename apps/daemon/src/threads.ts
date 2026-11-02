import type { DriveFix, DriveThread } from "@demesne/protocol";
import type { ProviderToolDefinition } from "@demesne/providers";
import { MAX_THREADS } from "./drive-fixes.ts";
import type { AgentTool } from "./tools.ts";

/// Threads: a chat in a project becomes an orchestrator when it splits a job
/// into threads. Each thread is a chat of its own in its own git worktree and
/// branch, claiming the files it may touch so two threads never overlap. They
/// report back to the orchestrator as they finish, and only the person merges
/// them (the thread list's Merge), never the model.

export const START_THREADS_TOOL = "start_threads";

const definition: ProviderToolDefinition = {
  name: START_THREADS_TOOL,
  description: `Split work into threads that run side by side, each a chat of its own in its own git worktree and branch. Use when the person asks for threads or parallel work, or for a change made of independent jobs that touch different files. Give each thread a short title, a brief (what to do and what done looks like) and the files or folders it may change; no two threads may claim the same file. At most ${MAX_THREADS}. You don't wait for them: each reports back to this chat when done. Only works inside a project. You can't merge them; the person merges from the thread list.`,
  inputSchema: {
    type: "object",
    properties: {
      threads: {
        type: "array", minItems: 1, maxItems: MAX_THREADS,
        items: {
          type: "object",
          properties: {
            title: { type: "string", description: "A few words, verb first, e.g. \"Trim the context card\"" },
            brief: { type: "string", description: "What the thread should do and what done looks like, in two to five sentences" },
            files: { type: "array", items: { type: "string" }, description: "Repository paths (files or folders) this thread may change" },
          },
          required: ["title", "brief", "files"],
          additionalProperties: false,
        },
      },
    },
    required: ["threads"],
    additionalProperties: false,
  },
};

export interface ThreadsHost {
  /// Why threads can't start from this chat (Home, a worktree, an untrusted folder), or null.
  refuse(workspaceRoot: string, sessionId: string): string | null;
  start(workspaceRoot: string, from: string, job: { title: string } & DriveThread): Promise<DriveFix>;
}

const norm = (path: string) => path.trim().replace(/^\.\//, "").replace(/\/+$/, "");
/// Two claims overlap when they name the same path or one holds the other.
export function overlappingClaims(jobs: { title: string; files: string[] }[]): string | null {
  for (let a = 0; a < jobs.length; a++) for (let b = a + 1; b < jobs.length; b++)
    for (const left of jobs[a]!.files.map(norm)) for (const right of jobs[b]!.files.map(norm))
      if (left && right && (left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)))
        return `"${jobs[a]!.title}" and "${jobs[b]!.title}" both claim ${left === right ? left : `${left} and ${right}`}`;
  return null;
}

export function startThreadsTool(host: ThreadsHost): AgentTool {
  return {
    definition,
    // No approval: threads only work in worktrees, and nothing reaches the
    // person's checkout until they merge.
    permission: () => null,
    async execute(input, context) {
      const raw = (input as { threads?: unknown } | null)?.threads;
      if (!Array.isArray(raw) || !raw.length) throw new Error("start_threads needs at least one thread");
      if (raw.length > MAX_THREADS) throw new Error(`At most ${MAX_THREADS} threads at once`);
      const jobs = raw.map((item, index) => {
        const value = (item ?? {}) as { title?: unknown; brief?: unknown; files?: unknown };
        const title = typeof value.title === "string" ? value.title.trim() : "";
        const brief = typeof value.brief === "string" ? value.brief.trim() : "";
        const files = Array.isArray(value.files) ? value.files.filter((file): file is string => typeof file === "string" && Boolean(file.trim())) : [];
        if (!title || !brief) throw new Error(`Thread ${index + 1} needs a title and a brief`);
        if (!files.length) throw new Error(`Thread ${index + 1} ("${title}") needs the files it may change`);
        return { title, brief, files };
      });
      const overlap = overlappingClaims(jobs);
      if (overlap) throw new Error(`Threads must not share files: ${overlap}. Give that file to one thread.`);
      if (!context.sessionId) throw new Error("Threads start from a chat");
      const refused = host.refuse(context.workspaceRoot, context.sessionId);
      if (refused) throw new Error(refused);
      const started: DriveFix[] = [];
      const failed: string[] = [];
      for (const job of jobs) {
        try { started.push(await host.start(context.workspaceRoot, context.sessionId, job)); }
        catch (error) { failed.push(`${job.title}: ${error instanceof Error ? error.message : String(error)}`); }
      }
      if (!started.length) throw new Error(`No thread started. ${failed.join(" ")}`);
      return [
        `Started ${started.length} thread${started.length === 1 ? "" : "s"}, each in its own worktree:`,
        ...started.map((fix) => `- ${fix.title} on ${fix.branch}${fix.status === "failed" ? ` (failed: ${fix.error})` : ""}`),
        ...(failed.length ? ["Couldn't start:", ...failed.map((line) => `- ${line}`)] : []),
        "They show on the thread list in this chat while they work, and each reports back here when done. Don't wait or poll for them. The person merges them; you can't.",
      ].join("\n");
    },
  };
}
