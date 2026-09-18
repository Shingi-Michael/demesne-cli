import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/// Compose a prompt in the user's editor.
///
/// `$VISUAL` wins over `$EDITOR`; both may carry arguments, which are split on
/// whitespace (the conventional interpretation). The terminal is handed to the
/// editor, the temporary file is read back, and the directory is always
/// removed. A non-zero editor exit (for example `:cq` in Vim) keeps the
/// original text so an aborted edit cannot discard the prompt.

export type EditorSpawn = (
  command: string[],
  options: { stdin: "inherit"; stdout: "inherit"; stderr: "inherit" },
) => { exited: Promise<number> };

export interface ExternalEditorOptions {
  env?: Record<string, string | undefined>;
  spawn?: EditorSpawn;
  temporaryRoot?: string;
}

export function resolveEditor(env: Record<string, string | undefined>): string[] {
  const configured = env.VISUAL?.trim() || env.EDITOR?.trim();
  if (!configured) return ["vi"];
  const parts = configured.split(/\s+/).filter(Boolean);
  return parts.length > 0 ? parts : ["vi"];
}

export async function composeInEditor(initial: string, options: ExternalEditorOptions = {}): Promise<string> {
  const spawn = options.spawn ?? ((command, spawnOptions) => Bun.spawn(command, spawnOptions));
  const directory = mkdtempSync(join(options.temporaryRoot ?? tmpdir(), "demesne-editor-"));
  const path = join(directory, "PROMPT.md");
  try {
    writeFileSync(path, initial, { mode: 0o600 });
    const child = spawn([...resolveEditor(options.env ?? process.env), path], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    const code = await child.exited;
    if (code !== 0) return initial;
    return readFileSync(path, "utf8").replace(/\n+$/, "");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}