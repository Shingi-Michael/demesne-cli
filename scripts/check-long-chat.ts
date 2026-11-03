// Opening a long chat: many turns of real-looking answers, each step editing a
// large file (so the saved history runs to megabytes, like real chats).
// Usage: xvfb-run -a bun scripts/check-long-chat.ts [electron executable]
// TURNS=60 sets the length.
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fixture, eventually } from '../apps/desktop/workspace/test/fixture.ts';
import { ProviderTurnProcessor } from '../apps/daemon/src/provider-processor.ts';
const TURNS = Number(process.env.TURNS ?? 60);
const answer = (n: number) => `## Step ${n}\n\nHere is what changed in **turn ${n}**, with \`inline code\` and a [link](https://example.com).\n\n- first point about the change\n- second point, a little longer so it wraps across the line in a narrow window\n- third point\n\n\`\`\`ts\nexport function add${n}(a: number, b: number) {\n  // add two numbers\n  return a + b + ${n};\n}\nconst values = [1, 2, 3].map((v) => add${n}(v, v));\n\`\`\`\n\n| File | Lines | Status |\n| --- | ---: | --- |\n| a.ts | ${n} | done |\n| b.ts | ${n * 2} | done |\n\nDone. Reply ${n}.`;
const f = await fixture(new ProviderTurnProcessor({ id: 'test', async listModels() { return [{ id: 'check', provider: 'test', contextWindow: 262144 }]; },
  async *stream({ messages }) {
    const at = messages.findLastIndex(m => m.role === 'user');
    const done = messages.slice(at + 1).filter(m => m.role === 'tool').length;
    const n = messages.filter(m => m.role === 'user').length;
    if (done < 3) {
      const edit = n % 2 ? { path: 'big.txt', oldText: 'header\n', newText: 'header!\n' } : { path: 'big.txt', oldText: 'header!\n', newText: 'header\n' };
      const [name, args] = ([['read_file', { path: 'a.txt' }], ['edit_file', edit], ['run_command', { command: 'echo ok' }]] as const)[done]!;
      yield { type: 'tool_call_delta', index: 0, idDelta: 'step-' + messages.length, nameDelta: name, argumentsDelta: JSON.stringify(args) };
      yield { type: 'finish', reason: 'tool_calls' }; return;
    }
    yield { type: 'text_delta', delta: answer(n) }; yield { type: 'finish', reason: 'stop' };
  } }, 'check', {}, undefined, 262144));
let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
try {
  writeFileSync(join(f.workspace, 'a.txt'), 'hello\n');
  writeFileSync(join(f.workspace, 'big.txt'), 'header\n' + 'a line of a large source file\n'.repeat(7000));
  const long = (await f.client.createSession({ workspacePath: f.workspace })).session.id;
  const short = (await f.client.createSession({ workspacePath: f.workspace })).session.id;
  for (let i = 0; i < TURNS; i++) {
    await f.client.submitTurn(long, { content: `Please make change number ${i + 1} to the project`, permissionMode: 'allow' });
    await eventually(async () => (await f.client.getSessionState(long)).session.turns.at(-1)?.status === 'completed', 10000);
  }
  await f.client.submitTurn(short, { content: 'Small chat', permissionMode: 'allow' });
  await eventually(async () => (await f.client.getSessionState(short)).session.turns.at(-1)?.status === 'completed', 10000);
  const executable = process.argv[2];
  app = await electron.launch({ ...(executable ? { executablePath: resolve(executable) } : {}), args: [...(executable ? [] : [resolve('apps/desktop/build/app')]), `--user-data-dir=${join(f.root, 'electron')}`, `--workspace=${f.workspace}`, `--server=${f.server.url}`], env: { ...f.env, DEMESNE_BUN: process.execPath, DEMESNE_GLASS: '0', XDG_CONFIG_HOME: join(f.home, '.config'), XDG_CACHE_HOME: join(f.home, '.cache') }, timeout: 30000 });
  const page = await app.firstWindow();
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.locator('.bar-tab.on').waitFor({ timeout: 30000 });
  await page.evaluate(() => { (window as any).__long = []; new PerformanceObserver(list => (window as any).__long.push(...list.getEntries().map(e => Math.round(e.duration)))).observe({ type: 'longtask' }); });
  // From asking for the chat to its newest answer painted.
  const open = async (id: string, text: string) => {
    const start = performance.now();
    await page.evaluate(id => (window as any).demesneDesktop.core.invoke('desktop_request', { method: 'select-session', args: { id } }), id);
    await page.locator(`.bar-tab.on[data-tab="${id}"]`).waitFor({ timeout: 30000 });
    await page.locator('#conversation').getByText(text, { exact: true }).last().waitFor({ timeout: 30000 });
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => setTimeout(r, 0))));
    return Math.round(performance.now() - start);
  };
  const times: number[] = [];
  for (let i = 0; i < 4; i++) {
    await open(short, 'Small chat');
    times.push(await open(long, `Done. Reply ${TURNS}.`));
  }
  console.log(`Long chat (${TURNS} turns) opened in ${times.join(', ')} ms (first open, then reopens).`);
  // The rest of the chat mounts above while idle, without moving the view.
  await page.waitForFunction(n => document.querySelectorAll('#conversation .turn').length >= n, TURNS, { timeout: 30000 });
  const fromBottom = await page.evaluate(() => { const s = document.getElementById('stage')!; return s.scrollHeight - s.clientHeight - s.scrollTop; });
  assert(fromBottom < 2, `the chat stays at its newest turn while older turns mount (${fromBottom}px up)`);
  // The first turn is reachable once everything mounted.
  assert.equal(await page.locator('#conversation').getByText('Done. Reply 1.', { exact: true }).count(), 1);
  // Adding to a long chat restyles only what changed.
  const insert = await page.evaluate(() => {
    const c = document.getElementById('conversation')!; document.body.offsetHeight;
    const t = performance.now(); const d = document.createElement('div'); d.textContent = 'x'; c.append(d); document.body.offsetHeight;
    const ms = performance.now() - t; d.remove(); return Math.round(ms);
  });
  const longTasks = await page.evaluate(() => (window as any).__long as number[]);
  console.log(`Adding a line to the long chat: ${insert} ms. Long tasks: ${JSON.stringify(longTasks)}.`);
  assert(insert < 40, `adding a line to a long chat took ${insert}ms`);
  assert.deepEqual(errors, []);
  console.log('Long chat check passed.');
} finally {
  await app?.close().catch(() => {});
  await f.close();
}
