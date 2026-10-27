import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDaemonApp, type DaemonApp, type ReloadReport } from "../src/app.ts";

const temporaryDirectories: string[] = [];
const apps: DaemonApp[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function startApp(databasePath: string, options: {
  reloadProviders?: () => Promise<{ switched: boolean; model: string; provider: string; previous: { model: string; provider: string } }>;
  configFile?: string | null;
  theme?: string;
}): DaemonApp {
  const app = createDaemonApp({ databasePath, ...options });
  apps.push(app);
  return app;
}

test("daemon reload reports no provider reloader and an unchanged theme", async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "daemon-reload-")));
  temporaryDirectories.push(directory);
  const app = startApp(join(directory, "state.sqlite"), {});
  const report = await app.reload();
  expect(report.providers).toBeNull();
  expect(report.theme.changed).toBe(false);
  expect(report.theme.selected).toBe("demesne");
  expect(report.binaryUpdated).toBe(false);
  expect(typeof report.reloadedAt).toBe("string");
});

test("daemon reload runs the configured provider reloader", async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "daemon-reload-providers-")));
  temporaryDirectories.push(directory);
  let calls = 0;
  const app = startApp(join(directory, "state.sqlite"), {
    reloadProviders: async () => {
      calls += 1;
      return { switched: true, model: "qwen3.8-27b", provider: "P", previous: { model: "gpt-6-astra", provider: "O" } };
    },
  });
  const report = await app.reload();
  expect(calls).toBe(1);
  expect(report.providers).toMatchObject({ switched: true, model: "qwen3.8-27b", provider: "P" });
  expect(report.theme.changed).toBe(false);
});

test("daemon reload re-selects the theme from the config file", async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "daemon-reload-theme-")));
  temporaryDirectories.push(directory);
  const configFile = join(directory, "config.toml");
  writeFileSync(configFile, "theme = \"demesne\"\n");
  const app = startApp(join(directory, "state.sqlite"), { configFile, theme: "demesne-light" });
  const report = await app.reload();
  expect(report.theme.changed).toBe(true);
  expect(report.theme.selected).toBe("demesne");
  expect(report.binaryUpdated).toBe(false);
});

test("POST /v1/daemon/reload returns the reload report", async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "daemon-reload-http-")));
  temporaryDirectories.push(directory);
  const app = startApp(join(directory, "state.sqlite"), {});
  const server = Bun.serve({ port: 0, fetch: app.fetch });
  try {
    const response = await fetch(new URL("/v1/daemon/reload", server.url), { method: "POST" });
    expect(response.status).toBe(200);
    const body = (await response.json()) as ReloadReport;
    expect(body.providers).toBeNull();
    expect(reportShape(body)).toBe(true);
    expect(body.binaryUpdated).toBe(false);
  } finally {
    await server.stop(true);
  }
});

function reportShape(report: ReloadReport): boolean {
  return typeof report.theme.changed === "boolean"
    && typeof report.theme.selected === "string"
    && typeof report.binaryUpdated === "boolean"
    && typeof report.reloadedAt === "string";
}
