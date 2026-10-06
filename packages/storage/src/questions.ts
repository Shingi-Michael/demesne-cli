import type { Database } from "bun:sqlite";
import { parseUserQuestions, type QuestionState, type QuestionMode, type UserQuestion, type UserAnswer, type QuestionActionRequest } from "@demesne/protocol";

interface Row {
  id: string; session_id: string; turn_id: string; tool_call_id: string;
  questions: string; answers: string; mode: QuestionMode; status: QuestionState["status"];
  draft: string; draft_version: number; revision: number; turn_status: string;
}
export class QuestionStateError extends Error {}

/** Durable human-input state, separate from a live model connection or window. */
export class QuestionRepository {
  constructor(private readonly db: Database, importLegacy = false) {
    db.run(`CREATE TABLE IF NOT EXISTS user_questions (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
      tool_call_id TEXT NOT NULL REFERENCES tool_calls(id) ON DELETE CASCADE,
      questions TEXT NOT NULL, answers TEXT NOT NULL DEFAULT '[]', mode TEXT NOT NULL,
      status TEXT NOT NULL, draft TEXT NOT NULL DEFAULT '', draft_version INTEGER NOT NULL DEFAULT 0,
      revision INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
    ); CREATE INDEX IF NOT EXISTS user_questions_session ON user_questions(session_id, created_at);`);
    if(importLegacy) {
      const rows=db.query(`SELECT e.session_id,e.turn_id,e.payload FROM events e JOIN tool_calls c
        ON c.id=json_extract(e.payload,'$.toolCallId') WHERE e.type='question.requested' AND c.status IN ('pending','running')
        AND NOT EXISTS(SELECT 1 FROM events r WHERE r.type='question.resolved' AND json_extract(r.payload,'$.questionId')=json_extract(e.payload,'$.questionId'))`).all() as {session_id:string;turn_id:string;payload:string}[];
      for(const row of rows){
        try {const value=JSON.parse(row.payload);if(typeof value.questionId !== "string" || this.get(value.questionId))continue;
          this.create(value.questionId,row.session_id,row.turn_id,value.toolCallId,parseUserQuestions(value.questions),"clarification");
        } catch { /* Preserve malformed legacy events for inspection without restoring an unusable prompt. */ }
      }
    }
  }
  create(id: string, sessionId: string, turnId: string, toolCallId: string, questions: UserQuestion[], mode: QuestionMode): QuestionState {
    this.db.query(`INSERT INTO user_questions (id,session_id,turn_id,tool_call_id,questions,mode,status,created_at)
      VALUES (?,?,?,?,?,?,'waiting',?)`).run(id,sessionId,turnId,toolCallId,JSON.stringify(questions),mode,new Date().toISOString());
    return this.get(id)!;
  }
  get(id: string): QuestionState | null {
    const row = this.db.query(`SELECT q.*, t.status AS turn_status FROM user_questions q JOIN turns t ON t.id=q.turn_id WHERE q.id=?`).get(id) as Row | null;
    return row ? this.map(row) : null;
  }
  list(sessionId: string): QuestionState[] {
    return (this.db.query(`SELECT q.*, t.status AS turn_status FROM user_questions q JOIN turns t ON t.id=q.turn_id
      WHERE q.session_id=? AND q.status IN ('waiting','paused') ORDER BY q.rowid`).all(sessionId) as Row[]).map(row=>this.map(row));
  }
  forTurn(turnId: string): QuestionState[] {
    return (this.db.query(`SELECT q.*,t.status AS turn_status FROM user_questions q JOIN turns t ON t.id=q.turn_id
      WHERE q.turn_id=? ORDER BY q.rowid`).all(turnId) as Row[]).map(row=>this.map(row));
  }
  private map(row: Row): QuestionState {
    return { id:row.id,sessionId:row.session_id,turnId:row.turn_id,toolCallId:row.tool_call_id,
      questions:JSON.parse(row.questions),answers:JSON.parse(row.answers),mode:row.mode,status:row.status,
      draft:row.draft,draftVersion:row.draft_version,revision:row.revision,
      interrupted: !["queued","running"].includes(row.turn_status) };
  }
  change(id: string, action: QuestionActionRequest): QuestionState {
    return this.db.transaction(() => {
      const current = this.get(id);
      if (!current) throw new QuestionStateError("Question not found");
      if (!["waiting","paused"].includes(current.status)) throw new QuestionStateError("This question is already closed");
      if (current.revision !== action.revision) throw new QuestionStateError("The question changed. Review it before answering");
      if (action.action === "answer" || action.action === "draft") {
        if (action.index !== current.answers.length) throw new QuestionStateError("This answer belongs to an earlier question");
        if (current.answers.length >= current.questions.length) throw new QuestionStateError("Your answers are already saved. Resume to continue");
        if (action.action === "draft") {
          if (action.draftVersion <= current.draftVersion) return current;
          this.db.query("UPDATE user_questions SET draft=?,draft_version=? WHERE id=?").run(action.text,action.draftVersion,id);
        } else {
          if (current.mode === "interview" && action.answer.source === "skipped") throw new QuestionStateError("Interview questions need an answer or explicit cancellation");
          this.db.query("UPDATE user_questions SET answers=?,status='waiting',draft='',draft_version=0,revision=revision+1 WHERE id=?")
            .run(JSON.stringify([...current.answers,action.answer]),id);
        }
      } else {
        const status = action.action === "cancel" ? "cancelled" : action.action === "pause" ? "paused" : "waiting";
        this.db.query("UPDATE user_questions SET status=?,revision=revision+1 WHERE id=?").run(status,id);
      }
      return this.get(id)!;
    })();
  }
  finish(id: string, answers: UserAnswer[]): QuestionState {
    const current = this.get(id);
    if (!current || current.status === "cancelled") throw new QuestionStateError("This question is no longer pending");
    if (answers.length !== current.questions.length) throw new QuestionStateError("Answers must match every question");
    if (current.mode === "interview" && answers.some(a=>a.source === "skipped")) throw new QuestionStateError("Interview questions need an answer or explicit cancellation");
    this.db.query("UPDATE user_questions SET status='answered',answers=?,draft='',revision=revision+1 WHERE id=?").run(JSON.stringify(answers),id);
    return this.get(id)!;
  }
  pauseTurn(turnId: string): QuestionState[] {
    this.db.query("UPDATE user_questions SET status='paused',revision=revision+1 WHERE turn_id=? AND status='waiting'").run(turnId);
    return (this.db.query(`SELECT q.*,t.status AS turn_status FROM user_questions q JOIN turns t ON t.id=q.turn_id
      WHERE q.turn_id=? AND q.status='paused'`).all(turnId) as Row[]).map(row=>this.map(row));
  }
  recover(): void {
    this.db.query(`UPDATE user_questions SET status='cancelled',draft='',revision=revision+1 WHERE status IN ('waiting','paused')
      AND EXISTS(SELECT 1 FROM turns t WHERE t.id=user_questions.turn_id AND t.status IN ('cancelled','completed'))`).run();
    // A crash can land after answers commit but before their tool result does.
    // Keep those answers resumable instead of losing them from model history.
    this.db.query(`UPDATE user_questions SET status='paused',revision=revision+1 WHERE status='answered'
      AND EXISTS(SELECT 1 FROM turns t WHERE t.id=user_questions.turn_id AND t.status='interrupted')
      AND NOT EXISTS(SELECT 1 FROM tool_calls c JOIN model_messages m ON m.turn_id=c.turn_id
        AND m.tool_call_id=c.provider_tool_call_id AND m.role='tool' WHERE c.id=user_questions.tool_call_id)`).run();
    this.db.query("UPDATE user_questions SET status='paused',revision=revision+1 WHERE status='waiting'").run();
  }
}
