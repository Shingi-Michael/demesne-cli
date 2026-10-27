import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { APP_URL, allowAppReload, desktopBlurs, FOUNDRY_CSP, foundryDocument, foundryURL, previewURL, assetPath, localAppURL, nextZoom, openTarget, validateRequest } from "../electron/policy.ts";

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

test("glass where the desktop blurs behind the window: the Mac and Hyprland", () => {
  expect(desktopBlurs("darwin", {})).toBe(true);
  expect(desktopBlurs("darwin", { DEMESNE_GLASS: "0" })).toBe(true);
  expect(desktopBlurs("linux", { HYPRLAND_INSTANCE_SIGNATURE: "abc_123" })).toBe(true);
  expect(desktopBlurs("linux", { XDG_CURRENT_DESKTOP: "Hyprland" })).toBe(true);
  expect(desktopBlurs("linux", { XDG_CURRENT_DESKTOP: "KDE" })).toBe(false);
  expect(desktopBlurs("linux", { XDG_CURRENT_DESKTOP: "ubuntu:GNOME" })).toBe(false);
  expect(desktopBlurs("linux", { XDG_CURRENT_DESKTOP: "sway", DEMESNE_GLASS: "1" })).toBe(true);
  expect(desktopBlurs("linux", { HYPRLAND_INSTANCE_SIGNATURE: "abc_123", DEMESNE_GLASS: "0" })).toBe(false);
  expect(desktopBlurs("win32", { DEMESNE_GLASS: "1" })).toBe(false);
});

test("Foundry frames accept only artifact URLs and block the network", () => {
  expect(foundryURL("foundry://artifact/2f6c1a3e-9b1d-4e0a-8c5b-1f2a3b4c5d6e?v=2")).toBe(true);
  expect(foundryURL("foundry://artifact/a/b")).toBe(false);
  expect(foundryURL("foundry://user:pw@artifact/abc")).toBe(false);
  expect(foundryURL("foundry://other/abc")).toBe(false);
  expect(foundryURL("https://artifact/abc")).toBe(false);
  expect(FOUNDRY_CSP).toContain("default-src 'none'");
  expect(FOUNDRY_CSP).not.toContain("connect-src");
  // SVG renders as an image, so a script inside it never runs.
  const page = foundryDocument("svg", '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', "Logo");
  expect(page).toContain("data:image/svg+xml;base64,");
  expect(page).not.toContain("<script>");
});
