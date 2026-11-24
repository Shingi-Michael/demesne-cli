import { expect, test } from "bun:test";
import { mermaidType } from "@demesne/protocol";
import { buildReact, codeExtension, codeLanguage, codePage, mermaidPage, reactPage } from "../electron/foundry-more-kinds.ts";
import { exportedSource, foundryDocument } from "../electron/policy.ts";

const APP = `import { useState } from "react";
import { Coffee } from "lucide-react";
type Props = { start?: number };
export default function Orders({ start = 2 }: Props) {
  const [count, setCount] = useState<number>(start);
  return <button className="rounded-lg px-4 py-2" onClick={() => setCount(count + 1)}><Coffee size={16} /> {count} orders</button>;
}`;

test("a React component compiles, and asks the kit for what it imports", () => {
  const built = buildReact(APP);
  if ("error" in built) throw new Error(built.error);
  expect(built.kits).toEqual(["react.js", "react-dom.js", "lucide.js"]);
  expect(built.code).toMatch(/exports\.\s*default = Orders/);
  expect(built.code).not.toContain("<button");
  const charts = buildReact(`import { BarChart, Bar } from "recharts";\nexport default () => <BarChart data={[]}><Bar dataKey="n" /></BarChart>;`);
  expect("kits" in charts && charts.kits).toEqual(["react.js", "react-dom.js", "prop-types.js", "recharts.js"]);
});

test("a component that won't run says why", () => {
  expect(buildReact("export default () => <div>")).toEqual({ error: expect.stringContaining("doesn't compile") });
  expect(buildReact(`import _ from "lodash";\nexport default () => <p>{_.x}</p>;`)).toEqual({ error: expect.stringContaining('"lodash" can\'t be imported') });
  expect(buildReact("export function App() { return null }")).toEqual({ error: expect.stringContaining("export default") });
});

test("a React page loads Tailwind and its libraries from the kit, then mounts the component", () => {
  const page = reactPage(APP, "Orders <board>");
  expect(page).toStartWith("<!doctype html>");
  expect(page).toContain("<title>Orders &lt;board&gt;</title>");
  expect(page.indexOf("foundry://kit/tailwind.js")).toBeLessThan(page.indexOf("foundry://kit/react.js"));
  expect(page).toContain('<script src="foundry://kit/lucide.js" crossorigin="anonymous"></script>');
  expect(page).not.toContain("recharts.js");
  expect(page).toContain("<script>window.react = React;</script>");
  expect(page).toContain("ReactDOM.createRoot(document.getElementById(\"root\"))");
  expect(page).toContain('"lucide-react":"LucideReact"');
  // A broken one throws, so the line under it offers to send the error.
  const broken = reactPage("export default () => <div>", "Broken");
  expect(broken).toContain("throw new SyntaxError(");
  expect(broken).not.toContain("foundry://kit/react.js");
  expect(foundryDocument("react", APP, "Orders")).toBe(reactPage(APP, "Orders"));
});

test("a Mermaid diagram is drawn in the page, its source kept safe", () => {
  const page = mermaidPage("flowchart LR\n  A[Order] --> B{Paid?} -->|yes| C<b>", "Order flow");
  expect(page).toContain('<script src="foundry://kit/mermaid.js" crossorigin="anonymous"></script>');
  expect(page).toContain("A[Order] --&gt; B{Paid?} --&gt;|yes| C&lt;b&gt;");
  expect(page).toContain('securityLevel: "strict"');
  expect(foundryDocument("mermaid", "pie\n  \"a\": 1", "P")).toContain('<pre class="mermaid">pie');
});

test("a diagram's type is its first word after front matter and comments", () => {
  expect(mermaidType("---\ntitle: Orders\n---\n%% the flow\n\nflowchart TD\n A-->B")).toBe("flowchart");
  expect(mermaidType("%%{init: {'theme':'base'}}%%\nsequenceDiagram\n A->>B: hi")).toBe("sequenceDiagram");
  expect(mermaidType("```mermaid\ngraph TD")).toBe(null);
  expect(mermaidType("")).toBe(null);
});

test("code is highlighted by its title's language, a line a row", () => {
  expect(codeLanguage("orders.ts")).toBe("ts");
  expect(codeLanguage("Orders board")).toBe(null);
  expect(codeExtension("orders.py")).toBe("py");
  expect(codeExtension("Orders board")).toBe("txt");
  const page = codePage("const a = `one\ntwo`;\nlet b = 2;\n", "orders.ts");
  const rows = [...page.matchAll(/<span class="ln">/g)];
  expect(rows).toHaveLength(3);
  // A string across lines is closed at the end of its first line and reopened on the next.
  expect(page).toMatch(/<span class="ln">.*?<span class="hljs-string">`one<\/span><\/span><span class="ln"><span class="hljs-string">two`<\/span>;<\/span>/);
  expect(page).toContain(".hljs{");
  expect(page).toContain("prefers-color-scheme: dark");
});

test("a saved copy inlines the libraries a React page loads", () => {
  const kit = { style: "", script: "", parts: "", kinds: { style: "", script: "" }, remember: "" };
  const page = exportedSource(reactPage(APP, "Orders"), kit, { "react.js": "window.React={}</script>", "react-dom.js": "window.ReactDOM={}", "lucide.js": "window.LucideReact={}", "tailwind.js": "/*tw*/" });
  expect(page).not.toContain('src="foundry://kit/');
  expect(page).toContain("<script>window.React={}<\\/script></script>");
  expect(page).toContain("<script>/*tw*/</script>");
  // Without the library, the tag stays as it was.
  expect(exportedSource('<script src="foundry://kit/mermaid.js"></script>', kit)).toBe('<script src="foundry://kit/mermaid.js"></script>');
});

test("step 3 of pass 273 A: a sheet is drawn as a table that sorts, edits, adds up and keeps what you type", async () => {
  const { sheetBase, sheetPage } = await import("../electron/foundry-more-kinds.ts");
  const csv = 'Plot,pH,Cost\nA1,6.4,"$1,200.50"\n<B2>,7.1,$80\n';
  const page = foundryDocument("sheet", csv, "Soil <samples>");
  expect(page).toBe(sheetPage(csv, "Soil <samples>"));
  expect(page).toContain("<title>Soil &lt;samples&gt;</title>");
  expect(page).toContain('"head":["Plot","pH","Cost"]');
  expect(page).toContain('"numbers":[false,true,true]');
  expect(page).toContain("\\u003cB2>");
  expect(page).not.toContain("<B2>");
  expect(page).toContain('demesne.save("sheet"');
  expect(page).toContain(`"base":"${sheetBase(csv)}"`);
  expect(sheetBase(csv)).not.toBe(sheetBase(csv + "C3,6,1\n"));
});

test("step 4 of pass 273 A: a whiteboard is drawn from its JSON, moves and connects, and keeps what you change", async () => {
  const { boardPage, sheetBase } = await import("../electron/foundry-more-kinds.ts");
  const json = '{"notes":[{"id":"a","text":"<Ask>","x":40,"y":40,"tone":"sky"},{"id":"b","text":"Book"}],"arrows":[{"from":"a","to":"b","label":"then"}]}';
  const page = foundryDocument("board", json, "Visit <flow>");
  expect(page).toBe(boardPage(json, "Visit <flow>"));
  expect(page).toContain("<title>Visit &lt;flow&gt;</title>");
  expect(page).toContain('"text":"\\u003cAsk>"');
  expect(page).not.toContain("<Ask>");
  expect(page).toContain('"tone":"sky"');
  expect(page).toContain('demesne.save("board"');
  expect(page).toContain(`"base":"${sheetBase(json)}"`);
});
