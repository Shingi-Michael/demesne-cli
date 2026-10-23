/// The Deed: a project's plain-sentence description, written from the code
/// and kept true both ways. Each sentence is tied to the code that makes it
/// true; a change there marks it to check, and editing it changes the code.

/// Where a sentence is made true: a file, and the lines quoted from it when
/// the sentence rests on particular code. The quote is how a change there is
/// noticed even after the lines move.
export interface DeedAnchor { path: string; line?: number; quote?: string; hash?: string }

/// true: held by its code. check: its code changed since it was last true.
/// checking: being read against its code. false: no longer true (why, and
/// words that would be true). working: a chat is making it true. failed: that
/// chat ended without making it true. wish: written but not built yet.
export type DeedState = "true" | "check" | "checking" | "false" | "working" | "failed" | "wish";

export interface DeedSentence {
  id: string;
  section: string;
  text: string;
  anchors: DeedAnchor[];
  state: DeedState;
  /// What the sentence said before an edit that is being made true.
  was?: string;
  /// Why it is no longer true, or why making it true failed.
  why?: string;
  /// Words that would be true of the code as it is now.
  words?: string;
  /// The chat that is making (or last made) it true.
  sessionId?: string;
  /// When an edit was made true; the receipt shows until it is dismissed.
  madeAt?: string;
  files?: number;
  updatedAt: string;
}

export interface Deed {
  workspace: string;
  writtenAt: string | null;
  /// Writing it from the code: the chat doing it, or why it stopped.
  writing: { sessionId: string; status: "running" | "failed"; error?: string } | null;
  sections: string[];
  sentences: DeedSentence[];
}

export interface DeedResponse { deed: Deed }

export type DeedAction =
  | { action: "write" }
  | { action: "make"; id?: string; text: string }
  | { action: "wish"; text: string }
  | { action: "check"; id: string }
  | { action: "words"; id: string }
  | { action: "fix"; id: string }
  | { action: "seen"; id: string }
  | { action: "remove"; id: string };
export type DeedRequest = DeedAction & { workspace: string };
