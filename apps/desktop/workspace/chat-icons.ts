/// Chat icons (pass 236 D, "colour by kind", 2026-11-18): one set drawn for
/// Demesne on a 16px grid with a 1.5px line, in place of stock icons drawn
/// for 24px and shrunk. A closed shape carries a faint fill of its own
/// colour (`.tint`, workspace.css). Steps colour by kind (`k-read`,
/// `k-edit`, …); every other icon stays grey. An agent's step shows the
/// agent's face, never a symbol.

const FILE = "M9.25 2.25h-4.5a1.5 1.5 0 0 0-1.5 1.5v8.5a1.5 1.5 0 0 0 1.5 1.5h6.5a1.5 1.5 0 0 0 1.5-1.5V5.75z";
const CORNER = '<path d="M9.25 2.25v2.5a1 1 0 0 0 1 1h2.5"/>';
const FOLDER = "M2.25 4.25a1.5 1.5 0 0 1 1.5-1.5h2.3a1.5 1.5 0 0 1 1.2.6l.85 1.15h4.15a1.5 1.5 0 0 1 1.5 1.5v5.75a1.5 1.5 0 0 1-1.5 1.5h-8.5a1.5 1.5 0 0 1-1.5-1.5z";
const PENCIL = "M10.75 2.75 13.25 5.25 5.5 13 2.5 13.5 3 10.5z";
const CUBE = "M8 2 13.25 5v6L8 14l-5.25-3V5z";
/// A shape twice: once as its faint fill, once as its line.
const both = (tag: string) => tag.replace(/^<(\w+)/, '<$1 class="tint"') + tag;

export const SHAPES = {
  read: both(`<path d="${FILE}"/>`) + CORNER,
  search: both('<circle cx="7.25" cy="7.25" r="4.5"/>') + '<path d="m10.5 10.5 3.25 3.25"/>',
  edit: both(`<path d="${PENCIL}"/>`) + '<path d="m9 4.5 2.5 2.5"/>',
  run: '<rect class="tint" x="1.25" y="2.25" width="13.5" height="11.5" rx="2.5"/><path d="m4.25 5.75 2.25 2.25-2.25 2.25"/><path d="M8.5 10.5h3.25"/>',
  list: both(`<path d="${FOLDER}"/>`),
  ask: both('<circle cx="8" cy="8" r="5.75"/>') + '<path d="M6.4 6.5a1.65 1.65 0 1 1 2.5 1.4c-.55.33-.9.7-.9 1.35"/><path d="M8 11.25h.01"/>',
  mail: both('<rect x="2" y="3.5" width="12" height="9" rx="2"/>') + '<path d="m2.75 5.25 5.25 3.75 5.25-3.75"/>',
  other: both('<circle cx="8" cy="8" r="5.75"/>') + '<path d="M8 5.5v3"/><path d="M8 10.75h.01"/>',
  copy: both('<rect x="5.75" y="5.75" width="8" height="8" rx="2"/>') + '<path d="M10.25 3.75a1.5 1.5 0 0 0-1.5-1.5h-5a1.5 1.5 0 0 0-1.5 1.5v5a1.5 1.5 0 0 0 1.5 1.5"/>',
  undo: '<path d="M6 3.25 2.75 6.5 6 9.75"/><path d="M2.75 6.5h6.5a3.5 3.5 0 0 1 0 7H7.5"/>',
  again: '<path d="M12.5 6A5 5 0 1 0 12.3 10.5"/><path d="M12.5 2.75V6H9.25"/>',
  chev: '<path d="m4 6.25 4 4 4-4"/>',
  check: '<circle class="tint" cx="8" cy="8" r="6.5"/><path d="m5.25 8.25 2 2 3.75-4"/>',
  plus: '<path d="M8 3v10M3 8h10"/>',
  send: '<circle class="tint" cx="8" cy="8" r="7"/><path d="M8 11.25V4.75M5.5 7.25 8 4.75l2.5 2.5"/>',
  machine: both('<rect x="2.25" y="3" width="11.5" height="8" rx="1.5"/>') + '<path d="M5.75 13.5h4.5M8 11v2.5"/>',
  branch: both('<circle cx="4.5" cy="11.75" r="1.75"/>') + both('<circle cx="11.5" cy="4.25" r="1.75"/>') + '<path d="M4.5 2.5V10"/><path d="M11.5 6a5.75 5.75 0 0 1-5.25 5.7"/>',
  model: both(`<path d="${CUBE}"/>`) + '<path d="M2.75 5 8 8l5.25-3M8 8v6"/>',
  changes: both(`<path d="${FILE}"/>`) + CORNER + '<path d="M6.25 8.25h3.5M8 6.5V10M6.25 11.75h3.5"/>',
  person: both('<circle cx="8" cy="5.25" r="2.75"/>') + '<path class="tint" d="M2.75 13.75a5.25 5.25 0 0 1 10.5 0z"/><path d="M2.75 13.75a5.25 5.25 0 0 1 10.5 0"/>',
  context: both('<circle cx="8" cy="8" r="5.75"/>') + '<path d="M8 2.25V8l4.75 3.25"/>',
  preview: both('<rect x="2" y="2.75" width="12" height="10.5" rx="1.75"/>') + '<path d="M2 5.75h12"/>',
  connectors: both('<path d="M4.5 5.5h7v2a3.5 3.5 0 0 1-7 0z"/>') + '<path d="M6 2.5v3M10 2.5v3M8 11v2.75"/>',
} as const;
export type ChatIcon = keyof typeof SHAPES;

/// One icon as markup; `extra` adds classes (a step's kind, `chev`, …).
export const chatIcon = (name: ChatIcon, extra = "") =>
  `<svg class="ico ico16${extra ? ` ${extra}` : ""}" viewBox="0 0 16 16" aria-hidden="true">${SHAPES[name]}</svg>`;

/// Demesne's own agent: the d. mark on a round tile, the size of an icon.
export const DEMESNE_FACE = '<span class="ask-d step-face" aria-hidden="true"><svg viewBox="0 0 100 100"><use href="#demesne-mark"/></svg></span>';

/// A fold mark that turns over when open (in place of ▴ / ▾).
export const foldMark = (open: boolean) => chatIcon("chev", open ? "chev up" : "chev");
