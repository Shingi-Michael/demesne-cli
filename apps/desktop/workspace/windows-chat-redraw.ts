/// Renderer-only: use the desktop bridge's existing mode and browser platform,
/// never a new preload API (installed apps can receive this with a UI update).
export function isWindowsDesktopChat(mode: string | undefined, platform: {
  platform?: string;
  userAgent?: string;
  userAgentData?: { platform?: string };
}): boolean {
  if (mode !== "desktop") return false;
  const name = platform.userAgentData?.platform || platform.platform;
  // In particular, "Darwin" is not Windows. Prefer the platform when supplied;
  // the UA is only a fallback for renderers which leave it empty.
  return name ? /^(?:Win32|Win64|Windows|WinCE)$/i.test(name) : /\bWindows\b/i.test(platform.userAgent ?? "");
}

/// Preserve the legacy write path everywhere else. On Windows, compare the
/// emitted HTML, not its browser-normalized serialization (entities can differ).
export class ChatDOM {
  private htmls = new WeakMap<HTMLElement, string>();
  constructor(private readonly preserve: boolean) {}

  html(node: HTMLElement, html: string) {
    if (!this.preserve || this.htmls.get(node) !== html) {
      if (!this.preserve || node.innerHTML !== html) node.innerHTML = html;
      this.htmls.set(node, html);
    }
  }
  text(node: HTMLElement, text: string) {
    if (!this.preserve || node.textContent !== text) node.textContent = text;
  }
  property<T, K extends keyof T>(node: T, key: K, value: T[K]) {
    if (!this.preserve || node[key] !== value) node[key] = value;
  }
  attribute(node: HTMLElement, name: string, value: string) {
    if (!this.preserve || node.getAttribute(name) !== value) node.setAttribute(name, value);
  }
  toggle(node: HTMLElement, name: string, on: boolean) {
    if (!this.preserve || node.classList.contains(name) !== on) node.classList.toggle(name, on);
  }
}

const MEASURE_STYLES = [
  "box-sizing", "width", "min-height", "max-height", "padding-top", "padding-right", "padding-bottom", "padding-left",
  "border-top-width", "border-right-width", "border-bottom-width", "border-left-width", "border-style",
  "font-family", "font-size", "font-weight", "font-style", "font-stretch", "font-variant", "font-feature-settings", "font-variation-settings",
  "line-height", "letter-spacing", "word-spacing", "text-indent", "text-transform", "text-rendering", "tab-size",
  "white-space", "overflow-wrap", "word-break", "direction", "writing-mode", "overflow-x", "overflow-y", "scrollbar-gutter",
] as const;

/// Measure the same 20px baseline and 132px cap offscreen, rather than shrinking
/// the focused textarea to read scrollHeight. Only write its final height if it
/// changed; otherwise its selection and internal/page scroll are left alone.
export class ComposerHeight {
  private mirror: HTMLTextAreaElement | null = null;
  private signature = "";

  resize(editor: HTMLTextAreaElement): boolean {
    if (!editor.clientWidth) return false; // A hidden composer is measured when shown.
    const style = editor.ownerDocument.defaultView!.getComputedStyle(editor);
    const values = MEASURE_STYLES.map(name => style.getPropertyValue(name));
    const signature = JSON.stringify([editor.value, editor.placeholder, editor.wrap, values]);
    if (signature === this.signature) return false;
    this.signature = signature;
    if (!this.mirror) {
      this.mirror = editor.ownerDocument.createElement("textarea");
      this.mirror.setAttribute("aria-hidden", "true");
      this.mirror.tabIndex = -1;
      this.mirror.style.cssText = "position:fixed;left:-100000px;top:0;visibility:hidden;pointer-events:none;height:20px;resize:none;";
      editor.ownerDocument.body.append(this.mirror);
    }
    const mirror = this.mirror;
    MEASURE_STYLES.forEach((name, index) => mirror.style.setProperty(name, values[index]!));
    mirror.wrap = editor.wrap;
    mirror.placeholder = editor.placeholder;
    mirror.value = editor.value;
    const height = `${Math.min(132, Math.max(20, mirror.scrollHeight))}px`;
    if (editor.style.height === height) return false;
    editor.style.height = height;
    return true;
  }
}

/// Draft/version/revision changes are not conversation changes. Keep this
/// projection explicit so new host bookkeeping cannot invalidate the turns.
export function threadConversationKey<T extends {
  id: string;
  runs: readonly unknown[];
  activeTurnId: string | null;
  approvals: readonly unknown[];
  questions: readonly unknown[];
  model?: string | null;
  provider?: unknown;
}>(chat: T | null, context: readonly unknown[]): string {
  return JSON.stringify([chat && [chat.id, chat.runs, chat.activeTurnId, chat.approvals, chat.questions, chat.model, chat.provider], context]);
}
