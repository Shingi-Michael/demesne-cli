import { describe, expect, test } from "bun:test";
import type { UserQuestion } from "@demesne/protocol";
import { createQuestionPrompt, reduceQuestionPrompt, type QuestionKey, type QuestionPromptState } from "../src/workbench/question-prompt.ts";

const questions: UserQuestion[] = [
  { question: "Which guard should change?", suggestions: ["The lexer guard", "Both guards"] },
  { question: "Allow digits after the first letter?", suggestions: ["Yes, match ASCII", "No, letters only"] },
  { question: "Anything to leave alone?", suggestions: [] },
];

function press(state: QuestionPromptState, ...keys: Array<string | QuestionKey>) {
  let result: ReturnType<typeof reduceQuestionPrompt> = { state };
  for (const key of keys) {
    result = typeof key === "string" ? reduceQuestionPrompt(result.state, key.length === 1 ? {} : { name: key }, key.length === 1 ? key : "") : reduceQuestionPrompt(result.state, key);
    if ("answers" in result) break;
  }
  return result;
}

describe("question prompt", () => {
  test("Enter accepts each recommended answer and moves on until all are answered", () => {
    const start = createQuestionPrompt(questions.slice(0, 2));
    expect(start.selected).toBe(0);
    let result = press(start, "return");
    expect("answers" in result).toBe(false);
    expect(result.state.index).toBe(1);
    result = press(result.state, "return");
    expect("answers" in result && result.answers).toEqual([
      { answer: "The lexer guard", source: "suggestion" }, { answer: "Yes, match ASCII", source: "suggestion" }]);
  });

  test("arrows or a number pick another suggestion, and typing gives your own answer", () => {
    let result = press(createQuestionPrompt(questions), "down", "return");
    expect(result.state.answers[0]).toEqual({ answer: "Both guards", source: "suggestion" });
    result = press(result.state, ..."only for identifiers".split(""), "return");
    expect(result.state.answers[1]).toEqual({ answer: "only for identifiers", source: "typed" });
    // No suggestions: the question opens on the typing row; Enter with nothing typed does nothing.
    expect(result.state.selected).toBe(0);
    expect(press(result.state, "return").state.index).toBe(2);
    const done = press(result.state, ..."the parser", "return");
    expect("answers" in done && done.answers[2]).toEqual({ answer: "the parser", source: "typed" });
    expect(press(createQuestionPrompt(questions), "2").state.selected).toBe(1);
    // Once typing has started, digits are text.
    expect(press(createQuestionPrompt(questions), "3", "2").state.typed[0]).toBe("2");
  });

  test("← goes back to a previous question with its answer selected; Backspace edits typed text", () => {
    let result = press(createQuestionPrompt(questions), "down", "return");
    result = press(result.state, "left");
    expect(result.state.index).toBe(0);
    expect(result.state.selected).toBe(1);
    result = press(result.state, "return", ..."abc", "backspace", "left");
    // Typing is under way, so ← does not leave the question.
    expect(result.state.index).toBe(1);
    expect(result.state.typed[1]).toBe("ab");
  });

  test("Esc lets the agent decide the unanswered questions and keeps the answered ones", () => {
    const result = press(createQuestionPrompt(questions), "return", "escape");
    expect("answers" in result && result.answers).toEqual([
      { answer: "The lexer guard", source: "suggestion" }, { answer: null, source: "skipped" }, { answer: null, source: "skipped" }]);
  });
});
