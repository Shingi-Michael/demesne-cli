/// Deep research (passes 179, 181 A, 182 A): the chat model splits a big
/// question into a few smaller ones, your agent tools (Claude Code, Codex,
/// Gemini) research one each at the same time with their own web search, and
/// a judge lines up what they brought back: what agrees, what disagrees, and
/// an important claim only one agent found goes to a second agent to check.
/// An agent tool that isn't here or fails hands its question to a sub-agent
/// on the chat's own model, which has web_search and web_fetch too.
import type { ProviderToolDefinition } from "@demesne/providers";
import { isRecord, type ResearchCheck, type ResearchLane, type ResearchState } from "@demesne/protocol";
import type { AgentId } from "./agent-cli.ts";

export type { ResearchCheck, ResearchLane, ResearchState };

export const RESEARCH_TOOL = "research";
export const RESEARCH_MAX_QUESTIONS = 5;
/// Each researcher stops at about this many pages; the run at about 40.
export const RESEARCH_PAGES_EACH = 15;
export const RESEARCH_MAX_RECHECKS = 2;
const NOTES_BYTES = 12 * 1024;

export const AGENT_NAMES: Record<AgentId, string> = { claude: "Claude Code", codex: "Codex", gemini: "Gemini" };

export const researchDefinition: ProviderToolDefinition = {
  name: RESEARCH_TOOL,
  description: "Deep research on the web for a question that needs many sources: \"research…\", \"compare…\", \"deep dive on…\", or anything a single web_search can't settle. "
    + "You split the question into 2–5 smaller ones that together answer it; each goes to one of the person's agent tools (or a sub-agent on your model), which search and read up to 15 pages at the same time and bring back claims with links. "
    + "A judge then checks where they agree and disagree. What comes back is every researcher's notes plus the judge's check. "
    + "Afterwards write the report as a Foundry doc (foundry_save, kind doc) with numbered sources, and answer in the chat in a few sentences. "
    + "For a quick fact, use web_search instead.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["topic", "questions"],
    properties: {
      topic: { type: "string", minLength: 1, maxLength: 120, description: "The question in a few words, e.g. \"local coding models for a 32 GB Mac\"." },
      questions: { type: "array", minItems: 2, maxItems: RESEARCH_MAX_QUESTIONS, items: { type: "string", minLength: 1, maxLength: 400 }, description: "2–5 smaller questions that don't overlap, each answerable on its own." },
      judge: { type: "string", enum: ["claude", "codex", "gemini"], description: "Only when the person names who should judge; otherwise the judge is you." },
    },
  },
};

export interface ResearchInput { topic: string; questions: string[]; judge?: AgentId }

export function parseResearchInput(input: unknown): ResearchInput {
  if (!isRecord(input) || typeof input.topic !== "string" || !input.topic.trim()) throw new Error("research needs a topic");
  if (!Array.isArray(input.questions)) throw new Error("research needs 2–5 questions");
  const questions = [...new Set(input.questions.filter((item): item is string => typeof item === "string").map((item) => item.trim().slice(0, 400)).filter(Boolean))];
  if (questions.length < 2 || questions.length > RESEARCH_MAX_QUESTIONS) throw new Error("research needs 2–5 different questions");
  const judge = input.judge === "claude" || input.judge === "codex" || input.judge === "gemini" ? input.judge : undefined;
  return { topic: input.topic.trim().slice(0, 120), questions, ...(judge ? { judge } : {}) };
}

export function researchBrief(topic: string, question: string): string {
  return `You are one researcher on a small team researching: ${topic}
Your part: ${question}

Use web search, then open and read the best pages (up to ${RESEARCH_PAGES_EACH}). Prefer primary sources: official docs, papers, release notes, maintainers' own posts; use blogs and forums for what people report from real use. Do not change any files or run anything.

Your final message goes to a judge who cannot see your steps. Write only notes, one claim per line:
- <the claim, with its numbers> — <the page's full URL> — "<a short quote from that page that supports it>"
Then a line "Unsure:" with anything you could not settle or where pages disagreed. Never state a claim without the URL it came from.`;
}

export function checkBrief(topic: string, claim: string): string {
  return `You are checking one claim for a research report on: ${topic}
Claim: ${claim}

Search the web and read 2–5 good pages, preferring primary sources. Do not change any files or run anything.
Answer on the first line with exactly one word, CONFIRMED, REFUTED or UNCLEAR. Then one or two lines on why, each with the page's full URL.`;
}

export function judgeBrief(topic: string, notes: { question: string; who: string; text: string }[]): string {
  return `You are the judge for a research team on: ${topic}
Below are the notes each researcher brought back. Compare them claim by claim. Do not search the web yourself.

Answer with JSON only, no prose:
{"agree": <number of claims at least two researchers or sources back up>, "disagree": ["<each real disagreement, in one line, naming both sides>"], "recheck": [{"claim": "<an important claim that rests on one researcher or one source only>", "from": <its researcher's number>}]}
Pick at most ${RESEARCH_MAX_RECHECKS} rechecks: only claims the final answer would lean on.

${notes.map((note, index) => `### Researcher ${index + 1} (${note.who}): ${note.question}\n${note.text}`).join("\n\n")}`;
}

export interface Judgment { agree: number; disagree: string[]; recheck: { claim: string; from: number }[] }

/// The judge's JSON, read leniently: the first {...} in its answer.
export function parseJudgment(text: string, lanes: number): Judgment {
  const empty: Judgment = { agree: 0, disagree: [], recheck: [] };
  const start = text.indexOf("{"), end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return empty;
  try {
    const value = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    const disagree = Array.isArray(value.disagree) ? value.disagree.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim().slice(0, 300)).slice(0, 8) : [];
    const recheck = Array.isArray(value.recheck) ? value.recheck.flatMap((item) => isRecord(item) && typeof item.claim === "string" && item.claim.trim()
      ? [{ claim: item.claim.trim().slice(0, 400), from: Number.isInteger(item.from) && Number(item.from) >= 1 && Number(item.from) <= lanes ? Number(item.from) : 0 }] : []).slice(0, RESEARCH_MAX_RECHECKS) : [];
    return { agree: Math.max(0, Math.floor(Number(value.agree) || 0)), disagree, recheck };
  } catch { return empty; }
}

/// A step that opened a page (it names a web address).
export const opensPage = (step: string) => /https?:\/\/\S+/.test(step) && !/^(searched|search)\b/i.test(step);
/// The pages a set of notes cites.
export const citedPages = (text: string) => new Set(text.match(/https?:\/\/[^\s)\]"'<>—]+/g) ?? []).size;

export function verdictOf(text: string): ResearchCheck["verdict"] {
  const first = text.trim().split("\n")[0]!.toUpperCase();
  return first.includes("REFUTED") ? "refuted" : first.includes("CONFIRMED") ? "confirmed" : "unclear";
}

export interface ResearchDeps {
  /// Agent tools that can research now, best first. Empty: the chat's model does it all.
  agents: AgentId[];
  /// One research or check run on an agent tool, with web search on. Throws when it can't.
  runAgent: (agent: AgentId, prompt: string, signal: AbortSignal, step: (line: string) => void) => Promise<string>;
  /// The same on a sub-agent on the chat's model (web_search and web_fetch).
  runModel: (prompt: string, signal: AbortSignal, step: (line: string) => void) => Promise<string>;
  /// The judge's one answer (the chat's model, or the agent you named).
  runJudge: (prompt: string, signal: AbortSignal) => Promise<string>;
  /// How an agent tool did, for Auto's record.
  note?: (agent: AgentId, ok: boolean, error?: string) => void;
  update: (state: ResearchState) => void;
  signal: AbortSignal;
}

export interface ResearchOutcome { state: ResearchState; text: string }

/// Runs one research: lanes at once, then the judge, then its rechecks.
export async function runResearch(input: ResearchInput, deps: ResearchDeps): Promise<ResearchOutcome> {
  const { signal } = deps;
  const lanes: ResearchLane[] = input.questions.map((question, index) => ({ question, agent: deps.agents.length ? deps.agents[index % deps.agents.length]! : null, state: "running", pages: 0 }));
  const state: ResearchState = { topic: input.topic, phase: "researching", pages: 0, lanes, checks: [], judge: input.judge && deps.agents.includes(input.judge) ? input.judge : null };
  const total = () => lanes.reduce((sum, lane) => sum + lane.pages, 0);
  const push = () => { state.pages = total(); deps.update(structuredClone(state)); };
  push();

  // A step that opened a page counts it, past the brief's cap only on the line.
  const stepper = (lane: { pages: number }) => (line: string) => { if (opensPage(line) && lane.pages < RESEARCH_PAGES_EACH + 5) { lane.pages++; push(); } };
  /// One run on an agent tool, else the chat's model. Returns the text and who did it.
  const attempt = async (agent: AgentId | null, prompt: string, lane: { pages: number }): Promise<{ text: string; agent: AgentId | null }> => {
    if (agent) {
      try {
        const text = await deps.runAgent(agent, prompt, signal, stepper(lane));
        deps.note?.(agent, true);
        return { text, agent };
      } catch (error) {
        signal.throwIfAborted();
        deps.note?.(agent, false, error instanceof Error ? error.message : String(error));
      }
    }
    return { text: await deps.runModel(prompt, signal, stepper(lane)), agent: null };
  };

  const notes = await Promise.all(lanes.map(async (lane) => {
    try {
      const done = await attempt(lane.agent, researchBrief(input.topic, lane.question), lane);
      lane.agent = done.agent;
      lane.state = "done";
      lane.pages = Math.max(lane.pages, Math.min(citedPages(done.text), RESEARCH_PAGES_EACH + 5));
      push();
      return done.text.trim().slice(0, NOTES_BYTES);
    } catch (error) {
      signal.throwIfAborted();
      lane.state = "failed";
      push();
      return `(This researcher could not finish: ${error instanceof Error ? error.message.split("\n")[0]!.slice(0, 200) : "unknown error"}.)`;
    }
  }));
  const who = (agent: AgentId | null) => agent ? AGENT_NAMES[agent] : "a sub-agent on your model";
  if (lanes.every((lane) => lane.state === "failed")) {
    state.phase = "done";
    push();
    return { state, text: `Research on ${input.topic} failed: no researcher could finish.\n${notes.join("\n")}\nTell the person, and offer to try web_search yourself.` };
  }

  state.phase = "judging";
  push();
  let judgment: Judgment = { agree: 0, disagree: [], recheck: [] };
  try {
    judgment = parseJudgment(await deps.runJudge(judgeBrief(input.topic, lanes.map((lane, index) => ({ question: lane.question, who: who(lane.agent), text: notes[index]! }))), signal), lanes.length);
  } catch (error) {
    signal.throwIfAborted();
  }
  state.agree = judgment.agree;
  state.disagree = judgment.disagree.length;

  // Each recheck goes to an agent other than the one that found the claim.
  const checks = judgment.recheck.map((item) => {
    const from = item.from ? lanes[item.from - 1]!.agent : null;
    const agent = deps.agents.find((one) => one !== from) ?? null;
    return { claim: item.claim, agent, verdict: "running" as ResearchCheck["verdict"] };
  });
  state.checks = checks;
  const checked: string[] = [];
  if (checks.length) {
    state.phase = "checking";
    push();
    await Promise.all(checks.map(async (check, index) => {
      const scratch = { pages: 0 };
      try {
        const done = await attempt(check.agent, checkBrief(input.topic, check.claim), scratch);
        check.agent = done.agent;
        check.verdict = verdictOf(done.text);
        checked[index] = done.text.trim().slice(0, 2000);
      } catch (error) {
        signal.throwIfAborted();
        check.verdict = "unclear";
        checked[index] = "(The check could not finish.)";
      }
      push();
    }));
  }

  state.phase = "done";
  push();
  const sections = lanes.map((lane, index) => `## ${index + 1}. ${lane.question}\nResearched by ${who(lane.agent)}${lane.state === "failed" ? " (did not finish)" : ""}.\n${notes[index]}`);
  const judged = [`## Judge (${state.judge ? AGENT_NAMES[state.judge] : "your model"})`, `Claims backed by more than one researcher or source: ${judgment.agree}.`,
    judgment.disagree.length ? `Disagreements:\n${judgment.disagree.map((line) => `- ${line}`).join("\n")}` : "No real disagreements found.",
    ...checks.map((check, index) => `Re-checked by ${who(check.agent)}: "${check.claim}" → ${check.verdict.toUpperCase()}\n${checked[index] ?? ""}`)].join("\n");
  const text = `Research on ${input.topic}: ${lanes.length} researchers, about ${state.pages} pages.\n\n${sections.join("\n\n")}\n\n${judged}\n\n`
    + "Next: write the report as a Foundry doc (foundry_save, kind doc): the answer first, a section per question, a section on where sources disagree, and numbered sources [1], [2] … each with its link and the researcher that found it. "
    + "Drop claims a check refuted. Then answer in the chat in 2–4 sentences: what it found, how sure it is, and where sources disagree. Don't repeat the report in the chat.";
  return { state, text };
}
