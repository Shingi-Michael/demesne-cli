import { createCustomTheme, parseSavedTheme, resolveTheme, THEMES, type Theme, type ThemeLibrary } from "@demesne/brand";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize } from "node:path";

interface ThemeState { version:1; selected:string; custom:Theme[]; history:string[]; installed?:Theme[]; system?:{enabled:boolean;path:string} }
const installedName = /^(system|installed-[a-z0-9][a-z0-9-]{0,63})$/;
function savedInstalled(value: unknown): Theme {
  if (!value || typeof value !== "object" || !installedName.test(String((value as Theme).name))) throw new Error("Invalid installed theme");
  const name = (value as Theme).name;
  return {...parseSavedTheme({...value, name:"custom-installed"}), name};
}
/** One daemon owns the library; external files are read-only inputs, never overwritten. */
export class ThemeStore {
  private state:ThemeState;
  private readError: string | undefined;
  private persisted=false;
  private sources=new Map<string,string>();
  private installedDirty=false;
  private systemError:string | undefined;
  private get systemSource() { return this.state.system ?? {enabled:false,path:join(this.directory,"system.json")}; }
  private sourcePath(path:string):string {
    if(typeof path!=="string" || path.length>4096 || /[\u0000-\u001f\u007f]/.test(path))throw new Error("Invalid system palette path");
    path=path.trim();
    if(path==="~" || path.startsWith("~/") || path.startsWith("~\\"))path=join(homedir(),path.slice(2));
    if(!isAbsolute(path))throw new Error("System palette path must be absolute or start with ~/");
    return normalize(path);
  }
  constructor(private readonly path:string, initial?:string, private readonly directory=join(homedir(),".demesne","themes")) {
    this.state={version:1,selected:resolveTheme(initial,process.env.COLORFGBG).name,custom:[],history:[],installed:[]};
    if(existsSync(path))try {
      if(readFileSync(path).byteLength>2*1024*1024)throw new Error("Theme library exceeds size limit");
      const saved=JSON.parse(readFileSync(path,"utf8"));
      if(saved.version!==1 || !Array.isArray(saved.custom) || saved.custom.length>256 || !Array.isArray(saved.history) || saved.history.length>20
        || (saved.installed!==undefined && (!Array.isArray(saved.installed) || saved.installed.length>256)))throw new Error("Invalid theme library");
      const custom=saved.custom.map(parseSavedTheme), installed=(saved.installed??[]).map(savedInstalled);
      const names=new Set([...Object.keys(THEMES),...custom.map((t:Theme)=>t.name),...installed.map((t:Theme)=>t.name)]);
      if(custom.length!==new Set(custom.map((t:Theme)=>t.name)).size || installed.length!==new Set(installed.map((t:Theme)=>t.name)).size
        || !names.has(saved.selected) || !saved.history.every((n:unknown)=>typeof n==="string" && names.has(n)))throw new Error("Invalid theme selection");
      let system:ThemeState["system"];
      if(saved.system!==undefined) {
        if(!saved.system || typeof saved.system.enabled!=="boolean" || typeof saved.system.path!=="string")throw new Error("Invalid system palette settings");
        system={enabled:saved.system.enabled,path:this.sourcePath(saved.system.path)};
      }
      this.state={version:1,selected:saved.selected,custom,installed,history:saved.history,...(system?{system}:{})};
      this.persisted=true;
    }catch(error){this.readError=`Cannot update the existing theme library: ${error instanceof Error?error.message:String(error)}`;console.warn(this.readError);}
    try { mkdirSync(this.directory,{recursive:true,mode:0o700}); } catch { /* Read-only home directories still allow built-ins. */ }
    this.refreshInstalled();
    if (initial && this.find(initial) && !this.persisted) this.state.selected=initial;
  }
  /** Polling the directory, rather than watching inodes, also handles atomic generator saves.
   * Missing/invalid files retain the last good palette. No timers or handles are held here. */
  private refreshInstalled() {
    let files:string[];
    try { files=readdirSync(this.directory).filter(f=>/^(system|[a-z0-9][a-z0-9-]{0,63})\.json$/.test(f)).sort().slice(0,256); }
    catch { files=[]; }
    const external=this.systemSource;
    this.systemError=undefined;
    const inputs=files.filter(file=>file!=="system.json").map(file=>({path:join(this.directory,file),name:"installed-"+file.slice(0,-5)}));
    if(external.enabled)inputs.push({path:external.path,name:"system"});
    for(const {path,name} of inputs)try {
      const stat=statSync(path);
      if(!stat.isFile() || stat.size>64*1024)throw new Error("Palette must be a regular JSON file no larger than 64 KiB");
      const source=readFileSync(path,"utf8");
      if(Buffer.byteLength(source)>64*1024)throw new Error("Palette exceeds 64 KiB");
      if(this.sources.get(name+":"+path)===source)continue;
      const theme=createCustomTheme(JSON.parse(source),name,"installed");
      const installed=this.state.installed??[];
      if(!installed.some(t=>t.name===name) && installed.length>=256)continue;
      this.state.installed=[...installed.filter(t=>t.name!==name),theme];
      this.installedDirty=true;
      this.sources.set(name+":"+path,source);
    }catch(error) {
      // Retain last-good colors for this source, but tell Settings why a reload failed.
      if(name==="system")this.systemError=error instanceof Error?error.message:String(error);
    }
  }
  snapshot():ThemeLibrary {
    this.refreshInstalled();
    const installed=(this.state.installed??[]).filter(t=>t.name!=="system" || this.systemSource.enabled), names=new Set(installed.map(t=>t.name));
    const latest=this.state.custom.at(-1);
    return structuredClone({selected:this.find(this.state.selected)!,themes:[...Object.values(THEMES).filter(t=>!names.has(t.name)),...installed,...this.state.custom,
      ...(latest?[{...latest,name:"themefy",label:"Themefy (latest generated)"}]:[])],canUndo:this.state.history.length>0,persisted:this.persisted,systemSource:{...this.systemSource,...(this.systemError?{error:this.systemError}:{})}});
  }
  private find(name:string):Theme | undefined {
    if(name==="themefy")return this.state.custom.at(-1);
    if(name==="system" && !this.systemSource.enabled)return THEMES.system;
    return this.state.installed?.find(t=>t.name===name) ?? (Object.hasOwn(THEMES,name)?THEMES[name]:this.state.custom.find(t=>t.name===name));
  }
  private commit(next:ThemeState):ThemeLibrary {
    if(this.readError)throw new Error(this.readError);
    mkdirSync(dirname(this.path),{recursive:true,mode:0o700});
    const temporary=this.path+"."+randomUUID()+".tmp";
    const serialized=JSON.stringify(next,null,2)+"\n";
    if(Buffer.byteLength(serialized)>2*1024*1024)throw new Error("Theme library exceeds size limit");
    writeFileSync(temporary,serialized,{mode:0o600});renameSync(temporary,this.path);this.state=next;this.persisted=true;this.installedDirty=false;return this.snapshot();
  }
  private history():string[]{return [...this.state.history,this.state.selected].slice(-20);}
  apply(input:unknown):ThemeLibrary {
    const theme=createCustomTheme(input,"custom-"+randomUUID());
    if(this.state.custom.length>=256)throw new Error("The saved-theme library is full (256 themes)");
    return this.commit({...this.state,selected:theme.name,custom:[...this.state.custom,theme],history:this.history()});
  }
  select(name:string):ThemeLibrary {
    this.refreshInstalled();
    const theme=this.find(name);
    if(!theme)throw new Error("Unknown theme");
    // Themefy is an alias, not a mutable history entry: every generation remains undoable.
    name=theme.name;
    return name===this.state.selected && this.persisted && !this.installedDirty?this.snapshot():this.commit({...this.state,selected:name,history:name===this.state.selected?this.state.history:this.history()});
  }
  configureSystem(enabled:boolean,path:string):ThemeLibrary {
    if(typeof enabled!=="boolean")throw new Error("System palette enabled must be a boolean");
    const system={enabled,path:this.sourcePath(path)};
    const changed=system.path!==this.systemSource.path;
    let installed=(this.state.installed??[]).filter(t=>!changed || t.name!=="system");
    if(enabled)try {
      const stat=statSync(system.path);
      if(!stat.isFile() || stat.size>64*1024)throw new Error("Palette must be a regular JSON file no larger than 64 KiB");
      const source=readFileSync(system.path,"utf8");
      if(Buffer.byteLength(source)>64*1024)throw new Error("Palette exceeds 64 KiB");
      const theme=createCustomTheme(JSON.parse(source),"system","installed");
      if(installed.some(t=>t.name==="system") || installed.length<256)installed=[...installed.filter(t=>t.name!=="system"),theme];
    }catch { /* Save unavailable sources too; snapshot reports the reload error. */ }
    if(changed)this.sources.delete("system:"+system.path);
    return this.commit({...this.state,system,installed});
  }
  undo():ThemeLibrary {
    const selected=this.state.history.at(-1);if(!selected)throw new Error("No theme change to undo");
    return this.commit({...this.state,selected,history:this.state.history.slice(0,-1)});
  }
}
