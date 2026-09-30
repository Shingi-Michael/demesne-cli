import type { UserAnswer, UserQuestion } from "@demesne/protocol";

/// The agent's questions (`ask_user`), answered one at a time (Figma 101:736).
/// Each question offers the agent's suggestions, recommended first and
/// preselected so Enter accepts it, then a row for the user's own words.
/// Nothing is sent until the last question is answered.
export interface QuestionPromptState {
  questions: readonly UserQuestion[];
  /// The question on screen.
  index: number;
  answers: (UserAnswer | null)[];
  /// Row on the current question: a suggestion, or `ownRow` for typed text.
  selected: number;
  /// The own-answer text for each question, kept when moving between them.
  typed: string[];
}

export interface QuestionKey { name?: string; ctrl?: boolean; meta?: boolean }

export type QuestionResult =
  | { state: QuestionPromptState }
  | { state: QuestionPromptState; answers: UserAnswer[] };

/// The row index of "Type your own answer" for a question.
export const ownRow = (question: UserQuestion): number => question.suggestions.length;

export function createQuestionPrompt(questions: readonly UserQuestion[]): QuestionPromptState {
  return { questions, index: 0, answers: questions.map(() => null), selected: defaultRow(questions[0]!), typed: questions.map(() => "") };
}

/// The recommended suggestion when there is one; otherwise straight to typing.
const defaultRow = (question: UserQuestion): number => question.suggestions.length ? 0 : ownRow(question);

/// The row that shows a recorded answer again when the user steps back.
function rowFor(question: UserQuestion, answer: UserAnswer | null): number {
  if (!answer) return defaultRow(question);
  if (answer.source === "suggestion" && answer.answer !== null) {
    const index = question.suggestions.indexOf(answer.answer);
    if (index >= 0) return index;
  }
  return answer.source === "typed" ? ownRow(question) : defaultRow(question);
}

const printable = (text: string, key: QuestionKey) => !key.ctrl && !key.meta && text.length > 0 && !/[\x00-\x1f\x7f]/.test(text);

export function reduceQuestionPrompt(state: QuestionPromptState, key: QuestionKey, text = ""): QuestionResult {
  const question = state.questions[state.index]!;
  const own = ownRow(question);
  const typed = state.typed[state.index] ?? "";
  const setTyped = (value: string): QuestionPromptState => ({ ...state, selected: own, typed: state.typed.map((entry, index) => index === state.index ? value : entry) });

  // Esc hands every unanswered question back to the agent to decide.
  if (key.name === "escape" || key.ctrl && key.name === "c") {
    return { state, answers: state.answers.map((answer) => answer ?? { answer: null, source: "skipped" }) };
  }
  if (key.name === "return" || key.name === "enter") {
    let answer: UserAnswer;
    if (state.selected < own) answer = { answer: question.suggestions[state.selected]!, source: "suggestion" };
    else if (typed.trim()) answer = { answer: typed.trim(), source: "typed" };
    else return { state };
    const answers = state.answers.map((entry, index) => index === state.index ? answer : entry);
    if (state.index + 1 >= state.questions.length) return { state: { ...state, answers }, answers: answers as UserAnswer[] };
    const next = state.index + 1;
    return { state: { ...state, answers, index: next, selected: rowFor(state.questions[next]!, answers[next] ?? null) } };
  }
  const editing = state.selected === own;
  if (key.name === "backspace") return editing ? { state: setTyped(typed.slice(0, -1)) } : { state };
  if (key.name === "up" || key.name === "down") {
    const rows = own + 1;
    return { state: { ...state, selected: (state.selected + (key.name === "up" ? -1 : 1) + rows) % rows } };
  }
  // ← steps back while the user is not typing, so it never eats a caret move.
  if (key.name === "left" && (!editing || !typed) && state.index > 0) {
    const previous = state.index - 1;
    return { state: { ...state, index: previous, selected: rowFor(state.questions[previous]!, state.answers[previous] ?? null) } };
  }
  if (!printable(text, key)) return { state };
  // A digit picks that row, except on the typing row, where it is text.
  if (!editing && /^[1-9]$/.test(text) && Number(text) <= own + 1) return { state: { ...state, selected: Number(text) - 1 } };
  return { state: setTyped(typed + text.replace(/[\r\n]+/g, " ")) };
}
