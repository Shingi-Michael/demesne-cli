import { describe, expect, test } from "bun:test";
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

describe("pinned tabs", () => {
  const store2 = () => { const data = new Map<string, string>(); return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) }; };
  test("a pinned tab moves first, stays put on close, and is saved", () => {
    const store = store2(), tabs = new OpenTabs(store);
    tabs.open("a"); tabs.open("b"); tabs.open("c");
    expect(tabs.pin("c", true)).toBe(true);
    expect(tabs.ids).toEqual(["c", "a", "b"]);
    expect(tabs.close("c")).toBeUndefined();
    expect(tabs.ids).toEqual(["c", "a", "b"]);
    tabs.open("d", "c");
    expect(tabs.ids).toEqual(["c", "d", "a", "b"]);
    const again = new OpenTabs(store);
    expect(again.pinned).toEqual(["c"]);
    expect(again.ids).toEqual(["c", "d", "a", "b"]);
  });
  test("tabs keep to their side of the pins when dragged, and unpinning lets a tab close", () => {
    const tabs = new OpenTabs(store2());
    for (const id of ["a", "b", "c"]) tabs.open(id);
    tabs.pin("b", true);
    tabs.move("c", 0);
    expect(tabs.ids).toEqual(["b", "c", "a"]);
    tabs.move("b", 2);
    expect(tabs.ids).toEqual(["b", "c", "a"]);
    tabs.pin("b", false);
    expect(tabs.ids).toEqual(["b", "c", "a"]);
    expect(tabs.close("b")).toBe("c");
  });
});
