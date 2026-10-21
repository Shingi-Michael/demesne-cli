/// The working cube: eight cubelets that part, turn a quarter on a random
/// axis, and close, once per beat. It is drawn as one small SVG of flat faces
/// lit from a fixed light, so a mark costs a few polygons instead of dozens of
/// 3D layers, and a mark drawn mid-beat (the conversation repaints while the
/// model streams) starts on the same frame as every other. One unit is one
/// pixel, the size of the CSS cube it replaced: it is a little larger than its
/// 12px box and spills past it while parted.

type Matrix = [number, number, number, number, number, number, number, number, number];
type Vector = [number, number, number];

export const BEAT_MS = 1400;
const PART_MS = 220, TURN_START = 220, TURN_MS = 560, CLOSE_START = 760, CLOSE_MS = 450;
const REST = 3, PARTED = 4.6, HALF = 2.7;

const multiply = (a: Matrix, b: Matrix): Matrix => [
  a[0] * b[0] + a[1] * b[3] + a[2] * b[6], a[0] * b[1] + a[1] * b[4] + a[2] * b[7], a[0] * b[2] + a[1] * b[5] + a[2] * b[8],
  a[3] * b[0] + a[4] * b[3] + a[5] * b[6], a[3] * b[1] + a[4] * b[4] + a[5] * b[7], a[3] * b[2] + a[4] * b[5] + a[5] * b[8],
  a[6] * b[0] + a[7] * b[3] + a[8] * b[6], a[6] * b[1] + a[7] * b[4] + a[8] * b[7], a[6] * b[2] + a[7] * b[5] + a[8] * b[8],
];
const apply = (m: Matrix, v: Vector): Vector => [
  m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
];
/// A rotation about x (0), y (1) or z (2). Screen axes: x right, y down, z toward you.
export function rotation(axis: number, degrees: number): Matrix {
  const r = (degrees * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  return axis === 0 ? [1, 0, 0, 0, c, -s, 0, s, c] : axis === 1 ? [c, 0, s, 0, 1, 0, -s, 0, c] : [c, -s, 0, s, c, 0, 0, 0, 1];
}
const IDENTITY: Matrix = [1, 0, 0, 0, 1, 0, 0, 0, 1];
/// Tilted so the top and two sides show.
const VIEW = multiply(rotation(0, -24), rotation(1, 36));
const LIGHT: Vector = (() => { const v: Vector = [-0.45, -0.8, 0.55], n = Math.hypot(...v); return [v[0] / n, v[1] / n, v[2] / n]; })();
const ease = (t: number) => { const x = Math.min(1, Math.max(0, t)); return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2; };

/// Where the cube is: its orientation at the start of this beat, the beat's
/// turn, and when the beat started.
export interface CubeState { base: Matrix; axis: number; sign: number; beatAt: number }
export const restingCube = (now = 0): CubeState => ({ base: IDENTITY, axis: 1, sign: 1, beatAt: now });

/// Moves to the beat that `now` falls in, settling every finished turn into
/// the base orientation and picking the next turn at random.
export function advance(state: CubeState, now: number, random = Math.random): CubeState {
  let next = state;
  while (now - next.beatAt >= BEAT_MS) {
    const settled = multiply(rotation(next.axis, next.sign * 90), next.base).map((value) => Math.round(value)) as Matrix;
    next = { base: settled, axis: Math.floor(random() * 3), sign: random() < 0.5 ? -1 : 1, beatAt: next.beatAt + BEAT_MS };
    // After a long pause, start fresh instead of replaying missed beats.
    if (now - next.beatAt >= BEAT_MS * 4) next = { ...next, beatAt: now };
  }
  return next;
}

/// Whether anything moves at `now` (between beats the cube rests).
export const moving = (state: CubeState, now: number) => now - state.beatAt < CLOSE_START + CLOSE_MS;

const FACES: { normal: Vector; corners: Vector[] }[] = [0, 1, 2].flatMap((axis) => [-1, 1].map((side) => {
  const normal = [0, 0, 0] as Vector; normal[axis] = side;
  const [u, v] = [0, 1, 2].filter((other) => other !== axis) as [number, number];
  const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => {
    const point = [0, 0, 0] as Vector; point[axis] = side * HALF; point[u] = a! * HALF; point[v] = b! * HALF; return point;
  });
  return { normal, corners };
}));

/// The SVG for one frame: back cubelets first, only faces turned toward you,
/// each shaded by how much it faces the light (theme colors via CSS).
export function cubeSvg(state: CubeState, now: number, still = false): string {
  const u = still ? BEAT_MS : now - state.beatAt;
  const gap = still ? 0 : u < CLOSE_START ? ease(u / PART_MS) : 1 - ease((u - CLOSE_START) / CLOSE_MS);
  const angle = still ? 0 : state.sign * 90 * ease((u - TURN_START) / TURN_MS);
  const whole = multiply(VIEW, multiply(rotation(state.axis, angle), state.base));
  const spread = REST + (PARTED - REST) * gap;
  const cubelets = [-1, 1].flatMap((x) => [-1, 1].flatMap((y) => [-1, 1].map((z) => apply(whole, [x * spread, y * spread, z * spread]))));
  cubelets.sort((a, b) => a[2] - b[2]);
  const faces = FACES.map((face) => ({ normal: apply(whole, face.normal), corners: face.corners.map((corner) => apply(whole, corner)) }))
    .filter((face) => face.normal[2] > 0.02);
  const polygons = cubelets.flatMap((center) => faces.map((face) => {
    const light = Math.max(0, face.normal[0] * LIGHT[0] + face.normal[1] * LIGHT[1] + face.normal[2] * LIGHT[2]);
    const share = Math.round(12 + 88 * light);
    const points = face.corners.map((corner) => `${(center[0] + corner[0]).toFixed(2)},${(center[1] + corner[1]).toFixed(2)}`).join(" ");
    return `<polygon points="${points}" style="fill:color-mix(in srgb,var(--t1) ${share}%,var(--t4))"/>`;
  }));
  return `<svg viewBox="-6 -6 12 12" width="12" height="12">${polygons.join("")}</svg>`;
}
