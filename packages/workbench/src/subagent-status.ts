/// Progress lines that only say a sub-agent is between steps (starting,
/// thinking, writing its report), optionally after a "<model> · " prefix.
/// They are not steps; the model name is kept for the guide's first line.
const STATUS = /^(?:([^·]+) · )?(?:starting|writing report|thinking · \d+ tool calls?)$/;
export function subagentStatus(text: string): { model?: string } | null {
  const match = STATUS.exec(text.trim());
  return match ? (match[1] ? { model: match[1].trim() } : {}) : null;
}
