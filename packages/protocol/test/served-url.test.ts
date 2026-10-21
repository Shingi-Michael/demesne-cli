import { expect, test } from "bun:test";
import { servedURL } from "../src/panels.ts";

test("a dev server's local address is read from its output", () => {
  expect(servedURL("\u001b[32m  ➜  Local:\u001b[39m   \u001b[36mhttp://localhost:\u001b[1m5173\u001b[22m/\u001b[39m\n")).toBe("http://localhost:5173/");
  expect(servedURL("ready - started server on 0.0.0.0:3000, url: http://0.0.0.0:3000")).toBe("http://localhost:3000/");
  expect(servedURL("Serving at http://127.0.0.1:8000/docs (Press CTRL+C to quit)")).toBe("http://127.0.0.1:8000/docs");
  expect(servedURL("listening on http://[::1]:4321")).toBe("http://[::1]:4321/");
});

test("other addresses and plain text are not previews", () => {
  expect(servedURL("see https://example.com:8080/ for docs")).toBeNull();
  expect(servedURL("compiled 12 modules")).toBeNull();
  expect(servedURL("http://localhost.evil.com:80/")).toBeNull();
});
