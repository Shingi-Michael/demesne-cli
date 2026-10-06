import {expect,test} from "bun:test";
import {contrast,createCustomTheme,palette} from "../src/index.ts";

import {warmOlive} from "./theme-fixture.ts";

test.each(["dark","light"] as const)("custom %s palettes adjust every text role across surfaces",appearance=>{
  const input=structuredClone(warmOlive);input.appearance=appearance;
  if(appearance === "light")Object.assign(input.colors,{background:"#FAF8EE",surface:"#F2EFDF",raised:"#EAE5D2",text:"#302F25"});
  const theme=createCustomTheme(input,"custom-test"),c=theme.colors;
  expect(Object.keys(c).sort()).toEqual(Object.keys(palette).sort());
  for(const text of ["paper","secondary","muted","electric","signal","citron","syntaxComment","syntaxKeyword"] as const)
    for(const bg of ["ink","surface","raised","thinkingSurface","errorSurface","accentSurface","tileSelection","diffAddedSurface","diffRemovedSurface"] as const)
      expect(contrast(c[text],c[bg]),`${text} on ${bg}`).toBeGreaterThanOrEqual(4.5);
  expect(c.secondary).not.toBe(input.colors.secondary);expect(c.ink).toBe(input.colors.background);expect(c.electric).not.toBe(c.signal);
});
test("model CSS and invalid surfaces cannot enter a palette",()=>{
  expect(()=>createCustomTheme({...warmOlive,css:"body {}"},"custom-test")).toThrow("unsupported");
  expect(()=>createCustomTheme({...warmOlive,colors:{...warmOlive.colors,accent:"url(javascript:alert(1))"}},"custom-test")).toThrow("hex");
  expect(()=>createCustomTheme({...warmOlive,colors:{...warmOlive.colors,raised:"#EEEEEE"}},"custom-test")).toThrow("darker");
  expect(()=>createCustomTheme({...warmOlive,label:"Bad\u001b[31m"},"custom-test")).toThrow();
});
