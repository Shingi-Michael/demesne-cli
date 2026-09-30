/// New interactive sessions are called `Session 10:00:04 AM` until something
/// better is known. The first request names them, so Recent and History read
/// as the work done rather than clock times (Figma 1:2).

const PLACEHOLDER = /^Session \d{1,2}[:.]\d{2}([:.]\d{2})?(\s?[AaPp]\.?[Mm]\.?)?$/;

export function isPlaceholderTitle(title: string): boolean {
  return PLACEHOLDER.test(title.trim());
}

/// The request's first line, with `@path` mentions shortened to file names,
/// whitespace collapsed, and at most `limit` characters on a word boundary.
export function titleFromRequest(text: string, limit = 60): string {
  const line = text.split("\n").map((part) => part.trim()).find(Boolean) ?? "";
  const clean = line.replace(/(^|\s)@(\S+)/g, (_, space: string, path: string) => `${space}${path.slice(path.lastIndexOf("/") + 1)}`).replace(/\s+/g, " ").trim();
  if (clean.length <= limit) return clean;
  const cut = clean.slice(0, limit - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space >= limit / 2 ? cut.slice(0, space) : cut).replace(/[\s,.;:–-]+$/, "")}…`;
}
