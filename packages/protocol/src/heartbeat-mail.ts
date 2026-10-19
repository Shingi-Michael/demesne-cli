/// Heartbeat mail as a turn: the daemon writes a mail turn's text with
/// `formatMail`, and the window reads it back with `parseMailTurn` to draw
/// the turn as mail (who sent it, what kind, the words) instead of as
/// something the person typed. Both sides share this file so the format
/// has one definition.

export const MAIL_HEADER = "Heartbeat mail for ";

export interface MailMessage {
  authority: "owner" | "peer";
  /// The compact envelope: `PERF#ID [^REF] [→TO] [←FROM] [why:"..."]`.
  compact: string;
  english: string;
}

export interface MailPairRequest {
  node_id: string;
  requester: string;
  capabilities: string[];
  note?: string | null;
}

export function formatMail(address: string, messages: MailMessage[], pairRequests: MailPairRequest[]): string {
  const lines = [`${MAIL_HEADER}${address}:`];
  for (const message of messages) lines.push(`[${message.authority}] ${message.compact}\n  = ${message.english}`);
  for (const request of pairRequests) {
    lines.push(`[pair-request] ${request.requester} on ${request.node_id} asks to connect, with ${request.capabilities.join(", ")}${request.note ? ` (note: ${request.note})` : ""}. `
      + `Ask your owner one yes-or-no question; on yes use the heartbeat tool's approve action for ${request.node_id}, on no its deny action.`);
  }
  return lines.join("\n");
}

/// Whether a turn's text is mail delivered by the daemon's bridge.
export function isMailTurn(content: string): boolean { return content.startsWith(MAIL_HEADER); }

export interface ParsedMailMessage {
  authority: "owner" | "peer";
  /// REQUEST, INFORM, ...: the performative, spelled out.
  performative: string;
  id: string;
  /// The sender's address, or "" when the envelope carries none.
  from: string;
  /// The words: the envelope's why:"..." when present, else its English line.
  text: string;
  compact: string;
}

export interface ParsedMailTurn {
  address: string;
  messages: ParsedMailMessage[];
  pairRequests: { requester: string; node: string }[];
}

const PERFORMATIVE_WORDS: Record<string, string> = {
  REQ: "request", OFF: "offer", AGR: "agree", REF: "refuse", INF: "inform", DON: "done", FAI: "fail", CAN: "cancel", LEA: "lease", REL: "release",
};

/// Reads a mail turn's text back into its parts; null for any other turn.
export function parseMailTurn(content: string): ParsedMailTurn | null {
  if (!isMailTurn(content)) return null;
  const lines = content.split("\n");
  const address = lines[0]!.slice(MAIL_HEADER.length).replace(/:$/, "").trim();
  const messages: ParsedMailMessage[] = [];
  const pairRequests: { requester: string; node: string }[] = [];
  for (let index = 1; index < lines.length; index++) {
    const line = lines[index]!;
    const mail = /^\[(owner|peer)\] (.*)$/.exec(line);
    if (mail) {
      const compact = mail[2]!.trim();
      const english = lines[index + 1]?.startsWith("  = ") ? lines[index + 1]!.slice(4).trim() : "";
      if (english) index++;
      const head = /^([A-Za-z]+)#(\S+)/.exec(compact);
      const code = (head?.[1] ?? "").toUpperCase();
      const why = /why:"([^"]*)"/.exec(compact)?.[1]?.trim() ?? "";
      messages.push({
        authority: mail[1] as "owner" | "peer",
        performative: PERFORMATIVE_WORDS[code.slice(0, 3)] ?? code.toLowerCase(),
        id: head?.[2] ?? "",
        from: /←(\S+)/.exec(compact)?.[1] ?? "",
        text: why || english,
        compact,
      });
      continue;
    }
    const pair = /^\[pair-request\] (\S+) on (\S+) asks to connect/.exec(line);
    if (pair) pairRequests.push({ requester: pair[1]!, node: pair[2]! });
  }
  return { address, messages, pairRequests };
}
