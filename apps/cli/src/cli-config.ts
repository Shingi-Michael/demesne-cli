import { loadConfig, userConfigPath, type AutoStartPolicy, type LoadedConfig, type NotificationConfig, type UiConfig } from "@demesne/config";
import { homedir } from "node:os";
import { join } from "node:path";

/// Resolves everything the CLI needs from configuration files and the
/// environment. The `--server` flag is the highest-precedence override because
/// it is explicit for the current invocation.

export interface CliSettings {
  loaded: LoadedConfig;
  server: string;
  dataDirectory: string;
  theme: "dark" | "light" | "auto";
  autoStart: AutoStartPolicy;
  notifications: NotificationConfig;
  ui: UiConfig;
  /// The user config path even when no file exists yet.
  configPath: string;
}

export interface LoadCliSettingsOptions {
  serverOverride?: string;
  workspaceRoot?: string;
  env?: Record<string, string | undefined>;
  home?: string;
}

export function loadCliSettings(options: LoadCliSettingsOptions = {}): CliSettings {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const loaded = loadConfig({
    workspaceRoot: options.workspaceRoot ?? process.cwd(),
    env,
    home,
  });
  const server = options.serverOverride ?? loaded.config.server ?? defaultServer(loaded.config);
  return {
    loaded,
    server,
    dataDirectory: loaded.config.dataDir ?? join(home, ".demesne"),
    theme: loaded.config.theme ?? "auto",
    autoStart: loaded.config.daemon.autoStart,
    notifications: loaded.config.notifications,
    ui: loaded.config.ui,
    configPath: loaded.files.user ?? userConfigPath(home),
  };
}

/// The daemon and the CLI share `daemon.host` / `daemon.port`, so a configured
/// port moves both ends without also setting DEMESNE_SERVER.
function defaultServer(config: { daemon: { host?: string; port?: number } }): string {
  const host = config.daemon.host ?? "127.0.0.1";
  const formattedHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${formattedHost}:${config.daemon.port ?? 7337}`;
}
