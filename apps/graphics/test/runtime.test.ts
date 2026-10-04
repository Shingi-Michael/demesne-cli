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

test.skipIf(process.platform === "win32")("a failed probe returns even when a descendant inherits diagnostics", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { probeGraphicsRuntime } = await import("../runtime.ts");
  const root = mkdtempSync(join(tmpdir(), "demesne-probe-test-"));
  try {
    writeFileSync(join(root, "runtime-probe.cjs"), `Bun.spawn([process.execPath, "-e", "setInterval(()=>{},1000)"], {stdout:"inherit",stderr:"inherit"}); console.error("sandbox failed"); process.exit(2);`);
    const started = Date.now();
    const result = await probeGraphicsRuntime(root, process.execPath, { timeoutMs: 2000 });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("sandbox failed");
    expect(result.timedOut).toBe(false);
    expect(Date.now() - started).toBeLessThan(2000);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a stuck renderer probe has a bounded timeout", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { probeGraphicsRuntime } = await import("../runtime.ts");
  const root = mkdtempSync(join(tmpdir(), "demesne-probe-timeout-"));
  try {
    writeFileSync(join(root, "runtime-probe.cjs"), "setInterval(()=>{},1000);");
    const started = Date.now();
    const result = await probeGraphicsRuntime(root, process.execPath, { timeoutMs: 100 });
    expect(result.timedOut).toBe(true);
    expect(result.code).not.toBe(0);
    expect(Date.now() - started).toBeLessThan(2000);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
