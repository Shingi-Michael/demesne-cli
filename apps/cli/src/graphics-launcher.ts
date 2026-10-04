import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** A separate process owns raw terminal mode and the optional Chromium runtime. */
export async function runGraphics(args: string[]): Promise<number> {
  const packaged = join(dirname(process.execPath), "graphics"),
    source = resolve(import.meta.dir, "../../graphics");
  const values: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (["--server", "--workspace", "--session", "--scale", "--model", "--prompt"].includes(arg)) {
      const value = args[++i];
      if (!value || value.startsWith("--"))
        throw new Error(`${arg} requires a value`);
      values.push(`${arg}=${value}`);
    } else values.push(arg);
  }
  if (values.includes("--help")) {
    console.log(
      "Usage: demesne graphics [--workspace <path>] [--session <id>] [--server <url>] [--scale auto|0.5-3] [--setup] [--check-runtime] [--install-sandbox]\nRuns the web-rendered UI inside Ghostty using Kitty graphics. Scale follows terminal text size by default. Ctrl+Q exits; Esc twice stops a running turn.",
    );
    return 0;
  }
  const bundled = existsSync(join(packaged, "host"));
  if (!bundled && !existsSync(join(source, "terminal.ts")))
    throw new Error(
      "The graphics runtime is not installed beside this binary. Build it with bun run build:graphics, or use bun run graphics from a checkout.",
    );
  const bun = bundled ? null : Bun.which("bun");
  if (!bundled && !bun)
    throw new Error("Bun is required to run graphics from source.");
  const child = Bun.spawn(
    bundled
      ? [join(packaged, "host"), "--live", ...values]
      : [bun!, join(source, "terminal.ts"), "--live", ...values],
    {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      env: {
        ...process.env,
        DEMESNE_GRAPHICS_ROOT: bundled ? packaged : source,
      },
    },
  );
  return await child.exited;
}
