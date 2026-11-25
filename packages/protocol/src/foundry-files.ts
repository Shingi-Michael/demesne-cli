/// Piece 6 of pass 274, out in the right file: the files Save a copy can
/// give each kind. The first is what the button saves, with no menu; the
/// rest are offered once, in words, on the quiet line after the save.

export type CopyFormat = "pptx" | "docx" | "xlsx" | "pdf" | "html" | "png" | "csv" | "json" | "svg" | "md" | "jsx" | "mmd" | "code" | "txt";

const FORMATS: Record<string, CopyFormat[]> = {
  deck: ["pptx", "pdf", "html"], doc: ["docx", "pdf", "html"], dashboard: ["html", "pdf", "png"], sheet: ["xlsx", "csv"], html: ["html", "png"],
  react: ["html", "jsx"], mermaid: ["html", "mmd"], svg: ["svg"], markdown: ["md"], board: ["json"], code: ["code"],
};
/// The files a kind can be saved as, the default first.
export const copyFormats = (kind: string): CopyFormat[] => FORMATS[kind] ?? ["txt"];
/// "Also as …": how the line offers another format.
export const COPY_WORDS: Partial<Record<CopyFormat, string>> = { pptx: "PowerPoint", docx: "Word", xlsx: "Excel", pdf: "PDF", html: "a web page", png: "a picture", csv: "CSV", jsx: "the .jsx", mmd: "the .mmd" };
/// The formats to offer after one was saved: the others, in order.
export const otherFormats = (kind: string, saved: CopyFormat): CopyFormat[] => copyFormats(kind).filter((format) => format !== saved && COPY_WORDS[format]);
