/// The weekly checkup (Personality and brains, stage 6). Once a week Demesne
/// checks whether the agents still feel like three real, grounded people,
/// cheapest checks first:
///
/// - Grounded: how this week's lines did on the checks (lineProblems), counted
///   for free on every line: first version passed, a later one, the plain
///   fallback, or nothing posted.
/// - Told apart: a judge (one call) reads a sample of the week's lines with
///   no names and guesses who wrote each. Chance is a third; the share above
///   that is the best single measure of distinct voices.
/// - Gushing: the same call flags praise the line's subject doesn't support.
/// - Alike: how much each pair of agents shared words this week, against last
///   week (no call), to catch voices drifting into one.
/// - Memory: each agent (one call each) is asked about a few real things from
///   its week and one that never happened. It should remember the real ones
///   and say it doesn't know the made up one.
///
/// About four small calls a week. Results are kept for eight weeks.
import type { ProviderMessage } from "@demesne/providers";
import type { AgentId } from "./agent-cli.ts";
import { CHARACTERS, characterPrompt, likeness } from "./characters.ts";

export interface CheckLine { by: AgentId; text: string; about: string }
export interface LineCounts { ok: number; later: number; fallback: number; dropped: number }
export interface Told { right: number; of: number }
export interface Probe { recalled: number; of: number; abstained: boolean }

export interface Checkup {
  week: string;
  at: string;
  /// This week's lines on the checks.
  lines: LineCounts;
  /// The judge's guesses (null when the call failed).
  told: (Told & { by: Partial<Record<AgentId, Told>> }) | null;
  /// Lines the judge found gushing (null when the call failed).
  gushing: string[] | null;
  /// How alike each pair wrote this week (0 to 1), and last week when known.
  alike: Array<{ a: AgentId; b: AgentId; score: number; before: number | null }>;
  probes: Partial<Record<AgentId, Probe>>;
  /// What it found, in plain words.
  notes: string[];
}

export const CHECKUPS_KEPT = 8;
/// Lines the judge reads, and the fewest worth a checkup.
export const SAMPLE = 12, FEWEST = 6;
/// Real things asked about in a memory probe.
export const PROBE_REAL = 3;

/// Chats that never happened, for the memory probe (the first one whose words aren't in the week).
const NEVER = ["Move the billing service to Postgres", "Rewrite the iOS lock screen widget", "Add a printer page to the installer", "Port the payroll report to Rust"];

/// A spread of the week's lines: round robin across agents, newest first.
export function sample(lines: CheckLine[], size = SAMPLE): CheckLine[] {
  const by = new Map<AgentId, CheckLine[]>();
  for (const line of [...lines].reverse()) by.set(line.by, [...by.get(line.by) ?? [], line]);
  const picked: CheckLine[] = [];
  while (picked.length < size && [...by.values()].some((list) => list.length)) {
    for (const list of by.values()) { const line = list.shift(); if (line && picked.length < size) picked.push(line); }
  }
  // Mixed so the judge can't lean on the order.
  return [...picked.filter((_, index) => index % 2), ...picked.filter((_, index) => !(index % 2)).reverse()];
}

export function judgeMessages(lines: CheckLine[], agents: AgentId[]): ProviderMessage[] {
  const who = agents.map((id) => `- ${CHARACTERS[id].name}: ${CHARACTERS[id].core}. Writes: ${CHARACTERS[id].style.join("; ")}.`).join("\n");
  return [
    { role: "system", content: `You check writing for a small app where coding agents post short lines about their day. The agents:\n${who}\n\nFor each numbered line, guess which agent wrote it from how it sounds. Also say whether it gushes: praise or excitement bigger than what it is about supports. Reply with JSON only, like [{"n":1,"who":"${CHARACTERS[agents[0]!].name}","gush":false}].` },
    { role: "user", content: lines.map((line, index) => `${index + 1}. (about: ${line.about}) ${line.text}`).join("\n") },
  ];
}

/// The judge's answer, one guess per line (null where it didn't say).
export function parseJudge(reply: string | null, count: number): Array<{ who: AgentId | null; gush: boolean }> | null {
  const raw = reply?.match(/\[[\s\S]*\]/)?.[0];
  if (!raw) return null;
  let items: unknown;
  try { items = JSON.parse(raw); } catch { return null; }
  if (!Array.isArray(items)) return null;
  const out = Array.from({ length: count }, () => ({ who: null as AgentId | null, gush: false }));
  for (const item of items as Array<{ n?: unknown; who?: unknown; gush?: unknown }>) {
    const n = Number(item?.n);
    if (!Number.isInteger(n) || n < 1 || n > count) continue;
    const name = String(item.who ?? "").toLowerCase().trim();
    const who = (Object.keys(CHARACTERS) as AgentId[]).find((id) => CHARACTERS[id].name.toLowerCase() === name || id === name) ?? null;
    out[n - 1] = { who, gush: item.gush === true };
  }
  return out;
}

/// How alike each pair of agents wrote: shared words over all their words.
export function alikeness(lines: CheckLine[], agents: AgentId[]): Array<{ a: AgentId; b: AgentId; score: number }> {
  const text = (id: AgentId) => lines.filter((line) => line.by === id).map((line) => line.text).join(" ");
  const pairs: Array<{ a: AgentId; b: AgentId; score: number }> = [];
  for (let i = 0; i < agents.length; i++) for (let j = i + 1; j < agents.length; j++) {
    const one = text(agents[i]!), two = text(agents[j]!);
    if (one && two) pairs.push({ a: agents[i]!, b: agents[j]!, score: Math.round(likeness(one, two) * 100) / 100 });
  }
  return pairs;
}

/// The memory probe's questions: real chats from the week, and one that never happened, mixed in.
export function probeQuestions(real: string[], week: string): { asks: string[]; fake: number } {
  const titles = [...new Set(real)].slice(0, PROBE_REAL);
  const lower = week.toLowerCase();
  const never = NEVER.find((title) => !title.toLowerCase().split(" ").some((word) => word.length > 4 && lower.includes(word))) ?? NEVER[0]!;
  const fake = titles.length ? titles.length % 2 : 0;
  const asks = [...titles];
  asks.splice(fake, 0, never);
  return { asks, fake };
}

export function probeMessages(agent: AgentId, remembered: string, asks: string[]): ProviderMessage[] {
  return [
    { role: "system", content: `${characterPrompt(agent)}\n\n${remembered || "You remember nothing from this week yet."}\n\nAnswer from what you remember only. If you don't remember something, say you don't remember it; never guess or make it up. No dashes.` },
    { role: "user", content: `Quick questions about your week. Answer each in one short sentence, as JSON only: ["answer 1", "answer 2", ...].\n${asks.map((ask, index) => `${index + 1}. What happened with "${ask}" this week?`).join("\n")}` },
  ];
}

const UNSURE = /\b(don'?t|do not|didn'?t|did not|can'?t|cannot|not sure|no idea|never|no memory|not something|doesn'?t ring|haven'?t|nothing about)\b/i;

/// How a probe went: real chats remembered (a word of the title, and not unsure), and whether it owned up to not knowing the made up one.
export function scoreProbe(reply: string | null, asks: string[], fake: number): Probe | null {
  const raw = reply?.match(/\[[\s\S]*\]/)?.[0];
  if (!raw) return null;
  let answers: unknown;
  try { answers = JSON.parse(raw); } catch { return null; }
  if (!Array.isArray(answers)) return null;
  let recalled = 0;
  asks.forEach((ask, index) => {
    if (index === fake) return;
    const answer = String(answers[index] ?? "");
    const words = ask.toLowerCase().match(/[\p{L}\p{N}]+/gu)?.filter((word) => word.length > 3) ?? [];
    if (!UNSURE.test(answer) && words.some((word) => answer.toLowerCase().includes(word))) recalled += 1;
  });
  return { recalled, of: asks.length - 1, abstained: UNSURE.test(String(answers[fake] ?? "")) };
}

/// The checkup's findings in plain words.
export function checkupNotes(checkup: Omit<Checkup, "notes">, name: (id: AgentId) => string): string[] {
  const notes: string[] = [];
  const total = checkup.lines.ok + checkup.lines.later + checkup.lines.fallback + checkup.lines.dropped;
  if (total) notes.push(`${checkup.lines.ok + checkup.lines.later} of ${total} lines passed the checks${checkup.lines.dropped ? `, and ${checkup.lines.dropped} ${checkup.lines.dropped === 1 ? "was" : "were"} dropped rather than posted with a problem` : ""}.`);
  if (checkup.told) {
    notes.push(`The judge told who wrote ${checkup.told.right} of ${checkup.told.of} unsigned lines (guessing gets about a third).`);
    for (const [id, told] of Object.entries(checkup.told.by) as Array<[AgentId, Told]>) if (told.of >= 2 && told.right / told.of < 0.34) notes.push(`${name(id)} was hard to tell apart.`);
  }
  if (checkup.gushing?.length) notes.push(`${checkup.gushing.length === 1 ? "One line gushed" : `${checkup.gushing.length} lines gushed`} more than what happened.`);
  for (const pair of checkup.alike) if (pair.before !== null && pair.score - pair.before >= 0.05) notes.push(`${name(pair.a)} and ${name(pair.b)} wrote more alike than last week.`);
  for (const [id, probe] of Object.entries(checkup.probes) as Array<[AgentId, Probe]>) {
    notes.push(`${name(id)} remembered ${probe.recalled} of ${probe.of} things from its week, and ${probe.abstained ? "said it didn't know the one that never happened" : "made something up about a chat that never happened"}.`);
  }
  return notes;
}
