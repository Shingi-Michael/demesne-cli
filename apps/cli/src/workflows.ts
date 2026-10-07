import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SlashCommand } from "@demesne/brand";
import type { DriveWorkflowRun, DriveWorkflowStep } from "@demesne/protocol";

/// Markdown workflow files: a fixed sequence of steps that runs as one Drive
/// mission.
///
/// Files live in `~/.demesne/workflows/` (user) and
/// `<workspace>/.demesne/workflows/` (project); the project wins on a name
/// collision. Each file is named `<workflow>.md` and may open with a `---`
/// frontmatter block containing `description:`. Every `## ` heading starts a
/// step; the text under it is what the coder is asked to do. A step's
/// `check: <command>` line is run by Drive itself in the mission's workspace
/// before the step counts as done; `expect: fail` after the command means the
/// step needs the command to fail (proving a bug exists). `$ARGUMENTS` is
/// replaced with what follows the command.

export const WORKFLOW_STEP_LIMIT = 12;

export interface Workflow {
  name: string;
  description: string;
  steps: DriveWorkflowStep[];
  source: string;
}

export function loadWorkflows(workspaceRoot: string | undefined, home = homedir()): Workflow[] {
  const directories = [
    join(home, ".demesne", "workflows"),
    ...(workspaceRoot ? [join(workspaceRoot, ".demesne", "workflows")] : []),
  ];
  const byName = new Map<string, Workflow>();
  for (const directory of directories) {
    if (!existsSync(directory)) continue;
    let entries: string[];
    try {
      entries = readdirSync(directory).sort();
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue;
      const name = entry.slice(0, -3);
      if (!/^[a-z0-9][a-z0-9-]*$/i.test(name)) continue;
      let text: string;
      try {
        text = readFileSync(join(directory, entry), "utf8");
      } catch {
        continue;
      }
      const parsed = parseWorkflow(text, name, join(directory, entry));
      if (parsed) byName.set(name.toLowerCase(), parsed);
    }
  }
  return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
}

/// Null when the file has no usable step.
export function parseWorkflow(text: string, name: string, source = ""): Workflow | null {
  let description = "";
  let body = text;
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (frontmatter) {
    body = text.slice(frontmatter[0].length);
    for (const line of frontmatter[1]!.split(/\r?\n/)) {
      const entry = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line.trim());
      if (entry && entry[1]!.toLowerCase() === "description") description = entry[2]!.trim();
    }
  }
  const steps: DriveWorkflowStep[] = [];
  let current: { title: string; lines: string[]; check?: DriveWorkflowStep["check"] } | null = null;
  const finish = () => {
    if (!current) return;
    const prompt = current.lines.join("\n").trim();
    if (prompt) steps.push({ title: current.title, prompt: prompt.slice(0, 2000), ...(current.check ? { check: current.check } : {}) });
    current = null;
  };
  for (const line of body.split(/\r?\n/)) {
    const heading = /^##\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      finish();
      current = { title: heading[1]!.slice(0, 80), lines: [] };
      continue;
    }
    if (!current) continue;
    const check = /^check:\s*(.+?)\s*$/i.exec(line.trim());
    if (check) {
      const expect = /\s+expect:\s*(pass|fail)$/i.exec(check[1]!);
      const command = (expect ? check[1]!.slice(0, expect.index) : check[1]!).replace(/^`(.*)`$/, "$1").trim();
      if (command) current.check = { command: command.slice(0, 500), expect: expect?.[1]!.toLowerCase() === "fail" ? "fail" : "pass" };
      continue;
    }
    current.lines.push(line);
  }
  finish();
  if (!steps.length) return null;
  return { name, description, steps: steps.slice(0, WORKFLOW_STEP_LIMIT), source };
}

export function workflowCommand(workflow: Workflow): SlashCommand {
  const argued = workflow.steps.some((step) => step.prompt.includes("$ARGUMENTS"));
  return {
    id: `workflow:${workflow.name}`,
    name: `/${workflow.name}`,
    aliases: [],
    argument: argued ? "required" : "optional",
    argumentLabel: argued ? "goal" : "notes",
    description: workflow.description || workflow.steps.map((step) => step.title).join(" › "),
    detail: `workflow · ${workflow.steps.length} step${workflow.steps.length === 1 ? "" : "s"}`,
    preview: `${workflow.steps.map((step) => step.title).join(" › ")} · runs in its own worktree`,
    section: "control",
  };
}

/// The run Drive keeps in its journal, with `$ARGUMENTS` filled in. Checks
/// are copied here so editing the file mid-mission can't change them.
export function workflowRun(workflow: Workflow, argument: string): DriveWorkflowRun {
  const args = argument.trim();
  return {
    name: workflow.name,
    current: 0,
    steps: workflow.steps.map((step) => ({
      ...structuredClone(step),
      prompt: step.prompt.includes("$ARGUMENTS") ? step.prompt.replaceAll("$ARGUMENTS", args) : step.prompt,
    })),
  };
}

export function workflowCheckText(check: NonNullable<DriveWorkflowStep["check"]>) {
  return `\`${check.command}\` must ${check.expect === "fail" ? "fail" : "pass"}`;
}

/// The mission text the planner reads. Its first line is the mission's title.
export function workflowMission(workflow: Workflow, run: DriveWorkflowRun, argument: string): string {
  const goal = argument.trim().replace(/\s+/g, " ") || workflow.description || workflow.name;
  const steps = run.steps.map((step, index) => `${index + 1}. ${step.title}: ${step.prompt.replace(/\s+/g, " ")}${step.check ? ` (Drive checks: ${workflowCheckText(step.check)})` : ""}`);
  return [
    `${workflow.name} · ${goal}`.slice(0, 300),
    `Run the "${workflow.name}" workflow, one step at a time and in order. The ledger's current task is the current step: work only on it. When it is done, use complete with basis verified-work. Drive then runs that step's check itself and moves on to the next step, or tells you what failed so you can send the coder back to fix it.`,
    "Steps:",
    ...steps,
  ].join("\n").slice(0, 8000);
}

export function stepTaskTitle(run: DriveWorkflowRun, index: number) {
  const step = run.steps[index]!;
  return `Step ${index + 1} of ${run.steps.length} · ${step.title}: ${step.prompt.replace(/\s+/g, " ")}`.slice(0, 1000);
}

export function stepCriteria(step: DriveWorkflowStep) {
  return [step.prompt.slice(0, 1000), ...(step.check ? [`Drive's own run of ${workflowCheckText(step.check)}`] : [])];
}

/// Whether a check run gives the step what it expects. `expect: fail` needs
/// the command itself to fail: a missing command (126/127) or a timeout
/// proves nothing.
export function checkSatisfied(check: NonNullable<DriveWorkflowStep["check"]>, exitCode: number | null) {
  if (check.expect === "pass") return exitCode === 0;
  return exitCode !== null && exitCode !== 0 && exitCode !== 126 && exitCode !== 127;
}

const CHECK_TIMEOUT_MS = 10 * 60_000;

/// Runs a check command through the shell in `cwd`. Output is the last 8 KB
/// of stdout and stderr together; a timeout or cancellation gives a null exit code.
export async function runWorkflowCheck(command: string, cwd: string, signal: AbortSignal, timeoutMs = CHECK_TIMEOUT_MS): Promise<{ exitCode: number | null; output: string }> {
  signal.throwIfAborted();
  const child = Bun.spawn(process.platform === "win32" ? ["cmd", "/d", "/s", "/c", command] : ["sh", "-c", command], {
    cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, CI: process.env.CI ?? "1" },
    // Its own process group, so stopping it also stops what the shell started.
    detached: process.platform !== "win32",
  });
  let stopped = false;
  const stop = () => {
    stopped = true;
    try { if (process.platform === "win32") child.kill(); else process.kill(-child.pid, "SIGKILL"); }
    catch { child.kill(); }
  };
  const timer = setTimeout(stop, timeoutMs);
  signal.addEventListener("abort", stop, { once: true });
  try {
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    const output = `${stdout}${stdout && stderr ? "\n" : ""}${stderr}`.slice(-8000);
    return { exitCode: stopped ? null : exitCode, output: stopped && !signal.aborted ? `${output}\n(stopped after ${Math.round(timeoutMs / 60_000)} minutes)`.trim() : output };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", stop);
  }
}
