export function applyFooterScrollRegion(rows: number): string {
  const safeRows = Math.max(1, Math.floor(rows));
  const region = safeRows >= 6 ? `\x1b[1;${safeRows - 1}r` : "\x1b[r";
  return `\x1b7${region}\x1b8`;
}

export function resetFooterScrollRegion(rows: number): string {
  const safeRows = Math.max(1, Math.floor(rows));
  return `\x1b7\x1b[${safeRows};1H\x1b[2K\x1b[r\x1b8`;
}
