import { sliceAnsi } from "bun";
import { driveAnswerText, type DriveAction, type DriveInspectAction, type DriveInspection, type DriveObservation } from "@demesne/protocol";

export interface DriveInspectionUI {
  observe(): DriveObservation;
  perform(action: DriveAction, observation: DriveObservation, signal: AbortSignal): Promise<string>;
}

/** Bounded, visible navigation. It collects evidence, never judges success. */
export async function inspectDrive(ui: DriveInspectionUI, action: DriveInspectAction, initial: DriveObservation, signal: AbortSignal,
  activity: (text: string) => void = () => {}): Promise<DriveInspection> {
  const nav = initial.navigation;
  if (!nav) throw new Error("Controller inspection is unavailable in this workbench.");
  const packet: DriveInspection = { sessionId: initial.sessionId, document: nav.document, turn: nav.turn, target: action.target,
    pages: [], truncated: action.position === "end" || action.position === "continue", actions: 0, result: "Controller inspection finished." };
  let screen = initial, characters = 0, full = false;
  const stable = () => !signal.aborted && screen.sessionId === initial.sessionId && screen.navigation?.document === nav.document
    && screen.navigation.turn === nav.turn && !screen.navigation.readingHeld && screen.mode === "input" && screen.ready && !screen.draft;
  const perform = async (next: DriveAction): Promise<boolean> => {
    signal.throwIfAborted();
    if (!stable()) return false;
    activity(`Controller · inspecting ${action.target} · ${packet.pages.length} views collected`);
    const result = await ui.perform(next, screen, signal); packet.actions++;
    signal.throwIfAborted(); screen = ui.observe();
    return !/^(UI changed|Control moved|Input changed)/.test(result) && stable();
  };
  const interrupted = () => { packet.pages = []; packet.truncated = true; packet.result = "UI changed during controller inspection; collected evidence discarded. Re-observe before continuing."; return packet; };
  const capture = () => {
    const answer = action.target === "answer";
    const surface = action.target === "checks" ? "review" : answer ? "response" : action.target;
    const pane = screen.panes?.find((pane) => pane.surface === surface);
    if (!pane) return false;
    const rows = answer ? nav.latest ? screen.latestAnswerRows ?? [] : screen.answerRows ?? []
      : screen.rows.slice(pane.row, pane.row + pane.height).map((row) => sliceAnsi(row, pane.column, pane.column + pane.width));
    const visible: string[] = [];
    for (const row of rows.map((row) => answer ? driveAnswerText(row) : row.trimEnd()).filter((row) => row.trim())) {
      if (characters + row.length > 24_000) { packet.truncated = true; full = true; break; }
      visible.push(row); characters += row.length;
    }
    if (visible.length) packet.pages.push({ observationId: screen.id, surface, rows: visible, answer, latest: answer && nav.latest,
      ...(region() ? { offset: region()!.offset, maximum: region()!.maximum } : {}),
      ...(screen.navigation?.item ? { item: screen.navigation.item } : {}) });
    return visible.length > 0;
  };
  const region = () => screen.scrollRegions?.findLast((item) => item.surface === (action.target === "answer" ? "response" : action.target === "diff" ? "diff-code" : action.target === "checks" ? "review" : "log"));
  const checkStart = action.position === "continue" && nav.item ? nav.checks.indexOf(nav.item) + 1 : 0;
  const items = action.target === "checks" && !action.item ? nav.checks.slice(checkStart, checkStart + 6) : [action.item];
  if (action.target === "checks" && !action.item && nav.checks.length > checkStart + items.length) packet.truncated = true;
  for (const item of items) {
    if (packet.pages.length >= 12 || characters >= 24_000 || full) { packet.truncated = true; break; }
    if (!await perform({ ...action, ...(item ? { item } : {}) })) return interrupted();
    if (action.position === "end" && !await perform({ kind: "key", key: "end" })) return interrupted();
    if (!capture()) { packet.truncated = true; break; }
    if (action.target === "checks" && !action.item && region() && region()!.offset < region()!.maximum) {
      // Verification outcomes are at the head; exact test counts are often at
      // the tail. Explicitly mark the omitted middle rather than claiming a scan.
      const before = region()!;
      if (before.maximum - before.offset > before.height) packet.truncated = true;
      if (packet.pages.length >= 12 || full) { packet.truncated = true; break; }
      if (!await perform({ kind: "key", key: "end" })) return interrupted();
      capture();
    } else if (action.position !== "end") {
      for (let page = 1; page < 6; page++) {
        const before = region();
        if (!before || before.offset >= before.maximum) break;
        if (packet.pages.length >= 12 || characters >= 24_000 || full) { packet.truncated = true; break; }
        if (!await perform({ kind: "key", key: "pagedown" })) return interrupted();
        const after = region();
        if (!after || after.offset <= before.offset || !capture()) { packet.truncated = true; break; }
      }
      if (region() && region()!.offset < region()!.maximum) packet.truncated = true;
    }
  }
  packet.result = `Controller inspected ${packet.pages.length} visible ${action.target} views using ${packet.actions} UI actions and no model calls.${packet.truncated ? " Bounded excerpt: some content was omitted; inspect a specific item or continue for more." : ""}`;
  return packet;
}
