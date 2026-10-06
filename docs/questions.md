# Questions and guided interviews

Demesne's `ask_user` tool pauses a model turn for a choice or preference that belongs to you. The model writes the question; you type the answer in the normal composer and press Enter. Suggestions are optional model-provided hints, not automatically accepted answers.

The model can request a guided interview:

```json
{
  "mode": "interview",
  "questions": [{ "question": "What mood should the interface have?" }]
}
```

Interview mode accepts one question per call. After receiving your typed answer, the model can ask a relevant follow-up, incorporate a refinement, or finish. It uses the same model turn and recorded conversation. Clarification mode still supports up to four questions; the composer collects their answers one at a time before the model continues.

Preference questions can run through the API without a workspace; that scope exposes only `ask_user`, with no filesystem tools. An interview also allows only one outstanding question in a turn, including when a model tries parallel tool calls.

## Pause, resume, and cancel

Use Pause to take a break, Resume to continue, or Cancel interview to stop the waiting turn. An unanswered question pauses after 30 minutes of inactivity; the model receives no fabricated answer or instruction to guess. Typing an answer explicitly resumes a paused question. Interview questions cannot be silently skipped.

Question text, progress, and drafts are saved privately in SQLite. A local composer cache protects the last keystrokes during a webview reload. Question replies are separate from a queued coding prompt, so answering does not overwrite or submit that prompt. An answer is bound to its question ID, index, and revision; stale and duplicate submissions are rejected.

Closing the app leaves daemon-owned work alive. If the daemon stops, an unfinished question is restored paused. Your explicit answer starts a continuation from the saved request, prior findings, and recorded answers; the interrupted model request is not silently replayed. Cancelling closes the question instead.

## Protocol

`GET /v1/sessions/ID` includes `pendingQuestions`. `POST /v1/questions/ID` accepts `answer`, `draft`, `pause`, `resume`, or `cancel` actions. All actions include the current revision; answer and draft actions also identify the current index. Older callers can still submit a complete `answers` array.

The state changes are journaled as `question.requested`, `question.updated`, `question.resolved`, and `question.cancelled`. Storage schema 8 adds the `user_questions` table. The caller never receives permission to infer a missing interview preference merely because time elapsed.

[`/themefy`](themes.md) uses this infrastructure for adaptive color interviews. Its restricted palette workflow validates, saves and applies the theme after your answers; `ask_user` handles the questions and their durable lifecycle.

Implementation: [tool definition](../apps/daemon/src/tools.ts), [live waiter](../apps/daemon/src/questions.ts), [durable state](../packages/storage/src/questions.ts), and [composer](../apps/graphics/live.ts).
