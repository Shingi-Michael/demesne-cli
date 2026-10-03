import type { Writable } from "node:stream";
export class PipeWriter {
  constructor(stream: Writable, onClose: (error?: Error & { code?: string }) => void);
  readonly closed: boolean;
  write(data: string | Uint8Array, done?: () => void): boolean;
  close(error?: Error): void;
}
export function isDisconnect(error?: Error & { code?: string }): boolean;
