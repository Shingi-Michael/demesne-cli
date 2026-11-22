import { expect, test } from "bun:test";
import { readSiteAsk, siteLine } from "../foundry-sites.ts";

test("a frame's ask about a site is read safely", () => {
  expect(readSiteAsk({ demesne: "site", action: "ask", host: "API.Example.com" })).toBe("api.example.com");
  expect(readSiteAsk({ demesne: "site", action: "ask", host: "<b>x</b>" })).toBe(null);
  expect(readSiteAsk({ demesne: "site", action: "ask", host: "localhost" })).toBe(null);
  expect(readSiteAsk({ demesne: "error", action: "ask", host: "a.com" })).toBe(null);
});

test("the line under the mockup names the site and asks", () => {
  const line = siteLine("api.example.com");
  expect(line).toContain("This page wants live data from <b>api.example.com</b>.");
  expect(line).toContain('data-site="allow">Allow</button>');
  expect(line).toContain('data-site="no">Not now</button>');
  expect(siteLine("a.com", "Couldn't allow it: x")).toContain("Couldn&#39;t allow it: x");
});
