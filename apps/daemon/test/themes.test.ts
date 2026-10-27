import {afterEach,expect,test} from "bun:test";
import {mkdtempSync,mkdirSync,readFileSync,renameSync,rmSync,symlinkSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {warmOlive} from "../../../packages/brand/test/theme-fixture.ts";
import {ThemeStore} from "../src/themes.ts";
class IsolatedThemeStore extends ThemeStore {
  constructor(path:string,initial?:string) { super(path,initial,join(path+"-files")); }
}
const roots:string[]=[];afterEach(()=>{for(const r of roots.splice(0))rmSync(r,{recursive:true,force:true});});
function fixture(){const root=mkdtempSync(join(tmpdir(),"demesne-themes-"));roots.push(root);return join(root,"themes.json");}
test("theme library saves, restores selection, and undoes without deleting saved palettes",()=>{
  const path=fixture(),store=new IsolatedThemeStore(path,"nord"),saved=store.apply(warmOlive);
  expect(saved.selected.name).toStartWith("custom-");expect(saved.canUndo).toBe(true);
  const reopened=new IsolatedThemeStore(path);expect(reopened.snapshot()).toEqual(saved);
  const undone=reopened.undo();expect(undone.selected.name).toBe("nord");expect(undone.themes.some(t=>t.name===saved.selected.name)).toBe(true);
  reopened.select(saved.selected.name);expect(new IsolatedThemeStore(path).snapshot().selected).toEqual(saved.selected);
  const before=readFileSync(path,"utf8");expect(()=>reopened.apply({...warmOlive,css:"bad"})).toThrow();expect(readFileSync(path,"utf8")).toBe(before);
  const copy=reopened.snapshot();copy.selected.colors.ink="#000000";expect(reopened.snapshot().selected.colors.ink).not.toBe("#000000");
});
test("corrupt saved themes are never overwritten",()=>{const path=fixture();writeFileSync(path,"broken");const store=new IsolatedThemeStore(path);expect(store.snapshot().selected.name).toBe("demesne");expect(()=>store.apply(warmOlive)).toThrow("existing theme library");expect(readFileSync(path,"utf8")).toBe("broken");});

test("installed themes and system palettes reload atomically, retaining last valid colors",()=>{
  const path=fixture(),directory=path+"-files";
  mkdirSync(directory);
  const store=new IsolatedThemeStore(path);
  expect(store.snapshot().themes.find(t=>t.name==="system")?.systemFallback).toBe(true);
  writeFileSync(join(directory,"olive.json"),JSON.stringify(warmOlive));
  expect(store.select("installed-olive").selected.colors.ink).toBe("#181A14");
  writeFileSync(join(directory,"system.json"),JSON.stringify(warmOlive));
  expect(store.select("system").selected.systemFallback).toBe(true);
  store.configureSystem(true,join(directory,"system.json"));
  expect(store.select("system").selected.systemFallback).toBeUndefined();
  const changed={...warmOlive,label:"Updated system",colors:{...warmOlive.colors,background:"#12140E"}};
  writeFileSync(join(directory,"replacement.tmp"),JSON.stringify(changed));
  renameSync(join(directory,"replacement.tmp"),join(directory,"system.json"));
  expect(store.snapshot().selected.colors.ink).toBe("#12140E");
  writeFileSync(join(directory,"system.json"),"incomplete");
  expect(store.snapshot().selected.colors.ink).toBe("#12140E");
  store.select("nord");
  expect(store.undo().selected.colors.ink).toBe("#12140E");
  expect(new IsolatedThemeStore(path).snapshot().selected.colors.ink).toBe("#12140E");
});
test("Themefy latest alias preserves every generation and exact undo",()=>{
  const path=fixture(),store=new IsolatedThemeStore(path);
  const first=store.apply(warmOlive).selected;
  const second=store.apply({...warmOlive,label:"Second"}).selected;
  expect(store.undo().selected).toEqual(first);
  expect(store.select("themefy").selected).toEqual(second);
  expect(store.undo().selected).toEqual(first);
  expect(new IsolatedThemeStore(path).select("themefy").selected).toEqual(second);
});
test("user symlinks to generator output survive atomic replacement",()=>{
  if(process.platform==="win32")return; // Creating symlinks requires extra Windows privileges.
  const path=fixture(),directory=path+"-files";
  mkdirSync(directory);
  const output=join(directory,"generated-output");
  writeFileSync(output,JSON.stringify(warmOlive));
  symlinkSync(output,join(directory,"system.json"));
  const store=new IsolatedThemeStore(path);
  store.configureSystem(true,join(directory,"system.json"));
  expect(store.select("system").selected.label).toBe(warmOlive.label);
  writeFileSync(output+".tmp",JSON.stringify({...warmOlive,label:"Regenerated"}));
  renameSync(output+".tmp",output);
  expect(store.snapshot().selected.label).toBe("Regenerated");
  rmSync(output);
  expect(store.snapshot().selected.label).toBe("Regenerated");
});
test("invalid installed files cannot inject CSS or replace built-ins",()=>{
  const path=fixture(),directory=path+"-files";
  mkdirSync(directory);
  writeFileSync(join(directory,"nord.json"),JSON.stringify(warmOlive));
  writeFileSync(join(directory,"bad.json"),JSON.stringify({...warmOlive,css:"body{}"}));
  const store=new IsolatedThemeStore(path);
  expect(store.select("nord").selected.label).toBe("Nord");
  expect(store.select("installed-nord").selected.label).toBe(warmOlive.label);
  expect(()=>store.select("installed-bad")).toThrow("Unknown theme");
});

test("reselecting a refreshed installed palette persists last-good colors",()=>{
  const path=fixture(),directory=path+"-files";
  mkdirSync(directory);
  const file=join(directory,"system.json");
  writeFileSync(file,JSON.stringify(warmOlive));
  const store=new IsolatedThemeStore(path);
  store.configureSystem(true,file);
  store.select("system");
  writeFileSync(file,JSON.stringify({...warmOlive,label:"New colors"}));
  store.snapshot();
  store.select("system");
  rmSync(file);
  expect(new IsolatedThemeStore(path).snapshot().selected.label).toBe("New colors");
});
test("installed surface contrast is flexible without changing Themefy constraints",()=>{
  const path=fixture(),directory=path+"-files";
  mkdirSync(directory);
  const input={...warmOlive,colors:{...warmOlive.colors,raised:"#666666"}};
  writeFileSync(join(directory,"contrast.json"),JSON.stringify(input));
  const store=new IsolatedThemeStore(path);
  expect(store.select("installed-contrast").selected.colors.raised).toBe("#666666");
  expect(()=>store.apply(input)).toThrow("raised must be darker");
});

test("Kuru's exact generated export loads as the System palette",()=>{
  const path=fixture(),directory=path+"-files";
  mkdirSync(directory);
  const source=readFileSync(new URL("../../../docs/theme-examples/kuru.json",import.meta.url),"utf8");
  writeFileSync(join(directory,"system.json"),source);
  const store=new IsolatedThemeStore(path);
  store.configureSystem(true,join(directory,"system.json"));
  const selected=store.select("system").selected;
  expect(selected.label).toBe("Kuru: monokai-soda");
  expect(selected.appearance).toBe("dark");
  expect(selected.colors.ink).toBe("#222222");
  expect(selected.colors.surface).toBe("#1C1C1C");
  expect(selected.colors.raised).toBe("#333333");
  expect(selected.systemFallback).toBeUndefined();
});

test("System defaults to Demesne and external palettes are an explicit persisted opt-in",()=>{
  const path=fixture(),store=new IsolatedThemeStore(path),file=join(path+"-files","system.json");
  writeFileSync(file,JSON.stringify(warmOlive));
  expect(store.select("system").selected.systemFallback).toBe(true);
  expect(store.snapshot().systemSource).toEqual({enabled:false,path:file});
  store.configureSystem(true,file);
  expect(store.snapshot().selected.label).toBe(warmOlive.label);
  expect(new IsolatedThemeStore(path).snapshot().selected.label).toBe(warmOlive.label);
  const off=store.configureSystem(false,file);
  expect(off.selected.name).toBe("system");
  expect(off.selected.systemFallback).toBe(true);
  expect(off.themes.filter(t=>t.name==="system")).toHaveLength(1);
  expect(new IsolatedThemeStore(path).snapshot().selected.systemFallback).toBe(true);
  expect(readFileSync(file,"utf8")).toBe(JSON.stringify(warmOlive));
});
test("System accepts an external path without creating or altering a symlink",()=>{
  const path=fixture(),store=new IsolatedThemeStore(path);
  const output=path+"-kuru.json";
  writeFileSync(output,JSON.stringify(warmOlive));
  store.configureSystem(false,output);
  expect(store.select("system").selected.systemFallback).toBe(true);
  store.configureSystem(true,output);
  expect(store.snapshot().selected.label).toBe(warmOlive.label);
  const missing=path+"-missing.json";
  const changed=store.configureSystem(true,missing);
  expect(changed.selected.systemFallback).toBe(true);
  expect(changed.systemSource?.error).toBeDefined();
  expect(new IsolatedThemeStore(path).snapshot().selected.systemFallback).toBe(true);
  const before=readFileSync(path,"utf8");
  expect(()=>store.configureSystem(true,"relative/palette.json")).toThrow("absolute");
  expect(readFileSync(path,"utf8")).toBe(before);
  writeFileSync(missing,JSON.stringify({...warmOlive,label:"New source"}));
  expect(store.snapshot().selected.label).toBe("New source");
  expect(store.snapshot().systemSource?.error).toBeUndefined();
  store.select("nord");
  store.configureSystem(false,output);
  expect(store.snapshot().selected.name).toBe("nord");
});

test("enabling a source caches its first valid palette before the settings write completes",()=>{
  const path=fixture(),store=new IsolatedThemeStore(path),source=path+"-kuru.json";
  store.select("system");
  writeFileSync(source,JSON.stringify(warmOlive));
  expect(store.configureSystem(true,source).selected.label).toBe(warmOlive.label);
  rmSync(source);
  const restored=new IsolatedThemeStore(path).snapshot();
  expect(restored.selected.label).toBe(warmOlive.label);
  expect(restored.systemSource?.error).toBeDefined();
  expect(store.configureSystem(false,source).selected.systemFallback).toBe(true);
});
