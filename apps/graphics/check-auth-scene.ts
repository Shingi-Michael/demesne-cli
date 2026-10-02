/** Visual-only auth fixture; no browser, callback server, or provider is opened. */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { dirname, join, resolve } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { palette } from "@demesne/brand";
import { initialWizard } from "../cli/src/setup-wizard.ts";
import { GraphicsHost } from "./host.ts";
import { fixture } from "./test/fixture.ts";
const f = await fixture(),
  host = new GraphicsHost({
    workspace: f.workspace,
    settings: f.settings,
    client: f.client,
    changed: () => {},
  });
await host.connect();
const snapshot = host.snapshot();
snapshot.setup = {
  ...initialWizard("~/.demesne/config.toml"),
  step: "auth",
  auth: {
    url: "https://openrouter.ai/auth?callback_url=http%3A%2F%2Flocalhost%3A3000%2Fcallback",
    status: "waiting",
    message: "Finish signing in, then return here.",
    expiresAt: Date.now() + 537000,
  },
  customResult: null,
  checkedAt: null,
  saving: false,
};
const chatgptScene = process.argv[3];
if (chatgptScene?.startsWith("chatgpt")) {
  snapshot.setup.authProvider = "chatgpt";
  snapshot.setup.chatgptAccount = { id: "fixture-account", label: "person@example.test · fixture", email: "person@example.test", signedIn: true, planEnabled: true, acknowledged: false };
  if (chatgptScene === "chatgpt-plan") snapshot.setup.step = "plan";
  else if (chatgptScene === "chatgpt-accounts") {
    snapshot.setup.step = "accounts";
    snapshot.setup.accounts = [snapshot.setup.chatgptAccount];
    snapshot.setup.accountIndex = 0;
  } else if (chatgptScene === "chatgpt-provider") snapshot.setup.step = "provider";
  else snapshot.setup.auth.url = "https://auth.openai.com/api/accounts/authorize?client_id=dynamic_agent_client&agent_name_hint=Demesne";
}
const cache = mkdtempSync(join(tmpdir(), "graphics-scene-")),
  root = import.meta.dir;
const bundle = await Bun.build({
  entrypoints: [join(root, "live.ts")],
  outdir: join(root, "dist"),
  target: "browser",
});
if (!bundle.success) throw new Error("UI build failed");
const electron = join(
  dirname(Bun.resolveSync("electron", root)),
  "dist",
  process.platform === "darwin"
    ? "Electron.app/Contents/MacOS/Electron"
    : "electron",
);
const child = spawn(electron, [join(root, "renderer.cjs")], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { HOME: f.home, PATH: process.env.PATH, DEMESNE_PIXEL_CACHE: cache },
  }),
  send = (message: unknown) =>
    child.stdin.write(JSON.stringify(message) + "\n");
let error = "",
  result = false;
child.stderr.on("data", (text) => (error += text));
createInterface({ input: child.stdout }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.kind === "request")
    send({
      kind: "response",
      id: message.id,
      ok: true,
      value: message.method === "bootstrap" ? snapshot : null,
    });
  if (message.kind === "snapshot") {
    result = true;
    console.log(message.path);
  }
  if (message.kind === "error") error += message.message;
});
const exit = new Promise<number | null>((resolve) => child.on("exit", resolve));
send({
  kind: "init",
  width: 1000,
  height: 620,
  cell: { width: 8, height: 18 },
  theme: palette,
  live: true,
  snapshot: resolve(
    process.argv[2] ?? "/tmp/demesne-graphics-live-check/setup-auth.png",
  ),
});
try {
  await exit;
  if (!result) throw new Error(error || "Auth scene did not render");
} finally {
  child.kill();
  host.dispose();
  await f.close();
  rmSync(cache, { recursive: true, force: true });
}
