/** Runs inside the disposable Linux CI image as an unprivileged user. */
import assert from "node:assert/strict";
import { lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { ensureGraphicsRuntime, graphicsEnvironment, graphicsStartupProblem, installSandboxHelper, verifyGraphicsRuntime } from "../apps/graphics/runtime.ts";
import { canonicalWorkspace } from "../apps/daemon/src/tools.ts";
import { chmodSync } from "node:fs";
const root = resolve(import.meta.dir, "../apps/graphics");
assert.equal(process.platform, "linux"); assert.notEqual(process.getuid?.(), 0);
const electron = await ensureGraphicsRuntime(root), helper = join(dirname(electron), "chrome-sandbox");
const cache = mkdtempSync(join(tmpdir(), "demesne-linux-probe-"));
try {
  // Force Chromium's SUID route to reproduce the report even on hosts with user namespaces.
  const child = Bun.spawn([electron, "--disable-namespace-sandbox", join(root, "runtime-probe.cjs")], {
    env: { ...graphicsEnvironment(), DEMESNE_PIXEL_CACHE: cache }, stdout: "pipe", stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 20000);
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]); clearTimeout(timer);
  assert.notEqual(code, 0);
  assert.match(stderr, /SUID sandbox helper binary was found/);
  assert.match(graphicsStartupProblem(stderr, electron, root), /--install-sandbox/);
  console.log("PASS: reproduced the original SUID failure and classified it");
  await installSandboxHelper(root, electron);
  assert(lstatSync(helper).isSymbolicLink());
  assert(realpathSync(helper).startsWith("/usr/local/lib/demesne/sandbox/"));
  assert.equal(statSync(helper).uid, 0); assert.equal(statSync(helper).mode & 0o7777, 0o4755);
  // Verify the repaired SUID route specifically; normal startup may prefer user namespaces.
  const fixed = Bun.spawn([electron, "--disable-namespace-sandbox", join(root, "runtime-probe.cjs")], {
    env: { ...graphicsEnvironment(), DEMESNE_PIXEL_CACHE: cache }, stdout: "pipe", stderr: "pipe",
  });
  const fixedTimer = setTimeout(() => fixed.kill("SIGKILL"), 20000);
  const [fixedCode, stdout, fixedError] = await Promise.all([fixed.exited, new Response(fixed.stdout).text(), new Response(fixed.stderr).text()]); clearTimeout(fixedTimer);
  assert.equal(fixedCode, 0, fixedError); assert.match(stdout, /DEMESNE_GRAPHICS_READY/);
  await verifyGraphicsRuntime(root, electron);
  console.log("PASS: repaired SUID and normal sandboxed renderer paths produce pixels");
  const workspace = mkdtempSync(join(tmpdir(), "demesne-mode-"));
  try {
    chmodSync(workspace, 0o775);
    assert.throws(() => canonicalWorkspace(workspace), /mode 775.*chmod go-w/);
    assert.equal(statSync(workspace).mode & 0o777, 0o775, "diagnosis does not mutate permissions");
    chmodSync(workspace, 0o755); assert.equal(canonicalWorkspace(workspace), realpathSync(workspace));
  } finally { rmSync(workspace, { recursive: true, force: true }); }
  console.log("PASS: workspace 775 is diagnosed separately; 755 is accepted");
  console.log(readFileSync("/etc/os-release", "utf8").split("\n").find(l => l.startsWith("PRETTY_NAME=")));
} finally { rmSync(cache, { recursive: true, force: true }); }
