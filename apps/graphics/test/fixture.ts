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
import { graphicsEnvironment } from "../runtime.ts";

export async function fixture(
  processor?: TurnProcessor,
  options: { vision?: boolean } = {},
) {
  const root = realpathSync(
      mkdtempSync(join(tmpdir(), "demesne-graphics-test-")),
    ),
    workspace = join(root, "workspace"),
    home = join(root, "home");
  mkdirSync(workspace);
  mkdirSync(join(home, ".demesne"), { recursive: true });
  writeFileSync(join(workspace, "README.md"), "# Isolated UI fixture\n");
  writeFileSync(
    join(home, ".demesne", "config.toml"),
    'theme = "dark"\n[daemon]\nauto_start = "never"\n[provider]\ncontext_window = 262144\n',
  );
  const token = "graphics-test-token",
    app = createDaemonApp({
      databasePath: join(root, "data/state.sqlite"),
      experimentWorktreeRoot: join(root, "worktrees"),
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
      ...graphicsEnvironment(),
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
