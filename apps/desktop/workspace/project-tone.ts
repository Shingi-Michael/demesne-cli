/// A project's own colour when its face is a letter: picked from its name, so
/// it is the same every time and on every machine.
const TONES = ["#7eaef0", "#b79cf0", "#71c994", "#f2b6c8", "#e7b96a", "#5fb0c8", "#ef8b8b", "#9fb4c8"];
export function projectTone(name: string): string {
  let hash = 0;
  for (const char of name.toLowerCase()) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  return TONES[hash % TONES.length]!;
}
