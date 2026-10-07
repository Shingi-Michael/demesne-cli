import { expect, test } from "bun:test";
import { desktopArgs, desktopLaunch, type DesktopProbe } from "../src/desktop-launcher.ts";

const probe = (overrides: Partial<DesktopProbe> & { files?: string[]; commands?: Record<string, string> } = {}): DesktopProbe => ({
  platform: "linux", env: {}, home: "/home/me", source: "/src/demesne", bun: "/usr/bin/bun",
  exists: (path) => (overrides.files ?? []).includes(path),
  which: (command) => overrides.commands?.[command] ?? null,
  ...overrides,
});

test("terminal words and options become the desktop's launch options for this project", () => {
  expect(desktopArgs(["fix", "the", "build", "--model", "qwen"], { cwd: "/work/app" }))
    .toEqual(["--workspace=/work/app", "--model=qwen", "--prompt=fix the build"]);
  expect(desktopArgs(["--workspace", "../other", "--session=s1", "--setup"], { cwd: "/work/app", server: "http://127.0.0.1:9000" }))
    .toEqual(["--workspace=/work/other", "--server=http://127.0.0.1:9000", "--session=s1", "--setup"]);
  expect(() => desktopArgs(["--scale", "2"], { cwd: "/w" })).toThrow("Unknown option --scale");
  expect(() => desktopArgs(["--model"], { cwd: "/w" })).toThrow("--model requires a value");
});

test("the desktop app is found where it was installed or built, then from source with Rust", () => {
  const args = ["--workspace=/w"];
  expect(desktopLaunch(args, probe({ env: { DEMESNE_DESKTOP_BIN: "/opt/d" } }))).toEqual({ argv: ["/opt/d", ...args], detached: true });
  expect(desktopLaunch(args, probe({ platform: "darwin", files: ["/home/me/Applications/Demesne.app"] })))
    .toEqual({ argv: ["open", "-n", "-a", "/home/me/Applications/Demesne.app", "--args", ...args], detached: false });
  expect(desktopLaunch(args, probe({ commands: { "demesne-desktop": "/usr/bin/demesne-desktop" } }))!.argv[0]).toBe("/usr/bin/demesne-desktop");
  expect(desktopLaunch(args, probe({ files: ["/src/demesne/apps/desktop/src-tauri/target/debug/demesne-desktop"] }))!.argv[0])
    .toBe("/src/demesne/apps/desktop/src-tauri/target/debug/demesne-desktop");
  expect(desktopLaunch(args, probe({ files: ["/src/demesne/scripts/run-desktop.ts"], commands: { cargo: "/usr/bin/cargo" } })))
    .toEqual({ argv: ["/usr/bin/bun", "/src/demesne/scripts/run-desktop.ts", "--", ...args], detached: false, cwd: "/src/demesne" });
  // A checkout without Rust, or nothing installed: no way to open it.
  expect(desktopLaunch(args, probe({ files: ["/src/demesne/scripts/run-desktop.ts"] }))).toBeNull();
});
