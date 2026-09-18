import { accessSync, constants, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { LoadedConfig } from "@demesne/config";
import type { Painter } from "@demesne/brand";
import { VERSION } from "./version.ts";

/// `demesne doctor` inspects configuration, the data directory, the daemon,
/// its provider, and the workspace, then reports each finding with a concrete
/// next step. Failures set a non-zero exit code; warnings do not.

export type DoctorStatus = "ok" | "warn" | "fail";

export interface DoctorCheck {
  name: string;
  status: DoctorStatus;
  detail: string;
  hint?: string;
}

export interface DoctorOptions {
  server: string;
  dataDirectory: string;
  token?: string;
  loaded: LoadedConfig;
  workspaceRoot: string;
  fetch?: typeof fetch;
  platform?: NodeJS.Platform;
  version?: string;
  runCommand?: (command: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
}

export async function runDoctor(options: DoctorOptions): Promise<{ checks: DoctorCheck[]; ok: boolean }> {
  const fetchImpl = options.fetch ?? fetch;
  const version = options.version ?? VERSION;
  const checks: DoctorCheck[] = [];

  checks.push(configurationCheck(options.loaded));
  const projectConfig = options.loaded.files.project;
  if (projectConfig) checks.push({ name: "Project config", status: "ok", detail: projectConfig });

  const instructions = ["DEMESNE.md", "AGENTS.md"]
    .map((name) => join(options.workspaceRoot, name))
    .find((path) => existsSync(path));
  if (instructions) {
    checks.push({ name: "Project rules", status: "ok", detail: instructions });
  }

  checks.push(...dataDirectoryChecks(options.dataDirectory));

  const health = await fetchHealth(fetchImpl, options.server);
  if (!health) {
    checks.push({
      name: "Daemon",
      status: "fail",
      detail: `not reachable at ${options.server}`,
      hint: "start it with `demesne daemon start`",
    });
  } else {
    checks.push({
      name: "Daemon",
      status: "ok",
      detail: `responding${health.version ? ` · version ${health.version}` : ""}`,
    });
    if (health.version && health.version !== version) {
      checks.push({
        name: "Version skew",
        status: "warn",
        detail: `CLI ${version} is talking to daemon ${health.version}`,
        hint: "rebuild or reinstall both binaries from the same release",
      });
    }
    checks.push(...await authenticationChecks(fetchImpl, options));
    checks.push(...await providerChecks(fetchImpl, options));
    checks.push(...await runtimeChecks(fetchImpl, options));
  }

  checks.push(...workspaceChecks(options));
  checks.push(...await memoryChecks(options));

  return { checks, ok: !checks.some((check) => check.status === "fail") };
}

export function formatDoctorReport(checks: DoctorCheck[], painter: Painter): string {
  const lines: string[] = [`  ${painter.bold("DEMESNE DOCTOR", "paper")}`, ""];
  for (const check of checks) {
    const badge = check.status === "ok"
      ? painter.text("✓", "citron")
      : check.status === "warn"
        ? painter.text("!", "electric")
        : painter.text("×", "signal");
    lines.push(`  ${badge} ${painter.bold(check.name.padEnd(16), "paper")} ${check.detail}`);
    if (check.hint) lines.push(`      ${painter.dim(check.hint)}`);
  }
  const failures = checks.filter((check) => check.status === "fail").length;
  const warnings = checks.filter((check) => check.status === "warn").length;
  lines.push("");
  if (failures > 0) {
    lines.push(`  ${painter.text(`${failures} failure${failures === 1 ? "" : "s"}`, "signal")} · ${warnings} warning${warnings === 1 ? "" : "s"}`);
  } else if (warnings > 0) {
    lines.push(`  ${painter.text(`${warnings} warning${warnings === 1 ? "" : "s"}`, "electric")} · everything required is working`);
  } else {
    lines.push(`  ${painter.text("All checks passed.", "citron")}`);
  }
  return lines.join("\n");
}

function configurationCheck(loaded: LoadedConfig): DoctorCheck {
  if (loaded.files.user) return { name: "Configuration", status: "ok", detail: loaded.files.user };
  return {
    name: "Configuration",
    status: "warn",
    detail: "no user config file found",
    hint: "run `demesne setup` to choose a provider and model",
  };
}

function dataDirectoryChecks(dataDirectory: string): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  if (!existsSync(dataDirectory)) {
    checks.push({
      name: "Data directory",
      status: "warn",
      detail: `${dataDirectory} does not exist yet`,
      hint: "the daemon creates it with mode 0700 on first start",
    });
    return checks;
  }
  const mode = statSync(dataDirectory).mode & 0o777;
  checks.push(mode === 0o700
    ? { name: "Data directory", status: "ok", detail: `${dataDirectory} (0700)` }
    : {
        name: "Data directory",
        status: "warn",
        detail: `${dataDirectory} has mode ${mode.toString(8).padStart(4, "0")}, expected 0700`,
        hint: `chmod 700 ${dataDirectory}`,
      });
  const tokenPath = join(dataDirectory, "daemon.token");
  if (existsSync(tokenPath)) {
    const tokenMode = statSync(tokenPath).mode & 0o777;
    checks.push(tokenMode === 0o600
      ? { name: "Daemon token", status: "ok", detail: `${tokenPath} (0600)` }
      : {
          name: "Daemon token",
          status: "warn",
          detail: `${tokenPath} has mode ${tokenMode.toString(8).padStart(4, "0")}, expected 0600`,
          hint: `chmod 600 ${tokenPath}`,
        });
  }
  return checks;
}

async function fetchHealth(fetchImpl: typeof fetch, server: string): Promise<{ version?: string } | null> {
  try {
    const response = await fetchImpl(new URL("/healthz", server), { signal: AbortSignal.timeout(1_500) });
    if (!response.ok) return null;
    const body = await response.json() as { status?: string; version?: string };
    if (body.status !== "ok") return null;
    return { ...(typeof body.version === "string" ? { version: body.version } : {}) };
  } catch {
    return null;
  }
}

async function authenticationChecks(fetchImpl: typeof fetch, options: DoctorOptions): Promise<DoctorCheck[]> {
  if (!options.token) {
    return [{
      name: "Authentication",
      status: "warn",
      detail: "no daemon token found",
      hint: "the daemon writes daemon.token into the data directory on first start",
    }];
  }
  try {
    const response = await fetchImpl(new URL("/v1/sessions", options.server), {
      headers: { Authorization: `Bearer ${options.token}` },
      signal: AbortSignal.timeout(2_000),
    });
    if (response.ok) return [{ name: "Authentication", status: "ok", detail: "token accepted" }];
    if (response.status === 401) {
      return [{
        name: "Authentication",
        status: "fail",
        detail: "daemon rejected the token",
        hint: "remove the stale token or set DEMESNE_DAEMON_TOKEN to the daemon's current token",
      }];
    }
    return [{ name: "Authentication", status: "warn", detail: `unexpected HTTP ${response.status}` }];
  } catch (error) {
    return [{ name: "Authentication", status: "warn", detail: messageOf(error) }];
  }
}

async function providerChecks(fetchImpl: typeof fetch, options: DoctorOptions): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  let models: Array<{ id: string; contextWindow?: number }> | null = null;
  try {
    const response = await fetchImpl(new URL("/v1/models", options.server), {
      headers: authHeaders(options.token),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      checks.push({ name: "Provider", status: "fail", detail: `model listing failed with HTTP ${response.status}` });
      return checks;
    }
    const body = await response.json() as { models?: Array<{ id?: unknown; contextWindow?: unknown }> };
    models = (body.models ?? []).flatMap((model) =>
      typeof model.id === "string"
        ? [{ id: model.id, ...(typeof model.contextWindow === "number" ? { contextWindow: model.contextWindow } : {}) }]
        : []
    );
    checks.push({ name: "Provider", status: "ok", detail: `serving ${models.length} model${models.length === 1 ? "" : "s"}` });
  } catch (error) {
    checks.push({
      name: "Provider",
      status: "fail",
      detail: messageOf(error),
      hint: "confirm the model server is running and provider.url points at it",
    });
    return checks;
  }

  const configured = options.loaded.config.provider.model;
  if (configured) {
    const match = models.find((model) => model.id === configured);
    if (!match) {
      checks.push({
        name: "Configured model",
        status: "warn",
        detail: `"${configured}" is not currently served`,
        hint: "load the model or update provider.model",
      });
    } else if (match.contextWindow && options.loaded.config.provider.contextWindow !== match.contextWindow) {
      checks.push({
        name: "Context window",
        status: "warn",
        detail: `configured ${options.loaded.config.provider.contextWindow ?? "unset"}, provider reports ${match.contextWindow}`,
        hint: "set provider.context_window to the loaded runtime limit, not the architecture maximum",
      });
    }
  }
  return checks;
}

async function runtimeChecks(fetchImpl: typeof fetch, options: DoctorOptions): Promise<DoctorCheck[]> {
  try {
    const response = await fetchImpl(new URL("/v1/runtime", options.server), {
      headers: authHeaders(options.token),
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) return [{ name: "Runtime profile", status: "warn", detail: `HTTP ${response.status}` }];
    const status = await response.json() as { profile?: string | null; state?: string; mismatches?: string[] };
    if (!status.profile) return [{ name: "Runtime profile", status: "ok", detail: "no strict profile configured" }];
    if (status.state === "verified") {
      return [{ name: "Runtime profile", status: "ok", detail: `${status.profile} verified` }];
    }
    if (status.state === "mismatch") {
      return [{
        name: "Runtime profile",
        status: "fail",
        detail: `${status.profile} mismatch: ${(status.mismatches ?? []).join(", ") || "unknown"}`,
        hint: "restart the model server with the profile's measured flags",
      }];
    }
    return [{ name: "Runtime profile", status: "warn", detail: `${status.profile} is ${status.state ?? "pending"}` }];
  } catch (error) {
    return [{ name: "Runtime profile", status: "warn", detail: messageOf(error) }];
  }
}

function workspaceChecks(options: DoctorOptions): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  const workspace = options.workspaceRoot;
  try {
    accessSync(workspace, constants.W_OK);
    checks.push({ name: "Workspace", status: "ok", detail: `${workspace} (writable)` });
  } catch {
    checks.push({ name: "Workspace", status: "fail", detail: `${workspace} is not writable` });
  }
  const home = homedir();
  if (workspace === "/" || workspace === home) {
    checks.push({
      name: "Workspace root",
      status: "fail",
      detail: "workspace cannot be / or the home directory",
      hint: "run Demesne inside a project directory",
    });
  }
  return checks;
}

async function memoryChecks(options: DoctorOptions): Promise<DoctorCheck[]> {
  if ((options.platform ?? process.platform) !== "darwin" || !options.runCommand) return [];
  try {
    const result = await options.runCommand(["sysctl", "-n", "vm.swapusage"]);
    if (result.code !== 0) return [];
    const match = /used\s*=\s*([\d.]+)([MG])/i.exec(result.stdout);
    if (!match) return [];
    const usedMiB = Number(match[1]) * (match[2]?.toUpperCase() === "G" ? 1024 : 1);
    if (!Number.isFinite(usedMiB)) return [];
    const detail = `swap used ${usedMiB.toFixed(0)} MiB`;
    return usedMiB > 2_048
      ? [{
          name: "Memory",
          status: "warn",
          detail,
          hint: "close memory-heavy applications or use the 64K profile for lower KV pressure",
        }]
      : [{ name: "Memory", status: "ok", detail }];
  } catch {
    return [];
  }
}

function authHeaders(token: string | undefined): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
