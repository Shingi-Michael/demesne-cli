import { formatDiffPreview, sanitizeTerminalLine, truncateText, wrapDisplayText, type Painter } from "@demesne/brand";
import { changeSummary } from "./activity.ts";
import { toolFailed } from "./evidence.ts";

export type InspectorTab = "Overview" | "Changes" | "Activity";
export const INSPECTOR_TABS: InspectorTab[] = ["Overview", "Changes", "Activity"];
export interface InspectorRecord {
  id: number; type: "tool"; name: string; phase: "inspect" | "change" | "verify";
  state: string; detail?: string; waiting?: boolean; exitCode?: number; durationMs?: number;
  message?: string; input: Record<string, unknown>; diff?: { oldText: string; newText: string };
}
export interface InspectorTarget { row: number; column: number; width: number; tab?: InspectorTab; entryId?: number; back?: boolean; follow?: boolean }

/// Content is independent of the panel location: the same inspector docks or
/// fills the conversation region on a narrow terminal.
export function inspectorPanel(options: {
  width: number; height: number; paint: Painter; tab: InspectorTab; records: InspectorRecord[];
  selected: number; detailId?: number; offset: number; title: string; context: string;
  revealSelected?: boolean;
}): { lines: string[]; targets: InspectorTarget[]; maxOffset: number; offset: number } {
  const { paint, width, height } = options;
  const textWidth = Math.max(8, width - 4);
  const targets: InspectorTarget[] = [{ row: 0, column: 1, width: width - 2, follow: true }];
  let tabs = " ";
  for (const tab of INSPECTOR_TABS) {
    const column = Bun.stringWidth(tabs);
    targets.push({ row: 1, column, width: tab.length + 2, tab });
    tabs += options.tab === tab ? paint.wash(` ${tab} `, "electric") : ` ${paint.text(tab, "secondary")} `;
  }
  const lines = [` ${paint.bold("INSPECTOR", "electricBright")} ${paint.dim(options.title)}`, tabs, ""];
  const content: string[] = [];
  const links = new Map<number, number>();
  const detail = options.records.find((entry) => entry.id === options.detailId);
  const addRecord = (entry: InspectorRecord, index: number) => {
    const failed = toolFailed(entry) || entry.state === "denied";
    links.set(content.length, entry.id);
    content.push(paint.text(truncateText(sanitizeTerminalLine(`${index === options.selected ? "›" : " "} ${entry.detail ?? entry.name}`), textWidth), failed ? "signal" : "paper"));
    content.push(paint.dim(`  ${entry.waiting ? "awaiting approval" : toolFailed(entry) ? "failed" : entry.state}${entry.durationMs === undefined ? "" : ` · ${entry.durationMs}ms`}`));
  };
  if (detail) {
    content.push(paint.text("← Back to list", "electricBright"), "", ...wrapDisplayText(sanitizeTerminalLine(detail.detail ?? detail.name), textWidth));
    content.push(paint.text(`${detail.waiting ? "awaiting approval" : detail.state}${detail.exitCode === undefined ? "" : ` · exit ${detail.exitCode}`}`, toolFailed(detail) || detail.state === "denied" ? "signal" : "secondary"), "");
    if (detail.diff) content.push(paint.bold(detail.state === "done" ? "RECORDED EDIT" : "PROPOSED EDIT", "secondary"), ...formatDiffPreview(detail.diff.oldText, detail.diff.newText, 10_000, paint), "");
    if (detail.message) content.push(paint.bold("RESULT", "secondary"), ...detail.message.split("\n").flatMap((line) => wrapDisplayText(sanitizeTerminalLine(line), textWidth)), "");
    content.push(paint.bold("ARGUMENTS", "secondary"), ...JSON.stringify(detail.input, null, 2).split("\n").flatMap((line) => wrapDisplayText(sanitizeTerminalLine(line), textWidth)));
  } else {
    if (options.tab === "Overview") content.push(paint.bold("TURN SUMMARY", "secondary"), ...wrapDisplayText(changeSummary(options.records), textWidth), "", paint.bold("SESSION CONTEXT", "secondary"), options.context, "", paint.bold("FILES & CHECKS", "secondary"));
    const records = options.tab === "Activity" ? options.records : options.records.filter((entry) => options.tab === "Changes" ? entry.phase === "change" : entry.phase !== "inspect");
    records.forEach(addRecord);
    if (!records.length) content.push(paint.dim(options.tab === "Changes" ? "No file changes in this turn." : "No recorded activity yet."));
  }
  const capacity = Math.max(1, height - lines.length - 1);
  const maxOffset = Math.max(0, content.length - capacity);
  let offset = Math.min(options.offset, maxOffset);
  if (options.revealSelected && !detail) {
    const selectedRow = [...links.keys()][options.selected];
    if (selectedRow !== undefined) {
      if (selectedRow < offset) offset = selectedRow;
      else if (selectedRow >= offset + capacity) offset = selectedRow - capacity + 1;
    }
  }
  for (let index = offset; index < Math.min(content.length, offset + capacity); index++) {
    if (links.has(index)) targets.push({ row: lines.length, column: 1, width: width - 2, entryId: links.get(index) });
    if (detail && index === 0) targets.push({ row: lines.length, column: 1, width: width - 2, back: true });
    lines.push(` ${content[index]}`);
  }
  lines.push(paint.dim(` ${detail ? "↑↓ scroll · Backspace list" : "↑↓ select · Enter inspect"}`));
  return { lines: lines.slice(0, height).map((line) => truncateText(line, width)), targets: targets.filter((target) => target.row < height), maxOffset, offset };
}
