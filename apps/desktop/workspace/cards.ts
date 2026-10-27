/// The cards on the right show only while this chat uses them (pass 86 A):
/// Changes for the files this chat edited until they are committed, Preview
/// while a server it started runs, Context from half full, Connectors it
/// called. A chat that uses none of them has no column at all.

const relative = (path: string, root: string) =>
  (root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path).replace(/^\.\//, "");

/// The folder's uncommitted files that this chat changed itself; edits from
/// another chat or by hand are left to the branch chip.
export function chatChanges<F extends { path: string }>(files: readonly F[], touched: Iterable<string>, root: string): F[] {
  const mine = new Set([...touched].map((path) => relative(path, root)));
  return files.filter((file) => mine.has(relative(file.path, root)));
}

/// The context card waits until the chat is half full, like Compact now.
export const contextInUse = (percentage: number | null | undefined) => (percentage ?? 0) >= 50;

/// The connectors whose tools this chat called (`mcp__<server>__<tool>`).
export function chatServers<S extends { name: string }>(servers: readonly S[], toolNames: Iterable<string>): S[] {
  const names = [...toolNames];
  return servers.filter((server) => names.some((name) => name.startsWith(`mcp__${server.name}__`)));
}
