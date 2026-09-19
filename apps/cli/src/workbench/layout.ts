/// Pure layout math for the full-screen workbench.
///
/// The frame has five regions: a one-line header, the conversation viewport, an
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
  const inputHeight = Math.min(inputLines, Math.max(1, h - 4));
  const input: Rect = { row: h - 1 - inputHeight, column: 0, height: inputHeight, width: w };
  const header: Rect = { row: 0, column: 0, height: 1, width: w };

  const showSidebar = sidebarMode !== "hidden" && w >= (sidebarMode === "wide" ? 80 : 100);
  const sidebarWidth = showSidebar ? Math.max(24, Math.min(38, Math.floor(w / 3))) : 0;
  const bodyTop = header.height;
  const bodyHeight = Math.max(1, h - header.height - inputHeight - 1);
  const conversationWidth = w - sidebarWidth - (showSidebar ? 1 : 0);
  const conversation: Rect = { row: bodyTop, column: 0, height: bodyHeight, width: conversationWidth };
  const sidebar: Rect | null = showSidebar
    ? { row: bodyTop, column: w - sidebarWidth, height: bodyHeight, width: sidebarWidth }
    : null;

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
