import type { ModelDescriptor } from "@demesne/protocol";

/// The model picker's hover card (pass 82 A): what a model is, how it is paid
/// for, how much it holds and thinks, and how it has done for you.

const escape = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const tokens = (value: number) => (value >= 1e6 ? `${+(value / 1e6).toFixed(1)}m` : value >= 1000 ? `${Math.round(value / 1000)}k` : String(value));

/** How a provider's turns are paid for: Codex counts against the plan,
 *  ChatGPT and OpenRouter spend credits, anything else is your own server. */
export function billing(provider: string): { words: string; tone: "plan" | "credits" | "own" } {
  if (/^codex$/i.test(provider)) return { words: "your plan", tone: "plan" };
  if (/^(chatgpt|openrouter)$/i.test(provider)) return { words: "credits", tone: "credits" };
  return { words: "your own server", tone: "own" };
}

/** The thinking line: "6 levels, up to Ultra", "On or off", or "None". */
export function thinkingWords(levels: string[] | undefined, word: (level: string) => string): string {
  if (!levels?.length) return "None";
  if (levels.length === 1) return word(levels[0]!);
  return `${levels.length} levels, up to ${word(levels[levels.length - 1]!)}`;
}

export function modelCardHTML(model: ModelDescriptor, options: { name?: string; record?: string; levelWord: (level: string) => string }): string {
  const name = options.name || model.displayName || model.id, bill = billing(model.provider);
  const facts = [
    model.contextWindow ? ["Context", tokens(model.contextWindow)] : null,
    model.maxOutputTokens ? ["Longest answer", tokens(model.maxOutputTokens)] : null,
    ["Thinking", thinkingWords(model.reasoningLevels, options.levelWord)],
  ].filter((fact): fact is string[] => fact !== null);
  return `<div class="mc-name">${escape(name)}</div>` +
    `<div class="mc-by">${escape(model.provider)} · <span class="mc-bill ${bill.tone}">${bill.words}</span></div>` +
    `<div class="mc-facts">${facts.map(([label, value]) => `<span>${label}</span><b>${escape(value!)}</b>`).join("")}</div>` +
    `<div class="mc-you">You: <b>${escape(options.record || "Not used yet")}</b></div>` +
    (name !== model.id ? `<div class="mc-id">${escape(model.id)}</div>` : "");
}
