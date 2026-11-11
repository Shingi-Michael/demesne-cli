/// A file shown in a preview card (pass 188 A): the daemon reads it
/// (GET /v1/sessions/:id/preview?path=) and the desktop draws it.

export type FilePreviewKind = "sheet" | "doc" | "slides" | "pdf" | "image";

export interface FilePreviewBase {
  /// As asked, and where it is on disk (for Open in its own app).
  path: string;
  absolute: string;
  name: string;
  size: number;
  modifiedAt: string;
}
export type FilePreview = FilePreviewBase & (
  | { kind: "sheet"; sheets: { name: string; rows: string[][]; more: boolean }[] }
  | { kind: "doc"; blocks: { level: 0 | 1 | 2 | 3; text: string; bullet?: boolean }[]; more: boolean }
  | { kind: "slides"; slides: { title: string; lines: string[] }[]; ratio: number }
  /// The PDF itself, base64; the desktop draws its pages.
  | { kind: "pdf"; data: string }
  | { kind: "image"; data: string; mimeType: string }
);

/// The files a click opens a preview of.
export const PREVIEW_EXTENSIONS = ["xlsx", "csv", "tsv", "docx", "pptx", "pdf", "numbers", "pages", "key", "md", "markdown", "txt", "png", "jpg", "jpeg", "gif", "webp"] as const;
export const previewable = (path: string) => {
  const extension = /\.([a-z0-9]+)$/i.exec(path.trim())?.[1]?.toLowerCase();
  return Boolean(extension && (PREVIEW_EXTENSIONS as readonly string[]).includes(extension));
};
