import type { DriveAuto, DriveAway, DriveFix, DriveFixProposal, DriveProposal, DriveSignal } from "@demesne/protocol";
import type { ProviderToolDefinition } from "@demesne/providers";
import type { AgentTool } from "./tools.ts";
/// What every chat in a project is told about Drive, so "does Drive have
/// ideas?" or "what did Drive change?" gets a real answer instead of "who is
/// Drive?". Facts only, kept short: the ideas, what it's working on, what
/// waits for review and what failed lately. Drive's own coder sessions (in
/// its worktrees) don't get it.

const IDEAS = 5, RECENT = 4;
const clip = (text: string, length: number) => (text.length > length ? `${text.slice(0, length - 1)}…` : text).replace(/\s+/g, " ").trim();

export function driveContext(state: { auto: DriveAuto | null; ideas: DriveProposal[]; fixes: DriveFix[]; away: DriveAway | null }): string {
  const { auto, ideas, fixes, away } = state;
  const lines = [
    "Drive: Demesne's background agent for this project. It works on one idea at a time in its own git worktree and branch, never in this checkout, and never pushes; the person reviews each branch before it is applied.",
    auto
      ? auto.on
        ? `It starts its top idea on its own after ${auto.quietMinutes} quiet minutes (${auto.usedToday} of ${auto.perDay} runs used today).`
        : "Starting on its own is turned off in this project."
      : null,
    `When the person asks you to run one of Drive's ideas, call ${DRIVE_RUN_TOOL} with its number; it starts in Drive's worktree and you don't wait for it. The person reviews finished branches on Drive's line under the conversation, and starts a mission with /drive <goal>. You can't stop or apply Drive's work yourself: say to use Drive's line.`,
  ];
  if (ideas.length) lines.push(`Drive's ideas now: ${ideas.slice(0, IDEAS).map((idea, index) => `${index + 1}. ${clip(idea.title, 120)} (${clip(idea.why, 160)})`).join(" ")}`);
  else lines.push("Drive has no ideas listed right now.");
  const working = fixes.filter((fix) => fix.status === "starting" || fix.status === "running");
  if (working.length) lines.push(`Working now: ${working.map((fix) => `${clip(fix.title, 120)} on branch ${fix.branch}${away?.auto && away.status === "running" ? " (started on its own)" : ""}`).join("; ")}.`);
  const ready = fixes.filter((fix) => fix.status === "ready").slice(-RECENT);
  if (ready.length) lines.push(`Waiting for review: ${ready.map((fix) => `${clip(fix.title, 120)}${fix.diff ? ` (+${fix.diff.additions} -${fix.diff.deletions} in ${fix.diff.files} files)` : ""}${fix.summary ? `: ${clip(fix.summary, 200)}` : ""}`).join("; ")}.`);
  const failed = fixes.filter((fix) => fix.status === "failed").slice(-RECENT);
  if (failed.length) lines.push(`Recently failed: ${failed.map((fix) => `${clip(fix.title, 120)}: ${clip(fix.error ?? fix.summary ?? "no reason recorded", 200)}`).join("; ")}.`);
  return lines.filter((line): line is string => Boolean(line)).join(" ");
}

export const DRIVE_RUN_TOOL = "drive_run";

const driveRunDefinition: ProviderToolDefinition = {
  name: DRIVE_RUN_TOOL,
  description: "Start one of Drive's listed ideas, the same as the person pressing Run on it: Drive works on it in its own worktree and branch, and the person reviews the result on Drive's line. Use only when the person asks for the idea to be run.",
  inputSchema: {
    type: "object",
    properties: {
      idea: { type: "string", description: "The idea's number in Drive's list (1 is the top one), or words from its title" },
    },
    required: ["idea"],
    additionalProperties: false,
  },
};

export interface DriveRunHost {
  /// Drive's ideas for the project, in the order chats are shown them, or null
  /// when the project can't run Drive work (a Drive worktree, an untrusted folder).
  ideas(workspaceRoot: string): { proposals: DriveProposal[]; signals: DriveSignal[] } | null;
  run(workspaceRoot: string, proposal: DriveFixProposal, signals: DriveSignal[]): Promise<DriveFix>;
}

/// Runs one of Drive's ideas from a chat. No approval: like Run, it only
/// works in a worktree, and nothing reaches your checkout until you apply it.
export function driveRunTool(host: DriveRunHost): AgentTool {
  return {
    definition: driveRunDefinition,
    permission: () => null,
    async execute(input, context) {
      const raw = (input as { idea?: unknown } | null)?.idea;
      const asked = typeof raw === "string" || typeof raw === "number" ? String(raw).trim() : "";
      if (!asked) throw new Error("drive_run needs the idea's number or title");
      const ideas = host.ideas(context.workspaceRoot);
      if (!ideas) throw new Error("Drive can't run ideas from this chat");
      if (!ideas.proposals.length) throw new Error("Drive has no ideas listed right now");
      const number = /^#?\d+$/.test(asked) ? Number(asked.replace("#", "")) : 0;
      const words = asked.toLowerCase();
      const item = number ? ideas.proposals[number - 1] : ideas.proposals.find((proposal) => proposal.title.toLowerCase().includes(words) || words.includes(proposal.title.toLowerCase()));
      if (!item) throw new Error(`No idea matches "${asked}". Drive's ideas: ${ideas.proposals.slice(0, IDEAS).map((idea, index) => `${index + 1}. ${idea.title}`).join(" ")}`);
      const fix = await host.run(context.workspaceRoot, { id: item.id, kind: item.kind, title: item.title, why: item.why, minutes: item.minutes, confidence: item.confidence },
        ideas.signals.filter((signal) => item.evidence.includes(signal.id)).slice(0, 5));
      return `Drive started "${fix.title}" on branch ${fix.branch}. It shows on Drive's line while it works, and waits there for review when done.`;
    },
  };
}
