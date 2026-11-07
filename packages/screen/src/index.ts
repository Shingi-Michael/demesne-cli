/// The window you're in, as a picture and its text, on Mac, Windows and
/// Linux (pass 187). One module for the app's capture keys and the model's
/// capture_window tool. Each system uses what it already has:
/// - Mac: a small Swift helper lists windows front to back and reads a
///   window's text through Accessibility; screencapture takes the picture.
/// - Windows: PowerShell lists windows in front-to-back order, PrintWindow
///   takes the picture and UI Automation reads the text. Nothing to install.
/// - Linux: Hyprland (hyprctl + grim), Sway (swaymsg + grim), X11 (xprop +
///   ImageMagick import), GNOME and KDE on Wayland only the window you're
///   in (gnome-screenshot / spectacle). No window text on Linux yet.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface ShotBounds { x: number; y: number; width: number; height: number }
export interface ShotWindow { id: string; app: string; title: string; pid?: number; bounds?: ShotBounds }
export interface Shot extends ShotWindow {
  png: Uint8Array;
  /// What the window says, read through the system's accessibility tree; "" when it couldn't be read.
  text: string;
  /// Why there's no text, in words, when there isn't any.
  textNote?: string;
}

export type Runner = (command: string, args: string[], options?: { input?: string; env?: Record<string, string | undefined>; signal?: AbortSignal; timeoutMs?: number; maxBytes?: number }) => Promise<{ code: number; stdout: Buffer; stderr: string }>;
export interface ScreenOptions {
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
  /// Where the Mac helper is compiled once and kept.
  cacheDir?: string;
  run?: Runner;
}

/// Window text sent along is capped; a long page is still mostly there.
export const TEXT_LIMIT = 60_000;
const PICTURE_LIMIT = 40 * 1024 * 1024;

export const runCommand: Runner = (command, args, options = {}) => new Promise((resolve, reject) => {
  options.signal?.throwIfAborted();
  const env = options.env ? { ...process.env, ...options.env } : process.env;
  const child = spawn(command, args, { env: env as NodeJS.ProcessEnv, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const chunks: Buffer[] = [];
  let size = 0, stderr = "", done = false;
  const limit = options.maxBytes ?? PICTURE_LIMIT;
  const finish = (error?: Error, code = 0) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    if (error) reject(error); else resolve({ code, stdout: Buffer.concat(chunks), stderr });
  };
  const abort = () => { child.kill(); finish(new Error("Stopped")); };
  const timer = setTimeout(() => { child.kill(); finish(new Error(`${command} took too long`)); }, options.timeoutMs ?? 30_000);
  options.signal?.addEventListener("abort", abort, { once: true });
  child.on("error", (error) => finish(error));
  child.stdout.on("data", (chunk: Buffer) => { size += chunk.length; if (size > limit) { child.kill(); finish(new Error(`${command} sent too much back`)); } else chunks.push(chunk); });
  child.stderr.on("data", (chunk: Buffer) => { if (stderr.length < 4000) stderr += chunk.toString("utf8"); });
  child.on("close", (code) => finish(undefined, code ?? 1));
  child.stdin.on("error", () => {});
  child.stdin.end(options.input ?? "");
});

const which = (env: Record<string, string | undefined>) => (name: string) =>
  (env.PATH ?? "").split(":").some((dir) => dir && existsSync(join(dir, name)));

// ── Mac ─────────────────────────────────────────────────────────────────

/// The Mac helper. `list` prints windows front to back; `text <pid> <title>`
/// prints that window's text; `access` says what's allowed (and asks for
/// Screen Recording once); `watch` prints "both" whenever both Command keys
/// are down together, once Accessibility is allowed.
export const MAC_HELPER = `import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

func emit(_ value: Any) {
  let data = try! JSONSerialization.data(withJSONObject: value)
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write("\\n".data(using: .utf8)!)
}
func windows() -> [[String: Any]] {
  let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
  return list.filter { ($0[kCGWindowLayer as String] as? Int) == 0 }.compactMap { w in
    guard let id = w[kCGWindowNumber as String] as? Int, let owner = w[kCGWindowOwnerName as String] as? String, let pid = w[kCGWindowOwnerPID as String] as? Int else { return nil }
    let b = w[kCGWindowBounds as String] as? [String: Any] ?? [:]
    let width = (b["Width"] as? NSNumber)?.doubleValue ?? 0, height = (b["Height"] as? NSNumber)?.doubleValue ?? 0
    if width < 40 || height < 40 { return nil }
    return ["id": String(id), "app": owner, "pid": pid, "title": w[kCGWindowName as String] as? String ?? "",
            "x": (b["X"] as? NSNumber)?.doubleValue ?? 0, "y": (b["Y"] as? NSNumber)?.doubleValue ?? 0, "width": width, "height": height]
  }
}
func text(_ pid: pid_t, _ title: String, _ ask: Bool) -> [String: Any] {
  let trusted = ask ? AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary) : AXIsProcessTrusted()
  if !trusted { return ["text": "", "note": "accessibility"] }
  let app = AXUIElementCreateApplication(pid)
  AXUIElementSetMessagingTimeout(app, 1.0)
  var value: CFTypeRef?
  var window: AXUIElement?
  if AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &value) == .success, let all = value as? [AXUIElement] {
    for w in all {
      var t: CFTypeRef?
      AXUIElementCopyAttributeValue(w, kAXTitleAttribute as CFString, &t)
      if (t as? String ?? "") == title { window = w; break }
    }
    if window == nil { window = all.first }
  }
  guard let root = window else { return ["text": "", "note": "none"] }
  var lines: [String] = []
  var seen = 0, size = 0
  let started = Date()
  func walk(_ e: AXUIElement, _ depth: Int) {
    if depth > 80 || seen > 8000 || size > ${TEXT_LIMIT} || Date().timeIntervalSince(started) > 4 { return }
    seen += 1
    for attr in [kAXValueAttribute, kAXTitleAttribute, kAXDescriptionAttribute] {
      var v: CFTypeRef?
      if AXUIElementCopyAttributeValue(e, attr as CFString, &v) == .success, let s = v as? String {
        let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
        if !t.isEmpty { if lines.last != t { lines.append(t); size += t.count }; break }
      }
    }
    var kids: CFTypeRef?
    if AXUIElementCopyAttributeValue(e, kAXChildrenAttribute as CFString, &kids) == .success, let k = kids as? [AXUIElement] {
      for c in k { walk(c, depth + 1) }
    }
  }
  walk(root, 0)
  return ["text": lines.joined(separator: "\\n")]
}
let args = CommandLine.arguments
let mode = args.count > 1 ? args[1] : "list"
if mode == "list" {
  if !CGPreflightScreenCaptureAccess() { emit(["error": "screen"]); exit(0) }
  emit(windows())
} else if mode == "access" {
  let screen = CGPreflightScreenCaptureAccess()
  if !screen { _ = CGRequestScreenCaptureAccess() }
  emit(["screen": screen, "accessibility": AXIsProcessTrusted()])
} else if mode == "text", args.count > 3 {
  emit(text(pid_t(Int32(args[2]) ?? 0), args[3], args.count > 4 && args[4] == "ask"))
} else if mode == "watch" {
  setvbuf(stdout, nil, _IOLBF, 0)
  let app = NSApplication.shared
  app.setActivationPolicy(.prohibited)
  var armed = true
  var installed = false
  func install() {
    if installed || !AXIsProcessTrusted() { return }
    installed = true
    print("ready")
    NSEvent.addGlobalMonitorForEvents(matching: .flagsChanged) { event in
      let raw = event.modifierFlags.rawValue
      // NX_DEVICELCMDKEYMASK and NX_DEVICERCMDKEYMASK: the left and right Command keys.
      let both = raw & 0x08 != 0 && raw & 0x10 != 0
      let others = event.modifierFlags.intersection([.shift, .option, .control]).isEmpty == false
      if both && !others && armed { armed = false; print("both") }
      if raw & 0x18 == 0 { armed = true }
    }
  }
  install()
  if !installed { print("waiting") }
  // Accessibility can be allowed later; look again every few seconds.
  Timer.scheduledTimer(withTimeInterval: 4, repeats: true) { _ in install() }
  app.run()
}
`;

async function macHelper(options: ScreenOptions): Promise<{ command: string; prefix: string[] }> {
  const run = options.run ?? runCommand;
  const dir = options.cacheDir ?? join(tmpdir(), "demesne-screen");
  const hash = createHash("sha256").update(MAC_HELPER).digest("hex").slice(0, 12);
  const binary = join(dir, `demesne-screen-${hash}`), source = join(dir, `demesne-screen-${hash}.swift`);
  if (existsSync(binary)) return { command: binary, prefix: [] };
  await mkdir(dir, { recursive: true });
  await writeFile(source, MAC_HELPER);
  // Compiled once (a few seconds) so every later capture starts at once.
  for (const [command, args] of [["/usr/bin/xcrun", ["swiftc", "-O", "-o", binary, source]], ["/usr/bin/swiftc", ["-O", "-o", binary, source]]] as const) {
    try { const result = await run(command, [...args], { timeoutMs: 180_000, maxBytes: 1024 * 1024 }); if (result.code === 0 && existsSync(binary)) return { command: binary, prefix: [] }; } catch {}
  }
  return { command: "/usr/bin/swift", prefix: [source] };
}

async function macRun(mode: string[], options: ScreenOptions) {
  const helper = await macHelper(options);
  const result = await (options.run ?? runCommand)(helper.command, [...helper.prefix, ...mode], { signal: options.signal, timeoutMs: 60_000, maxBytes: 8 * 1024 * 1024 });
  if (result.code !== 0) throw new Error("Couldn't read the Mac's windows. Window capture needs the Swift command-line tools (xcode-select --install).");
  return JSON.parse(result.stdout.toString("utf8").trim().split("\n").at(-1) ?? "null") as unknown;
}

const SCREEN_RECORDING = "Allow Demesne under System Settings › Privacy & Security › Screen & System Audio Recording, then try again.";

// ── Windows ─────────────────────────────────────────────────────────────

export const WINDOWS_SCRIPT = String.raw`$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices; using System.Text; using System.Collections.Generic;
public static class DemesneWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint f);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out RECT r, int s);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out int v, int s);
  public static List<IntPtr> Windows() { var list = new List<IntPtr>(); EnumWindows((h, l) => { list.Add(h); return true; }, IntPtr.Zero); return list; }
  public static string Title(IntPtr h) { var s = new StringBuilder(512); GetWindowText(h, s, 512); return s.ToString(); }
  public static RECT Bounds(IntPtr h) { RECT r; DwmGetWindowAttribute(h, 9, out r, Marshal.SizeOf(typeof(RECT))); return r; }
  public static bool Cloaked(IntPtr h) { int v; return DwmGetWindowAttribute(h, 14, out v, 4) == 0 && v != 0; }
}
'@
[void][DemesneWin]::SetProcessDPIAware()
function AppName([uint32]$id) {
  try { $p = Get-Process -Id $id; $d = $p.MainModule.FileVersionInfo.FileDescription; if ($d) { return $d } return $p.ProcessName } catch { try { return (Get-Process -Id $id).ProcessName } catch { return '' } }
}
if ($env:DEMESNE_SHOT_MODE -eq 'list') {
  $out = New-Object System.Collections.Generic.List[object]
  foreach ($h in [DemesneWin]::Windows()) {
    if (-not [DemesneWin]::IsWindowVisible($h) -or [DemesneWin]::IsIconic($h) -or [DemesneWin]::Cloaked($h)) { continue }
    if (([DemesneWin]::GetWindowLong($h, -20) -band 0x80) -ne 0) { continue }
    $t = [DemesneWin]::Title($h); if (-not $t) { continue }
    $r = [DemesneWin]::Bounds($h); if (($r.R - $r.L) -lt 40 -or ($r.B - $r.T) -lt 40) { continue }
    $id = [uint32]0; [void][DemesneWin]::GetWindowThreadProcessId($h, [ref]$id)
    $out.Add([pscustomobject]@{ id = [string]$h.ToInt64(); app = (AppName $id); title = $t; pid = [int]$id; x = $r.L; y = $r.T; width = $r.R - $r.L; height = $r.B - $r.T })
    if ($out.Count -ge 60) { break }
  }
  ConvertTo-Json -Compress -InputObject @($out.ToArray())
  exit 0
}
$h = [IntPtr][int64]$env:DEMESNE_SHOT_ID
$r = [DemesneWin]::Bounds($h); $w = $r.R - $r.L; $ht = $r.B - $r.T
if ($w -lt 1 -or $ht -lt 1) { throw 'That window is gone.' }
$bmp = New-Object System.Drawing.Bitmap $w, $ht
$g = [System.Drawing.Graphics]::FromImage($bmp)
$dc = $g.GetHdc(); $ok = [DemesneWin]::PrintWindow($h, $dc, 2); $g.ReleaseHdc($dc)
if (-not $ok) { $g.CopyFromScreen($r.L, $r.T, 0, 0, $bmp.Size) }
$g.Dispose()
$ms = New-Object System.IO.MemoryStream
$bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
$text = ''
if ($env:DEMESNE_SHOT_TEXT -eq '1') {
  try {
    Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
    $walker = [System.Windows.Automation.TreeWalker]::ContentViewWalker
    $lines = New-Object System.Collections.Generic.List[string]
    $script:seen = 0; $script:size = 0
    $clock = [Diagnostics.Stopwatch]::StartNew()
    function Walk($e, $depth) {
      if ($depth -gt 60 -or $script:seen -gt 6000 -or $script:size -gt ${TEXT_LIMIT} -or $clock.ElapsedMilliseconds -gt 4000) { return }
      $script:seen++
      $value = $null; $vp = $null
      try { if ($e.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp)) { $value = $vp.Current.Value } } catch {}
      foreach ($s in @($value, $e.Current.Name)) {
        if ($s -and $s.Trim()) { $t = $s.Trim(); if ($lines.Count -eq 0 -or $lines[$lines.Count - 1] -ne $t) { $lines.Add($t); $script:size += $t.Length }; break }
      }
      $c = $walker.GetFirstChild($e)
      while ($c -ne $null) { Walk $c ($depth + 1); $c = $walker.GetNextSibling($c) }
    }
    Walk ([System.Windows.Automation.AutomationElement]::FromHandle($h)) 0
    $text = [string]::Join([string][char]10, $lines)
  } catch {}
}
ConvertTo-Json -Compress -InputObject ([pscustomobject]@{ png = [Convert]::ToBase64String($ms.ToArray()); text = $text })
`;

async function powershell(env: Record<string, string>, options: ScreenOptions) {
  const result = await (options.run ?? runCommand)("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "-"],
    { input: WINDOWS_SCRIPT, env, signal: options.signal, timeoutMs: 60_000, maxBytes: 80 * 1024 * 1024 });
  if (result.code !== 0) throw new Error(`Windows couldn't capture the window${result.stderr ? `: ${result.stderr.split("\n")[0]}` : ""}`);
  return JSON.parse(result.stdout.toString("utf8").trim()) as unknown;
}

// ── Linux ───────────────────────────────────────────────────────────────

export type LinuxDesktop = "hyprland" | "sway" | "gnome" | "kde" | "x11" | "wayland";
export function linuxDesktop(env: Record<string, string | undefined>): LinuxDesktop {
  if (env.HYPRLAND_INSTANCE_SIGNATURE) return "hyprland";
  if (env.SWAYSOCK) return "sway";
  const desktop = (env.XDG_CURRENT_DESKTOP ?? "").toLowerCase();
  if (env.WAYLAND_DISPLAY) return desktop.includes("gnome") ? "gnome" : desktop.includes("kde") ? "kde" : "wayland";
  return "x11";
}
const ACTIVE: ShotWindow = { id: "active", app: "Window", title: "The window you’re in" };

interface Hypr { address: string; mapped?: boolean; hidden?: boolean; at: [number, number]; size: [number, number]; workspace?: { id: number }; class?: string; title?: string; pid?: number; focusHistoryID?: number }
export function hyprWindows(clients: Hypr[], visibleWorkspaces: Set<number>): ShotWindow[] {
  return clients.filter((c) => c.mapped !== false && !c.hidden && (!c.workspace || visibleWorkspaces.has(c.workspace.id)) && c.size[0] >= 40 && c.size[1] >= 40)
    .sort((a, b) => (a.focusHistoryID ?? 99) - (b.focusHistoryID ?? 99))
    .map((c) => ({ id: c.address, app: c.class ?? "", title: c.title ?? "", pid: c.pid, bounds: { x: c.at[0], y: c.at[1], width: c.size[0], height: c.size[1] } }));
}
interface SwayNode { id: number; type?: string; name?: string | null; pid?: number; app_id?: string | null; window_properties?: { class?: string }; visible?: boolean; focused?: boolean; rect?: ShotBounds; nodes?: SwayNode[]; floating_nodes?: SwayNode[] }
export function swayWindows(tree: SwayNode): ShotWindow[] {
  const out: (ShotWindow & { focused: boolean })[] = [];
  const walk = (node: SwayNode) => {
    if (node.pid && node.visible && node.rect) out.push({ id: String(node.id), app: node.app_id ?? node.window_properties?.class ?? "", title: node.name ?? "", pid: node.pid, bounds: node.rect, focused: Boolean(node.focused) });
    for (const child of [...node.nodes ?? [], ...node.floating_nodes ?? []]) walk(child);
  };
  walk(tree);
  return out.sort((a, b) => Number(b.focused) - Number(a.focused)).map(({ focused: _, ...window }) => window);
}
/// xprop writes UTF-8 bytes past ASCII as octal escapes ("\\342\\200\\223").
function unescapeX(text: string) {
  const bytes: number[] = [];
  for (let at = 0; at < text.length; at++) {
    const octal = /^\\([0-7]{3})/.exec(text.slice(at));
    if (octal) { bytes.push(parseInt(octal[1]!, 8)); at += 3; continue; }
    if (text[at] === "\\" && at + 1 < text.length) at++;
    bytes.push(...new TextEncoder().encode(text[at]!));
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}
/// xprop's "WM_CLASS(STRING) = "code", "Code"" and friends.
export function xprops(text: string) {
  const value = (name: string) => new RegExp(`^${name}\\([^)]*\\) = (.*)$`, "m").exec(text)?.[1];
  const strings = (raw?: string) => [...(raw ?? "").matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => unescapeX(m[1]!));
  return { title: strings(value("_NET_WM_NAME") ?? value("WM_NAME"))[0] ?? "", app: strings(value("WM_CLASS")).at(-1) ?? "", pid: Number(value("_NET_WM_PID")) || undefined };
}
export function xwininfo(text: string): ShotBounds | undefined {
  const n = (label: string) => Number(new RegExp(`${label}:\\s+(-?\\d+)`).exec(text)?.[1]);
  const bounds = { x: n("Absolute upper-left X"), y: n("Absolute upper-left Y"), width: n("Width"), height: n("Height") };
  return Object.values(bounds).every(Number.isFinite) ? bounds : undefined;
}

async function linuxList(options: ScreenOptions): Promise<ShotWindow[]> {
  const env = options.env ?? process.env, run = options.run ?? runCommand, has = which(env);
  const text = async (command: string, args: string[]) => {
    const result = await run(command, args, { signal: options.signal, timeoutMs: 10_000, maxBytes: 16 * 1024 * 1024 });
    if (result.code !== 0) throw new Error(`${command} failed`);
    return result.stdout.toString("utf8");
  };
  const desktop = linuxDesktop(env);
  if (desktop === "hyprland") {
    const monitors = JSON.parse(await text("hyprctl", ["monitors", "-j"])) as { activeWorkspace?: { id: number }; specialWorkspace?: { id: number } }[];
    const visible = new Set(monitors.flatMap((m) => [m.activeWorkspace?.id, m.specialWorkspace?.id].filter((id): id is number => typeof id === "number" && id !== 0)));
    return hyprWindows(JSON.parse(await text("hyprctl", ["clients", "-j"])) as Hypr[], visible);
  }
  if (desktop === "sway") return swayWindows(JSON.parse(await text("swaymsg", ["-t", "get_tree", "-r"])) as SwayNode);
  if (desktop === "x11") {
    if (!has("xprop") || !has("xwininfo")) throw new Error("Window capture on X11 needs xprop and xwininfo (x11-utils).");
    const active = /window id # (0x[0-9a-f]+)/i.exec(await text("xprop", ["-root", "_NET_ACTIVE_WINDOW"]))?.[1];
    const stack = [...(await text("xprop", ["-root", "_NET_CLIENT_LIST_STACKING"])).matchAll(/0x[0-9a-f]+/gi)].map((m) => m[0]).reverse();
    const ids = [...new Set([active, ...stack].filter((id): id is string => Boolean(id) && Number(id) !== 0))].slice(0, 30);
    const out: ShotWindow[] = [];
    for (const id of ids) {
      try {
        const props = xprops(await text("xprop", ["-id", id, "_NET_WM_NAME", "WM_NAME", "WM_CLASS", "_NET_WM_PID"]));
        const bounds = xwininfo(await text("xwininfo", ["-id", id]));
        if (bounds && bounds.width >= 40 && bounds.height >= 40 && /Map State:\s+IsViewable/.test(await text("xwininfo", ["-id", id]))) out.push({ id, ...props, bounds });
      } catch {}
    }
    return out;
  }
  // GNOME and KDE on Wayland don't say which windows exist; only the one you're in can be taken.
  return [ACTIVE];
}

async function linuxCapture(window: ShotWindow, options: ScreenOptions): Promise<Uint8Array> {
  const env = options.env ?? process.env, run = options.run ?? runCommand, has = which(env);
  const desktop = linuxDesktop(env);
  const picture = async (command: string, args: string[]) => {
    const result = await run(command, args, { signal: options.signal, timeoutMs: 30_000 });
    if (result.code !== 0 || !result.stdout.length) throw new Error(`${command} couldn't take the picture`);
    return result.stdout;
  };
  if (desktop === "hyprland" || desktop === "sway") {
    if (!has("grim")) throw new Error("Window capture here needs grim.");
    const b = window.bounds!;
    return picture("grim", ["-g", `${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.width)}x${Math.round(b.height)}`, "-"]);
  }
  if (desktop === "x11") {
    if (!has("import")) throw new Error("Window capture on X11 needs ImageMagick's import.");
    return picture("import", ["-silent", "-window", window.id, "png:-"]);
  }
  const root = await mkdtemp(join(tmpdir(), "demesne-shot-"));
  try {
    const file = join(root, "window.png");
    const tool = desktop === "kde" && has("spectacle") ? ["spectacle", ["-a", "-b", "-n", "-o", file]] as const
      : has("gnome-screenshot") ? ["gnome-screenshot", ["-w", "-f", file]] as const : null;
    if (!tool) throw new Error("Window capture on this desktop needs gnome-screenshot or spectacle.");
    const result = await run(tool[0], [...tool[1]], { signal: options.signal, timeoutMs: 30_000 });
    if (result.code !== 0 || !existsSync(file)) throw new Error(`${tool[0]} couldn't take the picture`);
    return await readFile(file);
  } finally { await rm(root, { recursive: true, force: true }); }
}

// ── All systems ─────────────────────────────────────────────────────────

const toWindow = (row: Record<string, unknown>): ShotWindow => ({
  id: String(row.id), app: String(row.app ?? ""), title: String(row.title ?? ""), pid: typeof row.pid === "number" ? row.pid : undefined,
  bounds: typeof row.width === "number" ? { x: Number(row.x), y: Number(row.y), width: Number(row.width), height: Number(row.height) } : undefined,
});

/// Can this system take a window's picture at all?
export const supported = (platform: NodeJS.Platform = process.platform) => platform === "darwin" || platform === "win32" || platform === "linux";

/// Visible windows, the one you're in first.
export async function listWindows(options: ScreenOptions = {}): Promise<ShotWindow[]> {
  const platform = options.platform ?? process.platform;
  if (platform === "darwin") {
    const rows = await macRun(["list"], options);
    if (rows && typeof rows === "object" && !Array.isArray(rows) && (rows as { error?: string }).error === "screen") {
      await macRun(["access"], options).catch(() => {});
      throw new Error(`Demesne isn't allowed to see other windows yet. ${SCREEN_RECORDING}`);
    }
    return (rows as Record<string, unknown>[]).map(toWindow);
  }
  if (platform === "win32") return (await powershell({ DEMESNE_SHOT_MODE: "list" }, options) as Record<string, unknown>[]).map(toWindow);
  if (platform === "linux") return linuxList(options);
  throw new Error("Window capture isn't available on this system.");
}

export interface Exclude { pid?: number; apps?: string[] }
const excluded = (window: ShotWindow, exclude: Exclude = {}) =>
  (exclude.pid !== undefined && window.pid === exclude.pid) || (exclude.apps ?? []).some((app) => app.toLowerCase() === window.app.toLowerCase());

/// The window you're in, leaving out Demesne's own.
export async function frontWindow(options: ScreenOptions & { exclude?: Exclude } = {}): Promise<ShotWindow> {
  const windows = await listWindows(options);
  const front = windows.find((window) => window.id === "active" || !excluded(window, options.exclude));
  if (!front) throw new Error("There's no other window to capture.");
  return front;
}

/// A window's picture, and its text when asked and the system shares it.
export async function captureWindow(window: ShotWindow, options: ScreenOptions & { text?: boolean; askForText?: boolean } = {}): Promise<Shot> {
  const platform = options.platform ?? process.platform, run = options.run ?? runCommand;
  if (platform === "darwin") {
    const root = await mkdtemp(join(tmpdir(), "demesne-shot-"));
    try {
      const file = join(root, "window.png");
      const reading = options.text && window.pid ? macRun(["text", String(window.pid), window.title, options.askForText ? "ask" : "quiet"], options).catch(() => null) : Promise.resolve(null);
      const result = await run("/usr/sbin/screencapture", ["-x", "-o", `-l${window.id}`, "-t", "png", file], { signal: options.signal, timeoutMs: 30_000 });
      if (result.code !== 0 || !existsSync(file)) throw new Error(`Couldn't take the window's picture. ${SCREEN_RECORDING}`);
      const png = await readFile(file);
      const read = await reading as { text?: string; note?: string } | null;
      const text = (read?.text ?? "").slice(0, TEXT_LIMIT);
      return { ...window, png, text, textNote: options.text && !text ? read?.note === "accessibility" ? "Allow Demesne under Privacy & Security › Accessibility to send the window’s text too." : "This window didn’t share its text." : undefined };
    } finally { await rm(root, { recursive: true, force: true }); }
  }
  if (platform === "win32") {
    const out = await powershell({ DEMESNE_SHOT_MODE: "shot", DEMESNE_SHOT_ID: window.id, DEMESNE_SHOT_TEXT: options.text ? "1" : "0" }, options) as { png: string; text?: string };
    const text = (out.text ?? "").slice(0, TEXT_LIMIT);
    return { ...window, png: Buffer.from(out.png, "base64"), text, textNote: options.text && !text ? "This window didn’t share its text." : undefined };
  }
  if (platform === "linux") return { ...window, png: await linuxCapture(window, options), text: "", textNote: options.text ? "Window text isn’t read on Linux yet; the picture is sent." : undefined };
  throw new Error("Window capture isn't available on this system.");
}

/// Both Command keys at once, on a Mac: calls `fire` each time. Needs
/// Accessibility; until it's allowed the helper waits quietly and starts
/// listening once it is.
export function watchBothCommands(fire: () => void, options: ScreenOptions & { log?: (line: string) => void } = {}): { stop(): void } {
  let child: ReturnType<typeof spawn> | undefined, stopped = false;
  void macHelper(options).then((helper) => {
    if (stopped) return;
    child = spawn(helper.command, [...helper.prefix, "watch"], { stdio: ["ignore", "pipe", "ignore"] });
    let buffer = "";
    child.stdout!.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
        const line = buffer.slice(0, at).trim(); buffer = buffer.slice(at + 1);
        if (line === "both") fire(); else if (line) options.log?.(`both-Command keys: ${line}`);
      }
    });
    child.on("exit", (code) => { if (!stopped) options.log?.(`both-Command keys helper stopped (${code})`); });
  }, (error: Error) => options.log?.(`both-Command keys unavailable: ${error.message}`));
  return { stop() { stopped = true; child?.kill(); } };
}
