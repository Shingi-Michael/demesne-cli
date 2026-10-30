import { expect, test } from "bun:test";
import { OpenTabs } from "../tabs.ts";

const memory = () => {
  const items = new Map<string, string>();
  return { getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => void items.set(key, value) };
};

test("a chat opens next to the tab you were on, once", () => {
  const tabs = new OpenTabs();
  tabs.open("a"); tabs.open("b"); tabs.open("c", "a");
  expect(tabs.ids).toEqual(["a", "c", "b"]);
  expect(tabs.open("b")).toBe(false);
  expect(tabs.ids).toEqual(["a", "c", "b"]);
});

test("closing shows the tab on the right, else the left, and reopening puts it back", () => {
  const tabs = new OpenTabs();
  for (const id of ["a", "b", "c"]) tabs.open(id);
  expect(tabs.close("b")).toBe("c");
  expect(tabs.close("c")).toBe("a");
  expect(tabs.close("a")).toBeUndefined();
  expect(tabs.reopen()).toBe("a");
  expect(tabs.reopen((id) => id !== "c")).toBe("b");
  expect(tabs.ids).toEqual(["a", "b"]);
  expect(tabs.reopen()).toBeUndefined();
});

test("tabs move, step around, drop chats that are gone, and survive a restart", () => {
  const store = memory();
  const tabs = new OpenTabs(store);
  for (const id of ["a", "b", "c"]) tabs.open(id);
  tabs.move("c", 0);
  expect(tabs.ids).toEqual(["c", "a", "b"]);
  expect(tabs.step("b", 1)).toBe("c");
  expect(tabs.step("c", -1)).toBe("b");
  expect(tabs.step("x", -1)).toBe("b");
  tabs.keep((id) => id !== "a");
  expect(new OpenTabs(store).ids).toEqual(["c", "b"]);
  store.setItem("demesne.tabs", "not json");
  expect(new OpenTabs(store).ids).toEqual([]);
});
