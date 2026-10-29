/** Focused real-Chromium regression check for System appearance and palette-independent glass.
 * Run after prepare-desktop.ts; on headless Linux use xvfb-run -a bun scripts/check-theme-material.ts. */
import {_electron as electron} from "playwright";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {join,resolve} from "node:path";
import {fixture} from "../apps/desktop/workspace/test/fixture.ts";
const f=await fixture({providerId:"fixture",modelId:"theme-material",async listModels(){return[];},async *stream(){yield{type:"finish" as const,reason:"stop" as const};}});
let desktop:Awaited<ReturnType<typeof electron.launch>> | undefined;
try {
  desktop=await electron.launch({args:[resolve("apps/desktop/build/app"),"--no-sandbox",`--user-data-dir=${join(f.root,"electron-material")}`,`--workspace=${f.workspace}`,`--server=${f.server.url}`],env:{...f.env,DEMESNE_GLASS:"1"},timeout:30000});
  const page=await desktop.firstWindow();
  await page.waitForFunction(()=>!!document.documentElement.dataset.theme,{timeout:30000});
  await page.evaluate(()=>{localStorage.setItem("demesne-glass","25");});
  await page.reload();
  await page.waitForFunction(()=>!!document.documentElement.dataset.theme,{timeout:30000});
  // Model a dark OS with Chromium still reporting the prior explicit light palette.
  await desktop.evaluate(({nativeTheme})=>{(globalThis as any).systemDark=true;Object.defineProperty(nativeTheme,"shouldUseDarkColors",{configurable:true,get:()=>nativeTheme.themeSource==="light"?false:(globalThis as any).systemDark});});
  await page.emulateMedia({colorScheme:"light"});
  await f.client.selectTheme("demesne-light");
  await page.waitForFunction(()=>document.documentElement.dataset.theme==="demesne-light");
  await f.client.selectTheme("system");
  await page.waitForFunction(()=>document.documentElement.dataset.theme==="demesne" && document.documentElement.dataset.appearance==="dark");
  assert.equal(await desktop.evaluate(({nativeTheme})=>nativeTheme.themeSource),"system");
  await desktop.evaluate(({nativeTheme})=>{(globalThis as any).systemDark=false;nativeTheme.emit("updated");});
  await page.waitForFunction(()=>document.documentElement.dataset.theme==="demesne-light");
  await desktop.evaluate(({nativeTheme})=>{(globalThis as any).systemDark=true;nativeTheme.emit("updated");});
  await page.waitForFunction(()=>document.documentElement.dataset.theme==="demesne");
  async function material() {
    return page.evaluate(()=>{
      function alpha(id:string) {
        const canvas=document.createElement("canvas");canvas.width=canvas.height=1;
        const ctx=canvas.getContext("2d")!;
        const color=getComputedStyle(document.getElementById(id)!).backgroundColor;
        ctx.fillStyle=color;ctx.fillRect(0,0,1,1);
        return {color,alpha:ctx.getImageData(0,0,1,1).data[3]!/255};
      }
      return {glass:document.documentElement.classList.contains("glass"),shell:alpha("desktop-shell"),panel:alpha("app"),body:getComputedStyle(document.body).backgroundColor};
    });
  }
  for(const name of ["demesne","dracula","catppuccin-latte"]) {
    await f.client.selectTheme(name);
    await page.waitForFunction(name=>document.documentElement.dataset.theme===name,name);
    const value=await material();
    assert(value.glass);
    assert(Math.abs(value.shell.alpha-0.288)<0.01,`${name} shell must remain glass: ${JSON.stringify(value)}`);
    assert(Math.abs(value.panel.alpha-0.31)<0.01,`${name} panel must remain glass: ${JSON.stringify(value)}`);
    assert.equal(value.body,"rgba(0, 0, 0, 0)");
  }
  const path=join(f.root,"kuru.json");
  await Bun.write(path,readFileSync("docs/theme-examples/kuru.json"));
  await f.client.configureSystemTheme(true,path);
  await f.client.selectTheme("system");
  await page.waitForFunction(()=>document.documentElement.dataset.theme==="system");
  const kuru=await material();
  assert(Math.abs(kuru.shell.alpha-0.288)<0.01,JSON.stringify(kuru));
  assert(Math.abs(kuru.panel.alpha-0.31)<0.01,JSON.stringify(kuru));
  // The opacity slider remains a material control after a palette swap.
  await page.evaluate(()=>{document.documentElement.style.setProperty("--shell-a","1");document.documentElement.style.setProperty("--panel-a","1");});
  const solid=await material();assert.equal(solid.shell.alpha,1);assert.equal(solid.panel.alpha,1);
  console.log("PASS: native dark System beats stale light media; glass survives built-in, light and Kuru palettes; opacity remains independent.");
}finally {await desktop?.close();await f.close();}
