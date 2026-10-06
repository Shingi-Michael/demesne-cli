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

  test("inactivity pauses without inventing answers, and explicit input resumes it", async () => {
    const broker = new QuestionBroker(10);
    let settled=false, pauses=0;
    const waiting=broker.wait("q2","turn",1,new AbortController().signal,()=>pauses++).then(value=>{settled=true;return value;});
    await Bun.sleep(25);
    expect(settled).toBe(false);expect(broker.isPaused("q2")).toBe(true);expect(pauses).toBe(1);
    expect(broker.resume("q2")).toBe(true);
    expect(broker.resolve("q2",[{answer:"warm",source:"typed"}])).toBe(true);
    expect(await waiting).toEqual([{answer:"warm",source:"typed"}]);
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

  test("explicit skips record missing preferences and unavailable input never invites guessing", async () => {
    const skipped = await tool.execute({ questions: [questions[1]] }, { ...context, ask: async () => [{ answer: null, source: "skipped" }] });
    expect(skipped).toContain("explicitly skipped");
    await expect(tool.execute({questions},context)).rejects.toThrow("do not infer");
  });

  test("interview mode asks one adaptive question per call", async () => {
    await expect(tool.execute({mode:"interview",questions},context)).rejects.toThrow("one question");
    let mode: string | undefined;
    await tool.execute({mode:"interview",questions:[questions[0]]},{...context,ask:async (_questions,value)=>{mode=value;return [{answer:"warm",source:"typed"}];}});
    expect(mode).toBe("interview");
  });

  test("already aborted waiters reject immediately and repeated answers clean up", async () => {
    const broker=new QuestionBroker(5), controller=new AbortController();controller.abort(new Error("already cancelled"));
    await expect(broker.wait("dead","turn",1,controller.signal)).rejects.toThrow("already cancelled");
    expect(broker.has("dead")).toBe(false);
    const active=new AbortController();
    for(let index=0;index<20;index++) {
      const id=String(index), waiting=broker.wait(id,"turn",1,active.signal);
      expect(broker.resolve(id,[{answer:"yes",source:"typed"}])).toBe(true);await waiting;
    }
    active.abort();expect(broker.has("19")).toBe(false);
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
