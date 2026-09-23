/// Grouped activity is a derived view of the event transcript. No prose is synthesized
/// or discarded: the chronological transcript remains the source of truth.
export interface ActivityEntry {
  id: number;
  type: string;
  phase?: "inspect" | "change" | "verify";
  closesTurn?: boolean;
  state?: string;
  exitCode?: number;
  waiting?: boolean;
}

export type SectionName = "Updates" | "Changes" | "Verification" | "Response";
export interface ActivityGroup<T> {
  id: number;
  number: number;
  request: T | null;
  sections: Array<{ name: SectionName; entries: T[] }>;
}

export function groupActivity<T extends ActivityEntry>(entries: readonly T[]): ActivityGroup<T>[] {
  const pages: Array<{ request: T | null; entries: T[] }> = [];
  for (const entry of entries) {
    if (entry.type === "user") pages.push({ request: entry, entries: [] });
    else {
      if (!pages.length) pages.push({ request: null, entries: [] });
      pages.at(-1)!.entries.push(entry);
    }
  }
  let number = 0;
  return pages.map((page) => {
    if (page.request) number++;
    const finalIndex = page.entries.findLastIndex((entry) => entry.type === "assistant");
    const lastTool = page.entries.findLastIndex((entry) => entry.type === "tool");
    const settled = page.entries.some((entry) => entry.closesTurn);
    const buckets: Record<SectionName, T[]> = { Updates: [], Changes: [], Verification: [], Response: [] };
    page.entries.forEach((entry, index) => {
      const section = entry.type === "tool"
        ? entry.phase === "change" ? "Changes" : entry.phase === "verify" ? "Verification" : "Updates"
        : entry.closesTurn || (settled && index === finalIndex && finalIndex > lastTool) ? "Response" : "Updates";
      buckets[section].push(entry);
    });
    return {
      id: page.request?.id ?? 0, number, request: page.request,
      sections: (Object.keys(buckets) as SectionName[]).filter((name) => buckets[name].length > 0)
        .map((name) => ({ name, entries: buckets[name] })),
    };
  });
}

export function evidenceCounts(entries: readonly ActivityEntry[]): { passed: number; failed: number; pending: number; blocked: number; waiting: number; stopped: number; unknown: number } {
  const checks = entries.filter((entry) => entry.type === "tool" && entry.phase === "verify");
  return {
    passed: checks.filter((entry) => entry.state === "done" && entry.exitCode === 0).length,
    failed: checks.filter((entry) => entry.state === "failed" || (entry.state === "done" && Boolean(entry.exitCode))).length,
    pending: checks.filter((entry) => entry.state === "running" && !entry.waiting).length,
    blocked: checks.filter((entry) => entry.state === "denied").length,
    waiting: checks.filter((entry) => entry.state === "running" && entry.waiting).length,
    stopped: checks.filter((entry) => entry.state === "stopped").length,
    unknown: checks.filter((entry) => entry.state === "done" && entry.exitCode === undefined).length,
  };
}

export function changeSummary(entries: readonly ActivityEntry[]): string {
  const changes = entries.filter((entry) => entry.type === "tool" && entry.phase === "change");
  const checks = evidenceCounts(entries);
  const parts = [`${changes.length} change operation${changes.length === 1 ? "" : "s"}`];
  const unfinished = changes.filter((entry) => entry.state !== "done").length;
  if (unfinished) parts[0] += ` (${unfinished} incomplete)`;
  parts.push(`${checks.passed} check${checks.passed === 1 ? "" : "s"} passed`);
  if (checks.failed) parts.push(`${checks.failed} failed`);
  if (checks.pending) parts.push(`${checks.pending} pending`);
  if (checks.waiting) parts.push(`${checks.waiting} awaiting approval`);
  if (checks.blocked) parts.push(`${checks.blocked} denied`);
  if (checks.stopped) parts.push(`${checks.stopped} stopped`);
  if (checks.unknown) parts.push(`${checks.unknown} unknown`);
  return parts.join(" · ");
}
