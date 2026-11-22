// Selected and background work, in the built desktop with an isolated profile.
// bun scripts/prepare-desktop.ts && bun scripts/check-quieter-chat.ts
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { _electron as electron, expect } from 'playwright/test';
import { fixture, eventually } from '../apps/desktop/workspace/test/fixture.ts';
import { ProviderTurnProcessor } from '../apps/daemon/src/provider-processor.ts';

const gate = Promise.withResolvers<void>();
const f = await fixture(new ProviderTurnProcessor({ id: 'test',
  async listModels() { return [{ id: 'check', provider: 'test', contextWindow: 262144 }]; },
  async *stream({ messages }) {
    if (JSON.stringify(messages.findLast(m => m.role === 'user')?.content).includes('Inspect the activity row')) await gate.promise;
    yield { type: 'text_delta', delta: 'The activity border is optional. The conversation shows when a reply is in progress.' };
    yield { type: 'finish', reason: 'stop' };
  },
}, 'check', {}, undefined, 262144));
let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
try {
  const ids: string[] = [];
  for (const title of ['Casual greeting', 'Demesne inference indicators']) {
    const id = (await f.client.createSession({ workspacePath: f.workspace })).session.id;
    await f.client.submitTurn(id, { content: title });
    await eventually(async () => (await f.client.getSessionState(id)).session.turns.at(-1)?.status === 'completed');
    ids.push(id);
  }
  const [other, active] = ids as [string, string];
  app = await electron.launch({ args: [resolve('apps/desktop/build/app'), `--user-data-dir=${join(f.root, 'electron')}`, `--workspace=${f.workspace}`, `--server=${f.server.url}`], env: { ...f.env, DEMESNE_BUN: process.execPath, XDG_CONFIG_HOME: join(f.home, '.config'), XDG_CACHE_HOME: join(f.home, '.cache') } });
  const page = await app.firstWindow();
  const open = async (id: string) => {
    await page.evaluate(id => (window as any).demesneDesktop.core.invoke('desktop_request', { method: 'select-session', args: { id } }), id);
    await expect(page.locator(`.bar-tab.on[data-tab="${id}"]`)).toBeVisible();
  };
  await page.locator('#sidebar-sessions[data-workspace]').waitFor();
  await open(other); await open(active);
  const row = page.locator(`#sidebar-sessions .sidebar-session[data-args*="${active}"]`);
  if (!await row.isVisible()) await page.locator('#sidebar-sessions [data-action="project-toggle"]').first().click();
  await page.locator('textarea#input, #composer textarea').first().fill('Inspect the activity row');
  await page.locator('#composer textarea').press('Enter');
  const working = page.locator('#conversation .working-line').last();
  await expect(working).toBeVisible();
  const checkSelected = async () => {
    await expect(row).toHaveAttribute('aria-current', 'page');
    await expect(row).toHaveAttribute('aria-label', /working/);
    await expect(row.locator('.sidebar-session-mark, .sidebar-say-state')).toHaveCount(0);
    await expect(page.locator('.bar-tab.on .sidebar-session-mark.working')).toHaveCount(0);
    await expect(page.locator('#app')).toHaveClass(/rim-work/);
  };
  await checkSelected();
  const box = async (selector: string) => (await page.locator(selector).last().boundingBox())!;
  const [svg, logo, words, text] = await Promise.all(['.wl-mark svg', '.answer-mark', '.wl-line', '.answer .markdown'].map(box));
  assert.equal(svg.width, 26); assert.equal(svg.height, 26);
  assert(Math.abs(svg.x + svg.width/2 - logo.x - logo.width/2) < .6, 'cube centred on the answer mark');
  assert(Math.abs(words.x - text.x) < .6, 'Thinking aligned with the reply text');
  mkdirSync('test-results/desktop', { recursive: true });
  await page.screenshot({ path: 'test-results/desktop/quieter-chat.png' });
  await open(other);
  await expect(row.locator('.sidebar-session-mark.working')).toBeVisible();
  await expect(row.locator('.sidebar-say-state')).toHaveText('working');
  await open(active); await checkSelected();
  gate.resolve(); await expect(working).toBeHidden();
  console.log('Passed: selected → background → selected; original-size cube and reply columns aligned.');
} finally { gate.resolve(); await app?.close(); await f.close(); }
