import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { APP_URL, allowAppReload, desktopBlurs, desktopGlass, exportedSource, liquidGlass, macVibrancy, notchInset, FOUNDRY_CSP, FOUNDRY_KIT, foundryDocument, foundryKitFile, foundryURL, previewURL, assetPath, localAppURL, nextZoom, openTarget, validateRequest } from "../electron/policy.ts";
import { ASSEMBLE_SCRIPT, assembledDocument, scriptText } from "../electron/foundry-assemble.ts";

test("project switching may reload only the exact main application document", () => {
  expect(allowAppReload(APP_URL, true)).toBe(true);
  expect(allowAppReload(APP_URL, false)).toBe(false);
  for (const url of ["https://example.com", "file:///etc/passwd", "demesne://app/other.html", `${APP_URL}?redirect=1`, "demesne://elsewhere/index.html"])
    expect(allowAppReload(url, true)).toBe(false);
});

test("only local application origins reach the bridge and asset resolver", () => {
  expect(localAppURL("demesne://app/index.html")).toBe(true);
  for (const url of ["https://app/", "file:///etc/passwd", "demesne://user@app/", "demesne://app:9000/", "demesne://elsewhere/"]) {
    expect(localAppURL(url)).toBe(false);
    expect(() => assetPath(resolve("ui"), url)).toThrow();
  }
  expect(assetPath(resolve("ui"), "demesne://app/vendor/font.woff2")).toBe(resolve("ui/vendor/font.woff2"));
  for (const path of ["%2e%2e%2fsecret", "%5csecret", "file%00.js"]) expect(() => assetPath(resolve("ui"), `demesne://app/${path}`)).toThrow();
});
test("IPC rejects malformed and oversized requests", () => {
  expect(() => validateRequest("submit", { text: "hello" })).not.toThrow();
  for (const [method, args] of [["", {}], ["x".repeat(65), {}], ["submit", []], ["submit", null], ["submit", { text: "x".repeat(260000) }]]) expect(() => validateRequest(method, args)).toThrow();
});
test("external opening accepts web URLs or absolute files, never executable URL schemes", () => {
  expect(openTarget("https://example.com/a")).toBe("url");
  expect(openTarget(resolve("README.md"))).toBe("file");
  for (const target of ["javascript:alert(1)", "data:text/html,test", "file:///etc/passwd", "mailto:a@example.com", "https://user:password@example.com", "relative.txt"]) expect(() => openTarget(target)).toThrow();
});
test("zoom preserves the desktop's fixed levels", () => {
  expect(nextZoom(1, 1)).toBe(1.1);
  expect(nextZoom(1, -1)).toBe(0.9);
  expect(nextZoom(1.25, 0)).toBe(1);
  expect(nextZoom(3, 1)).toBe(3);
  expect(nextZoom(0.67, -1)).toBe(0.67);
});

test("the live preview frame loads only pages served on this machine", () => {
  for (const url of ["http://localhost:5173/", "http://127.0.0.1:8000/docs", "http://[::1]:4321/", "https://localhost:3000/"]) expect(previewURL(url)).toBe(true);
  for (const url of ["https://example.com/", "http://localhost.evil.com/", "http://user:pw@localhost:3000/", "file:///etc/passwd", "javascript:alert(1)", "demesne://app/index.html"]) expect(previewURL(url)).toBe(false);
});

test("glass everywhere, blurred where the desktop blurs behind the window", () => {
  expect(desktopBlurs("darwin", {})).toBe(true);
  expect(desktopBlurs("darwin", { DEMESNE_GLASS: "0" })).toBe(true);
  expect(desktopBlurs("linux", { HYPRLAND_INSTANCE_SIGNATURE: "abc_123" })).toBe(true);
  expect(desktopBlurs("linux", { XDG_CURRENT_DESKTOP: "Hyprland" })).toBe(true);
  expect(desktopBlurs("linux", { XDG_CURRENT_DESKTOP: "KDE" })).toBe(false);
  expect(desktopBlurs("linux", { XDG_CURRENT_DESKTOP: "ubuntu:GNOME" })).toBe(false);
  expect(desktopBlurs("linux", { XDG_CURRENT_DESKTOP: "sway", DEMESNE_GLASS: "1" })).toBe(true);
  expect(desktopBlurs("win32", {})).toBe(true);
  // Glass and its slider are on everywhere; DEMESNE_GLASS=0 turns them off
  // on Linux and Windows.
  for (const platform of ["darwin", "linux", "win32"]) expect(desktopGlass(platform, { XDG_CURRENT_DESKTOP: "ubuntu:GNOME" })).toBe(true);
  expect(desktopGlass("linux", { DEMESNE_GLASS: "0" })).toBe(false);
  expect(desktopGlass("win32", { DEMESNE_GLASS: "0" })).toBe(false);
  expect(desktopGlass("darwin", { DEMESNE_GLASS: "0" })).toBe(true);
});

test("Foundry frames accept only artifact URLs and block the network", () => {
  expect(foundryURL("foundry://artifact/2f6c1a3e-9b1d-4e0a-8c5b-1f2a3b4c5d6e?v=2")).toBe(true);
  expect(foundryURL("foundry://artifact/a/b")).toBe(false);
  expect(foundryURL("foundry://user:pw@artifact/abc")).toBe(false);
  expect(foundryURL("foundry://other/abc")).toBe(false);
  expect(foundryURL("https://artifact/abc")).toBe(false);
  expect(FOUNDRY_CSP).toContain("default-src 'none'");
  expect(FOUNDRY_CSP).not.toContain("connect-src");
  expect(FOUNDRY_CSP).toMatch(/script-src 'unsafe-inline' foundry: https:\/\/cdnjs\.cloudflare\.com https:\/\/cdn\.jsdelivr\.net https:\/\/unpkg\.com;/);
  expect(FOUNDRY_CSP).toContain("style-src 'unsafe-inline' foundry: https://fonts.googleapis.com;");
  expect(FOUNDRY_CSP).toContain("font-src data: foundry: https://fonts.gstatic.com;");
  expect(FOUNDRY_CSP).toContain("form-action 'none'");
  // SVG renders as an image, so a script inside it never runs.
  const page = foundryDocument("svg", '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', "Logo");
  expect(page).toContain("data:image/svg+xml;base64,");
  expect(page).not.toContain("<script>");
});

test("a version's first show carries the assembly: the library, the previous version and the script, and nothing can close the script early", () => {
  const source = "<!doctype html><html><body><main><h1>Garden</h1><p>Grow</p></main></body></html>";
  expect(foundryDocument("html", source, "Garden")).toBe(source);
  const page = foundryDocument("html", source, "Garden", { library: "/*anime*/", previous: '<p>old</p><script>x="</script>"</script><!-- c -->' });
  expect(page.startsWith(source)).toBe(true);
  expect(page).toContain("<script>/*anime*/</script>");
  expect(page).toContain("window.__demesnePrevious=");
  expect(page).toContain(ASSEMBLE_SCRIPT);
  // The previous version is a JSON string the page can't break out of.
  const inner = page.slice(page.indexOf("window.__demesnePrevious=") + "window.__demesnePrevious=".length);
  expect(inner.slice(0, inner.indexOf(";(function"))).not.toContain("</script>");
  expect(scriptText("</script><!--")).toBe('"<\\/script><\\!--"');
  expect(JSON.parse(scriptText("</script>").replace("<\\/", "</"))).toBe("</script>");
  expect(assembledDocument(source, "L", null)).toContain("window.__demesnePrevious=null;");
  // The script shows the page whatever happens and never animates under reduced motion.
  expect(ASSEMBLE_SCRIPT).toContain("prefers-reduced-motion: reduce");
  expect(ASSEMBLE_SCRIPT).toContain("setTimeout(show, 4000)");
  expect(ASSEMBLE_SCRIPT).toContain("var kept = list.map");
  // A graphic's first show eases in with CSS alone; a plain show doesn't.
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"></svg>';
  expect(foundryDocument("svg", svg, "Logo", { library: "L", previous: null })).toContain("@keyframes in");
  expect(foundryDocument("svg", svg, "Logo")).not.toContain("@keyframes");
});

test("the Mac's blur is hud unless DEMESNE_VIBRANCY names a real material", () => {
  expect(macVibrancy({})).toBe("hud");
  expect(macVibrancy({ DEMESNE_VIBRANCY: "fullscreen-ui" })).toBe("fullscreen-ui");
  expect(macVibrancy({ DEMESNE_VIBRANCY: "glassy" })).toBe("hud");
});

test("liquid glass from macOS 26 (Darwin 25) unless a frosted material is named", () => {
  expect(liquidGlass("darwin", "25.5.0", {})).toBe(true);
  expect(liquidGlass("darwin", "24.6.0", {})).toBe(false);
  expect(liquidGlass("darwin", "25.5.0", { DEMESNE_VIBRANCY: "hud" })).toBe(false);
  expect(liquidGlass("linux", "25.0.0", {})).toBe(false);
});

test("simple full screen starts below the camera notch, and only where there is one", () => {
  const screen = (width: number, height: number, bar: number, internal = true) => ({ bounds: { x: 0, y: 0, width, height }, workArea: { x: 0, y: bar, width, height: height - bar }, internal });
  expect(notchInset(screen(1512, 982, 38))).toBe(38);
  expect(notchInset(screen(1728, 1117, 33))).toBe(33);
  expect(notchInset(screen(1440, 900, 25))).toBe(0);
  expect(notchInset(screen(2560, 1440, 25, false))).toBe(0);
  // The menu bar hidden: a notched panel's shape still says so.
  expect(notchInset(screen(1512, 982, 0))).toBe(38);
  expect(notchInset(screen(1440, 900, 0))).toBe(0);
  expect(notchInset(screen(1512, 982, 0, false))).toBe(0);
});

test("the kit is served at foundry://kit/<file>, only the files it has, and inlined on export", () => {
  expect(foundryKitFile("foundry://kit/base.css")).toBe("base.css");
  expect(foundryKitFile("foundry://kit/anime.js")).toBe("anime.js");
  expect(foundryKitFile("foundry://kit/fonts/inter-latin-500-normal.woff2")).toBe("fonts/inter-latin-500-normal.woff2");
  expect(FOUNDRY_KIT["anime.js"]).toEqual({ path: "vendor/anime.umd.min.js", type: "application/javascript; charset=utf-8", then: "kit/motion.js" });
  expect(FOUNDRY_KIT["base.css"]!.then).toBeUndefined();
  expect(foundryKitFile("foundry://kit/../index.html")).toBeNull();
  expect(foundryKitFile("foundry://kit/other.css")).toBeNull();
  expect(foundryKitFile("foundry://artifact/base.css")).toBeNull();
  expect(foundryKitFile("foundry://user:pw@kit/base.css")).toBeNull();
  expect(foundryURL("foundry://kit/base.css")).toBe(false);
  const kit = { style: '@font-face{font-family:Inter;src:url(foundry://kit/fonts/inter-latin-400-normal.woff2) format("woff2")}\n:root{--ink:#111}\nbody{color:var(--ink)}\n', script: 'window.anime={};if(1<2){}//</script>' };
  const source = '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="foundry://kit/base.css">\n<script src="foundry://kit/anime.js"></script><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces"></head><body><h1>Garden</h1></body></html>';
  const out = exportedSource(source, kit);
  expect(out).not.toContain("foundry://");
  expect(out).toContain("<style>\n:root{--ink:#111}\nbody{color:var(--ink)}\n</style>");
  expect(out).toContain("<script>window.anime={};if(1<2){}//<\\/script></script>");
  expect(out).toContain("fonts.googleapis.com/css2?family=Fraunces");
  expect(out).toContain("<h1>Garden</h1>");
  // A page without the kit is exported as it is.
  expect(exportedSource("<p>plain</p>", kit)).toBe("<p>plain</p>");
});
