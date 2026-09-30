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
  // Working is blue, like the live response; amber means it waits on you.
  canvas.put(0, center, paint.text("▪", working ? "electric" : "citron"), 1, "surface");
  canvas.put(1, Math.max(1, center - 1), paint.text("─".repeat(Math.min(3, width - 1)), "rule"), Math.min(3, width - 1), "surface");
  const actions: RailAction[] = ["files", "diff", "preview", ...(drive && height >= 12 ? ["drive" as const] : [])];
  const zones = actions.map((action, index) => {
    const row = 3 + index * 2;
    const icon = ["≡", "╪", "▣", "▷"][index]!;
    // Hover lifts the cell and brightens the icon; active Drive work is blue.
    const active = action === hovered;
    if (active) canvas.put(row, 1, "", width - 1, "raised");
    canvas.put(row, center, paint.text(icon, active ? "paper" : action === "drive" && drive === "active" ? "electric" : "muted"), 1, active ? "raised" : "surface");
    return { row: row - 1, height: 2, column: 1, width: width - 1, action };
  });
  canvas.put(height - 1, Math.max(1, center - 1), tint(paint, width >= 5 ? "[ ]" : "[]", "surface", "borderBright", 0.5), width - 1, "surface");
  return { rows: canvas.rows, zones };
}
