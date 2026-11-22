import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allowSite, limitedText, projectPath, publicAddress, readSites, secretPath, siteAllowed } from "../electron/foundry-data.ts";
import { foundryPageCall, usesRemember } from "../electron/policy.ts";

test("a page reads files inside its project only, never its secrets", () => {
  const root = mkdtempSync(join(tmpdir(), "foundry-data-")), outside = mkdtempSync(join(tmpdir(), "foundry-out-"));
  mkdirSync(join(root, "data")); writeFileSync(join(root, "data/sales.csv"), "day,n\nMon,3\n"); writeFileSync(join(root, ".env"), "KEY=1"); writeFileSync(join(outside, "x.txt"), "no");
  symlinkSync(join(outside, "x.txt"), join(root, "data/link.txt"));
  expect(projectPath(root, "data/sales.csv")).toEqual({ path: expect.stringMatching(/data\/sales\.csv$/) });
  expect(projectPath(root, "./data/sales.csv")).toEqual({ path: expect.stringMatching(/data\/sales\.csv$/) });
  expect(projectPath(root, "../x.txt")).toEqual({ error: expect.stringMatching(/no \.\.\/x\.txt|inside the project/) });
  expect(projectPath(root, "data/link.txt")).toEqual({ error: "demesne.read reads files inside the project only" });
  expect(projectPath(root, "/etc/passwd")).toEqual({ error: expect.stringContaining("inside the project") });
  expect(projectPath(root, ".env")).toEqual({ error: expect.stringContaining("kept from pages") });
  expect(projectPath(root, "data/missing.csv")).toEqual({ error: "There's no data/missing.csv in the project" });
  expect(projectPath(null, "data/sales.csv")).toEqual({ error: expect.stringContaining("isn't in a project") });
  for (const path of [".env.local", "config/.env", ".git/config", "deploy/key.pem", "home/.ssh/id_rsa", ".npmrc", "secrets.json", ".demesne/state.json"]) expect(secretPath(path)).toBe(true);
  for (const path of ["data/env.csv", "src/keyboard.ts", ".demesne/design.md", "docs/secret-sauce.md"]) expect(secretPath(path)).toBe(false);
});

test("a page fetches public https addresses only", () => {
  expect(publicAddress("https://api.example.com/v1/prices?x=1")?.hostname).toBe("api.example.com");
  for (const bad of ["http://api.example.com/", "https://user:pw@api.example.com/", "https://localhost/", "https://printer.local/", "https://10.0.0.4/", "https://192.168.1.1/", "https://172.20.0.1/", "https://127.0.0.1/", "https://169.254.169.254/latest", "https://[::1]/", "https://intranet/", "not a url"]) expect(publicAddress(bad)).toBe(null);
  expect(publicAddress("https://8.8.8.8/")?.hostname).toBe("8.8.8.8");
});

test("the sites each mockup may read are kept per mockup", () => {
  let sites = readSites('{"a1":["api.example.com"],"bad id!":["x.com"],"b2":"nope"}');
  expect(sites).toEqual({ a1: ["api.example.com"] });
  expect(siteAllowed(sites, "a1", "API.example.com")).toBe(true);
  expect(siteAllowed(sites, "b2", "api.example.com")).toBe(false);
  sites = allowSite(sites, "b2", "Data.Example.org");
  expect(sites.b2).toEqual(["data.example.org"]);
  expect(allowSite(sites, "b2", "data.example.org")).toBe(sites);
  expect(readSites("not json")).toEqual({});
});

test("an answer is read up to its limit", async () => {
  expect(await limitedText(new Response("hello"))).toBe("hello");
  await expect(limitedText(new Response("x".repeat(20)), 10)).rejects.toThrow("bigger than");
});

test("pages reach read, list and fetch, and get the runtime when they use them", () => {
  expect(foundryPageCall("foundry://read/a1")).toEqual({ what: "read", id: "a1" });
  expect(foundryPageCall("foundry://fetch/a1")).toEqual({ what: "fetch", id: "a1" });
  expect(foundryPageCall("foundry://delete/a1")).toBe(null);
  expect(usesRemember('const rows = await demesne.read("data/sales.csv")')).toBe(true);
  expect(usesRemember("demesne.fetch(url)")).toBe(true);
});
