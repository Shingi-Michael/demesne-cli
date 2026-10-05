import { splitNextPrompt } from "@demesne/protocol";
import type { SessionExport } from "@demesne/protocol";

/// Renders a session export as Markdown. Hidden reasoning and tool output are
/// excluded by the storage layer, so this is the visible conversation only.
export function formatSessionMarkdown(exported: SessionExport, now = new Date()): string {
  const { session, turns } = exported;
  const lines: string[] = [
    `# ${session.title}`,
    "",
    `- Session: \`${session.id}\``,
    `- Workspace: ${session.workspace ? `\`${session.workspace.root}\`` : "none"}`,
    `- Exported: ${now.toISOString()}`,
    `- Turns: ${turns.length}`,
    "",
  ];
  turns.forEach((turn, index) => {
    lines.push(`## Turn ${index + 1} · ${turn.status} · ${turn.createdAt}`, "");
    lines.push("**Request**", "", turn.content, "");
    if (turn.responses.length === 0) {
      lines.push("_No response recorded._", "");
      return;
    }
    lines.push("**Response**", "");
    for (const response of turn.responses) {
      lines.push(splitNextPrompt(response).text, "");
    }
  });
  return `${lines.join("\n").trimEnd()}\n`;
}
