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
import { isRecord } from "@demesne/protocol";
import type { ImageOutput } from "./artifacts.ts";

/// The look's pictures are named this way, so a model that sees gets them (engine.ts).
export const FOUNDRY_LOOK_PREFIX = "foundry-look-";

/// design: the page's design numbers (apps/desktop/electron/foundry-look-measure.ts DesignMeasure), for eval-foundry-quality.
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
  let queue: Promise<unknown> = Promise.resolve();
  return (page, signal) => {
    const run = queue.then(() => lookOnce(command, page, signal));
    queue = run.catch(() => {});
    return run;
  };
}

async function lookOnce(command: string[], page: { kind: string; source: string; title: string }, signal: AbortSignal): Promise<LookResult | null> {
  if (signal.aborted) return null;
  const dir = await mkdtemp(join(tmpdir(), "demesne-look-job-"));
  const job = join(dir, "job.json");
  try {
    await writeFile(job, JSON.stringify(page));
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = Bun.spawn([...command, `--foundry-look=${job}`], { stdout: "pipe", stderr: "ignore", stdin: "ignore", env });
    const kill = () => child.kill();
    signal.addEventListener("abort", kill, { once: true });
    const timer = setTimeout(kill, 30_000);
    try {
      const output = await new Response(child.stdout).text();
      await child.exited;
      const line = output.trim().split("\n").at(-1);
      if (!line) return null;
      const parsed: unknown = JSON.parse(line);
      if (!isRecord(parsed) || !Array.isArray(parsed.pages)) return null;
      const pages = parsed.pages.filter((p): p is LookedPage => isRecord(p) && typeof p.width === "number" && typeof p.png === "string" && Array.isArray(p.issues));
      return pages.length ? { pages, errors: Array.isArray(parsed.errors) ? parsed.errors.filter((e): e is string => typeof e === "string") : [] } : null;
    } catch { return null; }
    finally { clearTimeout(timer); signal.removeEventListener("abort", kill); }
  } finally { await rm(dir, { recursive: true, force: true }).catch(() => {}); }
}

/// A turn looks at one artifact at most this many times: the first save and
/// one fix. Later saves in the turn go without, so a page can't loop.
export const LOOKS_PER_TURN = 2;

/// What the save's result says about the look, and the pictures it carries.
export function lookReport(look: LookResult, last: boolean): { look: Record<string, unknown>; images: ImageOutput[] } {
  const name = (width: number) => width >= 800 ? `desktop ${width}px` : `phone ${width}px`;
  const problems = Object.fromEntries(look.pages.map((page) => [name(page.width), page.issues.length ? page.issues : "no layout problems found"]));
  const found = look.pages.some((page) => page.issues.length) || look.errors.length > 0;
  const next = last
    ? "This was the last look this turn: answer now."
    : found
      ? "Fix these, and anything off in the pictures, with one foundry_edit, then answer. Ignore a problem only if it is intended."
      : "Glance at the pictures; if nothing is off, answer without saving again.";
  return {
    look: { ...problems, ...(look.errors.length ? { console_errors: look.errors } : {}), pictures: look.pages.map((page) => name(page.width)), next },
    images: look.pages.map((page) => ({ data: Buffer.from(page.png, "base64"), mimeType: "image/png", filename: `${FOUNDRY_LOOK_PREFIX}${page.width}.png` })),
  };
}
