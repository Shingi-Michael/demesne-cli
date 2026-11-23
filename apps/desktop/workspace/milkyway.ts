/// Home's sky (Milky Way, pass 268): a spiral galaxy on the black of space
/// and, leaving it, the flagship Demesne with its engines burning. By day the
/// same ship flies through a pale dawn. Both are still pictures (the ship is
/// a rendered 3D model; scripts/milky-way/ makes it again), so Home costs
/// nothing while it sits there. The sky ends just above the greeting and
/// fades out, so no text sits on it.

export type MilkyWay = { setDark(dark: boolean): void; refit(): void };

export const SKY = { night: "assets/milky-way-night.jpg", dawn: "assets/milky-way-dawn.jpg", ship: "assets/milky-way-flagship.webp" } as const;
/// How far below the greeting's top the sky's fade may reach.
const UNDER = 14;

export function mountMilkyWay(host: HTMLElement, dark: boolean, floor: () => number): MilkyWay {
  const box = document.createElement("div"); box.className = "mw-hero";
  const sky = document.createElement("img"); sky.className = "mw-sky"; sky.alt = ""; sky.decoding = "async"; sky.draggable = false;
  const ship = document.createElement("img"); ship.className = "mw-ship"; ship.alt = ""; ship.decoding = "async"; ship.draggable = false; ship.src = SKY.ship;
  box.append(sky, ship); host.append(box);
  let shown: boolean | null = null, height = -1;
  const setDark = (next: boolean) => { if (next === shown) return; shown = next; sky.src = next ? SKY.night : SKY.dawn; };
  // Home's greeting moved (it grew a line, or lost one): end the sky above it again.
  const refit = () => { const next = Math.max(0, Math.round(floor() + UNDER)); if (next === height) return; height = next; box.style.height = `${next}px`; };
  setDark(dark); refit();
  return { setDark, refit };
}
