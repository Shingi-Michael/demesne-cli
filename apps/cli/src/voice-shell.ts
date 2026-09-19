/// Renders argv words for the agent's voice without executing anything.
export function shellWords(argv: readonly string[]): string {
  return argv.map((value) => (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`)).join(" ");
}