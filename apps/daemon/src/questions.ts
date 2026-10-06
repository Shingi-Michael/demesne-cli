import type { UserAnswer } from "@demesne/protocol";

interface PendingQuestions {
  turnId: string;
  count: number;
  resolve: (answers: UserAnswer[]) => void;
  reject: (error: unknown) => void;
  timeout?: ReturnType<typeof setTimeout>;
  paused: boolean;
  onPause?: () => void;
  cleanup: () => void;
}

/// Inactivity pauses the interview; it never supplies an invented answer.
export const QUESTION_TIMEOUT_MS = 30 * 60_000;

/// Questions the agent has put to the user (`ask_user`) and is waiting on.
/// Human input is explicit. A paused request can be resumed or cancelled.
export class QuestionBroker {
  private readonly pending = new Map<string, PendingQuestions>();

  constructor(private readonly timeoutMs = QUESTION_TIMEOUT_MS) {}

  wait(questionId: string, turnId: string, count: number, signal: AbortSignal, onPause?: () => void): Promise<UserAnswer[]> {
    if (signal.aborted) return Promise.reject(signal.reason);
    if (this.pending.has(questionId)) return Promise.reject(new Error("Question already has a waiter"));
    return new Promise((resolve, reject) => {
      const abort = () => this.cancel(questionId, signal.reason);
      const pending: PendingQuestions = { turnId,count,resolve,reject,paused:false,onPause,
        cleanup:()=>{clearTimeout(pending.timeout);signal.removeEventListener("abort",abort);} };
      this.pending.set(questionId,pending);
      signal.addEventListener("abort",abort,{once:true});
      this.arm(questionId,pending);
    });
  }

  private arm(id: string, pending: PendingQuestions) { pending.timeout=setTimeout(()=>this.pause(id),this.timeoutMs); }
  has(id: string): boolean { return this.pending.has(id); }
  isPaused(id: string): boolean { return this.pending.get(id)?.paused ?? false; }
  pause(id: string, notify = true): boolean {
    const pending=this.pending.get(id); if (!pending) return false;
    clearTimeout(pending.timeout); pending.paused=true;
    if (notify) pending.onPause?.(); return true;
  }
  resume(id: string): boolean {
    const pending=this.pending.get(id); if(!pending)return false;
    clearTimeout(pending.timeout);pending.paused=false;this.arm(id,pending);return true;
  }
  private cancel(id: string, reason: unknown) {
    const pending=this.pending.get(id);if(!pending)return;
    this.pending.delete(id);pending.cleanup();pending.reject(reason);
  }

  /// False when the question is no longer pending or the answers do not
  /// line up one-to-one with what was asked.
  resolve(questionId: string, answers: UserAnswer[]): boolean {
    const pending = this.pending.get(questionId);
    if (!pending || answers.length !== pending.count) return false;
    this.pending.delete(questionId);
    pending.cleanup();
    pending.resolve(answers);
    return true;
  }

  cancelTurn(turnId: string, reason: unknown): void {
    for (const [questionId, pending] of this.pending) {
      if (pending.turnId !== turnId) continue;
        this.cancel(questionId,reason);
    }
  }
}
