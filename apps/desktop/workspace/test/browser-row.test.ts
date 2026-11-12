import { expect, test } from "bun:test";
import { browserTarget } from "../browser-row.ts";

test("a browser step names the control the model used by number", () => {
  expect(browserTarget({ input: { action: "open", url: "http://localhost:5173/login" }, detail: "localhost:5173/login" })).toBe("localhost:5173/login");
  expect(browserTarget({ input: { action: "click", ref: 12 }, message: JSON.stringify({ did: 'button "Save"', changed: "new text" }) })).toBe("button “Save”");
  expect(browserTarget({ input: { action: "click", ref: 12 } })).toBe("");
  expect(browserTarget({ input: { action: "click", ref: "Save" }, detail: "“Save”", message: "not json" })).toBe("“Save”");
  expect(browserTarget({ input: { action: "type", ref: 3, text: "Ada" }, message: JSON.stringify({ did: 'textbox "Name"' }) })).toBe("“Ada” into textbox “Name”");
  expect(browserTarget({ input: { action: "type", text: "Ada" }, detail: "“Ada”" })).toBe("“Ada”");
  expect(browserTarget({ input: { action: "back" }, message: JSON.stringify({ title: "Sign in", changed: "went to /" }) })).toBe("Sign in");
  expect(browserTarget({ input: { action: "wait", for: "Saved" }, detail: "for “Saved”", message: JSON.stringify({ did: "“Saved” is on the page" }) })).toBe("for “Saved”");
});
