/// Foundry's look: the app started as `Demesne --foundry-look=<job.json>`
/// renders one page off screen at a desktop and a phone width, measures it
/// (foundry-look-measure.ts), takes a picture of each, prints the result as
/// one JSON line and quits. The daemon runs it after a page is saved, so the
/// model sees what it made and can fix what is off once. Nothing shows: no
/// window, no Dock icon, its own profile, and the page under the same policy
/// as in the pane.
import { app, BrowserWindow, session as sessions } from "electron";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DESIGN_MEASURE, LOOK_MEASURE, type DesignMeasure, type LookMeasure } from "./foundry-look-measure.ts";
import { FOUNDRY_CSP, FOUNDRY_KIT, foundryDocument, foundryKitFile, usesRemember, withRemember } from "./policy.ts";
import { changed, stepName, TRY_RUNTIME, TRY_WIDTHS, type Fingerprint, type TryPlan, type TryResult, type TryStep, type TryStepResult } from "./foundry-try.ts";

/// try: run these steps on the page instead of looking at it (foundry-try.ts).
/// url: open the person's own app instead (look_at_page: a local dev server or a project file).
export interface LookJob { kind: string; source: string; title: string; try?: TryPlan; url?: string }
export interface LookPage extends LookMeasure { png: string; design?: DesignMeasure }
export interface LookResult { pages: LookPage[]; errors: string[] }

/// The job file a `--foundry-look=` argument names, or null.
export function lookJobPath(argv: string[]): string | null {
  const arg = argv.find((value) => value.startsWith("--foundry-look="));
  return arg ? arg.slice("--foundry-look=".length) || null : null;
}

/// Desktop first screen and the whole phone page, capped so a picture stays small.
const VIEWS = [{ width: 1280, height: 800, maxHeight: 1600, scaleTo: 960 }, { width: 390, height: 844, maxHeight: 2400, scaleTo: 390 }];
const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function runFoundryLook(path: string) {
  // Its own profile, so it never touches the running app's.
  const profile = mkdtempSync(join(tmpdir(), "demesne-look-"));
  app.setPath("userData", profile);
  app.commandLine.appendSwitch("force-device-scale-factor", "1");
  // Pages show their settled state: motion is off, as the brief asks under reduced motion.
  app.commandLine.appendSwitch("force-prefers-reduced-motion");
  // A background app from the start, so no Dock icon flashes while it renders.
  if (process.platform === "darwin") app.setActivationPolicy("accessory");
  app.dock?.hide();
  let finished = false;
  const done = (result: LookResult | TryResult | { error: string }) => {
    if (finished) return;
    finished = true;
    process.stdout.write(JSON.stringify(result) + "\n", () => { try { rmSync(profile, { recursive: true, force: true }); } catch {} app.exit(0); });
  };
  setTimeout(() => done({ error: "The look took too long" }), 25_000).unref();
  app.on("window-all-closed", () => {});
  void app.whenReady().then(async () => {
    const job = JSON.parse(readFileSync(path, "utf8")) as LookJob;
    const base = app.getAppPath();
    const session = sessions.fromPartition("foundry-look");
    const kitFile = (name: string) => { const file = FOUNDRY_KIT[name]!; return Buffer.concat([readFileSync(join(base, "ui", file.path)), ...(file.then ? [Buffer.from("\n"), readFileSync(join(base, "ui", file.then))] : [])]); };
    session.protocol.handle("foundry", async (request) => {
      const kit = foundryKitFile(request.url);
      if (kit) return new Response(kitFile(kit), { headers: { "Content-Type": FOUNDRY_KIT[kit]!.type, "Access-Control-Allow-Origin": "*" } });
      // A page that remembers runs on its own here: saves stay in memory, asks get a placeholder.
      const page = foundryDocument(job.kind, job.source, job.title);
      return new Response(job.kind === "html" && usesRemember(job.source) ? withRemember(page, kitFile("remember.js").toString("utf8")) : page, { headers: { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": FOUNDRY_CSP } });
    });
    if (job.url) { done(await tryPage(session, job.try ?? { width: 1280, steps: [] }, job.url)); return; }
    if (job.try) { done(await tryPage(session, job.try)); return; }
    const errors: string[] = [], pages: LookPage[] = [];
    for (const view of VIEWS) {
      const win = new BrowserWindow({ show: false, width: view.width, height: view.height, useContentSize: true, paintWhenInitiallyHidden: true,
        webPreferences: { session, offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false } });
      try {
        const contents = win.webContents;
        contents.setWindowOpenHandler(() => ({ action: "deny" }));
        contents.on("will-navigate", (event) => event.preventDefault());
        contents.on("console-message", (event) => { if (event.level === "error" && errors.length < 6) errors.push(event.message.slice(0, 200)); });
        await win.loadURL("foundry://artifact/look");
        await Promise.race([contents.executeJavaScript("document.fonts.ready.then(() => true)"), settle(3000)]);
        await settle(400);
        const measured = await contents.executeJavaScript(LOOK_MEASURE) as LookMeasure;
        const design = await contents.executeJavaScript(DESIGN_MEASURE).catch(() => undefined) as DesignMeasure | undefined;
        const height = Math.min(Math.max(view.height, measured.height), view.maxHeight);
        if (height !== view.height) { win.setContentSize(view.width, height); await settle(350); }
        let image = await contents.capturePage({ x: 0, y: 0, width: view.width, height });
        if (image.getSize().width > view.scaleTo) image = image.resize({ width: view.scaleTo, quality: "good" });
        pages.push({ ...measured, ...(design ? { design } : {}), png: image.toPNG().toString("base64") });
      } catch (error) {
        errors.push(`Could not render at ${view.width}px: ${error instanceof Error ? error.message : String(error)}`);
      } finally { win.destroy(); }
    }
    done({ pages, errors });
  }).catch((error) => done({ error: error instanceof Error ? error.message : String(error) }));
}

/// Runs the steps with real input events, one at a time, and says after each
/// what a person would have seen happen. A picture after the last step, and
/// after the first step that went wrong. With a url (the person's own app) it
/// also takes one before the first step, may follow links on the same site,
/// and says the page's title.
async function tryPage(session: Electron.Session, plan: TryPlan, url?: string): Promise<TryResult> {
  const view = plan.width < 800 ? TRY_WIDTHS.phone : TRY_WIDTHS.desktop;
  const win = new BrowserWindow({ show: false, width: view.width, height: view.height, useContentSize: true, paintWhenInitiallyHidden: true,
    webPreferences: { session, offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false } });
  const errors: string[] = [], steps: TryStepResult[] = [], pictures: TryResult["pictures"] = [];
  const contents = win.webContents;
  const picture = async (after: string) => {
    let image = await contents.capturePage();
    if (image.getSize().width > view.scaleTo) image = image.resize({ width: view.scaleTo, quality: "good" });
    pictures.push({ after, png: image.toPNG().toString("base64") });
  };
  try {
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("will-navigate", (event) => { if (!url || !sameSite(url, event.url)) event.preventDefault(); });
    contents.on("console-message", (event) => { if (event.level === "error" && errors.length < 8) errors.push(event.message.slice(0, 200)); });
    await win.loadURL(url ?? "foundry://artifact/look");
    await Promise.race([contents.executeJavaScript("document.fonts.ready.then(() => true)"), settle(3000)]);
    await settle(300);
    await contents.executeJavaScript(TRY_RUNTIME);
    contents.focus();
    // The person's own app can go to another page: the runtime comes back with it.
    const loaded = async () => {
      if (contents.isLoading()) await Promise.race([new Promise<void>((resolve) => contents.once("did-stop-loading", () => resolve())), settle(5000)]);
      await contents.executeJavaScript(TRY_RUNTIME);
    };
    const print = () => contents.executeJavaScript("window.__demesneTry.fingerprint()") as Promise<Fingerprint>;
    const scrollY = () => contents.executeJavaScript("scrollY") as Promise<number>;
    const find = (target: string) => contents.executeJavaScript(`window.__demesneTry.find(${JSON.stringify(target)})`) as Promise<{ found: boolean; names?: string[]; x: number; y: number; many: number; what: string; covered: string | null; disabled: boolean }>;
    const click = async (x: number, y: number) => {
      contents.sendInputEvent({ type: "mouseMove", x, y });
      contents.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
      contents.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
    };
    // Reach a control the way a person would; null when they couldn't.
    const reach = async (target: string, then: (x: number, y: number) => Promise<void>): Promise<{ ok: boolean; said: string }> => {
      const found = await find(target);
      if (!found.found) return { ok: false, said: `nothing matches${found.names?.length ? `; the controls are ${found.names.map((n) => `“${n}”`).join(", ")}` : ""}` };
      if (found.covered) return { ok: false, said: `${found.what} is covered by ${found.covered}, so a person can't reach it` };
      if (found.disabled) return { ok: false, said: `${found.what} is disabled` };
      await then(found.x, found.y);
      return { ok: true, said: `${found.what}${found.many > 1 ? ` (first of ${found.many} matches)` : ""}` };
    };
    if (url && plan.steps.length) await picture("opening");
    let firstBad = true;
    for (const step of plan.steps) {
      if (url) await loaded();
      const before = await print(), y0 = await scrollY(), errorsBefore = errors.length, at = contents.getURL();
      let result: { ok: boolean; said: string };
      if ("click" in step) result = await reach(step.click, click);
      else if ("hover" in step) result = await reach(step.hover, async (x, y) => { contents.sendInputEvent({ type: "mouseMove", x, y }); });
      else if ("type" in step) {
        result = step.into ? await reach(step.into, click) : { ok: true, said: "" };
        if (result.ok) { await settle(80); await contents.insertText(step.type); }
      } else if ("key" in step) {
        const keyCode = step.key === "Space" ? "Space" : step.key;
        contents.sendInputEvent({ type: "keyDown", keyCode });
        if (step.key === "Enter" || step.key === "Space") contents.sendInputEvent({ type: "char", keyCode: step.key === "Enter" ? "\r" : " " });
        contents.sendInputEvent({ type: "keyUp", keyCode });
        result = { ok: true, said: "" };
      } else if ("scroll" in step) { await contents.executeJavaScript(`scrollBy(0, ${step.scroll})`); result = { ok: true, said: "" }; }
      else { await settle(step.wait); result = { ok: true, said: "" }; }
      await settle(350);
      if (url) await loaded();
      const went = url && contents.getURL() !== at ? wentTo(at, contents.getURL()) : null;
      const after = await print(), scrolled = "scroll" in step && (await scrollY()) !== y0;
      const what = result.ok ? went ?? changed(before, after, scrolled, "key" in step) : null;
      const newErrors = errors.slice(errorsBefore);
      const said = !result.ok ? result.said
        : [result.said, what ? `→ ${what}` : ("wait" in step || "hover" in step ? "" : "→ nothing visible changed"), newErrors.length ? `console error: ${newErrors[0]}` : ""].filter(Boolean).join(" ");
      const ok = result.ok && !newErrors.length && (what !== null || "wait" in step || "hover" in step || "scroll" in step);
      steps.push({ step: stepName(step as TryStep), ok, said });
      if (!ok && firstBad && plan.steps.at(-1) !== step) { firstBad = false; await picture(stepName(step as TryStep)); }
    }
    await picture(steps.length ? steps.at(-1)!.step : url ? "opening" : "loading");
    const tree = await contents.executeJavaScript("window.__demesneTry.tree()") as string[];
    return { width: view.width, steps, tree, errors, pictures, ...(url ? { title: contents.getTitle(), url: contents.getURL() } : {}) };
  } catch (error) {
    return { width: view.width, steps, tree: [], errors: [...errors, `Could not try the page: ${error instanceof Error ? error.message : String(error)}`], pictures };
  } finally { win.destroy(); }
}

/// "went to /home": where a step took the person's own app.
export function wentTo(from: string, to: string): string {
  try {
    const a = new URL(from), b = new URL(to);
    return `went to ${a.origin === b.origin ? `${b.pathname}${b.search}${b.hash}` || "/" : b.href}`;
  } catch { return `went to ${to}`; }
}

/// A link the person's own app may follow while it is tried: the same origin (or a file beside it).
export function sameSite(from: string, to: string): boolean {
  try {
    const a = new URL(from), b = new URL(to);
    return a.protocol === "file:" ? b.protocol === "file:" : a.origin === b.origin;
  } catch { return false; }
}
