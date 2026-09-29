import type { Painter } from "@demesne/brand";
import { Canvas } from "./canvas.ts";
import { tint } from "./interaction.ts";

export type RailAction = "files" | "diff" | "preview" | "drive";
export function sidebarRail(width: number, height: number, paint: Painter, working: boolean, hovered: RailAction | null, drive?: "active" | "idle") {
  const canvas = new Canvas(width, height, paint);
  const center = Math.floor(width / 2);
  for (let row = 0; row < height; row++) {
    canvas.put(row, 0, "", width, "surface");
    canvas.put(row, 0, paint.text("│", "rule"), 1, "surface");
  }
  canvas.put(0, center, paint.text("▪", working ? "thinking" : "citron"), 1, "surface");
  canvas.put(1, Math.max(1, center - 1), paint.text("─".repeat(Math.min(3, width - 1)), "rule"), Math.min(3, width - 1), "surface");
  const actions: RailAction[] = ["files", "diff", "preview", ...(drive && height >= 12 ? ["drive" as const] : [])];
  const zones = actions.map((action, index) => {
    const row = 3 + index * 2;
    const icon = ["≡", "╪", "▣", "▷"][index]!;
    const active = action === hovered;
    const label = active && width >= 5 ? `[${icon}]` : icon;
    canvas.put(row, active && width >= 5 ? center - 1 : center,
      paint.text(label, active ? "electric" : action === "drive" && drive === "active" ? "thinking" : "muted"), label.length, active ? "accentSurface" : "surface");
    return { row: row - 1, height: 2, column: 1, width: width - 1, action };
  });
  if (height >= (drive ? 19 : 17)) {
    const top = (drive ? 11 : 9) + Math.floor((height - (drive ? 13 : 11) - 5) / 2);
    for (const [index, letter] of [..."PANEL"].entries()) canvas.put(top + index, center, tint(paint, letter, "surface", "muted", 0.6), 1, "surface");
  }
  canvas.put(height - 1, Math.max(1, center - 1), tint(paint, width >= 5 ? "[ ]" : "[]", "surface", "borderBright", 0.5), width - 1, "surface");
  return { rows: canvas.rows, zones };
}
