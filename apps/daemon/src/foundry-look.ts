/// Foundry looks at its own page. After a page is saved, the desktop app is
/// started off screen (`--foundry-look`, apps/desktop/electron/foundry-look.ts)
/// to render it at 1280 and 390px wide, measure layout faults and take a
/// picture of each. The save's result carries both, so the model sees what
/// it made and fixes what is off once, in the same turn. Without the desktop
/// app (the CLI alone, or Linux with no display) pages save as before.
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isRecord, type TryStep } from "@demesne/protocol";
import type { ImageOutput } from "./artifacts.ts";

/// The look's pictures are named this way, so a model that sees gets them (engine.ts).
export const FOUNDRY_LOOK_PREFIX = "foundry-look-";

/// design: the page's design numbers (apps/desktop/electron/foundry-look-measure.ts DesignMeasure), shown to the model with targets and scored by eval-foundry-quality.
export interface LookedPage { width: number; height: number; issues: string[]; png: string; design?: Record<string, number> }
export interface LookResult { pages: LookedPage[]; errors: string[] }
export type FoundryLook = (page: { kind: string; source: string; title: string }, signal: AbortSignal) => Promise<LookResult | null>;

/// The app binary that can render a page: DEMESNE_ELECTRON (with
/// DEMESNE_ELECTRON_APP for an unpacked app folder), else the app this daemon
/// was bundled in (its backend folder sits inside the app).
export function lookCommand(env = process.env, execPath = process.execPath, platform = process.platform): string[] | null {
  if (env.DEMESNE_FOUNDRY_LOOK === "0") return null;
  if (env.DEMESNE_ELECTRON) return [env.DEMESNE_ELECTRON, ...(env.DEMESNE_ELECTRON_APP ? [env.DEMESNE_ELECTRON_APP] : [])];
  const backend = dirname(execPath);
  const app = platform === "darwin" ? join(backend, "..", "..", "MacOS", "Demesne")
    : platform === "win32" ? join(backend, "..", "..", "Demesne.exe") : join(backend, "..", "..", "demesne");
  return existsSync(app) ? [app] : null;
}

/// Renders pages one at a time with the given command; null when it can't.
export function electronLook(command: string[]): FoundryLook {
  return (page, signal) => queued(async () => {
    const parsed = await runJob(command, page, signal);
    if (!isRecord(parsed) || !Array.isArray(parsed.pages)) return null;
    const pages = parsed.pages.filter((p): p is LookedPage => isRecord(p) && typeof p.width === "number" && typeof p.png === "string" && Array.isArray(p.issues));
    return pages.length ? { pages, errors: strings(parsed.errors) } : null;
  });
}

/// Foundry tries its page (apps/desktop/electron/foundry-try.ts): the same
/// off-screen app runs the steps and reads the page's tree.
export interface TriedStep { step: string; ok: boolean; said: string }
export interface TryResult { width: number; steps: TriedStep[]; tree: string[]; errors: string[]; pictures: { after: string; png: string }[] }
export type FoundryTry = (page: { kind: string; source: string; title: string }, plan: { width: number; steps: TryStep[] }, signal: AbortSignal) => Promise<TryResult | null>;

export function electronTry(command: string[]): FoundryTry {
  return (page, plan, signal) => queued(async () => {
    const parsed = await runJob(command, { ...page, try: plan }, signal);
    if (!isRecord(parsed) || !Array.isArray(parsed.steps)) return null;
    return {
      width: typeof parsed.width === "number" ? parsed.width : plan.width,
      steps: parsed.steps.filter((s): s is TriedStep => isRecord(s) && typeof s.step === "string" && typeof s.ok === "boolean" && typeof s.said === "string"),
      tree: strings(parsed.tree), errors: strings(parsed.errors),
      pictures: Array.isArray(parsed.pictures) ? parsed.pictures.filter((p): p is { after: string; png: string } => isRecord(p) && typeof p.after === "string" && typeof p.png === "string").slice(0, 2) : [],
    };
  });
}

const strings = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
/// One off-screen app at a time, for looks and tries alike.
let queue: Promise<unknown> = Promise.resolve();
export function queued<T>(work: () => Promise<T>): Promise<T> {
  const run = queue.then(work);
  queue = run.catch(() => {});
  return run;
}

/// Starts the app on one job file and reads the JSON line it prints; null when it can't.
export async function runJob(command: string[], job: unknown, signal: AbortSignal): Promise<unknown> {
  if (signal.aborted) return null;
  const dir = await mkdtemp(join(tmpdir(), "demesne-look-job-"));
  const path = join(dir, "job.json");
  try {
    await writeFile(path, JSON.stringify(job));
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = Bun.spawn([...command, `--foundry-look=${path}`], { stdout: "pipe", stderr: "ignore", stdin: "ignore", env });
    const kill = () => child.kill();
    signal.addEventListener("abort", kill, { once: true });
    const timer = setTimeout(kill, 30_000);
    try {
      const output = await new Response(child.stdout).text();
      await child.exited;
      const line = output.trim().split("\n").at(-1);
      return line ? JSON.parse(line) : null;
    } catch { return null; }
    finally { clearTimeout(timer); signal.removeEventListener("abort", kill); }
  } finally { await rm(dir, { recursive: true, force: true }).catch(() => {}); }
}

/// What a try says to the model, and its pictures (named so a model that sees gets them).
export function tryReport(result: TryResult): { report: Record<string, unknown>; images: ImageOutput[] } {
  const bad = result.steps.filter((step) => !step.ok);
  const next = bad.length || result.errors.length
    ? "Fix what went wrong (unless a step was meant to change nothing) with one foundry_edit, then try the same steps again once."
    : "Every step did something. Answer, or try the controls not clicked yet.";
  return {
    report: { width: `${result.width}px`, steps: result.steps.map((step) => `${step.ok ? "✓" : "✕"} ${step.step}: ${step.said}`),
      tree_after: result.tree, ...(result.errors.length ? { console_errors: result.errors } : {}), pictures: result.pictures.map((p) => `after ${p.after}`), next },
    images: result.pictures.map((p, index) => ({ data: Buffer.from(p.png, "base64"), mimeType: "image/png", filename: `${FOUNDRY_LOOK_PREFIX}try-${index + 1}.png` })),
  };
}

/// Step 3 of the Foundry plan: the design numbers the quality eval scores
/// (scripts/foundry-quality.ts), shown to the model with their targets and
/// the design guide rule each one checks (design-guide.ts DESIGN_RULES), so
/// taste is measured while the page is made and not only afterwards.
export const DESIGN_TARGETS: readonly { key: string; rule: number; ok: (value: number) => boolean; say: (value: number) => string }[] = [
  { key: "sizes", rule: 3, ok: (n) => n >= 3 && n <= 6, say: (n) => `${n} text sizes; aim for 3 to 6 from the kit's scale` },
  { key: "lead", rule: 2, ok: (n) => n >= 2.8, say: (n) => `the biggest text is ${n}x the body; one thing should lead at 2.8x or more` },
  { key: "rhythm", rule: 4, ok: (n) => n >= 0.9, say: (n) => `${Math.round(n * 100)}% of spacing comes from six steps; aim for 90% from the kit's scale` },
  { key: "aligned", rule: 6, ok: (n) => n >= 0.85, say: (n) => `${Math.round(n * 100)}% of text blocks share a left edge; aim for 85% on one grid` },
  { key: "colours", rule: 5, ok: (n) => n >= 3 && n <= 8, say: (n) => `${n} colours; aim for a palette of 3 to 8` },
  { key: "surface", rule: 8, ok: (n) => n >= 0.35, say: (n) => `${Math.round(n * 100)}% of the first screen is more than blank paper; aim for a third or more` },
];

/// The desktop picture's numbers as lines the model can act on: what is off
/// target, by rule. Empty when none were measured.
export function designReport(design: Record<string, number> | undefined): { off: string[]; ok: string[] } {
  const off: string[] = [], ok: string[] = [];
  if (!design) return { off, ok };
  for (const target of DESIGN_TARGETS) {
    const value = design[target.key];
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    (target.ok(value) ? ok : off).push(`rule ${target.rule}: ${target.say(value)}`);
  }
  return { off, ok };
}

/// A turn looks at one artifact at most this many times: the first save and
/// one fix. Later saves in the turn go without, so a page can't loop.
export const LOOKS_PER_TURN = 2;

/// What the save's result says about the look, and the pictures it carries.
/// designed: a page the model designed itself (html), the only kind its design numbers judge; Demesne draws the ready kinds.
export function lookReport(look: LookResult, last: boolean, designed = true): { look: Record<string, unknown>; images: ImageOutput[]; found: boolean } {
  const name = (width: number) => width >= 800 ? `desktop ${width}px` : `phone ${width}px`;
  const problems = Object.fromEntries(look.pages.map((page) => [name(page.width), page.issues.length ? page.issues : "no layout problems found"]));
  const design = designReport(designed ? look.pages.find((page) => page.width >= 800)?.design : undefined);
  const found = look.pages.some((page) => page.issues.length) || look.errors.length > 0 || design.off.length > 0;
  const next = last
    ? "This was the last look this turn: answer now."
    : found
      ? "Critique before you fix: check the pictures against the Design guide rule by rule, and the numbers off target. Pass that critique (the rules it breaks, by number, and what you will change) to one foundry_edit that fixes them, then answer. Leave a number off target only on purpose, and say why in the critique. The critique is for you: never repeat it to the person."
      : "Glance at the pictures; if nothing is off, answer without saving again.";
  // A page with controls gets its main path tried once (foundry_try) before the answer.
  // A mockup is for using: every control gets one click (foundry_try), so a dead one is found before the person is.
  const tryIt = last ? "" : " If the page has controls, click each of them once with foundry_try (up to 12 steps) before you answer; one that changes nothing is dead: make it do something.";
  return {
    look: { ...problems, ...(look.errors.length ? { console_errors: look.errors } : {}),
      ...(design.off.length || design.ok.length ? { design: { ...(design.off.length ? { off_target: design.off } : {}), ...(design.ok.length ? { on_target: design.ok } : {}) } } : {}),
      pictures: look.pages.map((page) => name(page.width)), next: next + tryIt },
    /// Whether the next save of this page in the turn owes a critique.
    found: found && !last,
    images: look.pages.map((page) => ({ data: Buffer.from(page.png, "base64"), mimeType: "image/png", filename: `${FOUNDRY_LOOK_PREFIX}${page.width}.png` })),
  };
}
