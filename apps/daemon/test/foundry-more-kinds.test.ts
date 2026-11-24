import { expect, test } from "bun:test";
import { checkKindSource, MORE_KINDS_RULES } from "../src/foundry.ts";

test("a react artifact that won't run is refused at save, with why", () => {
  expect(() => checkKindSource("react", `import { useState } from "react";\nimport { Coffee } from "lucide-react";\nexport default function App() { const [n] = useState(1); return <p><Coffee />{n}</p>; }`)).not.toThrow();
  expect(() => checkKindSource("react", "export default () => <div>")).toThrow("doesn't compile");
  expect(() => checkKindSource("react", `import axios from "axios";\nexport default () => null;`)).toThrow('"axios" can\'t be imported');
  expect(() => checkKindSource("react", "export const App = () => null;")).toThrow("export default");
});

test("a mermaid artifact starts with its diagram type", () => {
  expect(() => checkKindSource("mermaid", "%% orders\nflowchart LR\n A --> B")).not.toThrow();
  expect(() => checkKindSource("mermaid", "```mermaid\nflowchart LR\n```")).toThrow("starts with its diagram type");
  expect(() => checkKindSource("mermaid", "A --> B")).toThrow('not "A"');
  expect(() => checkKindSource("html", "<p>anything</p>")).not.toThrow();
});

test("the model is told the more kinds and what react may import", () => {
  expect(MORE_KINDS_RULES).toContain("kind react");
  expect(MORE_KINDS_RULES).toContain("lucide-react, recharts");
  expect(MORE_KINDS_RULES).not.toContain("react-dom/client");
  expect(MORE_KINDS_RULES).toContain("kind mermaid");
  expect(MORE_KINDS_RULES).toContain("kind code");
});

test("step 3 of pass 273 A: a sheet is CSV with named columns, and one that won't draw says why", () => {
  expect(() => checkKindSource("sheet", "Plot,pH,Nitrogen\nA1,6.4,22\nB2,7.1,18")).not.toThrow();
  expect(() => checkKindSource("sheet", "Name,Age\nSmith, Ann,40")).toThrow("Row 1 has 3 cells");
  expect(() => checkKindSource("sheet", "")).toThrow("[invalid_input]");
  expect(MORE_KINDS_RULES).toContain("kind sheet: CSV, first row the column names");
});

test("step 4 of pass 273 A: a whiteboard is JSON notes, arrows and groups, and one that won't draw says why", () => {
  expect(() => checkKindSource("board", '{"notes":[{"id":"a","text":"Ask"},{"id":"b","text":"Book"}],"arrows":[{"from":"a","to":"b"}]}')).not.toThrow();
  expect(() => checkKindSource("board", '{"notes":[{"id":"a","text":"Ask"}],"arrows":[{"from":"a","to":"b"}]}')).toThrow("isn't a note's id");
  expect(() => checkKindSource("board", "")).toThrow("[invalid_input]");
  expect(MORE_KINDS_RULES).toContain("kind board: JSON notes, arrows, groups");
});
