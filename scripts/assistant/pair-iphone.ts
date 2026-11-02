/// Pairs the Demesne iPhone app with this computer's daemon: prints a QR code
/// holding the daemon's Tailscale address and its token. Scan it with the
/// iPhone's camera and the app opens and saves both.
///
///   bun run pair:iphone                      # address from `tailscale status`, port 8443
///   bun run pair:iphone -- --url https://pc.tail1234.ts.net:8443
///
/// The token can do anything the Demesne window can, so the code is shown
/// only in this terminal, never saved to a file.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import QRCode from "qrcode";
import { loadConfig } from "../../packages/config/src/index.ts";

/// The port `tailscale serve` publishes the daemon on in docs/assistant.md.
export const SERVE_PORT = 8443;

/// What the code holds: a link only the Demesne app opens.
export function pairingLink(server: string, token: string): string {
  return `demesne://pair?${new URLSearchParams({ server, token })}`;
}

/// This computer's https address inside the tailnet, from `tailscale status --json`.
export function serverFromTailscale(status: unknown, port = SERVE_PORT): string | null {
  const name = (status as { Self?: { DNSName?: unknown } } | null)?.Self?.DNSName;
  if (typeof name !== "string" || !name.trim()) return null;
  return `https://${name.trim().replace(/\.$/, "")}:${port}`;
}

/// The address must be https on a Tailscale name: the token goes with every request.
export function checkServer(url: string): string | null {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return "That isn't an address. It looks like https://pc.tail1234.ts.net:8443"; }
  if (parsed.protocol !== "https:") return "Use the https:// address from `tailscale serve status`, never plain http.";
  if (!parsed.hostname.endsWith(".ts.net")) return "Use the Tailscale name (it ends in .ts.net), so the phone only reaches the PC over Tailscale.";
  return null;
}

function daemonToken(): string | null {
  const configured = process.env.DEMESNE_DAEMON_TOKEN?.trim();
  if (configured) return configured;
  const dataDir = loadConfig({ includeProject: false }).config.dataDir ?? join(homedir(), ".demesne");
  const path = join(dataDir, "daemon.token");
  return existsSync(path) ? readFileSync(path, "utf8").trim() || null : null;
}

function tailscaleServer(): string | null {
  try {
    return serverFromTailscale(JSON.parse(execFileSync("tailscale", ["status", "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })));
  } catch { return null; }
}

if (import.meta.main) {
  const at = process.argv.indexOf("--url");
  const server = (at > 0 ? process.argv[at + 1] : undefined)?.replace(/\/$/, "") ?? tailscaleServer();
  if (!server) {
    console.error("Couldn't find this computer's Tailscale name. Is Tailscale running? Or pass it: bun run pair:iphone -- --url https://<pc>.<tailnet>.ts.net:8443");
    process.exit(1);
  }
  const problem = checkServer(server);
  if (problem) { console.error(problem); process.exit(1); }
  const token = daemonToken();
  if (!token) { console.error("No daemon token yet. Start Demesne (or the demesned task) once, then run this again."); process.exit(1); }
  try {
    const health = await fetch(`${server}/healthz`, { signal: AbortSignal.timeout(5_000) });
    if (!health.ok) console.warn(`${server} answered HTTP ${health.status}. Check \`tailscale serve status\`.`);
  } catch {
    console.warn(`Couldn't reach ${server} from here. Check \`tailscale serve status\` before scanning.`);
  }
  console.log(`\nScan this with your iPhone's camera to connect the Demesne app to ${server}:\n`);
  console.log(await QRCode.toString(pairingLink(server, token), { type: "terminal", small: true, errorCorrectionLevel: "M" }));
  console.log("This code holds the key to your PC. Scan it, then clear the screen (`cls` on Windows, `clear` elsewhere).");
}
