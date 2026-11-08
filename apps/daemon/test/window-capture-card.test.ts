import { expect, test } from "bun:test";
import { windowCaptureMetadata } from "@demesne/storage";

test("a window the model captured names its app, title and picture for the chat's card", () => {
  const message = windowCaptureMetadata("Captured window 42: Demesne — Foundry · Idea garden\n(no text)\nImage artifact 0b7f2c1e-1111-4222-8333-444455556666: window-screenshot.png (1280×800)").message;
  expect(JSON.parse(String(message))).toEqual({ app: "Demesne", title: "Foundry · Idea garden", picture: { id: "0b7f2c1e-1111-4222-8333-444455556666", width: 1280, height: 800 } });
  expect(windowCaptureMetadata("No unique matching window was captured.")).toEqual({});
});
