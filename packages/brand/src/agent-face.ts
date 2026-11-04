/// Each agent's face: one fixed drawn character, drawn in code (no image
/// model, nothing to download), so it is the same character every day. Each
/// has its own hair, clothes and one small thing you can spot even at
/// sidebar size: Claude a sakura clip, Codex glasses and headphones, Gemini
/// a bun with a star. Pass 148 polished them: grown-up proportions (a longer
/// face with a chin, smaller eyes, brows, a nose, a neck and shoulders), a
/// thin line around each shape, soft shading and a lit tile. The expression
/// (pass 140 B) follows what is really going on; the caller picks it. An
/// unknown agent gets a calm grey character with nothing extra. Parts are
/// grouped (.body, .head, .hair, .eyes) so a story can move them in CSS.
export type FaceMood = "calm" | "happy" | "focus" | "stuck" | "sleepy" | "wave";
export const FACE_MOODS: readonly FaceMood[] = ["calm", "happy", "focus", "stuck", "sleepy", "wave"];

export interface FaceLook {
  /// Hair in front, hair behind, the line colour, eyes, the tile (edge and
  /// lit centre), the top they wear and its shadow.
  hair: string; hair2: string; ink: string; eye: string; back: string; back0: string; top: string; top2: string;
  extra: "clip" | "glasses" | "star" | null;
  /// Hair paths in the 100x100 frame: behind the face, the fringe, and the shine on it.
  behind: string; fringe: string; shine: string;
}

export const FACES: Record<string, FaceLook> = {
  claude: {
    hair: "#e8a37c", hair2: "#c97f58", ink: "#8a4f35", eye: "#6b3b22", back: "#f6dfe6", back0: "#fdf3f6", top: "#4a3550", top2: "#3a2942", extra: "clip",
    behind: "M25 56 Q20 22 50 20 Q81 21 76 58 Q79 72 71 78 L69 56 Q66 42 50 40 L31 56 Q31 70 29 78 Q20 70 25 56Z",
    fringe: "M27 52 Q28 27 52 25 Q72 27 74 48 Q66 37 57 41 Q51 33 41 43 Q34 41 27 52Z",
    shine: "M37 36 Q46 29.5 58 30.5",
  },
  codex: {
    hair: "#8fcaa5", hair2: "#5f9f7c", ink: "#3e6b54", eye: "#2f5a45", back: "#e2f1ea", back0: "#f3faf6", top: "#26393f", top2: "#1b2a2f", extra: "glasses",
    behind: "M27 54 Q24 30 50 27 Q76 30 73 54Z",
    fringe: "M27 52 L25 38 L32 39 L32 27 L41 32 L47 19 L54 29 L62 21 L64 32 L73 29 L71 40 L75 50 Q67 39 50 39 Q36 39 27 52Z",
    shine: "M36 37 Q45 33 55 33.5",
  },
  gemini: {
    hair: "#9fb8f0", hair2: "#7392d6", ink: "#4a5f9c", eye: "#2b3f74", back: "#e3eafb", back0: "#f4f7fe", top: "#2d3560", top2: "#212849", extra: "star",
    behind: "M24 54 Q21 22 50 20 Q79 22 76 54 L79 88 Q70 82 70 62 L30 62 Q30 82 21 88Z",
    fringe: "M27 52 Q28 26 50 25 Q72 26 73 52 Q71 42 67 41 L63 47 L59 40 L53 46 L48 39 L43 46 L38 40 L34 47 Q31 43 27 52Z",
    shine: "M36 34 Q46 28.5 58 29.5",
  },
};
const GREY: FaceLook = {
  hair: "#b8bcc6", hair2: "#959aa6", ink: "#6b7180", eye: "#3c4250", back: "#eceef2", back0: "#f8f9fb", top: "#3c4250", top2: "#2c313c", extra: null,
  behind: "M26 56 Q22 24 50 22 Q78 24 74 56Z",
  fringe: "M27 52 Q28 27 50 25 Q72 27 73 52 Q64 38 50 40 Q36 38 27 52Z",
  shine: "M37 35 Q46 30 57 31",
};

const SKIN = "#fde8dc", SHADE = "#f3cdbd", SKIN_LINE = "#d6a08b", MOUTH = "#b9606f", BLUSH = "#f2a9bc", PINK = "#f2b6c8";
/// The face: a longer oval with a soft chin.
const FACE = "M30 51 C30 37 39 30.5 50 30.5 C61 30.5 70 37 70 51 C70 63.5 64 73.5 56 78 C52.8 79.8 47.2 79.8 44 78 C36 73.5 30 63.5 30 51Z";
const EYE_Y = 56, LEFT = 42, RIGHT = 58;

function eyes(look: FaceLook, mood: FaceMood): string {
  const arc = (bend: number, width: number) => `<path d="M${LEFT - 3.6} ${EYE_Y + 0.6} Q${LEFT} ${EYE_Y + bend} ${LEFT + 3.6} ${EYE_Y + 0.6}M${RIGHT - 3.6} ${EYE_Y + 0.6} Q${RIGHT} ${EYE_Y + bend} ${RIGHT + 3.6} ${EYE_Y + 0.6}" stroke="${look.eye}" stroke-width="${width}" fill="none" stroke-linecap="round"/>`;
  if (mood === "happy") return arc(-3.4, 1.9);
  if (mood === "sleepy") return arc(2.4, 1.8);
  const focus = mood === "focus", tall = focus ? 2.5 : 3.5, lid = focus ? 1 : 0;
  const one = (x: number) => `<ellipse cx="${x}" cy="${EYE_Y}" rx="2.7" ry="${tall}" fill="${look.eye}"/><circle cx="${x + 0.9}" cy="${EYE_Y - 1.3}" r=".95" fill="#fff"/>`
    + `<path d="M${x - 3.6} ${EYE_Y - 1.6 + lid} Q${x} ${EYE_Y - 4.6 + lid} ${x + 3.6} ${EYE_Y - 1.8 + lid}" stroke="${look.ink}" stroke-width="1.3" fill="none" stroke-linecap="round"/>`;
  return one(LEFT) + one(RIGHT);
}

function brows(look: FaceLook, mood: FaceMood): string {
  if (mood === "focus") return `<path d="M37.5 49 L46 50.4M62.5 49 L54 50.4" stroke="${look.hair2}" stroke-width="1.6" stroke-linecap="round"/>`;
  if (mood === "stuck") return `<path d="M37.5 50.2 L46 48.4M62.5 50.2 L54 48.4" stroke="${look.hair2}" stroke-width="1.6" stroke-linecap="round"/>`;
  return `<path d="M38 49.6 Q42 47.6 46 48.8M62 49.6 Q58 47.6 54 48.8" stroke="${look.hair2}" stroke-width="1.4" fill="none" stroke-linecap="round" opacity=".85"/>`;
}

function mouth(mood: FaceMood): string {
  if (mood === "happy" || mood === "wave") return `<path d="M45.6 68.4 Q50 73.4 54.4 68.4 Q50 69.4 45.6 68.4Z" fill="${MOUTH}"/>`;
  if (mood === "sleepy") return `<ellipse cx="50" cy="70" rx="1.8" ry="1.3" fill="${MOUTH}"/>`;
  if (mood === "stuck") return `<path d="M46 70 Q48 68.6 50 70 Q52 71.4 54 70" stroke="${MOUTH}" stroke-width="1.5" fill="none" stroke-linecap="round"/>`;
  if (mood === "focus") return `<path d="M47 69.6 H53" stroke="${MOUTH}" stroke-width="1.5" stroke-linecap="round"/>`;
  return `<path d="M46 68.8 Q50 71.6 54 68.8" stroke="${MOUTH}" stroke-width="1.5" fill="none" stroke-linecap="round"/>`;
}

/// Small marks around the face: z's, a sweat drop, petals, a raised hand.
/// Drawn as shapes, not text, so the picture and video references (made
/// into PNGs without fonts) show them too.
function marks(mood: FaceMood): string {
  if (mood === "sleepy") return `<g class="face-zz" stroke="#7a86c4" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M72 26 H79 L72 33 H79"/><path d="M82 16 H86.5 L82 20.5 H86.5"/></g>`;
  if (mood === "stuck") return `<path class="face-drop" d="M74 43 Q77 49 74 52 Q71 49 74 43Z" fill="#9fd0f4" stroke="#6aa8d6" stroke-width=".6"/>`;
  if (mood === "happy") return `<g class="face-petals" fill="${PINK}"><circle cx="19" cy="32" r="2.2"/><circle cx="83" cy="40" r="1.8"/><circle cx="80" cy="22" r="1.5"/></g>`;
  if (mood === "wave") return `<g transform="translate(80 74)"><path class="face-hand" d="M-4.5 6 L-4.5 -6 Q-4.5 -10 0 -10 Q4.5 -10 4.5 -6 L4.5 6Z" fill="${SKIN}" stroke="${SKIN_LINE}" stroke-width=".8"/></g>`;
  return "";
}

function extra(look: FaceLook): string {
  if (look.extra === "clip") {
    const petal = "M0 -3C-11 -9 -17 -24 -9 -35L0 -29.5L9 -35C17 -24 11 -9 0 -3Z";
    return `<g transform="translate(67 32) scale(.42)" fill="#f7a9c0" stroke="#d97d99" stroke-width="2">${[0, 72, 144, 216, 288].map((turn) => `<path d="${petal}" transform="rotate(${turn})"/>`).join("")}<circle r="4.4" fill="#fff3b0" stroke="#e0c46a" stroke-width="1.4"/></g>`;
  }
  if (look.extra === "glasses") return `<g stroke="#2b2b33" stroke-width="1.3" fill="#fff" fill-opacity=".2"><rect x="35.6" y="51" width="12.8" height="10" rx="4.2"/><rect x="51.6" y="51" width="12.8" height="10" rx="4.2"/><path d="M48.4 55 Q50 54 51.6 55" fill="none"/></g><path d="M38 52.4 L41 51.4" stroke="#fff" stroke-width=".9" stroke-linecap="round" opacity=".7"/>`
    + `<path d="M24.5 50 Q24.5 17.5 50 16.5 Q75.5 17.5 75.5 50" stroke="#2b2b33" stroke-width="2.8" fill="none"/><path d="M26 22 Q50 13 74 22" stroke="#fff" stroke-width=".8" fill="none" opacity=".25"/>`
    + `<rect x="20.5" y="45" width="7" height="13" rx="3.2" fill="#2b2b33"/><rect x="72.5" y="45" width="7" height="13" rx="3.2" fill="#2b2b33"/><rect x="21.8" y="47" width="2" height="9" rx="1" fill="#fff" opacity=".18"/>`;
  if (look.extra === "star") return `<circle cx="68" cy="23" r="7.5" fill="${look.hair}" stroke="${look.ink}" stroke-width=".9"/><path d="M64 19.5 Q67.5 17 71 18.5" stroke="#fff" stroke-width="1.1" fill="none" opacity=".45" stroke-linecap="round"/>`
    + `<path d="M70 33 l2 4 4.4 .6 -3.2 3 .8 4.4 -4-2.1 -4 2.1 .8-4.4 -3.2-3 4.4-.6Z" fill="#f6d36b" stroke="#d8ad3c" stroke-width=".7" stroke-linejoin="round"/>`;
  return "";
}

/// The face as inline SVG, square, sized by its container. Gradient and clip
/// ids are per character, so many copies on one page agree with each other.
export function agentFace(id: string, mood: FaceMood = "calm"): string {
  const known = Object.hasOwn(FACES, id), look = known ? FACES[id]! : GREY, key = known ? id : "grey";
  return `<svg class="agent-face-svg" viewBox="0 0 100 100" aria-hidden="true" data-mood="${mood}">`
    + `<defs><radialGradient id="af-tile-${key}" cx="45%" cy="35%" r="75%"><stop offset="0" stop-color="${look.back0}"/><stop offset="1" stop-color="${look.back}"/></radialGradient>`
    + `<clipPath id="af-face-${key}"><path d="${FACE}"/></clipPath></defs>`
    + `<rect width="100" height="100" fill="url(#af-tile-${key})"/>`
    + `<g class="face-body"><path d="M13 100 C16 89 29 84.5 43 83.5 L57 83.5 C71 84.5 84 89 87 100Z" fill="${look.top}" stroke="${look.top2}" stroke-width=".8"/>`
    + `<path d="M36 84.6 C38.5 91 44.5 94 50 94 C55.5 94 61.5 91 64 84.6" fill="${look.top2}"/>`
    + `<path d="M46.5 92 L46 99 M53.5 92 L54 99" stroke="#fff" stroke-opacity=".35" stroke-width="1" stroke-linecap="round"/>`
    + `<path d="M44.6 72 L44.6 85 Q50 89 55.4 85 L55.4 72Z" fill="${SKIN}" stroke="${SKIN_LINE}" stroke-width=".7"/><path d="M44.6 76 Q50 80.5 55.4 76 L55.4 79 Q50 83 44.6 79Z" fill="${SHADE}"/></g>`
    + `<g class="face-head"><g class="face-hair"><path d="${look.behind}" fill="${look.hair2}" stroke="${look.ink}" stroke-width=".8" stroke-linejoin="round"/></g>`
    + `<path d="M30.4 53 C27.6 52.6 27 57.6 29.2 60 C30.2 61.2 31.6 61 32 60" fill="${SKIN}" stroke="${SKIN_LINE}" stroke-width=".7"/><path d="M69.6 53 C72.4 52.6 73 57.6 70.8 60 C69.8 61.2 68.4 61 68 60" fill="${SKIN}" stroke="${SKIN_LINE}" stroke-width=".7"/>`
    + `<path d="${FACE}" fill="${SKIN}" stroke="${SKIN_LINE}" stroke-width=".8"/>`
    + `<g clip-path="url(#af-face-${key})"><path d="${look.fringe}" fill="${SHADE}" transform="translate(0 3.2)"/></g>`
    + `<ellipse cx="37" cy="63.4" rx="3.2" ry="1.6" fill="${BLUSH}" opacity=".38"/><ellipse cx="63" cy="63.4" rx="3.2" ry="1.6" fill="${BLUSH}" opacity=".38"/>`
    + `<g class="face-eyes">${eyes(look, mood)}</g>` + brows(look, mood)
    + `<path d="M50.4 60.6 L49.4 63.6 L50.8 63.9" stroke="${SKIN_LINE}" stroke-width=".8" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`
    + mouth(mood)
    + `<g class="face-hair"><path d="${look.fringe}" fill="${look.hair}" stroke="${look.ink}" stroke-width=".8" stroke-linejoin="round"/><path d="${look.shine}" stroke="#fff" stroke-width="1.6" fill="none" stroke-linecap="round" opacity=".42"/></g>`
    + extra(look) + marks(mood) + `</g></svg>`;
}
