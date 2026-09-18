import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@demesne/config";
import { createPainter } from "@demesne/brand";
import { formatDoctorReport, runDoctor, type DoctorOptions } from "../src/doctor.ts";

const temporaryDirectories: string[] = [];
const painter = createPainter(false, "dark");

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "demesne-doctor-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fakeFetch(routes: Record<string, () => Response>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const path = new URL(String(input)).pathname;
    const route = routes[path];
    return route ? route() : new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function healthyRoutes(): Record<string, () => Response> {
  return {
    "/healthz": () => json({ status: "ok", provider: "llama.cpp", model: "local", version: "0.1.0" }),
    "/v1/sessions": () => json({ sessions: [] }),
    "/v1/models": () => json({ models: [{ id: "local", contextWindow: 8192 }] }),
    "/v1/runtime": () => json({
      profile: null,
      state: "unconfigured",
      expected: null,
      observed: null,
      mismatches: [],
      observedAt: null,
    }),
  };
}

function doctorOptions(overrides: Partial<DoctorOptions> = {}): DoctorOptions {
  const home = temporaryDirectory();
  const dataDirectory = join(home, ".demesne");
  mkdirSync(dataDirectory, { mode: 0o700 });
  writeFileSync(join(dataDirectory, "daemon.token"), "token\n", { mode: 0o600 });
  const configPath = join(home, "config.toml");
  writeFileSync(configPath, `[provider]\nmodel = "local"\ncontext_window = 8192\n`);
  const loaded = loadConfig({ env: {}, userConfigPath: configPath, projectConfigPath: null });
  return {
    server: "http://127.0.0.1:7337",
    dataDirectory,
    token: "token",
    loaded,
    workspaceRoot: temporaryDirectory(),
    fetch: fakeFetch(healthyRoutes()),
    platform: "linux",
    version: "0.1.0",
    ...overrides,
  };
}

describe("runDoctor", () => {
  test("passes when configuration, daemon, provider, and workspace are healthy", async () => {
    const result = await runDoctor(doctorOptions());
    expect(result.ok).toBe(true);
    expect(result.checks.find((check) => check.name === "Configuration")?.status).toBe("ok");
    expect(result.checks.find((check) => check.name === "Daemon")?.status).toBe("ok");
    expect(result.checks.find((check) => check.name === "Authentication")?.status).toBe("ok");
    expect(result.checks.find((check) => check.name === "Provider")?.status).toBe("ok");
    expect(result.checks.find((check) => check.name === "Runtime profile")?.status).toBe("ok");
    expect(result.checks.find((check) => check.name === "Workspace")?.status).toBe("ok");
  });

  test("fails with a start hint when the daemon is unreachable", async () => {
    const result = await runDoctor(doctorOptions({
      fetch: (async () => {
        throw new Error("connect ECONNREFUSED");
      }) as unknown as typeof fetch,
    }));
    expect(result.ok).toBe(false);
    const daemon = result.checks.find((check) => check.name === "Daemon");
    expect(daemon?.status).toBe("fail");
    expect(daemon?.hint).toContain("daemon start");
  });

  test("fails when the daemon rejects the token", async () => {
    const result = await runDoctor(doctorOptions({
      fetch: fakeFetch({
        ...healthyRoutes(),
        "/v1/sessions": () => json({ error: { code: "unauthorized", message: "nope" } }, 401),
      }),
    }));
    expect(result.checks.find((check) => check.name === "Authentication")?.status).toBe("fail");
    expect(result.ok).toBe(false);
  });

  test("warns when the configured model is not served", async () => {
    const result = await runDoctor(doctorOptions({
      fetch: fakeFetch({
        ...healthyRoutes(),
        "/v1/models": () => json({ models: [{ id: "other-model", contextWindow: 8192 }] }),
      }),
    }));
    const configured = result.checks.find((check) => check.name === "Configured model");
    expect(configured?.status).toBe("warn");
    expect(result.ok).toBe(true);
  });

  test("fails on a strict runtime profile mismatch", async () => {
    const result = await runDoctor(doctorOptions({
      fetch: fakeFetch({
        ...healthyRoutes(),
        "/v1/runtime": () => json({
          profile: "llama-ngram-mod-f16-kv-100k-b256-32gb",
          state: "mismatch",
          expected: {},
          observed: {},
          mismatches: ["contextWindow expected 100000, observed 32768"],
          observedAt: new Date().toISOString(),
        }),
      }),
    }));
    const runtime = result.checks.find((check) => check.name === "Runtime profile");
    expect(runtime?.status).toBe("fail");
    expect(runtime?.detail).toContain("contextWindow");
    expect(result.ok).toBe(false);
  });

  test("warns about version skew without failing", async () => {
    const result = await runDoctor(doctorOptions({
      version: "0.2.0",
    }));
    expect(result.checks.find((check) => check.name === "Version skew")?.status).toBe("warn");
    expect(result.ok).toBe(true);
  });

  test("warns about heavy swap use but keeps the run healthy", async () => {
    const result = await runDoctor(doctorOptions({
      platform: "darwin",
      runCommand: async (command) => command[0] === "sysctl"
        ? { code: 0, stdout: "total = 5120.00M  used = 3000.00M  free = 2120.00M", stderr: "" }
        : { code: 1, stdout: "", stderr: "" },
    }));
    const memory = result.checks.find((check) => check.name === "Memory");
    expect(memory?.status).toBe("warn");
    expect(memory?.detail).toContain("3000 MiB");
    expect(result.ok).toBe(true);
  });
});

describe("formatDoctorReport", () => {
  test("renders every check and a passing summary", async () => {
    const { checks } = await runDoctor(doctorOptions());
    const report = formatDoctorReport(checks, painter);
    expect(report).toContain("DEMESNE DOCTOR");
    expect(report).toContain("Configuration");
    expect(report).toContain("All checks passed.");
  });

  test("renders failures with hints", async () => {
    const { checks } = await runDoctor(doctorOptions({
      fetch: (async () => {
        throw new Error("connect ECONNREFUSED");
      }) as unknown as typeof fetch,
    }));
    const report = formatDoctorReport(checks, painter);
    expect(report).toContain("1 failure");
    expect(report).toContain("demesne daemon start");
  });
});
