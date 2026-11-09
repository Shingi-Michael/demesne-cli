/// Files in the composer (pass 205 A). Any file can be attached, not just
/// pictures: each shows as a chip with its kind on a coloured square, its
/// name and its size. One that can't be read says so in red and isn't sent.
const h = (value: unknown) =>
  String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

/// Pictures the composer fits and sends as images; anything else is a file.
export const PICTURE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/heic", "image/heif"];
export const isPicture = (file: { type: string; name: string }) => PICTURE_TYPES.includes(file.type) || /\.hei[cf]$/i.test(file.name);
/// The window can carry about this much in one request (policy.ts).
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

const KINDS: [RegExp, string, string][] = [
  [/\.pdf$/i, "PDF", "pdf"],
  [/\.docx?$/i, "DOC", "doc"],
  [/\.(xlsx?|numbers)$/i, "XLS", "xls"],
  [/\.(pptx?|key)$/i, "PPT", "ppt"],
];

/// A file's mark: its kind on a colour (PDF red, Word blue, Excel green,
/// PowerPoint orange), else its ending on grey.
export function fileKind(name: string): { label: string; tone: string } {
  for (const [pattern, label, tone] of KINDS) if (pattern.test(name)) return { label, tone };
  const ending = /\.([a-z0-9]{1,4})$/i.exec(name)?.[1]?.toUpperCase();
  return { label: ending ?? "FILE", tone: "plain" };
}

export function sizeWord(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1).replace(/\.0$/, "")} MB`;
}

/// One chip. `remove` adds the × (the composer); `bad` is why it can't go.
export function fileChipHTML(file: { id?: string; filename: string; size?: number }, options: { remove?: string; bad?: string; small?: boolean } = {}): string {
  const kind = fileKind(file.filename);
  const sub = options.bad ?? (file.size != null ? sizeWord(file.size) : "");
  const x = options.remove ? `<button type="button" class="fc-x" data-action="${h(options.remove)}" data-args="${h(JSON.stringify({ id: file.id }))}" aria-label="Remove ${h(file.filename)}">×</button>` : "";
  return `<span class="fc${options.small ? " small" : ""}${options.bad ? " bad" : ""}" title="${h(file.filename)}"><span class="fc-k ${kind.tone}" aria-hidden="true">${h(kind.label)}</span><span class="fc-nm"><span>${h(file.filename)}</span>${sub ? `<small>${h(sub)}</small>` : ""}</span>${x}</span>`;
}

/// Why a file the daemon refused can't go, in a few words for its chip.
export function refusal(message: string, name: string): string {
  const why = message.replace(/^.*?can't be read:\s*/i, "").replace(/^.*?:\s*(?=[A-Z])/, "").trim();
  if (/30 MB|20 MB/.test(why)) return "too big · up to 20 MB";
  const ending = /\.([a-z0-9]{1,5})$/i.exec(name)?.[1]?.toLowerCase();
  if (/scanned/i.test(why)) return "can’t be read · a scan, no text";
  return `can’t be read${ending ? ` · ${ending}` : ""}`;
}
