/// Big pictures fit before they leave the window: a phone photo or a 5K
/// screenshot is redrawn at most `side` pixels on its long side (and under
/// the daemon's 40 megapixel decode limit), so any size can be attached or
/// shared. Small enough pictures pass through untouched.
export interface FitOptions { side: number; bytes: number; type?: "image/webp" | "image/jpeg" }

/// The size to draw at: the long side at most `side`, and no more than
/// 40 million pixels.
export function fitSize(width: number, height: number, side: number): { width: number; height: number } {
  const scale = Math.min(1, side / Math.max(width, height), Math.sqrt(40_000_000 / (width * height)));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

const asDataUrl = (blob: Blob) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result));
  reader.onerror = () => reject(reader.error);
  reader.readAsDataURL(blob);
});

/// The picture as a data URL, redrawn smaller when it is over `bytes` or
/// over `side` pixels. Throws when the picture can't be read.
export async function fitImage(file: Blob, options: FitOptions): Promise<{ url: string; type: string }> {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  try {
    const size = fitSize(bitmap.width, bitmap.height, options.side);
    if (file.size <= options.bytes && size.width === bitmap.width && size.height === bitmap.height) return { url: await asDataUrl(file), type: file.type };
    const canvas = new OffscreenCanvas(size.width, size.height);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("This picture could not be resized");
    context.imageSmoothingQuality = "high";
    context.drawImage(bitmap, 0, 0, size.width, size.height);
    const type = options.type ?? "image/webp";
    // Lower the quality until it fits, then give what we have.
    let blob: Blob | null = null;
    for (const quality of [0.92, 0.85, 0.75, 0.6]) {
      blob = await canvas.convertToBlob({ type, quality });
      if (blob.size <= options.bytes) break;
    }
    return { url: await asDataUrl(blob!), type };
  } finally { bitmap.close(); }
}
