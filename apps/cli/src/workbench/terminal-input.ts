import { parseMouseSequence, type MouseEvent } from "../mouse.ts";

export const PASTE_ENABLE = "\x1b[?2004h";
export const PASTE_DISABLE = "\x1b[?2004l";
export const FOCUS_ENABLE = "\x1b[?1004h";
export const FOCUS_DISABLE = "\x1b[?1004l";
const START = "\x1b[200~";
const END = "\x1b[201~";
export type TerminalInput = { kind: "text"; text: string } | { kind: "paste"; text: string }
  | { kind: "mouse"; event: MouseEvent } | { kind: "escape"; sequence: string } | { kind: "focus"; focused: boolean }
  | { kind: "graphics-reply"; header: string; message: string }
  | { kind: "cell-size"; width: number; height: number };

/// Preserve input order across arbitrary transport chunks. Paste content never
/// goes through readline, so pasted newlines cannot submit a draft.
export class TerminalInputDecoder {
  private carry = "";
  private paste: string | null = null;
  private apc: string | null = null;
  get waitingForEscape(): boolean { return this.paste === null && this.apc === null && /^\x1b(?:\[)?$/.test(this.carry); }
  reset(): void { this.carry = ""; this.paste = null; this.apc = null; }
  flushEscape(): TerminalInput[] {
    const text = this.carry;
    this.carry = "";
    return text === "\x1b" ? [{ kind: "escape", sequence: text }] : text ? [{ kind: "text", text }] : [];
  }
  push(text: string): TerminalInput[] {
    this.carry += text;
    const events: TerminalInput[] = [];
    while (this.carry) {
      if (this.apc !== null) {
        const end = this.carry.indexOf("\x1b\\");
        if (end >= 0) {
          const reply = this.apc + this.carry.slice(0, end);
          const match = /^G([^;]*);([\s\S]*)$/.exec(reply);
          if (match) events.push({ kind: "graphics-reply", header: match[1]!, message: match[2]! });
          this.apc = null; this.carry = this.carry.slice(end + 2); continue;
        }
        const keep = this.carry.endsWith("\x1b") ? 1 : 0;
        this.apc = (this.apc + this.carry.slice(0, this.carry.length - keep)).slice(0, 4096);
        this.carry = keep ? "\x1b" : "";
        break;
      }
      if (this.paste !== null) {
        const end = this.carry.indexOf(END);
        if (end >= 0) {
          events.push({ kind: "paste", text: this.paste + this.carry.slice(0, end) });
          this.paste = null; this.carry = this.carry.slice(end + END.length); continue;
        }
        let keep = 0;
        for (let size = 1; size < END.length; size++) if (this.carry.endsWith(END.slice(0, size))) keep = size;
        this.paste += this.carry.slice(0, this.carry.length - keep);
        this.carry = this.carry.slice(this.carry.length - keep);
        break;
      }
      const escape = this.carry.indexOf("\x1b");
      if (escape < 0) { events.push({ kind: "text", text: this.carry }); this.carry = ""; break; }
      if (escape > 0) { events.push({ kind: "text", text: this.carry.slice(0, escape) }); this.carry = this.carry.slice(escape); continue; }
      if (this.carry.startsWith(START)) { this.paste = ""; this.carry = this.carry.slice(START.length); continue; }
      if (START.startsWith(this.carry)) break;
      if (this.carry.startsWith("\x1b_")) { this.apc = ""; this.carry = this.carry.slice(2); continue; }
      const geometry = /^\x1b\[6;(\d+);(\d+)t/.exec(this.carry);
      if (geometry) {
        events.push({ kind: "cell-size", height: Number(geometry[1]), width: Number(geometry[2]) });
        this.carry = this.carry.slice(geometry[0].length); continue;
      }
      if (/^\x1b\[6(?:;\d*){0,2}$/.test(this.carry)) break;
      if (/^\x1b\[[IO]/.test(this.carry)) {
        events.push({ kind: "focus", focused: this.carry[2] === "I" });
        this.carry = this.carry.slice(3); continue;
      }
      const mouse = /^\x1b\[<\d+;\d+;\d+[Mm]/.exec(this.carry);
      if (mouse) {
        const event = parseMouseSequence(mouse[0]);
        if (event) events.push({ kind: "mouse", event });
        this.carry = this.carry.slice(mouse[0].length); continue;
      }
      if (/^\x1b\[<[\d;]*$/.test(this.carry) && this.carry.length < 64) break;
      const doubled = /^\x1b{2,}/.exec(this.carry);
      if (doubled) { events.push({ kind: "escape", sequence: doubled[0] }); this.carry = this.carry.slice(doubled[0].length); continue; }
      // Other key sequences remain intact for readline, including split CSI.
      const next = this.carry.indexOf("\x1b", 1);
      const end = next < 0 ? this.carry.length : next;
      events.push({ kind: "text", text: this.carry.slice(0, end) });
      this.carry = this.carry.slice(end);
    }
    return events;
  }
}
