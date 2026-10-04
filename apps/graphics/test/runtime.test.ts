import { expect, test } from "bun:test";
import { graphicsEnvironment, graphicsStartupProblem, linuxSessionProblem, runtimeSuffix, shellQuote } from "../runtime.ts";

test("graphics keeps desktop authentication but excludes provider credentials and sandbox bypasses", () => {
  const env = graphicsEnvironment({ HOME: "/home/demo", PATH: "/usr/bin", DISPLAY: ":1", XAUTHORITY: "/run/auth", WAYLAND_DISPLAY: "wayland-0", XDG_RUNTIME_DIR: "/run/user/1000", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/bus", DEMESNE_API_KEY: "secret", DEMESNE_DAEMON_TOKEN: "secret", ELECTRON_RUN_AS_NODE: "1", CHROME_DEVEL_SANDBOX: "", NODE_OPTIONS: "--require evil" });
  expect(env).toEqual({ HOME: "/home/demo", PATH: "/usr/bin", DISPLAY: ":1", XAUTHORITY: "/run/auth", WAYLAND_DISPLAY: "wayland-0", XDG_RUNTIME_DIR: "/run/user/1000", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/bus" });
});
test("Linux requires an unprivileged desktop session, accepting X11 or Wayland", () => {
  expect(linuxSessionProblem({ DISPLAY: ":1" }, 1000)).toBeUndefined();
  expect(linuxSessionProblem({ WAYLAND_DISPLAY: "wayland-0" }, 1000)).toBeUndefined();
  expect(linuxSessionProblem({}, 1000)).toContain("demesne prompt");
  expect(linuxSessionProblem({ DISPLAY: ":1" }, 0)).toContain("normal user");
});
test("SUID errors identify the helper and targeted repair, not workspace chmod", () => {
  const message = graphicsStartupProblem("The SUID sandbox helper binary was found, but is not configured correctly", "/project with spaces/electron", "/project with spaces");
  expect(message).toContain("/project with spaces/chrome-sandbox");
  expect(message).toContain("bun run graphics:setup --install-sandbox");
  expect(message).toContain("'/project with spaces/host' --install-sandbox");
  expect(message).not.toContain("--no-sandbox");
  expect(message).not.toContain("chmod");
});
test("missing desktop libraries and display authentication have distinct remedies", () => {
  expect(graphicsStartupProblem("error while loading shared libraries: libnss3.so: cannot open shared object file", "/electron", "/app")).toContain("missing a Linux system library: libnss3.so");
  expect(graphicsStartupProblem("Authorization required, but no authorization protocol specified", "/electron", "/app")).toContain("XAUTHORITY");
  expect(graphicsStartupProblem("unexpected failure", "/electron", "/app")).toContain("unexpected failure");
});
test("runtime suffixes and repair paths preserve platform and shell boundaries", () => {
  expect(runtimeSuffix("linux")).toBe("electron");
  expect(runtimeSuffix("darwin")).toBe("Electron.app/Contents/MacOS/Electron");
  expect(runtimeSuffix("win32")).toBe("electron.exe");
  expect(shellQuote("/tmp/a'b;$HOME")).toBe("'/tmp/a'\\''b;$HOME'");
});
