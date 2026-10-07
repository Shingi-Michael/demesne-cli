import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DemesneClient } from "@demesne/client";
import { createDaemonApp } from "../../daemon/src/app.ts";
import { serveDaemon } from "../../daemon/src/http-server.ts";
import type { TurnProcessor } from "../../daemon/src/processor.ts";
import { loadCliSettings } from "../../cli/src/cli-config.ts";

/// What a child process (the desktop sidecar, a UI check) inherits: the
/// session it draws in, never provider credentials.
function sessionEnvironment(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return Object.fromEntries([
    "HOME", "PATH", "TMPDIR", "LANG", "LC_ALL", "DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR",
    "XAUTHORITY", "DBUS_SESSION_BUS_ADDRESS", "XDG_SESSION_TYPE",
  ].flatMap(key => env[key] ? [[key, env[key]!]] : []));
}

export async function fixture(
  processor?: TurnProcessor,
  // `root` and `workspaceName` give screenshots a readable project path.
  options: { vision?: boolean; trusted?: boolean; root?: string; workspaceName?: string } = {},
) {
  if (options.root) mkdirSync(options.root);
  const root = realpathSync(
      options.root ?? mkdtempSync(join(tmpdir(), "demesne-graphics-test-")),
    ),
    workspace = join(root, options.workspaceName ?? "workspace"),
    home = join(root, "home");
  mkdirSync(workspace);
  mkdirSync(join(home, ".demesne"), { recursive: true });
  writeFileSync(join(workspace, "README.md"), "# Isolated UI fixture\n");
  mkdirSync(join(root, "data"));
  if (options.trusted !== false)
    writeFileSync(join(root, "data", "trusted-workspaces.json"), JSON.stringify({ trusted: [workspace] }));
  writeFileSync(
    join(home, ".demesne", "config.toml"),
    'theme = "dark"\n[daemon]\nauto_start = "never"\n[provider]\ncontext_window = 262144\n',
  );
  const token = "graphics-test-token",
    app = createDaemonApp({
      databasePath: join(root, "data/state.sqlite"),
      authToken: token,
      providerVision: options.vision,
      processor: processor ?? {
        providerId: "test",
        modelId: "qwen3.8-27b",
        contextCapacity: 262144,
        async listModels() {
          return [
            { id: "qwen3.8-27b", provider: "test", contextWindow: 262144 },
          ];
        },
        async *stream() {
          yield { type: "text_delta", delta: "Ready." };
          yield { type: "finish", reason: "stop" };
        },
      },
    });
  const server = serveDaemon(app, { hostname: "127.0.0.1", port: 0 }),
    client = new DemesneClient({ server: server.url.href, token }),
    settings = loadCliSettings({
      home,
      env: {},
      workspaceRoot: workspace,
      serverOverride: server.url.href,
    });
  return {
    root,
    workspace,
    home,
    server,
    client,
    settings,
    env: {
      ...sessionEnvironment(),
      HOME: home,
      PATH: process.env.PATH!,
      TERM: "xterm-256color",
      DEMESNE_DAEMON_TOKEN: token,
    },
    async close() {
      await server.stop(true);
      await app.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
export async function eventually(check: () => unknown, timeout = 6000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(10);
  }
  throw new Error("Condition did not settle");
}
