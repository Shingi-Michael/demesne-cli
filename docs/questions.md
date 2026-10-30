# Questions and guided interviews

Demesne's `ask_user` tool asks you for a choice or preference that belongs to you. The model writes the question; suggestions are optional model-provided hints (the first is the one it suggests), each with an optional `details` line saying what picking it means, and `multiple: true` lets you pick several.

A clarification (the default mode, up to four questions) doesn't stop the agent. The question appears as a card in the conversation at the step that asked it, and the tool returns at once: the agent keeps doing the work that doesn't depend on the answer and, when only dependent work is left, says what waits and ends its turn. You answer in the card: pick a suggestion (1–4 while the composer is empty), pick several and choose Done, type your own answer in the card's field, choose Let it decide, or Dismiss it. The composer stays a normal composer, so a message you type there is a message (or steers the running turn), not an answer. If the turn is still running, the answer reaches it after its current step; otherwise it starts the next turn, which reads as "✓ Asked · question · answer". An answered question folds into that same one line among the steps. A pill above the composer leads back to a question you've scrolled past.

The model can request a guided interview:

```json
{
  "mode": "interview",
  "questions": [{ "question": "What mood should the interface have?" }]
}
```

Interview mode waits: the turn holds until you answer, in the card or the composer. It accepts one question per call. After receiving your typed answer, the model can ask a relevant follow-up, incorporate a refinement, or finish. It uses the same model turn and recorded conversation. A clarification with several questions collects their answers one at a time in its card, with the earlier answers listed above the current question.

Preference questions can run through the API without a workspace; that scope exposes only `ask_user`, with no filesystem tools. An interview also allows only one outstanding question in a turn, including when a model tries parallel tool calls.

## Pause, resume, and cancel

Use Pause to take a break, Resume to continue, or Cancel interview to stop the waiting turn. An unanswered question pauses after 30 minutes of inactivity; the model receives no fabricated answer or instruction to guess. Typing an answer explicitly resumes a paused question. Interview questions cannot be silently skipped.

Question text, progress, and drafts are saved privately in SQLite. A local composer cache protects the last keystrokes during a webview reload. Question replies are separate from a queued coding prompt, so answering does not overwrite or submit that prompt. An answer is bound to its question ID, index, and revision; stale and duplicate submissions are rejected.

Closing the app leaves daemon-owned work alive. An open clarification outlives its turn and a daemon restart; Dismiss closes it without touching the chat. If the daemon stops, an unfinished interview question is restored paused. Your explicit answer starts a continuation from the saved request, prior findings, and recorded answers; the interrupted model request is not silently replayed. Cancelling closes the question instead.

## Protocol

`GET /v1/sessions/ID` includes `pendingQuestions` (an open clarification carries `open: true`) and `answeredQuestions`. `POST /v1/questions/ID` accepts `answer`, `draft`, `pause`, `resume`, or `cancel` actions. All actions include the current revision; answer and draft actions also identify the current index. Older callers can still submit a complete `answers` array.

The state changes are journaled as `question.requested`, `question.updated`, `question.resolved`, and `question.cancelled`. Storage schema 8 adds the `user_questions` table. The caller never receives permission to infer a missing interview preference merely because time elapsed.

[`/themefy`](themes.md) uses this infrastructure for adaptive color interviews. Its restricted palette workflow validates, saves and applies the theme after your answers; `ask_user` handles the questions and their durable lifecycle.

Implementation: [tool definition](../apps/daemon/src/tools.ts), [live waiter](../apps/daemon/src/questions.ts), [durable state](../packages/storage/src/questions.ts), and [composer](../apps/desktop/workspace/live.ts).
