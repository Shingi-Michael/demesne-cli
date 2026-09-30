import { describe, expect, test } from "bun:test";
import { parseAnswerQuestionsRequest, parseUserQuestions, type UserAnswer } from "@demesne/protocol";
import { QuestionBroker } from "../src/questions.ts";
import { ToolRegistry } from "../src/tools.ts";

describe("QuestionBroker", () => {
  test("resolves with the user's answers only when they match what was asked", async () => {
    const broker = new QuestionBroker();
    const waiting = broker.wait("q1", "turn", 2, new AbortController().signal);
    expect(broker.resolve("q1", [{ answer: "yes", source: "suggestion" }])).toBe(false);
    expect(broker.resolve("other", [{ answer: "yes", source: "suggestion" }, { answer: null, source: "skipped" }])).toBe(false);
    const answers: UserAnswer[] = [{ answer: "yes", source: "suggestion" }, { answer: "only in src/", source: "typed" }];
    expect(broker.resolve("q1", answers)).toBe(true);
    expect(await waiting).toEqual(answers);
    // Answered once: a second answer is refused.
    expect(broker.resolve("q1", answers)).toBe(false);
  });

  test("an unanswered question times out as skipped instead of hanging the turn", async () => {
    const broker = new QuestionBroker(10);
    expect(await broker.wait("q2", "turn", 2, new AbortController().signal)).toEqual([
      { answer: null, source: "skipped" }, { answer: null, source: "skipped" }]);
  });

  test("cancelling the turn rejects its pending questions", async () => {
    const broker = new QuestionBroker();
    const controller = new AbortController();
    const waiting = broker.wait("q3", "turn", 1, controller.signal);
    const other = broker.wait("q4", "other-turn", 1, new AbortController().signal);
    broker.cancelTurn("turn", new Error("cancelled"));
    await expect(waiting).rejects.toThrow("cancelled");
    expect(broker.resolve("q4", [{ answer: "ok", source: "typed" }])).toBe(true);
    expect(await other).toEqual([{ answer: "ok", source: "typed" }]);
  });
});

describe("ask_user", () => {
  const tool = new ToolRegistry().get("ask_user")!;
  const context = { workspaceRoot: "/tmp", signal: new AbortController().signal };
  const questions = [{ question: "Which guard should change?", reason: "Two places reject it.", suggestions: ["The lexer guard", "Both"] },
    { question: "Allow digits after the first letter?" }];

  test("needs no approval and reports each answer with where it came from", async () => {
    expect(tool.permission({ questions })).toBeNull();
    const asked: unknown[] = [];
    const result = await tool.execute({ questions }, { ...context, ask: async (list) => {
      asked.push(list);
      return [{ answer: "The lexer guard", source: "suggestion" }, { answer: "yes, like ASCII", source: "typed" }];
    } });
    expect(asked).toEqual([[{ question: "Which guard should change?", reason: "Two places reject it.", suggestions: ["The lexer guard", "Both"] },
      { question: "Allow digits after the first letter?", suggestions: [] }]]);
    expect(result).toBe("1. Which guard should change?\n   Answer: The lexer guard\n2. Allow digits after the first letter?\n   Answer: yes, like ASCII (the user's own words)");
  });

  test("a skipped question and a turn with nobody to ask both tell the agent to decide", async () => {
    const skipped = await tool.execute({ questions: [questions[1]] }, { ...context, ask: async () => [{ answer: null, source: "skipped" }] });
    expect(skipped).toContain("no answer. Decide yourself and state the assumption you made.");
    expect(await tool.execute({ questions }, context)).toBe("Nobody is available to answer. Decide yourself and state the assumption you made.");
  });

  test("rejects malformed questions and answers", async () => {
    await expect(tool.execute({ questions: [] }, context)).rejects.toThrow("1 to 4 questions");
    expect(() => parseUserQuestions([{ question: " " }])).toThrow("question must be");
    expect(() => parseUserQuestions(Array.from({ length: 5 }, () => ({ question: "q" })))).toThrow("1 to 4 questions");
    expect(() => parseUserQuestions([{ question: "q", suggestions: ["a", "b", "c", "d", "e"] }])).toThrow("suggestions");
    expect(() => parseAnswerQuestionsRequest({ answers: [{ source: "typed", answer: " " }] })).toThrow("answer must be");
    expect(() => parseAnswerQuestionsRequest({ answers: [{ source: "guess", answer: "x" }] })).toThrow("source must be");
    expect(parseAnswerQuestionsRequest({ answers: [{ source: "skipped", answer: "ignored" }, { source: "typed", answer: " mine " }] }))
      .toEqual({ answers: [{ answer: null, source: "skipped" }, { answer: "mine", source: "typed" }] });
  });
});
