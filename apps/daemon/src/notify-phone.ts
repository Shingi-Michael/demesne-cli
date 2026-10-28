import { isRecord } from "@demesne/protocol";
import { toolError, type AgentTool } from "./tools.ts";

/// Push notifications to your phone through ntfy (https://ntfy.sh): the
/// daemon posts to a topic, and the ntfy app on your iPhone, subscribed to
/// the same topic, shows it. The topic is fixed in `[assistant] ntfy`, so the
/// model can reach you and nobody else.

export interface PhoneMessage { title?: string; text: string; urgent?: boolean }

export interface Phone {
  send(message: PhoneMessage, signal?: AbortSignal): Promise<void>;
}

export function ntfy(url: string, token?: string, fetcher: typeof fetch = fetch): Phone {
  return {
    async send({ title, text, urgent }, signal) {
      const headers: Record<string, string> = { "content-type": "text/plain; charset=utf-8", markdown: "yes" };
      // HTTP headers are Latin-1 only; RFC 2047 encoding keeps any title intact.
      if (title) headers.title = `=?UTF-8?B?${Buffer.from(title.slice(0, 120)).toString("base64")}?=`;
      if (urgent) headers.priority = "high";
      if (token) headers.authorization = `Bearer ${token}`;
      let response: Response;
      try {
        response = await fetcher(url, { method: "POST", headers, body: text.slice(0, 4000), signal });
      } catch (error) {
        if (signal?.aborted) throw error;
        throw new Error(`Can't reach ntfy at ${new URL(url).host}`);
      }
      if (!response.ok) throw new Error(`ntfy answered HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
    },
  };
}

/// The tool the model uses to push something to your phone mid-conversation:
/// "send that to my phone". In a chat you're at, it asks first, like any
/// other step that reaches outside the computer; on Auto (routines, mail) it
/// sends. At most `perHour` an hour, so a confused loop can't flood you.
export function notifyPhoneTool(phone: Phone, perHour = 10, now: () => number = Date.now): AgentTool {
  const sent: number[] = [];
  return {
    definition: {
      name: "notify_phone",
      description: "Send a push notification to the user's iPhone. Use it only when the user asks for something on their phone, or for something time-sensitive they need to see. Keep it to a short title and one or two sentences.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", maxLength: 120 },
          text: { type: "string", maxLength: 1000 },
          urgent: { type: "boolean", description: "Breaks through Focus. Only for things that can't wait." },
        },
        required: ["text"],
        additionalProperties: false,
      },
    },
    permission(input) {
      const title = isRecord(input) && typeof input.title === "string" ? input.title : isRecord(input) && typeof input.text === "string" ? input.text : "";
      return { kind: "execute", summary: `Send to your phone: ${title.slice(0, 80)}` };
    },
    async execute(input, context) {
      if (!isRecord(input) || typeof input.text !== "string" || !input.text.trim()) throw toolError("MISSING_TEXT", "a notification needs text", "say what to show");
      while (sent.length && now() - sent[0]! > 3_600_000) sent.shift();
      if (sent.length >= perHour) throw toolError("TOO_MANY", `${perHour} notifications already sent this hour`, "put the rest in your answer instead");
      await phone.send({ title: typeof input.title === "string" ? input.title : undefined, text: input.text, urgent: input.urgent === true }, context.signal);
      sent.push(now());
      return "Sent to the user's phone.";
    },
  };
}

/// What a routine's run sends to your phone: its answer, or why there isn't one.
export function routineMessage(title: string, status: string, responseText: string): PhoneMessage | null {
  if (status === "completed") return { title, text: responseText.trim() || "Finished, with nothing to say." };
  // Cancelled or interrupted means you stopped it or the daemon shut down.
  if (status === "failed") return { title, text: "This routine didn't finish. Open its chat in Demesne to see why." };
  return null;
}
