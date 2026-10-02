export class TileEncoder {
  constructor(size?: number);
  workers: unknown[];
  encode(bgra: Buffer, path?: string | null): Promise<{ data: string; bytes: number } | { file: string; bytes: number }>;
  fail(error: Error): void;
}
export function toRGBA(bgra: Buffer): Buffer;
export function encodeSync(bgra: Buffer): Buffer;
