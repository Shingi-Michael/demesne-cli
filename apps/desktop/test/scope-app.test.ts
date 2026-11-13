import { expect, test } from "bun:test";
import { scopeAppStyles } from "../foundry-kit/scope-app.ts";

// Pass 220 A: the app's own styles, made safe inside a Foundry page.
test("the app's styles are scoped to the window a mockup draws", () => {
  const css = scopeAppStyles([
    `@font-face{font-family:Inter;src:url(node_modules/@fontsource/inter/files/inter-latin-400-normal.woff2)}
     /* a comment with body { } in it */
     html,body{height:100%}body.desktop{--tone:red;height:100vh}
     html.glass body.desktop #cards{width:40vw}.glass .bar-tab.on,.desktop-home{color:red}
     :root{--a:1}html[data-theme="demesne-light"] .x{color:blue}`,
    `@keyframes spin{to{transform:rotate(1turn)}}
     @media (max-width: 760px){.desktop #cards{display:none}@keyframes in{from{opacity:0}}}
     @media (prefers-reduced-motion: reduce){body .x{animation:none}}
     .tbody,.html-view,#body{color:green}`,
  ]);
  const [global, scoped] = [css.slice(0, css.indexOf("@scope (d-app)")), css.slice(css.indexOf("@scope (d-app)"))];
  // Fonts and keyframes are document-wide by nature; fonts come from the kit.
  expect(global).toContain("@font-face{font-family:Inter;src:url(foundry://kit/fonts/inter-latin-400-normal.woff2)}");
  expect(global).toContain("@keyframes spin");
  expect(global).toContain("@keyframes in");
  expect(scoped).not.toContain("@keyframes");
  expect(scoped).not.toContain("a comment");
  // One layer, under the page: a mockup changes the app by name, without out-weighing it.
  expect(css).toContain("@layer demesne {\n@scope (d-app) {");
  // html is the scope's root, body the element inside it.
  expect(scoped).toContain(":where(:scope),d-body{height:100%}");
  expect(scoped).toContain("d-body.desktop{--tone:red;height:100cqh}");
  expect(scoped).toContain(":where(:scope).glass d-body.desktop #cards{width:40cqw}");
  expect(scoped).toContain(":where(:scope).glass .bar-tab.on,.desktop-home{color:red}");
  expect(scoped).toContain(":scope{--a:1}");
  expect(scoped).toContain(':where(:scope)[data-theme="demesne-light"] .x{color:blue}');
  // The window's size is the element's.
  expect(scoped).toContain("@container app (max-width: 760px){.desktop #cards{display:none}");
  expect(scoped).toContain("@media (prefers-reduced-motion: reduce){d-body .x{animation:none}");
  // Names that only contain the words are left alone.
  expect(scoped).toContain(".tbody,.html-view,#body{color:green}");
});
