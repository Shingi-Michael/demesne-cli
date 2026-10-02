export interface CellPixels {
  width: number;
  height: number;
}

// The design's 14px body text was calibrated in an 18px terminal row. Cell
// reports are physical pixels: a 36px Retina row needs a 2× browser zoom to
// preserve the apparent size. Following cells also respects terminal zoom.
const REFERENCE_ROW_HEIGHT = 18;

export function parseDisplayScale(
  value: string | undefined,
): number | undefined {
  if (value === undefined || value === "auto") return undefined;
  const scale = Number(value);
  if (!Number.isFinite(scale) || scale < 0.5 || scale > 3)
    throw new Error("--scale must be auto or a number between 0.5 and 3");
  return scale;
}

export function displayScale(cell: CellPixels, explicit?: number): number {
  if (
    ![cell.width, cell.height].every(
      (value) => Number.isSafeInteger(value) && value > 0,
    )
  )
    throw new Error("The terminal reported an invalid character-cell size");
  return explicit ?? cell.height / REFERENCE_ROW_HEIGHT;
}
