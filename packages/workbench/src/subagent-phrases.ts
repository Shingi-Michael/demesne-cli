/// What a sub-agent's line says while it works: a cycling, irreverent saying
/// after its task, instead of "thinking · 3 tool calls". Its real steps live
/// in the guide that unfolds under the row. Dependency-free so the renderer
/// can bundle it.

const BAD_INTENTIONS = [
  "Dreaming about rm -rf",
  "Plotting a force-push",
  "Whispering to --no-verify",
  "Eyeing node_modules hungrily",
  "Fantasising about git reset --hard",
  "Negotiating with sudo",
  "Considering chmod 777",
];

const GREMLIN_ENERGY = [
  "Licking the semicolons",
  "Hoarding curly braces",
  "Chewing on regexes",
  "Sniffing the lockfile",
  "Burrowing into utils",
  "Nesting in the callbacks",
  "Gnawing through the monorepo",
];

/// Pokes at the model the sub-agent runs on.
function pokes(model: string): string[] {
  const id = model.toLowerCase();
  if (id.includes("qwen")) return ["Qwen-ing it", "Locally overthinking", "Heating up your PC"];
  if (id.includes("astra") || id.includes("gpt")) return ["Consulting the stars", "Burning plan credits"];
  return [];
}

/// Long enough to read a phrase before it changes.
const SUBAGENT_PHRASE_MS = 4000;

/// The phrase a card shows at `now`. Every card follows one shuffled order on
/// one clock, offset by its `slot` (its place among the turn's sub-agents),
/// so parallel sub-agents never say the same thing at once; a full cycle
/// shows each phrase before any repeats.
export function subagentPhrase(slot: number, now: number, model = ""): string {
  const phrases = [...BAD_INTENTIONS, ...GREMLIN_ENERGY, ...pokes(model)];
  let state = 2166136261;
  for (const character of "demesne") state = Math.imul(state ^ character.charCodeAt(0), 16777619);
  const random = () => { state = Math.imul(state ^ (state >>> 15), 2246822507) ^ Math.imul(state ^ (state >>> 13), 3266489909); return ((state ^= state >>> 16) >>> 0) / 4294967296; };
  for (let index = phrases.length - 1; index > 0; index--) {
    const pick = Math.floor(random() * (index + 1));
    [phrases[index], phrases[pick]] = [phrases[pick]!, phrases[index]!];
  }
  return phrases[(Math.floor(Math.max(0, now) / SUBAGENT_PHRASE_MS) + slot * 3) % phrases.length]!;
}

