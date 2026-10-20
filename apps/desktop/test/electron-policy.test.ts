import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { APP_URL, allowAppReload, assetPath, localAppURL, nextZoom, openTarget, validateRequest } from "../electron/policy.ts";

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
