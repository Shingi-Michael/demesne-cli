import {afterEach,expect,test} from "bun:test";
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {warmOlive} from "../../../packages/brand/test/theme-fixture.ts";
import {ThemeStore} from "../src/themes.ts";
const roots:string[]=[];afterEach(()=>{for(const r of roots.splice(0))rmSync(r,{recursive:true,force:true});});
function fixture(){const root=mkdtempSync(join(tmpdir(),"demesne-themes-"));roots.push(root);return join(root,"themes.json");}
test("theme library saves, restores selection, and undoes without deleting saved palettes",()=>{
  const path=fixture(),store=new ThemeStore(path,"nord"),saved=store.apply(warmOlive);
  expect(saved.selected.name).toStartWith("custom-");expect(saved.canUndo).toBe(true);
  const reopened=new ThemeStore(path);expect(reopened.snapshot()).toEqual(saved);
  const undone=reopened.undo();expect(undone.selected.name).toBe("nord");expect(undone.themes.some(t=>t.name===saved.selected.name)).toBe(true);
  reopened.select(saved.selected.name);expect(new ThemeStore(path).snapshot().selected).toEqual(saved.selected);
  const before=readFileSync(path,"utf8");expect(()=>reopened.apply({...warmOlive,css:"bad"})).toThrow();expect(readFileSync(path,"utf8")).toBe(before);
  const copy=reopened.snapshot();copy.selected.colors.ink="#000000";expect(reopened.snapshot().selected.colors.ink).not.toBe("#000000");
});
test("corrupt saved themes are never overwritten",()=>{const path=fixture();writeFileSync(path,"broken");const store=new ThemeStore(path);expect(store.snapshot().selected.name).toBe("demesne");expect(()=>store.apply(warmOlive)).toThrow("existing theme library");expect(readFileSync(path,"utf8")).toBe("broken");});
