import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/// The window's page: frontend.ts bundled with its styles, fonts and KaTeX.
/// prepare-desktop.ts builds it into the app; `--out` builds the page alone.
const root = resolve(import.meta.dir, ".."), desktop = join(root, "apps/desktop"), workspace = join(desktop, "workspace");

export async function prepareUi(out: string) {
  rmSync(out, { recursive: true, force: true }); mkdirSync(out, { recursive: true });
  const bundle = await Bun.build({ entrypoints: [join(desktop, "frontend.ts")], outdir: out, target: "browser", format: "esm", external: ["electron"], minify: true, splitting: true });
  if (!bundle.success) throw new Error(bundle.logs.map(String).join("\n"));
  writeFileSync(join(out, "ui.css"), readFileSync(join(workspace, "ui.css"), "utf8").replaceAll(/node_modules\/@fontsource\/[a-z-]+\/files\//g, "vendor/fonts/"));
  cpSync(join(workspace, "live.css"), join(out, "live.css"));
  writeFileSync(join(out, "index.html"), readFileSync(join(desktop, "index.html"), "utf8").replaceAll("node_modules/katex/dist/katex.min.css", "vendor/katex/katex.min.css"));
  cpSync(join(desktop, "desktop.css"), join(out, "desktop.css"));
  cpSync(join(desktop, "workspace.css"), join(out, "workspace.css"));
  cpSync(join(workspace, "assets"), join(out, "assets"), { recursive: true });
  mkdirSync(join(out, "vendor/fonts"), { recursive: true });
  for (const weight of [400, 500]) cpSync(join(desktop, "node_modules/@fontsource/jetbrains-mono/files", `jetbrains-mono-latin-${weight}-normal.woff2`), join(out, "vendor/fonts", `jetbrains-mono-latin-${weight}-normal.woff2`));
  for (const weight of [400, 500, 600]) cpSync(join(desktop, "node_modules/@fontsource/inter/files", `inter-latin-${weight}-normal.woff2`), join(out, "vendor/fonts", `inter-latin-${weight}-normal.woff2`));
  // anime.js rides into an artifact frame for its first show (foundry-assemble.ts).
  cpSync(join(desktop, "node_modules/animejs/dist/bundles/anime.umd.min.js"), join(out, "vendor/anime.umd.min.js"));
  mkdirSync(join(out, "vendor/katex"), { recursive: true });
  cpSync(join(desktop, "node_modules/katex/dist/katex.min.css"), join(out, "vendor/katex/katex.min.css"));
  cpSync(join(desktop, "node_modules/katex/dist/fonts"), join(out, "vendor/katex/fonts"), { recursive: true });
}

if (import.meta.main) {
  const at = process.argv.indexOf("--out"), out = at >= 0 ? process.argv[at + 1] : undefined;
  if (!out) throw new Error("Usage: bun scripts/prepare-ui.ts --out <dir>");
  await prepareUi(resolve(out));
  console.log(`Prepared the window's page in ${resolve(out)}.`);
}
