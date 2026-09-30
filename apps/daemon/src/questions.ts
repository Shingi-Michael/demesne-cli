import type { UserAnswer } from "@demesne/protocol";

interface PendingQuestions {
  turnId: string;
  count: number;
  resolve: (answers: UserAnswer[]) => void;
  reject: (error: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
}

/// How long the agent waits on the user before deciding for itself.
export const QUESTION_TIMEOUT_MS = 30 * 60_000;

/// Questions the agent has put to the user (`ask_user`) and is waiting on.
/// An unanswered question resolves as skipped, so a turn can never hang on it.
export class QuestionBroker {
  private readonly pending = new Map<string, PendingQuestions>();

  constructor(private readonly timeoutMs = QUESTION_TIMEOUT_MS) {}

  wait(questionId: string, turnId: string, count: number, signal: AbortSignal): Promise<UserAnswer[]> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(questionId);
        resolve(Array.from({ length: count }, () => ({ answer: null, source: "skipped" as const })));
      }, this.timeoutMs);
      this.pending.set(questionId, { turnId, count, resolve, reject, timeout });
      signal.addEventListener("abort", () => {
        if (this.pending.delete(questionId)) { clearTimeout(timeout); reject(signal.reason); }
      }, { once: true });
    });
  }

  /// False when the question is no longer pending or the answers do not
  /// line up one-to-one with what was asked.
  resolve(questionId: string, answers: UserAnswer[]): boolean {
    const pending = this.pending.get(questionId);
    if (!pending || answers.length !== pending.count) return false;
    this.pending.delete(questionId);
    clearTimeout(pending.timeout);
    pending.resolve(answers);
    return true;
  }

  cancelTurn(turnId: string, reason: unknown): void {
    for (const [questionId, pending] of this.pending) {
      if (pending.turnId !== turnId) continue;
      this.pending.delete(questionId);
      clearTimeout(pending.timeout);
      pending.reject(reason);
    }
  }
}
