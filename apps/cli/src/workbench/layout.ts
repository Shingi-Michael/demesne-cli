/// Pure layout math for the full-screen workbench.
///
/// The frame has five regions: a three-line task heading, the conversation viewport, an
/// optional right sidebar, the input area (which grows with the palette), and
/// the fixed footer. Everything is expressed in zero-based terminal cells so
/// the renderer can address rows directly.

export type SidebarMode = "auto" | "hidden" | "wide";

export interface Rect {
  row: number;
  column: number;
  height: number;
  width: number;
}

export interface WorkbenchLayout {
  width: number;
  height: number;
  header: Rect;
  conversation: Rect;
  sidebar: Rect | null;
  /// Column of the vertical rule between conversation and sidebar.
  dividerColumn: number | null;
  input: Rect;
  footer: Rect;
}

export const MIN_WORKBENCH_WIDTH = 40;
export const MIN_WORKBENCH_HEIGHT = 10;

export function workspaceInset(width: number): number {
  return width < 65 ? 0 : Math.max(2, Math.floor((width - 108) / 2));
}

/// One text alignment for requests, thinking, responses, evidence, and drafts.
export function conversationInset(_width: number): number { return 3; }

/// The rail, and a docked panel at about 40% of the window as in the Figma
/// frames (620 of 1480px), never narrower than 44 cells or wider than 84.
/// Short terminals keep their editor available beneath a full-width panel.
export function sessionPanelLayout(width: number, open: boolean): { conversationWidth: number; panelWidth: number; overlay: boolean } {
  const rail = width >= 65 ? 6 : 3;
  const docked = open && width >= 100;
  const panelWidth = docked ? Math.max(Math.min(44, Math.floor(width * 0.44)), Math.min(84, Math.floor(width * 0.4))) : rail;
  return { conversationWidth: width - panelWidth, panelWidth, overlay: open && !docked };
}

/// A quiet session line above the conversation. The controller owns the unified
/// prompt/status strip; additional reading controls only appear during inspection.
export interface SessionLayout {
  width: number;
  height: number;
  header: Rect;
  actionsRow: number;
  body: Rect;
  footerRow: number;
}

export function computeSessionLayout(width: number, height: number, options: { inspection?: boolean; footer?: boolean } = {}): SessionLayout {
  // The session view is a sub-region of the terminal (the controller owns the
  // prompt and status rows), so it is laid out at its real size rather than
  // clamped to the whole-terminal minimum.
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  const header: Rect = { row: 0, column: 0, height: h >= 10 ? 2 : 1, width: w };
  const inset = w >= 65 ? 2 : 0;
  const gap = h >= 10 ? 1 : 0;
  const actionsRow = header.height + gap;
  const footerRow = h - 1;
  const bodyTop = actionsRow + (options.inspection ? h >= 10 ? 2 : 1 : 0);
  const body: Rect = { row: bodyTop, column: inset,
    height: Math.max(1, h - bodyTop - (options.footer && !options.inspection && h >= 10 ? 1 : 0)), width: w - inset * 2 };
  return { width: w, height: h, header, actionsRow, body, footerRow };
}

export function computeWorkbenchLayout(
  width: number,
  height: number,
  options: { sidebar?: SidebarMode; inputLines?: number } = {},
): WorkbenchLayout {
  const w = Math.max(MIN_WORKBENCH_WIDTH, width);
  const h = Math.max(MIN_WORKBENCH_HEIGHT, height);
  const sidebarMode = options.sidebar ?? "auto";
  const inputLines = Math.max(1, options.inputLines ?? 2);

  const footer: Rect = { row: h - 1, column: 0, height: 1, width: w };
  const inputHeight = Math.min(inputLines, Math.max(1, h - 6));
  const input: Rect = { row: h - 1 - inputHeight, column: 0, height: inputHeight, width: w };
  const header: Rect = { row: 0, column: 0, height: 3, width: w };

  const showSidebar = sidebarMode !== "hidden" && w >= (sidebarMode === "wide" ? 72 : 110);
  const sidebarWidth = showSidebar ? Math.max(24, Math.min(38, Math.floor(w / 3))) : 0;
  const bodyTop = header.height;
  const bodyHeight = Math.max(1, h - header.height - inputHeight - 1);
  const conversationWidth = w - sidebarWidth - (showSidebar ? 1 : 0);
  const conversation: Rect = { row: bodyTop, column: 0, height: bodyHeight, width: conversationWidth };
  const sidebar: Rect | null = showSidebar
    ? { row: bodyTop, column: w - sidebarWidth, height: h - bodyTop - 1, width: sidebarWidth }
    : null;
  input.width = conversationWidth;

  return {
    width: w,
    height: h,
    header,
    conversation,
    sidebar,
    dividerColumn: sidebar ? w - sidebarWidth - 1 : null,
    input,
    footer,
  };
}
