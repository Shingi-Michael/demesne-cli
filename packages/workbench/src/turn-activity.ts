
type TurnPhase = "inspect" | "change" | "verify";

const CHANGE_TOOLS = new Set(["edit_file", "write_file", "move_path", "delete_path"]);

export function classifyTurnPhase(
  name: string,
  input: Record<string, unknown> = {},
  hasChanges = false,
): TurnPhase {
  if (CHANGE_TOOLS.has(name)) return "change";
  if (name === "run_command" && isValidationCommand(commandFrom(input) ?? "")) return "verify";
  if (hasChanges && (name === "git_diff" || name === "git_status")) return "verify";
  return "inspect";
}

function isValidationCommand(command: string): boolean {
  return /(^|\s)(test|typecheck|check|lint|build)(?=[:_-]|\s|$)/i.test(command) ||
    /(^|\s)(pytest|xcodebuild|tsc|eslint)(\s|$)/i.test(command);
}

function commandFrom(input: Record<string, unknown>): string | undefined {
  return Array.isArray(input.argv) && input.argv.every((value) => typeof value === "string")
    ? (input.argv as string[]).map(shellWord).join(" ")
    : undefined;
}

function shellWord(value: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}
