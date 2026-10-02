import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import type { DemesneStore } from "@demesne/storage";
import type {
  ReviewFile,
  ReviewResponse,
  ReviewScope,
  ToolFileChange,
  WorkspaceFingerprint,
} from "@demesne/protocol";
import { isSensitivePath, resolveWorkspacePath } from "./tools.ts";
const FILE_LIMIT = 128 * 1024,
  TOTAL_LIMIT = 2 * 1024 * 1024;
const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
function git(root: string, args: string[], maxBuffer = 2 * 1024 * 1024) {
  return execFileSync(
    "git",
    ["-C", root, "-c", "core.fsmonitor=false", ...args],
    {
      timeout: 5000,
      maxBuffer,
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    },
  );
}
function text(bytes: Uint8Array | null): {
  content: string | null;
  reason?: string;
} {
  if (bytes === null) return { content: null };
  if (bytes.length > FILE_LIMIT)
    return {
      content: null,
      reason:
        "File exceeds the 128 KiB diff limit; open the current file for more context.",
    };
  if (bytes.includes(0)) return { content: null, reason: "Binary file" };
  try {
    return { content: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch {
    return { content: null, reason: "Not UTF-8 text" };
  }
}
function current(root: string, path: string) {
  const absolute = resolveWorkspacePath(root, path, true, true);
  if (!existsSync(absolute))
    return {
      exists: false,
      content: null as string | null,
      hash: null as string | null,
    };
  const stat = lstatSync(absolute);
  if (!stat.isFile() || stat.nlink > 1)
    return {
      exists: true,
      content: null,
      hash: null,
      reason: "Not a regular file",
    };
  if (stat.size > 2 * 1024 * 1024)
    return {
      exists: true,
      content: null,
      hash: null,
      reason: "File exceeds the viewer limit",
    };
  const bytes = readFileSync(absolute);
  return { exists: true, hash: hash(bytes), ...text(bytes) };
}
/** Source fingerprints are bounded, exclude protected paths, and never claim
 * freshness if the inventory or content could not be read completely. */
export function workspaceFingerprint(root: string): WorkspaceFingerprint {
  let paths: string[];
  let scope = "Git tracked and non-ignored files, excluding protected paths";
  try {
    paths = [
      ...new Set(
        git(
          root,
          [
            "ls-files",
            "-z",
            "--cached",
            "--others",
            "--exclude-standard",
            "--",
            ".",
          ],
          4 * 1024 * 1024,
        )
          .toString("utf8")
          .split("\0")
          .filter(Boolean),
      ),
    ];
  } catch {
    scope =
      "Workspace files excluding generated, dependency and protected paths";
    paths = [];
    const stack = [root],
      skip = new Set([
        ".git",
        "node_modules",
        ".venv",
        "venv",
        "dist",
        "build",
        "coverage",
        ".next",
        "target",
        "__pycache__",
        "Pods",
        "DerivedData",
      ]);
    let visited = 0;
    try {
      while (stack.length) {
        const dir = stack.pop()!;
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (++visited > 20000)
            throw new Error("File inventory exceeds the review limit");
          const path = join(dir, entry.name),
            rel = relative(root, path);
          if (isSensitivePath(rel)) continue;
          if (entry.isDirectory() && !skip.has(entry.name)) stack.push(path);
          else if (entry.isFile()) paths.push(rel);
        }
      }
    } catch (error) {
      return { value: null, files: paths.length, scope, reason: String(error) };
    }
  }
  paths = paths.filter((path) => !isSensitivePath(path)).sort();
  if (paths.length > 10000)
    return {
      value: null,
      files: paths.length,
      scope,
      reason: "More than 10,000 source files",
    };
  const digest = createHash("sha256");
  let bytes = 0;
  try {
    for (const path of paths) {
      const absolute = resolveWorkspacePath(root, path, true, true);
      if (!existsSync(absolute)) {
        digest.update(JSON.stringify([path, "absent"]));
        continue;
      }
      const stat = lstatSync(absolute);
      if (!stat.isFile() || stat.nlink > 1)
        throw new Error(`Cannot fingerprint ${path}`);
      bytes += stat.size;
      if (bytes > 64 * 1024 * 1024)
        throw new Error("Source content exceeds the 64 MiB review budget");
      const content = readFileSync(absolute);
      digest.update(
        JSON.stringify([path, "file", stat.mode & 0o111, content.length]),
      );
      digest.update(content);
    }
    return { value: digest.digest("hex"), files: paths.length, scope };
  } catch (error) {
    return {
      value: null,
      files: paths.length,
      scope,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
export function workspaceReview(
  store: DemesneStore,
  sessionId: string,
  scope: ReviewScope,
  turnId?: string,
): ReviewResponse {
  const session = store.getSession(sessionId);
  if (!session?.workspace) throw new Error("Session has no workspace");
  const root = session.workspace.root;
  if (scope === "turn" && !session.turns.some((turn) => turn.id === turnId))
    throw new Error("Turn not found in this session");
  const files = new Map<string, ReviewFile>();
  let truncated = false;
  if (scope === "workspace") {
    let prefix: string;
    try {
      prefix = git(root, ["rev-parse", "--show-prefix"]).toString().trim();
    } catch {
      throw new Error(
        "Workspace comparison requires a Git repository. Use Session to review recorded edits.",
      );
    }
    let hasHead = true;
    try {
      git(root, ["rev-parse", "--verify", "HEAD"]);
    } catch {
      hasHead = false;
    }
    const changed = hasHead
      ? git(root, [
          "diff",
          "--name-only",
          "--no-renames",
          "-z",
          "HEAD",
          "--",
          ".",
        ])
          .toString()
          .split("\0")
          .map((path) =>
            path.startsWith(prefix) ? path.slice(prefix.length) : "",
          )
      : git(root, ["ls-files", "--cached", "-z", "--", "."])
          .toString()
          .split("\0");
    const untracked = git(root, [
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
      "--",
      ".",
    ])
      .toString()
      .split("\0");
    const paths = [
      ...new Set(
        [...changed, ...untracked].filter(
          (path) => path && !isSensitivePath(path),
        ),
      ),
    ].sort();
    truncated = paths.length > 200;
    for (const path of paths.slice(0, 200)) {
      let before: Buffer | null = null;
      if (hasHead) {
        try {
          before = git(root, ["show", `HEAD:${prefix}${path}`], FILE_LIMIT + 1);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOBUFS") {
            files.set(path, {
              path,
              before: null,
              after: null,
              beforeExists: true,
              afterExists: true,
              state: "workspace",
              edits: 0,
              unavailable: "Committed file exceeds diff limit",
            });
            continue;
          }
        }
      }
      try {
        const after = current(root, path),
          old = text(before);
        files.set(path, {
          path,
          before: old.content,
          after: after.content,
          beforeExists: before !== null,
          afterExists: after.exists,
          state: "workspace",
          edits: 0,
          ...(old.reason || after.reason
            ? { unavailable: old.reason ?? after.reason }
            : {}),
        });
      } catch (error) {
        files.set(path, {
          path,
          before: null,
          after: null,
          beforeExists: before !== null,
          afterExists: true,
          state: "unavailable",
          edits: 0,
          unavailable: String(error),
        });
      }
    }
  } else {
    const events = store.reviewEvents(
      sessionId,
      scope === "turn" ? turnId : undefined,
    );
    truncated = events.length > 10000;
    for (const event of events.slice(0, 10000)) {
      if (
        event.type === "tool.call_completed" &&
        Array.isArray(event.payload.changes)
      )
        for (const change of event.payload.changes as ToolFileChange[]) {
          if (typeof change.path !== "string" || isSensitivePath(change.path))
            continue;
          const old = files.get(change.path);
          files.set(change.path, {
            path: change.path,
            before: old ? old.before : change.before,
            after: change.after,
            beforeExists: old ? old.beforeExists : change.beforeExists,
            afterExists: change.afterExists,
            state: "applied",
            edits: (old?.edits ?? 0) + 1,
            ...(old?.unavailable || change.unavailable
              ? { unavailable: old?.unavailable ?? change.unavailable }
              : {}),
          });
        }
      if (
        event.type === "turn.reverted" &&
        event.turnId &&
        Array.isArray(event.payload.files)
      )
        for (const path of event.payload.files as string[]) {
          const file = files.get(path),
            snapshot = store
              .snapshotsForTurn(sessionId, event.turnId)
              ?.find((file) => file.path === path);
          if (!file || !snapshot) continue;
          const before = text(snapshot.data);
          file.after = before.content;
          file.afterExists = snapshot.existed;
          file.state = "reverted";
          file.unavailable = before.reason;
        }
    }
    const checkpoints = new Map<
      string,
      {
        turnId: string;
        snapshot: NonNullable<
          ReturnType<DemesneStore["snapshotsForTurn"]>
        >[number];
      }
    >();
    for (const turn of [...session.turns].reverse()) {
      if (scope === "turn" && turn.id !== turnId) continue;
      for (const snapshot of store.snapshotsForTurn(sessionId, turn.id) ?? [])
        if (!snapshot.revertedAt && !checkpoints.has(snapshot.path))
          checkpoints.set(snapshot.path, { turnId: turn.id, snapshot });
    }
    for (const file of files.values()) {
      const checkpoint = checkpoints.get(file.path);
      if (!checkpoint) continue;
      const { turnId, snapshot } = checkpoint;
      try {
        const live = current(root, file.path);
        const matches =
          snapshot.postExisted === live.exists &&
          (!live.exists || snapshot.postHash === live.hash);
        file.undo = {
          turnId,
          available: matches,
          reason: matches
            ? undefined
            : "Current file differs from the recorded result",
        };
      } catch {
        file.undo = {
          turnId,
          available: false,
          reason: "Current file could not be checked",
        };
      }
    }
  }
  let remaining = TOTAL_LIMIT;
  const selected = [...files.values()].slice(0, 200);
  truncated ||= files.size > selected.length;
  for (const file of selected) {
    const size =
      Buffer.byteLength(file.before ?? "") +
      Buffer.byteLength(file.after ?? "");
    if (size > remaining || size > FILE_LIMIT * 2) {
      file.before = file.after = null;
      file.unavailable = "Diff response limit reached; open the current file.";
      truncated = true;
    } else remaining -= size;
  }
  return {
    scope,
    turnId: scope === "turn" ? turnId! : null,
    files: selected,
    capturedAt: new Date().toISOString(),
    truncated,
    description:
      scope === "workspace"
        ? "Current working files compared with HEAD, including untracked files"
        : scope === "session"
          ? "Recorded session edits, including recorded undos"
          : "Recorded edits for this turn",
  };
}
