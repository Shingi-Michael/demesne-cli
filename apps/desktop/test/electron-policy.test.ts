import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { APP_URL, allowAppReload, desktopBlurs, desktopGlass, foundryPageCall, foundryShotURL, usesRemember, withRemember, withShots, liquidGlass, macVibrancy, FOUNDRY_CSP, FOUNDRY_KIT, foundryDocument, foundryKitFile, foundryURL, previewURL, assetPath, localAppURL, nextZoom, browserKey, outsideSignin, openTarget, placeRect, validateRequest, windowPlace } from "../electron/policy.ts";

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
  // A picture (a 5 MB screenshot as base64) fits; the same size elsewhere doesn't.
  expect(() => validateRequest("attach", { data: "x".repeat(7_000_000) })).not.toThrow();
  expect(() => validateRequest("socials-share", { image: "x".repeat(7_000_000) })).not.toThrow();
  expect(() => validateRequest("attach", { data: "x".repeat(34_000_000) })).toThrow();
});
test("external opening accepts web URLs or absolute files, never executable URL schemes", () => {
  expect(openTarget("https://example.com/a")).toBe("url");
  expect(openTarget(resolve("README.md"))).toBe("file");
  for (const target of ["javascript:alert(1)", "data:text/html,test", "file:///etc/passwd", "mailto:a@example.com", "https://user:password@example.com", "relative.txt"]) expect(() => openTarget(target)).toThrow();
});
test("find and zoom keys pressed on the chat's page go to its bar", () => {
  const key = (k: string, more: Partial<{ meta: boolean; control: boolean; alt: boolean; shift: boolean; type: string }> = {}) => ({ type: "keyDown", key: k, meta: true, control: false, alt: false, shift: false, ...more });
  expect(browserKey(key("f"), true)).toBe("find");
  expect(browserKey(key("g"), true)).toBe("find-next");
  expect(browserKey(key("G", { shift: true }), true)).toBe("find-back");
  expect(browserKey(key("="), true)).toBe("zoom-in");
  expect(browserKey(key("+", { shift: true }), true)).toBe("zoom-in");
  expect(browserKey(key("-"), true)).toBe("zoom-out");
  expect(browserKey(key("0"), true)).toBe("zoom-reset");
  // Ctrl is the key off a Mac; ⌘ is on one. Typing and other shortcuts stay the page's.
  expect(browserKey(key("f", { meta: false, control: true }), false)).toBe("find");
  expect(browserKey(key("f", { meta: false, control: true }), true)).toBe("");
  expect(browserKey(key("f", { meta: false }), true)).toBe("");
  expect(browserKey(key("c"), true)).toBe("");
  expect(browserKey(key("f", { alt: true }), true)).toBe("");
  expect(browserKey(key("f", { type: "keyUp" }), true)).toBe("");
});
test("Google's sign-in pages go to your own browser; its sign-out does not", () => {
  for (const url of ["https://accounts.google.com/v3/signin/identifier?continue=x", "https://accounts.google.com/o/oauth2/v2/auth?client_id=1", "https://accounts.google.com/ServiceLogin"]) expect(outsideSignin(url)).toBe(true);
  for (const url of ["https://accounts.google.com/Logout", "https://google.com/", "http://accounts.google.com/x", "https://accounts.google.com.evil.test/", "nonsense"]) expect(outsideSignin(url)).toBe(false);
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
  // Its only fetch: a page's own saves and asks, to foundry:.
  expect(FOUNDRY_CSP).toContain("connect-src foundry:;");
  // Pass 240 A: a review's real picture comes from inside the app, and no picture from the web.
  expect(FOUNDRY_CSP).toContain("img-src data: blob: foundry:;");
  expect(FOUNDRY_CSP).toMatch(/script-src 'unsafe-inline' foundry: https:\/\/cdnjs\.cloudflare\.com https:\/\/cdn\.jsdelivr\.net https:\/\/unpkg\.com;/);
  expect(FOUNDRY_CSP).toContain("style-src 'unsafe-inline' foundry: https://fonts.googleapis.com;");
  expect(FOUNDRY_CSP).toContain("font-src data: foundry: https://fonts.gstatic.com;");
  expect(FOUNDRY_CSP).toContain("form-action 'none'");
  // SVG renders as an image, so a script inside it never runs.
  const page = foundryDocument("svg", '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', "Logo");
  expect(page).toContain("data:image/svg+xml;base64,");
  expect(page).not.toContain("<script>");
});

test("a page is served as written, with no assembly", () => {
  const source = "<!doctype html><html><body><main><h1>Garden</h1><p>Grow</p></main></body></html>";
  expect(foundryDocument("html", source, "Garden")).toBe(source);
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"></svg>';
  expect(foundryDocument("svg", svg, "Logo")).not.toContain("@keyframes");
});

test("a page with options gets no Pick button: you choose in the chat", () => {
  const options = '<div data-option="A · Pills">A</div><div data-option="B · Joined">B</div>';
  expect(foundryDocument("html", options, "Tabs")).toBe(options);
  expect(FOUNDRY_KIT["pick.js"]).toBeUndefined();
  expect(foundryKitFile("foundry://kit/pick.js")).toBeNull();
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

test("the kit is served at foundry://kit/<file>, only the files it has", () => {
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
  expect(foundryKitFile("foundry://kit/parts.js")).toBe("parts.js");
});

test("a review's real picture: only foundry://shot/<mockup>/<picture>, told to the kit before the page runs (pass 240 A)", () => {
  expect(foundryShotURL("foundry://shot/abc-1/9f2c-77")).toEqual({ id: "abc-1", shot: "9f2c-77" });
  for (const bad of ["foundry://shot/abc-1", "foundry://shot/a/b/c", "foundry://shot/a/b?x=1", "foundry://shot/a%2F../b", "foundry://kit/a/b", "foundry://artifact/a/b", "https://shot/a/b", "foundry://u:p@shot/a/b"]) expect(foundryShotURL(bad)).toBeNull();
  expect(withShots("<!doctype html><p>x", {})).toBe("<!doctype html><p>x");
  expect(withShots("<!doctype html><p>x", { s: { url: "foundry://shot/a/s", width: 2880, height: 1800, scale: 2 } }))
    .toBe('<!doctype html><script>window.__demesneShots={"s":{"url":"foundry://shot/a/s","width":2880,"height":1800,"scale":2}};</script><p>x');
  // A picture's address can never end the script early.
  const odd = withShots("<p>x", { s: { url: "</script><b>", width: 1, height: 1, scale: 1 } });
  expect(odd).toContain("\\u003c/script>\\u003cb>");
  expect(odd.split("</script>").length).toBe(2);
});

test("pages that remember: only a page's own data and ask addresses, and the runtime goes in first", () => {
  expect(foundryPageCall("foundry://data/abc-1")).toEqual({ what: "data", id: "abc-1" });
  expect(foundryPageCall("foundry://ask/abc-1")).toEqual({ what: "ask", id: "abc-1" });
  for (const bad of ["foundry://data/", "foundry://data/a/b", "foundry://data/a?x=1", "foundry://kit/remember.js", "foundry://artifact/a", "https://data/a", "foundry://data/a%2F..%2Fb"]) expect(foundryPageCall(bad)).toBeNull();
  expect(usesRemember("<script>demesne.save('a', 1)</script>")).toBe(true);
  expect(usesRemember("<script>await demesne . load(\"a\")</script>")).toBe(true);
  expect(usesRemember("<script>demesne.motion('Arrive', tl)</script>")).toBe(false);
  const page = withRemember("<!DOCTYPE html><html><body><script>demesne.load('x')</script>", "window.demesne={}</script>", { id: "a1", key: "k<" });
  // Straight after the doctype, so the page stays in standards mode and the runtime runs before the page's own script.
  expect(page.startsWith("<!DOCTYPE html><script>window.__demesnePage={\"id\":\"a1\",\"key\":\"k\\u003c\"};</script><script>window.demesne={}<\\/script></script><html>")).toBe(true);
  expect(withRemember("<p>x</p>", "R")).toBe("<script>R</script><p>x</p>");
  expect(FOUNDRY_KIT["remember.js"]?.path).toBe("kit/remember.js");
});

test("the browser split's page area becomes a place in the window for the real page", () => {
  const window = { width: 1440, height: 900 };
  expect(placeRect({ x: 880.4, y: 86, width: 550, height: 752 }, 1, window)).toEqual({ x: 880, y: 86, width: 550, height: 752 });
  // The page's own pixels times the app's zoom are the window's points.
  expect(placeRect({ x: 400, y: 40, width: 300, height: 300 }, 1.5, window)).toEqual({ x: 600, y: 60, width: 450, height: 450 });
  // Kept inside the window; too small to show, or not a place at all, is nothing.
  expect(placeRect({ x: 1200, y: 700, width: 600, height: 600 }, 1, window)).toEqual({ x: 1200, y: 700, width: 240, height: 200 });
  expect(placeRect({ x: 1400, y: 86, width: 500, height: 700 }, 1, window)).toBeNull();
  expect(placeRect({ x: 0, y: 0, width: Number.NaN, height: 300 }, 1, window)).toBeNull();
  expect(placeRect(null, 1, window)).toBeNull();
});

test("pass 262 C: a saved copy stands on its own and gets a free name in Downloads", async () => {
  const { exportedSource, copyName } = await import("../electron/policy.ts");
  const kit = { style: "@font-face{src:url(foundry://kit/fonts/inter.woff2)}\nbody{margin:0}", script: "anime()", parts: "parts()</script>", kinds: { style: ".deck{}", script: "kinds()" }, remember: "remember()" };
  const page = `<!doctype html><link rel="stylesheet" href="foundry://kit/base.css"><script src="foundry://kit/parts.js"></script><script>demesne.save("a", 1)</script>`;
  const out = exportedSource(page, kit);
  expect(out).not.toContain("foundry://kit/base.css");
  expect(out).not.toContain("foundry://kit/parts.js");
  expect(out).toContain("<style>\nbody{margin:0}</style>");
  expect(out).toContain("<script>parts()<\\/script></script>");
  expect(out.startsWith("<!doctype html><script>remember()</script>")).toBe(true);
  const taken = new Set(["Orders board v2.html"]);
  expect(copyName("Orders/board", 2, "html", () => false)).toBe("Ordersboard v2.html");
  expect(copyName("Orders board", 2, "html", (name) => taken.has(name))).toBe("Orders board v2 (2).html");
  expect(copyName("  ", 1, "svg", () => false)).toBe("Mockup v1.svg");
});

test("the window opens where you left it, when that still fits a display", () => {
  const laptop = { workArea: { x: 0, y: 25, width: 1512, height: 957 } }, monitor = { workArea: { x: 1512, y: 0, width: 2560, height: 1415 } };
  expect(windowPlace(null, [laptop])).toEqual({ width: 1180, height: 820 });
  expect(windowPlace("not json", [laptop])).toEqual({ width: 1180, height: 820 });
  expect(windowPlace('{"x":1}', [laptop])).toEqual({ width: 1180, height: 820 });
  expect(windowPlace('{"x":100,"y":80,"width":1000,"height":700}', [laptop])).toEqual({ x: 100, y: 80, width: 1000, height: 700 });
  // Bigger than the display: shrinks to its work area.
  expect(windowPlace('{"x":0,"y":0,"width":3000,"height":2000}', [laptop])).toEqual({ x: 0, y: 25, width: 1512, height: 957 });
  // Below the least size: grows to it.
  expect(windowPlace('{"x":100,"y":80,"width":400,"height":300}', [laptop])).toEqual({ x: 100, y: 80, width: 900, height: 620 });
  // Left on a monitor that is gone: starts over; still plugged in: stays there.
  const onMonitor = '{"x":2000,"y":100,"width":1400,"height":900}';
  expect(windowPlace(onMonitor, [laptop])).toEqual({ width: 1180, height: 820 });
  expect(windowPlace(onMonitor, [laptop, monitor])).toEqual({ x: 2000, y: 100, width: 1400, height: 900 });
  // Hanging off an edge: pulled back on.
  expect(windowPlace('{"x":1200,"y":500,"width":1000,"height":700}', [laptop])).toEqual({ x: 512, y: 282, width: 1000, height: 700 });
});
