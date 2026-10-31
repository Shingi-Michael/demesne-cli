/// A chat's name: after its first turn, the chat's own model (thinking off)
/// names it in a few words from what was asked and answered, so a tab reads
/// "Tab names" instead of the first prompt cut at sixty characters. Only for
/// chats a person is in (not Drive, routines, mail or the assistant), only
/// once, and never over a name someone gave it meanwhile.
import type { ProviderMessage } from "@demesne/providers";
import type { TurnInference } from "./processor.ts";

export const NAME_PROMPT = "Name this chat for a tab, from what was asked and answered. Reply with the name only: 2 to 4 words, sentence case, no quotes, no punctuation at the end, no emoji. Name the subject, not the request (\"Tab names\", not \"Fix my tabs please\").";

/// The model's reply as a tab name, or null when it isn't one.
export function cleanName(reply: string): string | null {
  const line = reply.split("\n").map((part) => part.trim()).find(Boolean) ?? "";
  const name = line.replace(/^(title|name)\s*:\s*/i, "").replace(/^["'“‘*`]+|[.!?:;,]*["'”’*`]+[.!?:;,]*$/g, "").replace(/[.!?:;,]+$/, "").replace(/\s+/g, " ").trim();
  if (!/\p{L}/u.test(name) || name.length > 40 || name.split(" ").length > 6) return null;
  return name.charAt(0).toUpperCase() + name.slice(1);
}

export function nameMessages(asked: string, answered: string): ProviderMessage[] {
  const clip = (text: string) => text.length > 800 ? `${text.slice(0, 800)}…` : text;
  return [{ role: "system", content: NAME_PROMPT }, { role: "user", content: `Asked:\n${clip(asked)}\n\nAnswered:\n${clip(answered) || "(it worked without a written answer)"}` }];
}

/// Ask for the name; a slow or failed call names nothing.
export async function askName(inference: TurnInference, asked: string, answered: string, timeoutMs = 20_000): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("Naming the chat took too long")), timeoutMs);
  let text = "";
  try {
    for await (const event of inference.stream(nameMessages(asked, answered), [], controller.signal)) {
      if (event.type === "text_delta") text += event.delta;
      if (text.length > 200 || event.type === "tool_call_delta") break;
    }
  } catch { return null; } finally { clearTimeout(timer); }
  return cleanName(text);
}
