import { describe, expect, test } from "bun:test";
import { findSource, pointLabel, pointMessage, type PointPick } from "../point.ts";

const pick = (over: Partial<PointPick> = {}): PointPick => ({ tag: "button", text: "Save", label: "Save", selector: "div.btns > button.save", html: '<button class="save">Save</button>', page: "/settings", ...over });

describe("point at it", () => {
  test("names an element by its words and its kind", () => {
    expect(pointLabel(pick())).toBe("Save button");
    expect(pointLabel(pick({ tag: "input", label: "Display name" }))).toBe("Display name field");
    expect(pointLabel(pick({ tag: "img", label: "" }))).toBe("image");
    expect(pointLabel(pick({ tag: "p", label: "Weekly digest goes out on Mondays at nine" }))).toBe("“Weekly digest goes out…”");
    expect(pointLabel(pick({ tag: "section", label: "" }))).toBe("section");
  });

  test("the message carries the page, the file and the markup", () => {
    const message = pointMessage([{ ...pick(), id: "1", source: { path: "src/Settings.tsx", line: 42 }, component: "Settings" }]);
    expect(message).toStartWith("The element I pointed at in the live preview:");
    expect(message).toContain("Save button on /settings · `src/Settings.tsx:42` · component Settings");
    expect(message).toContain("selector `div.btns > button.save`");
    expect(message).toContain('<button class="save">Save</button>');
    expect(pointMessage([])).toBe("");
    expect(pointMessage([{ ...pick(), id: "1", source: null }, { ...pick({ tag: "a", label: "Home" }), id: "2", source: null }])).toContain("The elements I pointed at");
  });

  test("a file the page names wins, relative to the project", () => {
    const files = [{ path: "src/Settings.tsx", text: "x" }, { path: "src/other.tsx", text: "<button>Save</button>" }];
    expect(findSource(files, pick({ hint: { file: "/home/me/app/src/Settings.tsx", line: 42 } }), "/home/me/app")).toEqual({ path: "src/Settings.tsx", line: 42 });
    expect(findSource(files, pick({ hint: { file: "/elsewhere/src/Settings.tsx" } }), "/home/me/app")).toEqual({ path: "src/Settings.tsx", line: 1 });
  });

  test("otherwise the source is searched: id, then text as markup, then the label", () => {
    const files = [
      { path: "src/Header.test.tsx", text: "<button>Save</button>" },
      { path: "src/lib/strings.ts", text: "export const save = 'Save';" },
      { path: "src/Settings.tsx", text: "export function Settings() {\n  return <div>\n    <button className=\"save\">\n      Save\n    </button>\n  </div>;\n}" },
      { path: "src/Form.tsx", text: "line\n<input id=\"email\" />" },
    ];
    expect(findSource(files, pick())).toEqual({ path: "src/Settings.tsx", line: 3 });
    expect(findSource(files, pick({ tag: "input", text: "", label: "", html: '<input id="email" type="email">' }))).toEqual({ path: "src/Form.tsx", line: 2 });
    expect(findSource(files, pick({ tag: "a", text: "Nowhere", label: "Nowhere", html: "<a>Nowhere</a>" }))).toBeNull();
    expect(findSource(files, pick({ text: "", label: "", html: "<div></div>", component: "Settings" }))).toEqual({ path: "src/Settings.tsx", line: 1 });
  });
});
