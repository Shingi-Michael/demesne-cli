import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

/// A project's face in the sidebar: its own icon when it has one, otherwise a
/// coloured letter. These are the places projects usually keep their icon,
/// checked in order; `apps/*` and `packages/*` cover monorepos.
const ICON_FILES = [
  "icon.svg", "logo.svg", "favicon.svg", "icon.png", "logo.png", "favicon.png",
  "public/icon.svg", "public/logo.svg", "public/favicon.svg", "public/icon.png", "public/logo.png", "public/favicon.png", "public/apple-touch-icon.png",
  "static/favicon.svg", "static/favicon.png", "assets/icon.svg", "assets/icon.png", "assets/logo.svg", "assets/logo.png",
  "app/icon.svg", "app/icon.png", "src/app/icon.svg", "src/app/icon.png", "build/icon.png", "resources/icon.png",
];
const MAX_BYTES = 256 * 1024;

/// The data URL of the project's icon, or null when it has none we can show.
/// SVGs are shown through an <img>, which never runs their scripts.
export function projectFace(root: string): string | null {
  for (const file of iconCandidates(root)) {
    try {
      const size = statSync(file).size;
      if (!size || size > MAX_BYTES) continue;
      const bytes = readFileSync(file);
      if (file.endsWith(".svg")) {
        if (!/<svg[\s>]/i.test(bytes.toString("utf8", 0, Math.min(bytes.length, 4096)))) continue;
        return `data:image/svg+xml;base64,${bytes.toString("base64")}`;
      }
      if (bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") continue;
      return `data:image/png;base64,${bytes.toString("base64")}`;
    } catch { /* unreadable: try the next one */ }
  }
  return null;
}

function iconCandidates(root: string): string[] {
  const direct = ICON_FILES.map((file) => join(root, file));
  const nested: string[] = [];
  for (const parent of ["apps", "packages"]) {
    const dir = join(root, parent);
    if (!existsSync(dir)) continue;
    let kids: string[] = [];
    try { kids = readdirSync(dir).filter((kid) => !kid.startsWith(".")).sort().slice(0, 30); } catch { continue; }
    // The app named like the project, or a desktop/web app, is the likeliest home of its icon.
    const name = basename(root).toLowerCase();
    kids.sort((a, b) => rank(a, name) - rank(b, name));
    for (const kid of kids) for (const file of ["icon.svg", "icon.png", "public/favicon.svg", "public/icon.png", "build/icon.png"]) nested.push(join(dir, kid, file));
  }
  return [...direct, ...nested];
}

const rank = (kid: string, name: string) => name.includes(kid.toLowerCase()) ? 0 : /desktop|web|app/i.test(kid) ? 1 : 2;
