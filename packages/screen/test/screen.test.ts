import { expect, test } from "bun:test";
import { captureWindow, frontWindow, hyprWindows, linuxDesktop, listWindows, swayWindows, xprops, xwininfo, type Runner } from "../src/index.ts";

const fake = (answers: Record<string, string | Buffer>, calls: string[][] = []): Runner => async (command, args, options) => {
  calls.push([command, ...args]);
  const key = Object.keys(answers).find((k) => `${command} ${args.join(" ")}`.startsWith(k));
  if (!key) return { code: 1, stdout: Buffer.alloc(0), stderr: "unknown" };
  void options;
  const answer = answers[key]!;
  return { code: 0, stdout: Buffer.isBuffer(answer) ? answer : Buffer.from(answer), stderr: "" };
};

test("which Linux desktop this is", () => {
  expect(linuxDesktop({ HYPRLAND_INSTANCE_SIGNATURE: "x", WAYLAND_DISPLAY: "w" })).toBe("hyprland");
  expect(linuxDesktop({ SWAYSOCK: "/s" })).toBe("sway");
  expect(linuxDesktop({ WAYLAND_DISPLAY: "w", XDG_CURRENT_DESKTOP: "ubuntu:GNOME" })).toBe("gnome");
  expect(linuxDesktop({ WAYLAND_DISPLAY: "w", XDG_CURRENT_DESKTOP: "KDE" })).toBe("kde");
  expect(linuxDesktop({ DISPLAY: ":0" })).toBe("x11");
});

test("Hyprland windows: visible workspaces only, most recently focused first", () => {
  const clients = [
    { address: "0xb", at: [0, 0], size: [800, 600], workspace: { id: 1 }, class: "kitty", title: "b", pid: 2, focusHistoryID: 1 },
    { address: "0xa", at: [10, 20], size: [900, 700], workspace: { id: 1 }, class: "firefox", title: "a", pid: 1, focusHistoryID: 0 },
    { address: "0xc", at: [0, 0], size: [900, 700], workspace: { id: 3 }, class: "code", title: "c", pid: 3, focusHistoryID: 2 },
    { address: "0xd", at: [0, 0], size: [10, 10], workspace: { id: 1 }, class: "tiny", title: "d", pid: 4, focusHistoryID: 3 },
  ] as Parameters<typeof hyprWindows>[0];
  expect(hyprWindows(clients, new Set([1])).map((w) => w.id)).toEqual(["0xa", "0xb"]);
  expect(hyprWindows(clients, new Set([1]))[0]!.bounds).toEqual({ x: 10, y: 20, width: 900, height: 700 });
});

test("Sway windows: the focused one first", () => {
  const tree = { id: 1, nodes: [{ id: 2, nodes: [
    { id: 5, pid: 9, app_id: "foot", name: "shell", visible: true, rect: { x: 0, y: 0, width: 500, height: 400 } },
    { id: 6, pid: 8, app_id: null, window_properties: { class: "Firefox" }, name: "page", visible: true, focused: true, rect: { x: 500, y: 0, width: 500, height: 400 } },
    { id: 7, pid: 7, app_id: "hidden", name: "x", visible: false, rect: { x: 0, y: 0, width: 500, height: 400 } },
  ] }] };
  expect(swayWindows(tree).map((w) => [w.id, w.app])).toEqual([["6", "Firefox"], ["5", "foot"]]);
});

test("X11 properties and geometry", () => {
  expect(xprops('_NET_WM_NAME(UTF8_STRING) = "Settings – Acme"\nWM_CLASS(STRING) = "navigator", "firefox"\n_NET_WM_PID(CARDINAL) = 4242\n'))
    .toEqual({ title: "Settings – Acme", app: "firefox", pid: 4242 });
  expect(xprops('_NET_WM_NAME(UTF8_STRING) = "Settings \\342\\200\\223 Acme \\"x\\""\n').title).toBe('Settings – Acme "x"');
  expect(xwininfo("  Absolute upper-left X:  12\n  Absolute upper-left Y:  34\n  Width: 800\n  Height: 600\n")).toEqual({ x: 12, y: 34, width: 800, height: 600 });
});

test("Hyprland: the window you're in is listed and taken with grim", async () => {
  const env = { HYPRLAND_INSTANCE_SIGNATURE: "x", PATH: "/usr/bin" };
  const calls: string[][] = [];
  const run = fake({
    "hyprctl monitors -j": JSON.stringify([{ activeWorkspace: { id: 2 } }]),
    "hyprctl clients -j": JSON.stringify([{ address: "0x1", at: [5, 6], size: [700, 500], workspace: { id: 2 }, class: "firefox", title: "Docs", pid: 50, focusHistoryID: 0 }]),
    "grim": Buffer.from([137, 80]),
  }, calls);
  const front = await frontWindow({ platform: "linux", env, run, exclude: { pid: 1 } });
  expect(front).toMatchObject({ id: "0x1", app: "firefox", title: "Docs" });
  // grim isn't on this machine's PATH in the test; the capture says what's missing.
  await expect(captureWindow(front, { platform: "linux", env: { ...env, PATH: "" }, run })).rejects.toThrow("grim");
});

test("Windows: the list comes back front to back, and Demesne's own window is skipped", async () => {
  const run = fake({ "powershell.exe": JSON.stringify([
    { id: "100", app: "Demesne", title: "Chat", pid: 7, x: 0, y: 0, width: 900, height: 700 },
    { id: "200", app: "Microsoft Edge", title: "Settings – Acme", pid: 8, x: 10, y: 10, width: 1200, height: 800 },
  ]) });
  expect((await listWindows({ platform: "win32", run })).length).toBe(2);
  expect(await frontWindow({ platform: "win32", run, exclude: { pid: 7 } })).toMatchObject({ id: "200", app: "Microsoft Edge", bounds: { x: 10, y: 10, width: 1200, height: 800 } });
});

test("Windows: a capture brings the picture and the window's text", async () => {
  const calls: string[][] = [];
  const run: Runner = async (command, args, options) => {
    calls.push([command, ...args, options?.env?.DEMESNE_SHOT_MODE ?? "", options?.env?.DEMESNE_SHOT_ID ?? ""]);
    return { code: 0, stdout: Buffer.from(JSON.stringify({ png: Buffer.from([1, 2, 3]).toString("base64"), text: "Settings\nSave" })), stderr: "" };
  };
  const shot = await captureWindow({ id: "200", app: "Edge", title: "x" }, { platform: "win32", run, text: true });
  expect([...shot.png]).toEqual([1, 2, 3]);
  expect(shot.text).toBe("Settings\nSave");
  expect(calls[0]!.slice(-2)).toEqual(["shot", "200"]);
});

test("GNOME on Wayland: only the window you're in", async () => {
  expect(await listWindows({ platform: "linux", env: { WAYLAND_DISPLAY: "w", XDG_CURRENT_DESKTOP: "GNOME" }, run: fake({}) })).toEqual([{ id: "active", app: "Window", title: "The window you’re in" }]);
});
