/** Bun's compiled module paths use different virtual roots on Unix and Windows. */
export function isCompiledPath(path: string): boolean {
  return path.startsWith("/$bunfs/") || /^[a-z]:[\\/]~BUN[\\/]/i.test(path);
}
