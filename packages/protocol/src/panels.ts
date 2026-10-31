export type ReviewScope = "turn" | "session" | "workspace";
export interface ReviewFile {
  path: string;
  before: string | null;
  after: string | null;
  beforeExists: boolean;
  afterExists: boolean;
  state: string;
  edits: number;
  unavailable?: string;
  undo?: { turnId: string; available: boolean; reason?: string };
}
export interface ReviewResponse {
  scope: ReviewScope;
  turnId: string | null;
  files: ReviewFile[];
  capturedAt: string;
  truncated: boolean;
  description: string;
}
export interface WorkspaceFingerprint {
  value: string | null;
  files: number;
  scope: string;
  checkedAt?: string;
  reason?: string;
}
export type CommandState =
  | "running"
  | "stopping"
  | "completed"
  | "failed"
  | "stopped"
  | "interrupted";
export interface CommandRecord {
  id: string;
  sessionId: string;
  turnId: string;
  toolCallId: string | null;
  rerunOf: string | null;
  argv: string[];
  cwd: string;
  background: boolean;
  check: boolean;
  pid: number | null;
  status: CommandState;
  startedAt: string;
  completedAt: string | null;
  lastOutputAt: string | null;
  outputLoaded?: boolean;
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  truncated: boolean;
  fingerprint: WorkspaceFingerprint | null;
  freshness: "current" | "outdated" | "unknown";
  freshnessReason?: string;
  /// The local address a running background command serves, read from its
  /// output ("Local: http://localhost:5173/"), for the desktop's live preview.
  serves?: string | null;
}
/// The first loopback http(s) address in a command's output, with colour
/// codes stripped and 0.0.0.0 shown as localhost.
export function servedURL(output: string): string | null {
  const plain = output.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
  const match = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d{2,5})?(?=[/\s"'<>()\]]|$)(?:\/[^\s"'<>()\]]*)?/.exec(plain);
  if (!match) return null;
  try {
    const url = new URL(match[0].replace("//0.0.0.0", "//localhost"));
    return url.href;
  } catch {
    return null;
  }
}
export interface CommandsResponse {
  queuePosition?: number | null;
  revision: number;
  commands: CommandRecord[];
  capturedAt: string;
  fingerprint: WorkspaceFingerprint;
  unchanged?: boolean;
}

/// How one model has actually done in this daemon's recorded work: real
/// turns, tool calls, speed, checks and Drive runs, not a benchmark.
export interface ModelScore {
  provider: string; model: string;
  /// Served from this machine (Ollama, LM Studio, llama.cpp).
  local: boolean;
  /// Turns it answered, and how they ended. Turns you stopped count in neither.
  turns: number; finished: number; failed: number;
  toolCalls: number; toolErrors: number;
  /// Medians over its requests: generation speed after the first token, and
  /// the wait for that first token.
  tokensPerSecond: number | null; firstTokenMs: number | null;
  /// Turns that ran a check, and how many of those ended on a passing one.
  checkedTurns: number; passingTurns: number;
  /// Drive proposals it ran, and how many you applied or opened as a PR.
  driveRuns: number; driveLanded: number;
  lastUsed: string;
  /// Turns it answered each day, oldest first, one entry per day of the window.
  daily?: number[];
}
export interface ModelScoreboardResponse { days: number; workspace: string | null; models: ModelScore[] }
