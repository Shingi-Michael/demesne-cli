/// Scroll state for the conversation viewport.
///
/// The viewport holds fully rendered lines; the renderer rebuilds them when
/// content or width changes. Scroll offset is measured in lines from the
/// bottom, so new output keeps the view pinned unless the reader has scrolled
/// up, and resizing preserves the anchor.

export class ConversationViewport {
  private lines: string[] = [];
  private offset = 0;

  setLines(lines: readonly string[]): void {
    // Streaming appends must not drag a reader who has scrolled into history.
    if (this.offset > 0) this.offset = Math.max(0, this.offset + lines.length - this.lines.length);
    this.lines = [...lines];
    this.clamp();
  }

  get lineCount(): number {
    return this.lines.length;
  }

  get atBottom(): boolean {
    return this.offset === 0;
  }

  get scrollOffset(): number {
    return this.offset;
  }

  scrollUp(delta: number): void {
    this.offset += Math.max(0, delta);
    this.clamp();
  }

  scrollDown(delta: number): void {
    this.offset = Math.max(0, this.offset - Math.max(0, delta));
  }

  toBottom(): void {
    this.offset = 0;
  }

  toTop(): void {
    this.offset = this.lines.length;
    this.clamp();
  }

  revealLine(line: number, height: number): void {
    this.offset = Math.max(0, this.lines.length - Math.max(1, height) - Math.max(0, line));
  }

  /// Returns exactly `height` lines, padding the top with blanks when the
  /// content is shorter than the viewport. The offset is clamped to the
  /// largest value that still shows content, so scrolling past the top simply
  /// rests on the first lines.
  visible(height: number): string[] {
    const safeHeight = Math.max(1, height);
    const maxOffset = Math.max(0, this.lines.length - safeHeight);
    const offset = Math.min(this.offset, maxOffset);
    const end = Math.max(0, this.lines.length - offset);
    const start = Math.max(0, end - safeHeight);
    const slice = this.lines.slice(start, end);
    const padding = Math.max(0, safeHeight - slice.length);
    return [...Array.from({ length: padding }, () => ""), ...slice];
  }

  private clamp(): void {
    this.offset = Math.max(0, Math.min(this.offset, this.lines.length));
  }
}
