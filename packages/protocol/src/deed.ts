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

/// A word in a sentence that is a value in the code: a number to drag, or a
/// word with a few real choices. `code` is the line as it was pinned, so a
/// change finds the same line again even after it moves.
export interface DeedValue {
  id: string;
  /// The word as the sentence says it ("20", "three", "Enter").
  text: string;
  path: string;
  line: number;
  /// The token on that line it stands for ("20", "3", "\"Enter\"").
  literal: string;
  code: string;
  kind: "number" | "choice";
  /// For a choice: each word the sentence can say, and the code token it means.
  choices?: { word: string; literal: string }[];
}

/// Running the tests that hold a sentence.
export interface DeedProof {
  state: "running" | "passed" | "failed";
  at: string;
  files: string[];
  passed?: number;
  failed?: number;
  ms?: number;
  /// What failed, in a line or two of the runner's own words.
  detail?: string;
  /// A changed value that failed its proof was put back.
  putBack?: boolean;
}

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
  /// Live words, and the test files that hold the sentence.
  values?: DeedValue[];
  tests?: string[];
  proof?: DeedProof;
  /// A chat is writing the test that proves it.
  covering?: boolean;
  /// The last value changed here, until it is undone or the line moves on.
  undo?: { path: string; before: string; after: string; text: string; values: DeedValue[] };
  updatedAt: string;
}

/// One change to the page, kept so the week can be read back: who made it,
/// and the words before and after.
export interface DeedChange {
  at: string;
  id: string;
  section: string;
  kind: "added" | "words" | "broke" | "mended" | "removed";
  /// you: made from the page; code: the code under it changed.
  who: "you" | "code";
  was?: string;
  text: string;
}

export interface Deed {
  workspace: string;
  writtenAt: string | null;
  /// Writing it from the code: the chat doing it, or why it stopped.
  writing: { sessionId: string; status: "running" | "failed"; error?: string } | null;
  sections: string[];
  sentences: DeedSentence[];
  /// Prove it: each sentence's tests, in turn.
  proving?: { total: number; done: number; failed: number; running: boolean; at: string } | null;
  /// What changed and when, newest last.
  log?: DeedChange[];
}

export interface DeedResponse { deed: Deed }

/// The lines of code under a sentence, as they are now.
export interface DeedPeek { id: string; path: string; line: number; lines: { n: number; text: string }[] }
export interface DeedPeekResponse { peek: DeedPeek | null }

export type DeedAction =
  | { action: "write" }
  | { action: "make"; id?: string; text: string }
  | { action: "wish"; text: string }
  | { action: "check"; id: string }
  | { action: "words"; id: string }
  | { action: "fix"; id: string }
  /// A chat writes the test that proves a sentence nothing tests.
  | { action: "cover"; id: string }
  | { action: "seen"; id: string }
  | { action: "remove"; id: string }
  /// A live word takes a new value: a number, or one of its choices.
  | { action: "set"; id: string; value: string; to: number | string }
  | { action: "undo"; id: string }
  /// One sentence's tests, or every sentence's when no id is given.
  | { action: "prove"; id?: string }
  | { action: "stop" };
export type DeedRequest = DeedAction & { workspace: string };
