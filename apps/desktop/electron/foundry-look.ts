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
import { LOOK_MEASURE, type LookMeasure } from "./foundry-look-measure.ts";
import { FOUNDRY_CSP, FOUNDRY_KIT, foundryDocument, foundryKitFile } from "./policy.ts";

export interface LookJob { kind: string; source: string; title: string }
export interface LookPage extends LookMeasure { png: string }
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
  const done = (result: LookResult | { error: string }) => {
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
      return new Response(foundryDocument(job.kind, job.source, job.title), { headers: { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": FOUNDRY_CSP } });
    });
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
        const height = Math.min(Math.max(view.height, measured.height), view.maxHeight);
        if (height !== view.height) { win.setContentSize(view.width, height); await settle(350); }
        let image = await contents.capturePage({ x: 0, y: 0, width: view.width, height });
        if (image.getSize().width > view.scaleTo) image = image.resize({ width: view.scaleTo, quality: "good" });
        pages.push({ ...measured, png: image.toPNG().toString("base64") });
      } catch (error) {
        errors.push(`Could not render at ${view.width}px: ${error instanceof Error ? error.message : String(error)}`);
      } finally { win.destroy(); }
    }
    done({ pages, errors });
  }).catch((error) => done({ error: error instanceof Error ? error.message : String(error) }));
}
