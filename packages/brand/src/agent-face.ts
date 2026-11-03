/// Each agent's face: one fixed drawn character in Demesne's anime print
/// style, drawn in code (no image model, nothing to download), so it is the
/// same face every day. Hair and eyes are the agent's colours; an unknown
/// agent gets a calm grey.
export interface FaceLook { hair: string; eye: string; back: string }

export const FACES: Record<string, FaceLook> = {
  claude: { hair: "#e8a37c", eye: "#6b3b22", back: "#f6dfe6" },
  codex: { hair: "#9fd0b0", eye: "#2f5a45", back: "#e2f1ea" },
  gemini: { hair: "#9fb8f0", eye: "#2b3f74", back: "#e3eafb" },
};
const GREY: FaceLook = { hair: "#b8bcc6", eye: "#3c4250", back: "#eceef2" };

/// The face as inline SVG, square, sized by its container.
export function agentFace(id: string): string {
  const look = FACES[id] ?? GREY;
  return `<svg class="agent-face-svg" viewBox="0 0 100 100" aria-hidden="true"><rect width="100" height="100" fill="${look.back}"/>`
    + `<circle cx="50" cy="58" r="26" fill="#fbe7da"/>`
    + `<path d="M22 58 Q20 26 50 24 Q80 26 78 58 Q70 38 52 40 Q36 40 22 58Z" fill="${look.hair}"/>`
    + `<circle cx="41" cy="60" r="3.6" fill="${look.eye}"/><circle cx="59" cy="60" r="3.6" fill="${look.eye}"/>`
    + `<path d="M45 70 Q50 73 55 70" stroke="#c26f7d" stroke-width="2" fill="none" stroke-linecap="round"/>`
    + `<ellipse cx="35" cy="67" rx="4" ry="2" fill="#f2b6c8" opacity=".7"/><ellipse cx="65" cy="67" rx="4" ry="2" fill="#f2b6c8" opacity=".7"/></svg>`;
}
