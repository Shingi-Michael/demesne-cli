// Exercise the actual desktop slot loader, including remount and stale replies.
import { chromium } from "playwright";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const source=readFileSync(new URL('../apps/desktop/workspace/live.ts',import.meta.url),'utf8');
const loader=source.slice(source.indexOf('const fileEditViews ='),source.indexOf('const repoSlot ='));
const build=await Bun.build({entrypoints:['apps/desktop/workspace/file-edit.ts'],target:'browser',format:'esm'});
assert(build.success);
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH});
try {
  const page=await browser.newPage({reducedMotion:'reduce'});
  await page.setContent('<main></main>');
  await page.addScriptTag({type:'module',content:await build.outputs[0]!.text()+'\nwindow.FileEditView = FileEditView;'});
  await page.evaluate(new Bun.Transpiler({loader:'ts'}).transformSync(`(() => {
    let state={session:{id:'a'}}, calls=0;
    const deferredChanges=tool=>tool.deferredChanges;
    const stepsSeenRunning=new Set(),windowOpenedAt=Date.now();
    const pending=[];
    const api=()=>{calls++;return new Promise((resolve,reject)=>pending.push({resolve,reject}));};
    const tool={id:1,type:'tool',name:'edit_file',toolCallId:'edit',phase:'change',state:'done',startedAt:0,input:{},changes:[{path:'file.ts',before:null,after:null,beforeExists:true,afterExists:true}],deferredChanges:{revision:1,added:1,removed:1}};
    const run={id:'turn',entries:[tool]};
    const original=JSON.stringify(run);
    ${loader}
    const mount=()=>{document.querySelector('main').innerHTML='<div data-file-edit="edit"></div>';placeFileEdits(document.querySelector('main'),run);};
    window.check={mount,calls:()=>calls,resolve:()=>pending.shift().resolve([{path:'file.ts',before:'before\\n',after:'after\\n',beforeExists:true,afterExists:true}]),reject:()=>pending.shift().reject(new Error('Unavailable')),switch:()=>{state={session:{id:state.session.id+'-next'}};fileEditViews.forEach(v=>v.dispose());fileEditViews.clear();fileEditRequests.clear();},unchanged:()=>JSON.stringify(run)===original};
  })()`));
  const call=async(name:string)=>page.evaluate(name=>(window as any).check[name](),name);
  await call('mount'); await call('mount');
  assert.equal(await call('calls'),1,'remount deduplicates in-flight detail requests');
  assert.equal(await page.locator('.file-edit').count(),0);
  await call('resolve'); await page.locator('.file-edit').waitFor();
  await page.locator('[data-mode="before"]').click();
  assert.equal((await page.locator('.fe-code').allTextContents()).join('\n'),'before');
  await page.locator('[data-mode="after"]').click();
  assert.equal((await page.locator('.fe-code').allTextContents()).join('\n'),'after');
  await call('mount'); assert.equal(await call('calls'),1);
  assert(await call('unchanged'),'hydration never mutates state-wire projections');
  await call('switch'); await call('mount'); await call('reject');
  await page.getByRole('button',{name:'Try again'}).click();
  assert.equal(await call('calls'),3);
  await call('switch'); await call('resolve');
  assert.equal(await page.locator('.file-edit').count(),0,'late response cannot mount in another chat');
  console.log('Lazy edits passed: on-demand fetch, remount deduplication, exact before/after, retry, immutable state and stale-session replies.');
} finally {await browser.close();}
