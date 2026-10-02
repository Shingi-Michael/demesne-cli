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
}
export interface CommandsResponse {
  queuePosition?: number | null;
  revision: number;
  commands: CommandRecord[];
  capturedAt: string;
  fingerprint: WorkspaceFingerprint;
  unchanged?: boolean;
}
