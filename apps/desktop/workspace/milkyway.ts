/// Home's sky (Milky Way, pass 268): a spiral galaxy on the black of space
/// and, in front of it, the piece you picked in Settings › Appearance (pass
/// 276): the flagship Demesne by default, or a wheel station, a freighter, a
/// twin-hull scout, the ringed planet, or nothing at all. By day the same
/// piece flies through a pale dawn. All are still pictures (rendered 3D
/// models; scripts/milky-way/ makes them again), so Home costs nothing while
/// it sits there. The sky ends just above the greeting and fades out, so no
/// text sits on it.

export type MilkyWay = { setDark(dark: boolean): void; setPiece(piece: HomeSky): void; refit(): void };

/// What can fly over Home, in the order Settings shows them, with the words it uses.
export const HOME_SKIES = [
  ["flagship", "The flagship"], ["station", "Wheel station"], ["freighter", "Freighter"],
  ["scout", "Twin-hull scout"], ["planet", "Ringed planet"], ["none", "Just the sky"],
] as const;
export type HomeSky = (typeof HOME_SKIES)[number][0];
export const isHomeSky = (value: unknown): value is HomeSky => HOME_SKIES.some(([id]) => id === value);

export const SKY = { night: "assets/milky-way-night.jpg", dawn: "assets/milky-way-dawn.jpg", ship: "assets/milky-way-flagship.webp" } as const;
/// The picture for each piece; "none" has none.
export const PIECES: Record<Exclude<HomeSky, "none">, string> = {
  flagship: SKY.ship, station: "assets/milky-way-station.webp", freighter: "assets/milky-way-freighter.webp",
  scout: "assets/milky-way-scout.webp", planet: "assets/milky-way-planet.webp",
};
/// How far below the greeting's top the sky's fade may reach.
const UNDER = 14;

export function mountMilkyWay(host: HTMLElement, dark: boolean, floor: () => number, piece: HomeSky = "flagship"): MilkyWay {
  const box = document.createElement("div"); box.className = "mw-hero";
  const sky = document.createElement("img"); sky.className = "mw-sky"; sky.alt = ""; sky.decoding = "async"; sky.draggable = false;
  const ship = document.createElement("img"); ship.className = "mw-ship"; ship.alt = ""; ship.decoding = "async"; ship.draggable = false;
  box.append(sky, ship); host.append(box);
  let shown: boolean | null = null, height = -1, flying: HomeSky | null = null;
  const setDark = (next: boolean) => { if (next === shown) return; shown = next; sky.src = next ? SKY.night : SKY.dawn; };
  // Each piece has its own place in the sky (workspace.css, .mw-hero[data-piece]).
  const setPiece = (next: HomeSky) => {
    if (next === flying) return; flying = next;
    box.dataset.piece = next; ship.hidden = next === "none";
    if (next !== "none") ship.src = PIECES[next];
  };
  // Home's greeting moved (it grew a line, or lost one): end the sky above it again.
  const refit = () => { const next = Math.max(0, Math.round(floor() + UNDER)); if (next === height) return; height = next; box.style.height = `${next}px`; };
  setDark(dark); setPiece(piece); refit();
  return { setDark, setPiece, refit };
}
