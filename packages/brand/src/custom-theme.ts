import { palette, type Theme, type PaletteColor } from "./theme.ts";

export const THEME_INPUT_COLORS = ["background", "surface", "raised", "text", "secondary", "accent", "accentBright", "warning",
  "syntaxKeyword", "syntaxString", "syntaxNumber", "syntaxComment", "syntaxType", "syntaxFunction"] as const;
export type ThemeInputColor = typeof THEME_INPUT_COLORS[number];
export interface ThemeInput { label: string; appearance: "dark" | "light"; colors: Record<ThemeInputColor, string> }
export interface ThemeLibrary { selected: Theme; themes: Theme[]; canUndo: boolean; persisted: boolean }
const hex = /^#[0-9a-f]{6}$/i;
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const mix = (a: string, b: string, weight: number) => "#" + [1,3,5].map(i => Math.round(parseInt(a.slice(i,i+2),16)*(1-weight)+parseInt(b.slice(i,i+2),16)*weight).toString(16).padStart(2,"0")).join("");
export function luminance(color: string): number {
  const channels = [1,3,5].map(i => { const v=parseInt(color.slice(i,i+2),16)/255; return v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4; });
  return channels[0]!*0.2126+channels[1]!*0.7152+channels[2]!*0.0722;
}
export function contrast(a: string, b: string): number { const x=luminance(a),y=luminance(b);return (Math.max(x,y)+0.05)/(Math.min(x,y)+0.05); }
function readable(color: string, backgrounds: string[], appearance: "dark" | "light"): string {
  const endpoint=appearance === "dark"?"#FFFFFF":"#000000";
  for(let step=0;step<=100;step++) { const candidate=mix(color,endpoint,step/100);if(backgrounds.every(bg=>contrast(candidate,bg)>=4.5))return candidate; }
  throw new Error("The surfaces cannot support readable text. Use darker dark-mode surfaces or lighter light-mode surfaces.");
}
export function parseThemeInput(value: unknown): ThemeInput {
  if(!record(value) || typeof value.label !== "string" || !value.label.trim() || value.label.length>60 || /[\u0000-\u001f\u007f]/.test(value.label)
    || !["dark","light"].includes(String(value.appearance)) || !record(value.colors))throw new Error("A theme needs a label, dark/light appearance, and hex colors");
  if(Object.keys(value).some(k=>!["label","appearance","colors"].includes(k)) || Object.keys(value.colors).some(k=>!THEME_INPUT_COLORS.includes(k as ThemeInputColor)))throw new Error("Theme contains unsupported properties");
  const colors={} as ThemeInput["colors"];
  for(const key of THEME_INPUT_COLORS){const color=value.colors[key];if(typeof color!=="string" || !hex.test(color))throw new Error(`${key} must be a six-digit hex color`);colors[key]=color.toUpperCase();}
  return {label:value.label.trim(),appearance:value.appearance as ThemeInput["appearance"],colors};
}
/** Only tokens enter the renderer. Readability adjustments retain hue where possible;
 * no model CSS, JavaScript, paths, fonts or layout instructions are accepted. */
export function createCustomTheme(value: unknown, name: string): Theme {
  const input=parseThemeInput(value), c=input.colors, dark=input.appearance === "dark";
  for(const role of ["background","surface","raised"] as const) {
    const light=luminance(c[role]);if(dark?light>0.12:light<0.6)throw new Error(`${role} must be ${dark?"darker":"lighter"} for ${input.appearance} mode`);
  }
  const surfaces=[c.background,c.surface,c.raised];
  const accent=readable(c.accent,surfaces,input.appearance), warning=readable(c.warning,surfaces,input.appearance);
  const signal=dark?"#FF8B84":"#A52C25", citron=dark?"#8DD6A8":"#17673D";
  const wash=(color:string,alpha=0.08)=>mix(c.surface,color,alpha);
  const colors: Record<PaletteColor,string>={...palette,
    ink:c.background,surface:c.surface,raised:c.raised,toolSurface:c.surface,toolActive:c.raised,userSurface:c.surface,
    paper:c.text,strong:c.text,secondary:c.secondary,muted:c.secondary,
    electric:accent,electricBright:c.accentBright,inspect:accent,execute:warning,thinking:warning,signal,citron,
    rule:mix(c.surface,c.text,0.13),borderBright:mix(c.surface,c.text,0.3),
    thinkingSurface:wash(warning),errorSurface:wash(signal),accentSurface:wash(accent),menuSelection:wash(accent),
    tileSelection:mix(c.raised,accent,0.08),diffAddedSurface:wash(citron),diffRemovedSurface:wash(signal),
    syntaxKeyword:c.syntaxKeyword,syntaxString:c.syntaxString,syntaxNumber:c.syntaxNumber,syntaxComment:c.syntaxComment,syntaxType:c.syntaxType,syntaxFunction:c.syntaxFunction,
    contextMessages:accent,contextTools:c.syntaxKeyword,contextReserved:warning,contextFree:c.secondary,
    composerQueuedBorder:mix(c.surface,warning,0.45),composerStoppedBorder:mix(c.surface,signal,0.6),composerRestoredBorder:mix(c.surface,accent,0.4),
  };
  const backgrounds=[...surfaces,colors.thinkingSurface,colors.errorSurface,colors.accentSurface,colors.tileSelection,colors.diffAddedSurface,colors.diffRemovedSurface];
  for(const role of ["paper","strong","secondary","muted","electric","electricBright","signal","citron","thinking","inspect","execute",
    "syntaxKeyword","syntaxString","syntaxNumber","syntaxComment","syntaxType","syntaxFunction","contextMessages","contextTools","contextReserved","contextFree"] as PaletteColor[]) {
    colors[role]=readable(colors[role],backgrounds,input.appearance);
  }
  return {name,label:input.label,appearance:input.appearance,colors};
}

export function parseSavedTheme(value: unknown): Theme {
  if(!record(value) || typeof value.name!=="string" || !/^custom-[a-z0-9-]{1,80}$/.test(value.name)
    || typeof value.label!=="string" || !value.label.trim() || value.label.length>60 || /[\u0000-\u001f\u007f]/.test(value.label)
    || !["dark","light"].includes(String(value.appearance)) || !record(value.colors))throw new Error("Invalid saved theme");
  const colors={} as Theme["colors"];for(const key of Object.keys(palette) as PaletteColor[]){const color=value.colors[key];if(typeof color!=="string" || !hex.test(color))throw new Error("Invalid saved theme colors");colors[key]=color;}
  return {name:value.name,label:value.label,appearance:value.appearance as Theme["appearance"],colors};
}
