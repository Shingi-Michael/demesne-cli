/// Pages that remember: demesne.ask("…") from inside a Foundry page. The
/// chat's own model (thinking off) answers one question in plain words, with
/// the page's title for context and no tools. A page's script could ask in a
/// loop, so each artifact gets a few asks a minute and a few dozen an hour.
import type { ProviderMessage } from "@demesne/providers";

export const ASK_PROMPT = "You answer a question asked from inside a page someone made in Demesne's Foundry (the page's own code calls you when they press something). "
  + "Reply with the answer only, in plain text: no greeting, no markdown, no code fences unless the question asks for code or JSON. Keep it short unless the question asks for more. "
  + "If the question asks for JSON, reply with the JSON only.";
export const ASK_MAX_QUESTION = 8000, ASK_MAX_ANSWER = 8000;

export function askMessages(title: string, question: string): ProviderMessage[] {
  return [{ role: "system", content: ASK_PROMPT }, { role: "user", content: `The page: ${title}\n\n${question.slice(0, ASK_MAX_QUESTION)}` }];
}

/// How often a page may ask: per artifact, a sliding minute and hour.
export class AskLimits {
  private readonly asked = new Map<string, number[]>();
  constructor(private readonly perMinute = 6, private readonly perHour = 60, private readonly now = () => Date.now()) {}
  /// Null when the ask may go, else why not.
  take(id: string): string | null {
    const now = this.now(), times = (this.asked.get(id) ?? []).filter((at) => now - at < 3_600_000);
    if (times.filter((at) => now - at < 60_000).length >= this.perMinute) { this.asked.set(id, times); return "This page is asking too often; wait a minute"; }
    if (times.length >= this.perHour) { this.asked.set(id, times); return "This page has asked a lot this hour; try again later"; }
    times.push(now);
    this.asked.set(id, times);
    return null;
  }
}

/// The answer, cut to size; a slow call fails with a plain reason.
export async function askOnce(stream: (messages: ProviderMessage[], signal: AbortSignal) => AsyncIterable<{ type: string; delta?: string }>, title: string, question: string, timeoutMs = 60_000): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("The answer took too long")), timeoutMs);
  let text = "";
  try {
    for await (const event of stream(askMessages(title, question), controller.signal)) {
      if (event.type === "text_delta" && typeof event.delta === "string") text += event.delta;
      if (text.length > ASK_MAX_ANSWER) break;
    }
  } catch (error) {
    if (controller.signal.aborted) throw new Error("The answer took too long");
    throw error;
  } finally { clearTimeout(timer); }
  const answer = text.trim().slice(0, ASK_MAX_ANSWER);
  if (!answer) throw new Error("The model gave no answer");
  return answer;
}
