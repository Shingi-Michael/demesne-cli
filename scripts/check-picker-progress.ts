// DOM regression check for picker hover and running-tool updates, without a live daemon.
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { defaultThinkingLevel, resolveReasoningLevel } from "../packages/protocol/src/index.ts";
const source = readFileSync(new URL("../apps/desktop/workspace/live.ts", import.meta.url), "utf8");
const slice = (from: string, to: string) => source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)));
const transpile = (code: string) => new Bun.Transpiler({ loader: "ts" }).transformSync(code);
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.setContent('<div id="overlay"></div><div id="content"><p id="answer">Keep this answer mounted.</p></div>');
  const result = await page.evaluate(transpile(`(() => {
    const el = id => document.getElementById(id);
    const h = text => String(text ?? "").replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
    const btn = (action, html, args, cls) => '<button data-action="'+action+'" data-args="'+h(JSON.stringify(args))+'" class="'+cls+'">'+html+'</button>';
    let state = { model: { id: "a" }, session: {id:"chat-a"}, revision:1 }, overlaySignature = "";
    const overlay = "models", modelsLoading = false, modelsMore = false, overlayQuery = "";
    let overlayIndex = 0, thinkingDrag = null;
    const modelLevels = new Map(), models = ["a", "b"].map(id => ({id, provider:"test", reasoningLevels:["low","medium","high"]}));
    const defaultThinkingLevel = ${defaultThinkingLevel.toString()}, resolveReasoningLevel = ${resolveReasoningLevel.toString()};
    ${slice("function modelLevel(", "\n}")}\n}
    const levelWord = s => s, k = s => s;
    const overlayRows = models.map(m => ({action:"model", data:{id:m.id}, kind:"short", label:m.id}));
    const modelCardOpen = false, modelCardTimer = null, pointModelCard = () => {}, hideModelCard = () => {};
    const renderOverlay = () => { throw new Error("Hover rebuilt the picker"); };
    ${slice("function renderModelPopover(", "/// Pass 82 A:")}
    ${slice('// Pointing at a model in the picker', 'document.addEventListener("submit"')}
    renderModelPopover(0);
    const mediumDefault = el("overlay").querySelector('.mp-thinking').getAttribute('aria-valuetext') === "medium";
    const input = el("overlay").querySelector("input"), row = el("overlay").querySelector('[data-index="1"]');
    let clicks = 0; row.addEventListener("click", () => clicks++);
    input.focus(); input.setSelectionRange(0,0);
    for (let i=0;i<50;i++) {
      const target = el("overlay").querySelector('[data-index="'+(i%2)+'"]');
      target.dispatchEvent(new MouseEvent("mouseover", {bubbles:true}));
    }
    row.click();
    const picker = input === el("overlay").querySelector("input") && row.isConnected && clicks === 1 && document.activeElement === input;
    modelLevels.set("b", "high"); updateModelHighlight();
    const effort = overlayRows[1].data.reasoning === "high" && el("overlay").querySelector('.mp-thinking').getAttribute('aria-valuetext') === "high";
    ${slice("function renderState(next:", "\n  }")}\n  } state = next; }
    modelLevels.set("a", "high"); thinkingDrag = {};
    renderState({ model:{id:"a"}, session:{id:"chat-b"}, reasoning:"low", revision:2 });
    overlayIndex = 0; updateModelHighlight();
    const restoredEffort = modelLevels.size === 0 && thinkingDrag === null && overlayRows[0].data.reasoning === "low"
      && el("overlay").querySelector('.mp-thinking').getAttribute('aria-valuetext') === "low";
    const stepOpen = new Set(), splitNextPrompt = raw => ({text:raw});
    const toolRow = (run, tool) => btn("step", '<span class="verb">Running</span><span class="target">'+tool.detail+'</span><span class="meta">'+tool.trace.length+'</span>', {runId:run.id,id:tool.id}, "tool-row");
    ${slice("function patchStream(", "function revealCompactedTurn(")}
    const tool = {type:"tool",id:1,name:"subagent",phase:"read",state:"running",detail:"Working",trace:[]};
    const run = {id:"r",status:"running",content:"ask",entries:[tool]};
    const content = el("content"); content.insertAdjacentHTML("beforeend",toolRow(run,tool));
    const paragraph = el("answer"), toolButton = content.querySelector("button");
    const saved = {run,content,views:new Map()};
    let patched = true;
    for(let i=0;i<50;i++) {
      const next = {...run,entries:[{...tool,detail:"Progress "+i,trace:Array(i).fill("step")}]};
      patched = patchStream(saved,next) && patched; saved.run=next;
    }
    stepOpen.add("r:1");
    const structural = !runningRowOnly(tool,tool,"r");
    const stableText = paragraph === el("answer") && toolButton === content.querySelector("button");
    const progress = content.querySelector(".target").textContent;
    let disconnects = 0;
    customElements.define("answer-probe", class extends HTMLElement { disconnectedCallback() { disconnects++; } connectedMoveCallback() {} });
    paragraph.append(document.createElement("answer-probe"));
    const template = document.createElement("template");
    template.innerHTML = '<section><div data-entry="1"></div><p>Tool finished</p></section>';
    replaceTurnShell(content, template.content, [[template.content.querySelector('[data-entry]'), paragraph]]);
    return {picker,effort,mediumDefault,restoredEffort,patched,structural,stableText,progress,disconnects,retained:el("answer") === paragraph};
  })()`));
  assert.deepEqual(result, {picker:true,effort:true,mediumDefault:true,restoredEffort:true,patched:true,structural:true,stableText:true,progress:"Progress 49",disconnects:0,retained:true});
  console.log("Picker hover, effort payload, and tool-progress DOM checks passed.");
} finally { await browser.close(); }
