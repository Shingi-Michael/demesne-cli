import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";

const source = readFileSync(new URL("../live.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
function section(start: string, end: string) {
  const from = source.indexOf(start), to = source.indexOf(end, from);
  if (from < 0 || to <= from) throw new Error(`Missing renderer section: ${start}`);
  return source.slice(from, to);
}
// Exercise the real composer and thread-pane entry points. Only host data and
// unrelated turn/control renderers are stand-ins; no native actions are run.
const fixtureScript = new Bun.Transpiler({ loader: "ts" }).transformSync(`
const {ChatDOM, ComposerHeight, isWindowsDesktopChat, threadConversationKey} = window.RedrawUI;
const windowsDesktopChat = isWindowsDesktopChat(window.boot.mode, window.boot.platform);
const composerDOM = new ChatDOM(windowsDesktopChat), composerHeight = windowsDesktopChat ? new ComposerHeight() : null;
const el = id => document.getElementById(id), editor = document.querySelector('textarea');
${section("const h = (value:", "const shortcut =")}
${section("const btn = (", "const duration =")}
const k = text => '<kbd>' + h(text) + '</kbd>';
let state = {
  activeTurnId:null, queue:'', restored:false, connection:'online', busy:false,
  approvals:[], questions:[], files:[{path:'src/alpha.ts'},{path:'src/beta.ts'}],
  session:{id:'main',workspace:'C:/project',autoApprove:false,acceptEdits:false},
  workspace:'C:/project', planOnly:false, runs:[{id:'main-turn'}], model:{id:'model',contextWindow:1000},
  attachments:[{id:'image',filename:'shot.png',width:40,height:30}],
  threads:{busy:null,list:[{id:'fix',status:'running'}],chat:{id:'thread',provider:'provider',model:'model',draft:'',draftVersion:0,activeTurnId:null,approvals:[],questions:[],runs:[{id:'thread-turn',content:'Request',entries:[{id:1,type:'assistant',raw:'Answer'}]}]}}
};
const inSession = () => state.runs.length > 0, inAssistant = () => false, isPlain = () => !state.session?.workspace;
const projectLabel = path => path.replace(/\\\\/g, '/').split('/').at(-1);
let question = null, suggestion = null, whereOpen = null, stopArmed = 0, answeringQuestion = false;
const pendingQuestion = () => question, questionIndex = () => 0, nextSuggestion = () => suggestion;
const diffNotes = new Map(), pointed = [], pastes = [], attachmentPreviews = new Map([['image','data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30"/>')]]);
const PASTE_ICON = '', pasteLabel = text => text.slice(0,20), pointLabel = point => point.label;
let composerSignature = '', composerFiles = null, composerWidth = 0, pendingMode = null;
${section('type Mode =', 'let pendingMode:')}
const whereRow = () => '<button type="button">Current project</button>';
${section('function renderWhere()', 'function toggleWhere(')}
${section('function renderComposer()', '/// An approval is')}
let threadPaneFor = '', threadPaneSignature = '', threadTurnsSignature = '', threadWorking = null, threadContextOpen = false, threadDeleteArmed = null;
const stepsOpen = new Set(), stepOpen = new Set(), detailsOpen = new Set(), expanded = new Set(), models = [];
class WorkingLine { element = document.createElement('div'); update() {} }
const spinner = () => '', workingLine = () => {}, renderThreadContext = () => {};
const threadMergeHTML = view => '<button>' + (view.busy ? 'Merging' : 'Merge') + '</button>';
const threadModelWords = () => state.threads.chat?.model || 'Choose a model';
const splitNextPrompt = raw => ({text:raw}), markdown = raw => '<p>' + h(raw) + '</p>';
const runHTML = run => '<div class="request">' + h(run.content) + '</div><div class="response"><div class="markdown" data-answer="' + h(run.id) + '" data-entry="1"></div></div>';
${section('function asThread<T>', '/// The thread\'s model chip:')}
${section('function renderThreadPane(', '/// The thread\'s context, like')}
const drawThread = () => renderThreadPane(state.threads.list[0]);
editor.addEventListener('input', () => renderComposer());
window.fixture = {
  render() { composerSignature = ''; renderComposer(); },
  draft(text) { editor.value = text; renderComposer(); },
  patch(patch) { Object.assign(state,patch); composerSignature = ''; renderComposer(); },
  question(value) { question = value; state.questions = value ? [value] : []; composerSignature = ''; renderComposer(); },
  preview(url) { attachmentPreviews.set('image',url); composerSignature = ''; renderComposer(); },
  thread(patch, busy = null) { Object.assign(state.threads.chat,patch); state.threads.busy = busy; drawThread(); },
  fold() { stepOpen.add('thread-turn:tool'); drawThread(); },
  nodes: () => ({image:el('attach-row').querySelector('img'),attachment:el('attach-row').firstChild,mention:el('mention-chips').firstChild,where:el('composer-where').firstChild,mode:el('composer-mode').firstChild,queue:el('queue-label').firstChild,send:el('send-label').firstChild}),
  gate: windowsDesktopChat
};
renderComposer(); drawThread();
`);

// Opt-in real DOM/layout checks, using existing browsers only. These do not
// launch the user's app or establish a Windows compositor/flicker diagnosis.
describe.skipIf(process.env.DEMESNE_DOM_TESTS !== "1")("Windows desktop chat redraw DOM", () => {
  let browser: Browser, page: Page, bundle: string, errors: string[];
  const styles = ["../ui.css", "../live.css", "../../workspace.css"].map(path => readFileSync(new URL(path, import.meta.url), "utf8")).join("\n");
  beforeAll(async () => {
    const build = await Bun.build({ entrypoints: [fileURLToPath(new URL("../windows-chat-redraw.ts", import.meta.url))], target: "browser", format: "esm" });
    if (!build.success) throw new Error(build.logs.map(String).join("\n"));
    bundle = await build.outputs[0]!.text();
    browser = await chromium.launch({ headless: true, channel: process.env.DEMESNE_BROWSER_CHANNEL || undefined });
  }, 20_000);
  const mount = async (mode: string | undefined, platform: string) => {
    await page.setContent(`<!doctype html><body class="desktop"><div class="harness" style="width:540px"><div id="app" class="live-app"><div id="stage" style="height:100px;overflow:auto"><div style="height:1000px">Conversation</div></div><form id="composer" class="composer"><div class="composer-box"><div id="queue-label"></div><div id="attach-row"></div><div id="mention-chips"></div><textarea id="message" rows="1" aria-label="Message"></textarea><button type="button" class="send"><kbd>Enter</kbd><span id="send-label"></span><span id="tokens"></span></button></div><div class="composer-bar"><button type="button" id="composer-mode"></button><button type="button" id="composer-where"></button><span class="hints"><span id="hint-mention">@</span></span></div><div id="where-row"></div></form></div><div id="thread-pane" style="display:block;position:static;width:420px;height:260px"></div></div></body>`);
    await page.addStyleTag({ content: styles + '\n#thread-pane .tp-conv{height:150px;overflow:auto}' });
    await page.evaluate(async ({ source, mode, platform }) => {
      (window as any).boot = { mode, platform: { platform } };
      const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
      try { (window as any).RedrawUI = await import(url); }
      finally { URL.revokeObjectURL(url); }
    }, { source: bundle, mode, platform });
    await page.addScriptTag({ content: fixtureScript });
  };
  beforeEach(async () => {
    page = await browser.newPage(); errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await mount("desktop", "Win32");
  });
  afterEach(async () => { await page?.close(); expect(errors).toEqual([]); });
  afterAll(async () => { await browser?.close(); });

  test("ordinary typing retains thumbnails, chips and labels without no-op composer mutations", async () => {
    const result = await page.evaluate(() => {
      const f = (window as any).fixture;
      f.draft("@src/alpha.ts x");
      const before = f.nodes(), form = document.getElementById("composer")!, editor = document.querySelector("textarea")!;
      const observer = new MutationObserver(() => {}); observer.observe(form, { subtree:true,childList:true,attributes:true,characterData:true });
      editor.value += "y"; editor.setSelectionRange(3,7,"backward"); editor.dispatchEvent(new Event("input", {bubbles:true}));
      const after = f.nodes(), records = observer.takeRecords();
      const retained = Object.keys(before).every(key => before[key] === after[key]);
      f.render();
      return { retained, unrelatedMutations: records.filter(record => !(record.target as Element).closest?.('#tokens')).length, noops: observer.takeRecords().length, selection: [editor.selectionStart,editor.selectionEnd,editor.selectionDirection] };
    });
    expect(result).toEqual({ retained:true, unrelatedMutations:0, noops:0, selection:[3,7,"backward"] });
  });

  test("height matches the existing baseline/cap across wrap, shrink, min-height and width changes", async () => {
    const cases = [
      { text:"", width:540, home:false }, { text:"a short line", width:540, home:false },
      { text:"wrapped words ".repeat(18), width:280, home:false },
      { text:Array.from({length:20},(_,i) => `line ${i}`).join("\n"), width:540, home:false },
      { text:"short again", width:540, home:false }, { text:"", width:540, home:true },
    ];
    for (const item of cases) {
      const result = await page.evaluate(({ text, width, home }) => {
        const f = (window as any).fixture, app = document.getElementById("app")!;
        (document.querySelector('.harness') as HTMLElement).style.width = `${width}px`;
        app.classList.toggle("start",home); f.patch({runs:home ? [] : [{id:'main-turn'}]}); f.draft(text); f.render();
        const editor = document.querySelector("textarea")!, expected = editor.cloneNode() as HTMLTextAreaElement;
        expected.value = text; expected.removeAttribute("id");
        expected.style.cssText += `;position:fixed;visibility:hidden;width:${getComputedStyle(editor).width};height:20px`;
        editor.parentElement!.append(expected);
        const height = `${Math.min(132,Math.max(20,expected.scrollHeight))}px`; expected.remove();
        return {actual:editor.style.height,expected:height};
      }, item);
      expect(result.actual).toBe(result.expected);
    }
  });

  test("a capped focused editor keeps selection and textarea/page scroll with no height reset", async () => {
    const result = await page.evaluate(() => {
      const f = (window as any).fixture, editor = document.querySelector("textarea")!, stage = document.getElementById("stage")!;
      f.draft("line\n".repeat(30)); editor.focus({preventScroll:true});
      editor.value += "x"; editor.setSelectionRange(3,8,"backward"); editor.scrollTop = 88; stage.scrollTop = 180;
      const before = [editor.style.height,editor.scrollTop,stage.scrollTop,editor.selectionStart,editor.selectionEnd,editor.selectionDirection];
      const observer = new MutationObserver(() => {}); observer.observe(editor,{attributes:true,attributeFilter:['style']});
      f.render();
      return {before,after:[editor.style.height,editor.scrollTop,stage.scrollTop,editor.selectionStart,editor.selectionEnd,editor.selectionDirection],heights:observer.takeRecords().length};
    });
    expect(result.before[0]).toBe("132px");
    expect(result.after).toEqual(result.before);
    expect(result.heights).toBe(0);
  });

  test("changed attachments, mentions, mode, stop and question controls still update", async () => {
    await page.evaluate(() => (window as any).fixture.draft("@src/alpha.ts ready"));
    expect(await page.locator('[data-action="remove-mention"]').textContent()).toContain("src/alpha.ts");
    await page.evaluate(() => (window as any).fixture.draft("ready"));
    expect(await page.locator('[data-action="remove-mention"]').count()).toBe(0);
    await page.evaluate(() => (window as any).fixture.preview('data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="20"/>')));
    expect(await page.locator('#attach-row img').evaluate(node => decodeURIComponent(node.getAttribute('src') ?? ''))).toContain('width="20"');
    await page.evaluate(() => (window as any).fixture.patch({planOnly:true,activeTurnId:'turn'}));
    expect(await page.locator('#composer-mode').getAttribute('aria-label')).toBe('Mode: Plan');
    expect(await page.locator('#composer .send').getAttribute('aria-label')).toBe('Stop');
    await page.evaluate(() => (window as any).fixture.question({id:'q',questions:[{question:'Where?'}],answers:[],status:'waiting'}));
    expect(await page.locator('#composer .send').getAttribute('aria-label')).toBe('Send');
    expect(await page.locator('#attach-row').isHidden()).toBe(true);
    expect(await page.locator('#send-label').textContent()).toBe('answer');
    await page.evaluate(() => (window as any).fixture.question(null));
    expect(await page.locator('#attach-row').isHidden()).toBe(false);
  });

  test("unrelated thread drafts and footer state preserve turn identity and scroll; actual answer changes redraw", async () => {
    const result = await page.evaluate(() => {
      const f = (window as any).fixture, turns = document.querySelector('.tp-turns')!, article = turns.querySelector('article'), answer = turns.querySelector('p');
      const conv = document.querySelector('.tp-conv')! as HTMLElement;
      const spacer = document.createElement('div'); spacer.style.cssText = 'height:1000px;flex:none'; conv.append(spacer); conv.scrollTop = 100;
      const observer = new MutationObserver(() => {}); observer.observe(turns,{subtree:true,childList:true,characterData:true,attributes:true});
      f.thread({draft:'typing',draftVersion:1}); f.thread({draft:'typing more',draftVersion:2},'merge');
      const same = article === turns.querySelector('article') && answer === turns.querySelector('p'), records = observer.takeRecords().length, top = conv.scrollTop;
      f.thread({runs:[{id:'thread-turn',content:'Request',entries:[{id:1,type:'assistant',raw:'Answer grows'}]}]});
      return {same,records,top,updated:turns.textContent?.includes('Answer grows'),replaced:article !== turns.querySelector('article')};
    });
    expect(result).toEqual({same:true,records:0,top:100,updated:true,replaced:true});
  });

  test("macOS, Linux and Windows browser-only renderers retain the legacy composer/thread path", async () => {
    for (const boot of [{mode:'desktop',platform:'MacIntel'},{mode:'desktop',platform:'Linux x86_64'},{mode:undefined,platform:'Win32'}]) {
      // A fresh document avoids top-level lexical declarations from the fixture.
      await page.goto('about:blank'); await mount(boot.mode,boot.platform);
      const result = await page.evaluate(() => {
        const f = (window as any).fixture, image = f.nodes().image, turn = document.querySelector('.tp-turns article');
        f.draft('new draft'); f.thread({draft:'thread draft',draftVersion:1});
        return {gate:f.gate,imageReplaced:image !== f.nodes().image,turnReplaced:turn !== document.querySelector('.tp-turns article')};
      });
      expect(result).toEqual({gate:false,imageReplaced:true,turnReplaced:true});
    }
  });
});
