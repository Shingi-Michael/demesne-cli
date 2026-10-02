import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@demesne/config";

test.each(["save", "retry", "pending", "review-cancel", "cli-cancel"])("setup PTY: %s restores terminal and saves only at Review", async scenario => {
  const home = mkdtempSync(join(tmpdir(), "demesne-wizard-pty-"));
  let output = "";
  const listeners = new Set<() => void>();
  const child = Bun.spawn([process.execPath, scenario === "cli-cancel" ? "apps/cli/src/main.ts" : "apps/cli/test/fixtures/setup-auth.ts",
    ...(scenario === "cli-cancel" ? ["setup"] : [`--${scenario}`])], {
    cwd: join(import.meta.dir, "../../.."), env: { ...process.env, HOME: home },
    terminal: { cols: 110, rows: 30, data(_terminal, bytes) { output += Buffer.from(bytes).toString(); for (const notify of listeners) notify(); } },
  });
  const until = (text: string) => new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { listeners.delete(check); reject(new Error(`Missing ${text}: ${output.slice(-2000)}`)); }, 15000);
    const check = () => { if (output.includes(text)) { clearTimeout(timer); listeners.delete(check); resolve(); } };
    listeners.add(check); check();
  });
  const send = (text: string) => child.terminal!.write(text);
  try {
    await until("Where should demesne run its model?");
    if (scenario === "cli-cancel") send("\x03");
    else {
      await until("Found 0 local servers");
      send("\x1b[A\x1b[A\x1b[A\r");
      if (scenario === "pending") { await until("Could not open the browser"); send("\x03"); }
      else {
        if (scenario === "retry") { await until("Sign-in did not complete"); send("r"); }
        await until("Which model should it use?");
        expect(existsSync(join(home, ".demesne/config.toml"))).toBe(false);
        send("\r"); await until("Ready to write your config");
        if (scenario === "review-cancel") send("\x03");
        else { send("\r"); await until("demesne is ready"); send("\r"); }
      }
    }
    await child.exited;
    expect(output).toContain("\x1b[?25h\x1b[?1049l");
    expect(output).not.toContain("fixture-private-key");
    const path = join(home, ".demesne/config.toml");
    if (scenario === "save" || scenario === "retry") {
      expect(loadConfig({ userConfigPath: path, projectConfigPath: null, env: {} }).config.provider).toMatchObject({
        id: "OpenRouter", apiKey: "fixture-private-key", model: "fixture/model", contextWindow: 262144, maxOutputTokens: 131072,
      });
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(readFileSync(path, "utf8")).toContain("fixture-private-key");
    } else expect(existsSync(path)).toBe(false);
  } finally { child.kill(); child.terminal?.close(); rmSync(home, { recursive: true, force: true }); }
}, 60000);
