import type { Painter, PaletteColor } from "@demesne/brand";

/// Ambient machine awareness for the sidebar.
///
/// The agent runs on a memory-constrained machine, so the workbench shows the
/// pressure it is actually under. macOS reports swap usage through sysctl;
/// other platforms and failed reads simply render nothing.

export function parseSwapUsedMiB(output: string): number | null {
  const match = /used\s*=\s*([\d.]+)([MG])/i.exec(output);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  return value * (match[2]?.toUpperCase() === "G" ? 1024 : 1);
}

export function formatAmbientMemory(usedMiB: number, painter: Painter): string[] {
  const gib = usedMiB / 1024;
  const label = usedMiB >= 1024 ? `${gib.toFixed(1)} GiB` : `${Math.round(usedMiB)} MiB`;
  const color: PaletteColor = usedMiB >= 3_072 ? "signal" : usedMiB >= 1_024 ? "secondary" : "citron";
  return [
    painter.bold("MEMORY", "secondary"),
    painter.text(`swap ${label}`, color),
  ];
}

/// Reads swap usage on macOS. Returns null when unavailable or on other
/// platforms so the section disappears cleanly.
export async function readAmbientMemory(): Promise<number | null> {
  if (process.platform !== "darwin") return null;
  try {
    const child = Bun.spawn(["sysctl", "-n", "vm.swapusage"], { stdout: "pipe", stderr: "ignore" });
    const timer = setTimeout(() => child.kill(), 1_000);
    try {
      const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
      if (code !== 0) return null;
      return parseSwapUsedMiB(stdout);
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}
