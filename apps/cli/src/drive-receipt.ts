import type { DriveFix, DriveFacts, DriveState, DriveTask, DriveWorkflowStep } from "@demesne/protocol";

/// A mission receipt: what Drive set out to do and what the records show,
/// separating work backed by recorded checks from work that is only claimed.
/// Built from the task ledger and recorded facts, never from model prose
/// alone, so it can go into a PR body as evidence.

export interface DriveReceipt {
  markdown: string;
  /// One line for the review card, e.g. "2 of 2 tasks verified · 3 checks passing".
  headline: string;
  tasks: number;
  verified: number;
  passing: number;
  failing: number;
}

type Check = DriveFacts["checks"][number];
const passed = (check: Check) => check.status === "completed";
const failed = (check: Check) => check.status === "failed" || check.status === "interrupted";
const one = (text: string) => text.replace(/\s+/g, " ").trim();
const code = (text: string) => `\`${one(text).replace(/`/g, "'").slice(0, 200)}\``;

/// Whether a task's latest completion rests on recorded passing checks
/// that are current for the files it changed.
export function taskVerified(task: DriveTask) {
  const done = task.completions.at(-1);
  if (task.status !== "completed" || !done) return false;
  if (done.basis === "answer") return true;
  return done.checks.length > 0 && done.checks.every((check) => passed(check) && check.freshness === "current");
}

function checkLine(check: Check) {
  const mark = passed(check) ? "✓" : failed(check) ? "✕" : "·";
  const notes = [failed(check) ? "failed" : passed(check) ? "" : check.status, check.freshness === "current" ? "" : `${check.freshness} for the final files`].filter(Boolean);
  return `  - ${mark} ${code(check.command)}${notes.length ? ` (${notes.join(", ")})` : ""}`;
}

/// A workflow step is verified by Drive's own run of its check; a step
/// without a check counts once its task is finished.
function stepVerified(task: DriveTask, step: DriveWorkflowStep) {
  return task.status === "completed" && (!step.check || step.result?.ok === true);
}

export function missionReceipt(state: DriveState, fix?: Pick<DriveFix, "branch" | "base"> & Partial<Pick<DriveFix, "diff">> | null): DriveReceipt {
  const tasks = state.ledger?.tasks ?? [];
  const run = state.workflow;
  const stepOf = (task: DriveTask) => run?.steps.find((step) => step.taskId === task.id);
  const verifiedTask = (task: DriveTask) => { const step = stepOf(task); return step ? stepVerified(task, step) : taskVerified(task); };
  const verified = tasks.filter(verifiedTask).length;
  // The latest result of each check across every completion.
  const latest = new Map<string, Check>();
  for (const task of tasks) for (const done of task.completions) for (const check of done.checks) latest.set(check.key, check);
  const checks = [...latest.values()];
  const passing = checks.filter(passed).length, failing = checks.filter(failed).length;

  const lines = [`### Drive mission receipt`, "", `> ${one(state.mission).slice(0, 600)}`, ""];
  const facts = [`**Status:** ${state.status}${state.mode ? ` (${state.mode})` : ""}`];
  if (run) facts.push(`**Workflow:** \`${run.name}\`, ${run.steps.length} step${run.steps.length === 1 ? "" : "s"}`);
  if (fix?.branch) facts.push(`**Branch:** \`${fix.branch}\` from \`${fix.base.slice(0, 10)}\``);
  if (fix?.diff) facts.push(`**Diff:** +${fix.diff.additions} −${fix.diff.deletions} in ${fix.diff.files} file${fix.diff.files === 1 ? "" : "s"}`);
  lines.push(facts.join(" · "), "");

  if (!tasks.length) lines.push("_No tasks were recorded for this mission._", "");
  for (const task of tasks) {
    const done = task.completions.at(-1);
    const step = stepOf(task), ok = verifiedTask(task);
    const label = task.status !== "completed" ? "not finished" : step ? (step.check ? (ok ? "verified by the workflow's check" : "claimed, not verified") : "finished (this step has no check)")
      : !done ? "completed without evidence" : done.basis === "answer" ? "answered" : ok ? "verified by recorded checks" : "claimed, not verified";
    lines.push(`#### ${ok ? "✓" : task.status === "completed" ? "△" : "○"} ${one(task.title).slice(0, 200)}`, "", `_${label}_${task.reopened ? ` · reopened (${one(task.reopened.reason).slice(0, 160)})` : ""}`, "");
    const criteria = done?.criteria.length ? done.criteria : task.criteria;
    if (criteria.length) lines.push("Acceptance criteria:", ...criteria.map((item) => `- [${ok ? "x" : " "}] ${one(item).slice(0, 300)}`), "");
    if (done?.summary) lines.push(`Result: ${one(done.summary).slice(0, 600)}`, "");
    if (step?.check?.command && step.result) lines.push(`Workflow check: ${step.result.ok ? "✓" : "✕"} ${code(step.check.command)} ${step.result.exitCode === null ? "didn't finish" : `exited ${step.result.exitCode}`}${step.check.expect === "fail" ? " (this step needs it to fail)" : ""}`, "");
    if (done?.checks.length) lines.push("Checks:", ...done.checks.slice(0, 12).map(checkLine), "");
    else if (task.status === "completed" && done?.basis !== "answer") lines.push("Checks: none recorded.", "");
    if (done?.files.length) lines.push(`Files: ${done.files.slice(0, 12).map((file) => code(file.path)).join(", ")}${done.files.length > 12 ? ` and ${done.files.length - 12} more` : ""}`, "");
  }

  const used = state.protection?.used;
  if (used) {
    const tokens = used.planningTokens + used.workerTokens;
    lines.push(`<sub>${used.workerRequests} coder request${used.workerRequests === 1 ? "" : "s"} · ${used.cycles} planning cycle${used.cycles === 1 ? "" : "s"} · ${Math.round(used.activeMs / 60_000)} active min · ~${tokens.toLocaleString("en-US")} tokens (estimate, not a bill)</sub>`, "");
  }
  lines.push("<sub>✓ verified by recorded passing checks that are current for the final files · △ completed, but the records don't prove it · ○ not finished</sub>");

  const stepChecks = run?.steps.filter((step) => step.check && step.result?.ok).length ?? 0;
  const headline = run ? [`${run.name} · ${tasks.filter(verifiedTask).length} of ${run.steps.length} step${run.steps.length === 1 ? "" : "s"} passed`,
    `${stepChecks} check${stepChecks === 1 ? "" : "s"}`].join(" · ") : [tasks.length ? `${verified} of ${tasks.length} task${tasks.length === 1 ? "" : "s"} verified` : "no tasks recorded",
    checks.length ? `${passing} check${passing === 1 ? "" : "s"} passing${failing ? `, ${failing} failing` : ""}` : "no checks recorded"].join(" · ");
  return { markdown: lines.join("\n").slice(0, 16_000), headline, tasks: run ? run.steps.length : tasks.length, verified, passing, failing };
}
