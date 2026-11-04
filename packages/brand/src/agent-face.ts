/// Each agent's face: one fixed drawn character in Demesne's anime print
/// style, drawn in code (no image model, nothing to download), so it is the
/// same character every day. Each has its own hair, clothes and one small
/// thing you can spot even at sidebar size: Claude a sakura clip, Codex
/// glasses and headphones, Gemini a bun with a star. The expression (pass
/// 140 B) follows what is really going on; the caller picks it. An unknown
/// agent gets a calm grey character with nothing extra.
export type FaceMood = "calm" | "happy" | "focus" | "stuck" | "sleepy" | "wave";
export const FACE_MOODS: readonly FaceMood[] = ["calm", "happy", "focus", "stuck", "sleepy", "wave"];

export interface FaceLook {
  /// Hair in front, hair behind, eyes, the tile behind the face, the top they wear.
  hair: string; hair2: string; eye: string; back: string; top: string;
  extra: "clip" | "glasses" | "star" | null;
  /// Hair paths in the 100x100 frame: behind the face, then the fringe.
  behind: string; fringe: string;
}

export const FACES: Record<string, FaceLook> = {
  claude: {
    hair: "#e8a37c", hair2: "#c97f58", eye: "#6b3b22", back: "#f6dfe6", top: "#4a3550", extra: "clip",
    behind: "M25 56 Q20 22 50 20 Q81 21 76 58 Q79 72 71 78 L69 56 Q66 42 50 40 L31 56 Q31 70 29 78 Q20 70 25 56Z",
    fringe: "M27 52 Q28 27 52 25 Q72 27 74 48 Q66 37 57 41 Q51 33 41 43 Q34 41 27 52Z",
  },
  codex: {
    hair: "#8fcaa5", hair2: "#5f9f7c", eye: "#2f5a45", back: "#e2f1ea", top: "#26393f", extra: "glasses",
    behind: "M27 54 Q24 30 50 27 Q76 30 73 54Z",
    fringe: "M27 52 L25 38 L32 39 L32 27 L41 32 L47 19 L54 29 L62 21 L64 32 L73 29 L71 40 L75 50 Q67 39 50 39 Q36 39 27 52Z",
  },
  gemini: {
    hair: "#9fb8f0", hair2: "#7392d6", eye: "#2b3f74", back: "#e3eafb", top: "#2d3560", extra: "star",
    behind: "M24 54 Q21 22 50 20 Q79 22 76 54 L79 88 Q70 82 70 62 L30 62 Q30 82 21 88Z",
    fringe: "M27 52 Q28 26 50 25 Q72 26 73 52 Q71 42 67 41 L63 47 L59 40 L53 46 L48 39 L43 46 L38 40 L34 47 Q31 43 27 52Z",
  },
};
const GREY: FaceLook = {
  hair: "#b8bcc6", hair2: "#959aa6", eye: "#3c4250", back: "#eceef2", top: "#3c4250", extra: null,
  behind: "M26 56 Q22 24 50 22 Q78 24 74 56Z",
  fringe: "M27 52 Q28 27 50 25 Q72 27 73 52 Q64 38 50 40 Q36 38 27 52Z",
};

const SKIN = "#fde8dc", MOUTH = "#c26f7d", BLUSH = "#f2b6c8";
const EYE_Y = 57, LEFT = 41, RIGHT = 59;

function eyes(look: FaceLook, mood: FaceMood): string {
  const arc = (bend: number, width: number) => `<path d="M${LEFT - 4} ${EYE_Y + 1} Q${LEFT} ${EYE_Y + bend} ${LEFT + 4} ${EYE_Y + 1}M${RIGHT - 4} ${EYE_Y + 1} Q${RIGHT} ${EYE_Y + bend} ${RIGHT + 4} ${EYE_Y + 1}" stroke="${look.eye}" stroke-width="${width}" fill="none" stroke-linecap="round"/>`;
  if (mood === "happy") return arc(-4, 2.4);
  if (mood === "sleepy") return arc(3, 2.2);
  const tall = mood === "focus" ? 3.2 : 4.4;
  const one = (x: number) => `<ellipse cx="${x}" cy="${EYE_Y}" rx="3.4" ry="${tall}" fill="${look.eye}"/><circle cx="${x + 1.2}" cy="${EYE_Y - 1.6}" r="1.2" fill="#fff"/>`;
  return one(LEFT) + one(RIGHT);
}

function brows(look: FaceLook, mood: FaceMood): string {
  if (mood === "focus") return `<path d="M36 49 L45 51M64 49 L55 51" stroke="${look.hair2}" stroke-width="2" stroke-linecap="round"/>`;
  if (mood === "stuck") return `<path d="M36 51 L45 49M64 51 L55 49" stroke="${look.hair2}" stroke-width="2" stroke-linecap="round"/>`;
  return "";
}

function mouth(mood: FaceMood): string {
  if (mood === "happy" || mood === "wave") return `<path d="M45 67 Q50 73 55 67Z" fill="${MOUTH}"/>`;
  if (mood === "sleepy") return `<ellipse cx="50" cy="69" rx="2.2" ry="1.6" fill="${MOUTH}"/>`;
  if (mood === "stuck") return `<path d="M45 69 Q47.5 67 50 69 Q52.5 71 55 69" stroke="${MOUTH}" stroke-width="2" fill="none" stroke-linecap="round"/>`;
  if (mood === "focus") return `<path d="M46 68 H54" stroke="${MOUTH}" stroke-width="2" stroke-linecap="round"/>`;
  return `<path d="M45 67 Q50 71 55 67" stroke="${MOUTH}" stroke-width="2" fill="none" stroke-linecap="round"/>`;
}

/// Small marks around the face: z's, a sweat drop, petals, a raised hand.
/// Drawn as shapes, not text, so the picture and video references (made
/// into PNGs without fonts) show them too.
function marks(mood: FaceMood): string {
  if (mood === "sleepy") return `<path d="M70 26 H78 L70 34 H78M80 16 H85 L80 21 H85" stroke="#7a86c4" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
  if (mood === "stuck") return `<path d="M73 44 Q76 50 73 53 Q70 50 73 44Z" fill="#8ec5f0"/>`;
  if (mood === "happy") return `<g fill="${BLUSH}"><circle cx="20" cy="30" r="2.4"/><circle cx="82" cy="40" r="2"/><circle cx="78" cy="22" r="1.6"/></g>`;
  if (mood === "wave") return `<g transform="translate(76 70) rotate(-18)"><rect x="-5" y="-12" width="10" height="16" rx="5" fill="${SKIN}"/></g>`;
  return "";
}

function extra(look: FaceLook): string {
  if (look.extra === "clip") {
    const petal = "M0 -3C-11 -9 -17 -24 -9 -35L0 -29.5L9 -35C17 -24 11 -9 0 -3Z";
    return `<g transform="translate(67 32) scale(.42)" fill="#f7a9c0">${[0, 72, 144, 216, 288].map((turn) => `<path d="${petal}" transform="rotate(${turn})"/>`).join("")}<circle r="4" fill="#fff3b0"/></g>`;
  }
  if (look.extra === "glasses") return `<g stroke="#2b2b33" stroke-width="1.6" fill="#fff" fill-opacity=".18"><circle cx="41" cy="57" r="6.5"/><circle cx="59" cy="57" r="6.5"/><path d="M47.5 57 H52.5" fill="none"/></g>`
    + `<path d="M24 50 Q24 18 50 17 Q76 18 76 50" stroke="#2b2b33" stroke-width="3" fill="none"/><rect x="20" y="46" width="7" height="12" rx="3" fill="#2b2b33"/><rect x="73" y="46" width="7" height="12" rx="3" fill="#2b2b33"/>`;
  if (look.extra === "star") return `<circle cx="68" cy="23" r="7.5" fill="${look.hair}" stroke="${look.hair2}" stroke-width="1"/><path d="M70 33 l2 4 4.4 .6 -3.2 3 .8 4.4 -4-2.1 -4 2.1 .8-4.4 -3.2-3 4.4-.6Z" fill="#f6d36b"/>`;
  return "";
}

/// The face as inline SVG, square, sized by its container.
export function agentFace(id: string, mood: FaceMood = "calm"): string {
  const look = FACES[id] ?? GREY;
  return `<svg class="agent-face-svg" viewBox="0 0 100 100" aria-hidden="true" data-mood="${mood}"><rect width="100" height="100" fill="${look.back}"/>`
    + `<path d="${look.behind}" fill="${look.hair2}"/>`
    + `<path d="M17 100 Q20 81 50 79 Q80 81 83 100Z" fill="${look.top}"/><path d="M42 80 L50 90 L58 80" stroke="#fff" stroke-opacity=".35" stroke-width="1.6" fill="none"/>`
    + `<rect x="44" y="70" width="12" height="11" rx="3" fill="#f3d4c4"/><ellipse cx="50" cy="55" rx="22" ry="23.5" fill="${SKIN}"/>`
    + `<ellipse cx="36" cy="64" rx="4.2" ry="2.2" fill="${BLUSH}" opacity=".75"/><ellipse cx="64" cy="64" rx="4.2" ry="2.2" fill="${BLUSH}" opacity=".75"/>`
    + eyes(look, mood) + brows(look, mood) + mouth(mood)
    + `<path d="${look.fringe}" fill="${look.hair}"/>`
    + extra(look) + marks(mood) + `</svg>`;
}
