// Real desktop markup, styles and tab renderer, exercised without a live daemon.
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { OpenTabs } from "../apps/desktop/workspace/tabs.ts";
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const live = read("apps/desktop/workspace/live.ts");
const html = read("apps/desktop/index.html").replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "").replace(/<link\b[^>]*>/g, "").replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/g, "");
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, reducedMotion: "reduce" });
  await page.route("**/*", route => route.abort());
  await page.setContent(html);
  for (const path of ["apps/desktop/workspace/ui.css", "apps/desktop/workspace/live.css", "apps/desktop/desktop.css", "apps/desktop/workspace.css"])
    await page.addStyleTag({ content: read(path) });
  await page.evaluate(new Bun.Transpiler({ loader: "ts" }).transformSync(`(() => {
    document.documentElement.dataset.theme = "demesne";
    document.documentElement.classList.add("mac-chrome");
    for (const id of ["app", "desktop-sidebar", "desktop-toolbar", "conversation"]) document.getElementById(id).hidden = false;
    document.getElementById("desktop-home").hidden = true;
    const OpenTabs = ${OpenTabs.toString()};
    const h = value => String(value ?? "").replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const btn = (action, label, args, cls) => '<button type="button" data-action="'+action+'" data-args="'+h(JSON.stringify(args))+'" class="'+cls+'">'+label+'</button>';
    const sessions = Array.from({length:8}, (_,i) => ({id:'chat-'+i,title:['Model effort','Browser connector with a very long title','Release notes'][i] ?? 'Chat '+i,updatedAt:'2026-11-02T00:00:00Z',workspace:'/project',tone:i===1?'warn':i===2?'working':''}));
    let state = {session:sessions[0],sessions,workspace:'/project',breakage:{fix:null,inbox:[]}}, pageOpen = '';
    const deletedSessions = new Set(), inSession = () => true, inAssistant = () => false;
    const chatTone = chat => chat.tone, STATE_WORDS = {warn:'needs you',working:'working'}, fullTime = s => s, shortcut = s => s;
    let peek = null; const drivePeek = () => peek;
    const dispatch = async (action,args) => { if (action === 'select-session') {state.session = sessions.find(s => s.id === args.id); pageOpen='';} renderTabs(); };
    const openPage = page => {pageOpen = page; renderTabs();};
    ${live.slice(live.indexOf('const tabs = new OpenTabs('), live.indexOf('function totals('))}
    for (const session of sessions) tabs.open(session.id);
    renderTabs();
    document.getElementById('workspace-tabs').addEventListener('click',event=>{
      const button=event.target.closest('button[data-action]');if(!button)return;
      const args=JSON.parse(button.dataset.args); if(button.dataset.action==='tab-close') closeTab(args.id); else dispatch(button.dataset.action,args);
    });
    window.tabCheck = { select: id => dispatch('select-session',{id}), reopen: reopenTab, page: openPage,
      move: (id,to) => {tabs.move(id,to); renderTabs();},
      busy: () => {sessions[7].waiting=true;peek={sessionId:'drive',kind:'work',words:'Drive · Verify changes'};renderTabs();} };
  })()`));
  const measure = () => page.locator('.bar-tab').evaluateAll(nodes => nodes.map(node => ({ x: node.getBoundingClientRect().x, width: node.getBoundingClientRect().width })));
  const before = await measure();
  assert(before.every(tab => tab.width === 180), 'every tab reserves 180px, even when crowded');
  await page.locator('[data-tab="chat-1"] [role="tab"]').click();
  assert.deepEqual(await measure(), before, 'switching tabs does not change their widths or positions');
  assert.equal(await page.locator('.bar-tab.on [role="tab"]').getAttribute('aria-selected'), 'true');
  const seam = await page.evaluate(() => {
    const tab = document.querySelector('.bar-tab.on')!, panel = document.getElementById('app')!;
    const style = getComputedStyle(tab);
    return {bottom:tab.getBoundingClientRect().bottom, top:panel.getBoundingClientRect().top, bottomRadius:style.borderBottomLeftRadius, bottomBorder:style.borderBottomWidth, tabColor:style.backgroundColor, panelColor:getComputedStyle(panel).backgroundColor, underline:getComputedStyle(tab,'::after').content};
  });
  assert.equal(seam.bottom, seam.top, 'active tab meets the conversation with no gap');
  assert.equal(seam.bottomRadius, '0px'); assert.equal(seam.bottomBorder, '0px');
  assert.equal(seam.tabColor, seam.panelColor); assert.equal(seam.underline, 'none');
  const inactive = page.locator('[data-tab="chat-0"]');
  await page.mouse.move(1190, 700);
  assert.equal(await inactive.locator('.bar-tab-close').evaluate(node => getComputedStyle(node).opacity), '0');
  await inactive.locator('[role="tab"]').focus();
  assert.equal(await inactive.locator('.bar-tab-close').evaluate(node => getComputedStyle(node).opacity), '1', 'keyboard focus reveals close');
  assert.equal(await inactive.locator('.sidebar-session-mark').evaluate(node => getComputedStyle(node).display), 'none', 'idle dots stay quiet');
  assert.notEqual(await page.locator('[data-tab="chat-2"] .working').evaluate(node => getComputedStyle(node).display), 'none', 'working state remains visible');
  await page.locator('[data-tab="chat-1"] .bar-tab-close').click();
  assert.equal(await page.locator('[data-tab="chat-1"]').count(), 0);
  await page.evaluate(() => (window as any).tabCheck.reopen());
  assert.equal(await page.locator('[data-tab="chat-1"]').count(), 1);
  await page.evaluate(() => (window as any).tabCheck.move('chat-2', 0));
  assert.equal(await page.locator('.bar-tab[data-tab]').first().getAttribute('data-tab'), 'chat-2');
  await page.evaluate(() => (window as any).tabCheck.page('settings'));
  assert.equal(await page.locator('.bar-tab.on.here .bar-tab-name').innerText(), 'Settings');
  await page.locator('.bar-tab.on.here .bar-tab-close').click();
  assert.equal(await page.locator('.bar-tab.on').getAttribute('data-tab'), 'chat-1');
  for (const theme of ['demesne', 'demesne-light']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    for (const width of [1200, 720, 390]) {
      await page.setViewportSize({ width, height: 800 });
      await page.evaluate(() => { document.getElementById('desktop-sidebar')!.hidden = true; (window as any).tabCheck.busy(); });
      const fit = await page.evaluate(() => {
        const rail = document.getElementById('workspace-tabs')!, add = document.getElementById('workspace-new-tab')!;
        const box = add.getBoundingClientRect();
        return { pageFits: document.documentElement.scrollWidth <= innerWidth, railOverflows: rail.scrollWidth > rail.clientWidth, addVisible: box.x >= 0 && box.right <= innerWidth, addOutsideRail: !rail.contains(add), tabWidth: document.querySelector('.bar-tab')!.getBoundingClientRect().width };
      });
      assert.deepEqual(fit, {pageFits:true,railOverflows:true,addVisible:true,addOutsideRail:true,tabWidth:width<=720?152:180}, theme+' '+width);
    }
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await page.locator('.bar-tab').first().evaluate(node => getComputedStyle(node).transitionDuration), '0s');
  console.log('Joined tabs: stable geometry, panel seam, focus, status, close/reopen, reorder, page tabs and narrow light/dark layouts passed.');
} finally { await browser.close(); }
