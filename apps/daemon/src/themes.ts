import { createCustomTheme, parseSavedTheme, resolveTheme, THEMES, type Theme, type ThemeLibrary } from "@demesne/brand";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

interface ThemeState { version:1; selected:string; custom:Theme[]; history:string[] }
/** One daemon owns this atomic file. A failed validation/write leaves the active palette intact. */
export class ThemeStore {
  private state:ThemeState;
  private readError: string | undefined;
  private persisted=false;
  constructor(private readonly path:string, initial?:string) {
    this.state={version:1,selected:resolveTheme(initial,process.env.COLORFGBG).name,custom:[],history:[]};
    if(existsSync(path))try {
      if(readFileSync(path).byteLength>2*1024*1024)throw new Error("Theme library exceeds size limit");
      const saved=JSON.parse(readFileSync(path,"utf8"));
      if(saved.version!==1 || !Array.isArray(saved.custom) || saved.custom.length>256 || !Array.isArray(saved.history) || saved.history.length>20)throw new Error("Invalid theme library");
      const custom=saved.custom.map(parseSavedTheme), names=new Set([...Object.keys(THEMES),...custom.map((t:Theme)=>t.name)]);
      if(custom.length!==new Set(custom.map((t:Theme)=>t.name)).size || !names.has(saved.selected) || !saved.history.every((n:unknown)=>typeof n==="string" && names.has(n)))throw new Error("Invalid theme selection");
      this.state={version:1,selected:saved.selected,custom,history:saved.history};
      this.persisted=true;
    }catch(error){this.readError=`Cannot update the existing theme library: ${error instanceof Error?error.message:String(error)}`;console.warn(this.readError);}
  }
  snapshot():ThemeLibrary { return structuredClone({selected:this.find(this.state.selected)!,themes:[...Object.values(THEMES),...this.state.custom],canUndo:this.state.history.length>0,persisted:this.persisted}); }
  private find(name:string):Theme | undefined {return Object.hasOwn(THEMES,name)?THEMES[name]:this.state.custom.find(t=>t.name===name);}
  private commit(next:ThemeState):ThemeLibrary {
    if(this.readError)throw new Error(this.readError);
    mkdirSync(dirname(this.path),{recursive:true,mode:0o700});
    const temporary=this.path+"."+randomUUID()+".tmp";
    writeFileSync(temporary,JSON.stringify(next,null,2)+"\n",{mode:0o600});renameSync(temporary,this.path);this.state=next;this.persisted=true;return this.snapshot();
  }
  private history():string[]{return [...this.state.history,this.state.selected].slice(-20);}
  apply(input:unknown):ThemeLibrary {
    const theme=createCustomTheme(input,"custom-"+randomUUID());
    if(this.state.custom.length>=256)throw new Error("The saved-theme library is full (256 themes)");
    return this.commit({...this.state,selected:theme.name,custom:[...this.state.custom,theme],history:this.history()});
  }
  select(name:string):ThemeLibrary {
    if(!this.find(name))throw new Error("Unknown theme");
    return name===this.state.selected && this.persisted?this.snapshot():this.commit({...this.state,selected:name,history:name===this.state.selected?this.state.history:this.history()});
  }
  undo():ThemeLibrary {
    const selected=this.state.history.at(-1);if(!selected)throw new Error("No theme change to undo");
    return this.commit({...this.state,selected,history:this.state.history.slice(0,-1)});
  }
}
