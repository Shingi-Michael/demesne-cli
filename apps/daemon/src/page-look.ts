/// See the app (pass 174): the model opens the person's own app, a local dev
/// server or an HTML file in the project, in the same hidden window Foundry
/// tries its pages in (apps/desktop/electron/foundry-look.ts), takes a
/// picture, can click and type through a short path, and reads what broke in
/// the console. Only this computer: localhost addresses and project files.
import { existsSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { isRecord, parseSteps, TRY_MAX_STEPS, type TryStep } from "@demesne/protocol";
import type { ImageOutput } from "./artifacts.ts";
import { queued, runJob, type TriedStep } from "./foundry-look.ts";
import { resolveWorkspacePath, toolError, type AgentTool } from "./tools.ts";

export const LOOK_AT_PAGE = "look_at_page";
/// Its pictures are named this way, so a model that sees gets them (engine.ts).
export const PAGE_LOOK_PREFIX = "page-look-";
export const PAGE_LOOKS_PER_TURN = 6;

export interface PageLookResult { width: number; title: string; url: string; steps: TriedStep[]; tree: string[]; errors: string[]; pictures: { after: string; png: string }[] }
export type PageLook = (url: string, plan: { width: number; steps: TryStep[] }, signal: AbortSignal) => Promise<PageLookResult | null>;

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "0.0.0.0"]);

/// The address to open: a localhost URL (any port), or an HTML file in the project.
export function pageAddress(input: string, workspaceRoot: string): string {
  const value = input.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    let url: URL;
    try { url = new URL(value); } catch { throw toolError("INVALID_URL", "that is not an address", "pass http://localhost:<port>/<path> or a project .html file"); }
    if (url.protocol !== "http:" && url.protocol !== "https:") throw toolError("NOT_LOCAL", `${url.protocol} addresses can't be opened`, "pass http://localhost:<port> or a project .html file");
    if (!LOCAL_HOSTS.has(url.hostname) && !url.hostname.endsWith(".localhost")) throw toolError("NOT_LOCAL", "look_at_page opens only this computer's own apps", "use a localhost address, or web_fetch for sites on the internet");
    if (url.hostname === "0.0.0.0") url.hostname = "127.0.0.1";
    return url.href;
  }
  // localhost:5173 without a scheme.
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(value)) return pageAddress(`http://${value}`, workspaceRoot);
  if (!/\.html?$/i.test(value.split(/[?#]/)[0]!)) throw toolError("INVALID_URL", "pass a localhost address or an .html file", "start the app's dev server in the background first, then look at http://localhost:<port>");
  let path: string;
  try { path = resolveWorkspacePath(workspaceRoot, value.split(/[?#]/)[0]!, true); } catch (error) { throw toolError("INVALID_PATH", error instanceof Error ? error.message : String(error), "pass a path inside the project"); }
  if (!existsSync(path) || !statSync(path).isFile()) throw toolError("NOT_FOUND", `${value} does not exist`, "check the path with list_files");
  return pathToFileURL(path).href;
}

export function electronPageLook(command: string[]): PageLook {
  return (url, plan, signal) => queued(async () => {
    const parsed = await runJob(command, { kind: "html", source: "", title: "", url, try: plan }, signal);
    if (!isRecord(parsed) || !Array.isArray(parsed.steps)) return null;
    const strings = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
    return {
      width: typeof parsed.width === "number" ? parsed.width : plan.width,
      title: typeof parsed.title === "string" ? parsed.title : "", url: typeof parsed.url === "string" ? parsed.url : url,
      steps: parsed.steps.filter((s): s is TriedStep => isRecord(s) && typeof s.step === "string" && typeof s.ok === "boolean" && typeof s.said === "string"),
      tree: strings(parsed.tree), errors: strings(parsed.errors),
      pictures: Array.isArray(parsed.pictures) ? parsed.pictures.filter((p): p is { after: string; png: string } => isRecord(p) && typeof p.after === "string" && typeof p.png === "string").slice(0, 3) : [],
    };
  });
}

/// What the model reads, and the pictures it sees.
export function pageReport(result: PageLookResult): { report: Record<string, unknown>; images: ImageOutput[] } {
  const bad = result.steps.filter((step) => !step.ok);
  return {
    report: {
      url: result.url, title: result.title, width: `${result.width}px`,
      ...(result.steps.length ? { steps: result.steps.map((step) => `${step.ok ? "✓" : "✕"} ${step.step}: ${step.said}`) } : {}),
      tree: result.tree.slice(0, 80), console_errors: result.errors,
      pictures: result.pictures.map((p) => p.after === "opening" ? "on opening" : `after ${p.after}`),
      next: bad.length || result.errors.length
        ? "Fix what went wrong in the code, then look again to check."
        : "Check the pictures against what was asked; say what you saw in your answer.",
    },
    images: result.pictures.map((p, index) => ({ data: Buffer.from(p.png, "base64"), mimeType: "image/png", filename: `${PAGE_LOOK_PREFIX}${index + 1}.png` })),
  };
}

export function lookAtPageTool(look: PageLook, looks = new Map<string, number>()): AgentTool {
  return {
    definition: {
      name: LOOK_AT_PAGE,
      description: "Open the app you are working on in a hidden window and see it: a picture, its headings and controls, and console errors. "
        + "url is a local dev server (http://localhost:5173/settings; start it with run_command background and wait_for first) or an .html file in the project. "
        + "Optional steps use it the way a person would, with real clicks and typing, and say after each what visibly changed: "
        + "{click: name}, {type: text, into?: name}, {key: Enter|Tab|Escape|Backspace|Space|ArrowUp|ArrowDown|ArrowLeft|ArrowRight}, {scroll: px}, {hover: name}, {wait: ms}. "
        + "A name is a control's visible text, label, aria-label or placeholder (a CSS selector also works). "
        + "Use it after changing a web UI, to check it looks and works right before you answer. "
        + "This is one look that starts fresh each time; to stay in a page across calls (sign in, go several pages deep, act on what you find), use browser.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", minLength: 1, maxLength: 2000 },
          width: { type: "string", enum: ["desktop", "phone"], description: "desktop is 1280px (default), phone is 390px." },
          steps: { type: "array", maxItems: TRY_MAX_STEPS, items: { type: "object" } },
        },
        required: ["url"],
        additionalProperties: false,
      },
    },
    // Only this computer's own app, in a window nobody sees: like reading a file.
    permission: () => null,
    async execute() { throw toolError("UNAVAILABLE", "look_at_page needs the desktop app", "check the page with run_command instead"); },
    async executeWithArtifacts(input, context) {
      const args = isRecord(input) ? input : {};
      if (typeof args.url !== "string" || !args.url.trim()) throw toolError("MISSING_URL", "url is required", "pass http://localhost:<port> or a project .html file");
      const url = pageAddress(args.url, context.workspaceRoot);
      let steps: TryStep[] = [];
      if (Array.isArray(args.steps) && args.steps.length) {
        try { steps = parseSteps(args.steps); } catch (error) { throw toolError("INVALID_STEPS", error instanceof Error ? error.message : String(error), "each step is one of click, type, key, scroll, hover or wait"); }
      }
      const key = context.turnId ?? "", seen = looks.get(key) ?? 0;
      if (seen >= PAGE_LOOKS_PER_TURN) throw toolError("LIMIT", `the app was looked at ${PAGE_LOOKS_PER_TURN} times this turn`, "answer with what you found");
      looks.set(key, seen + 1);
      if (looks.size > 200) looks.delete(looks.keys().next().value!);
      const result = await look(url, { width: args.width === "phone" ? 390 : 1280, steps }, context.signal);
      if (!result) throw toolError("UNAVAILABLE", "the page could not be opened just now", "try once more, or check it with run_command");
      if (!result.pictures.length && result.errors.length) throw toolError("UNREACHABLE", result.errors.join("; ").slice(0, 400), "is the dev server running? start it in the background and wait_for its ready line");
      const report = pageReport(result);
      return { text: JSON.stringify(report.report), images: report.images };
    },
  };
}
