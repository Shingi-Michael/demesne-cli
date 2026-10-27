// Review-only characterization: bun scripts/review-pr302-notifications.ts <PR checkout>
// The last two checks assert the observed defects, not the desired behavior.
import { expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

if (!process.argv[2]) throw new Error('Pass the checkout of PR #302 (679e3085f26d65c8eb989155cb9926878c0c7df0)');
const root = resolve(process.argv[2]);
const { notifyKinds } = await import(pathToFileURL(join(root, 'apps/desktop/workspace/settings-page.ts')).href);
function test(name: string, check: () => void) { check(); console.log(`PASS ${name}`); }

// Run the exact PR function, not a reimplementation. Only its environment is fake.
const source = readFileSync(join(root, 'apps/desktop/workspace/live.ts'), 'utf8');
const start = source.indexOf('function renderNotifications() {');
const end = source.indexOf('// A banner\'s click', start);
const js = new Bun.Transpiler({ loader: 'ts' }).transformSync(source.slice(start, end));
function harness(old = false) {
  const calls: any[] = [];
  const state: any = { connection: 'online', session: { id: 'selected', title: 'Selected' }, sessions: [], approvals: [], questions: [] };
  const document = { hasFocus: () => false };
  const preferences = notifyKinds(null, null);
  const make = new Function('state', 'window', 'document', 'notifyOn', 'api', 'backOf', 'reviewJobs', 'inSession', `let notified = null; const notifyFrom = Date.now() - 5000; ${js}; return renderNotifications;`);
  const render = make(state, { demesne: { mode: 'desktop' } }, document, preferences,
    (method: string, alert: any) => { calls.push({ method, ...alert }); return Promise.resolve(); }, () => 'none', () => [], () => true);
  state.sessions = [{ id: 'background', title: 'Background', workspace: '/project', status: 'running', waiting: false, updatedAt: new Date(Date.now() - (old ? 60000 : 0)).toISOString() }];
  render();
  return { state, document, preferences, calls, render, item: state.sessions[0] };
}
test('background input request and completion reach desktop IPC, once each', () => {
  const h = harness(); h.item.waiting = true; h.render(); h.render();
  expect(h.calls.map(c => c.body)).toEqual(['Is waiting for you']);
  expect(h.calls[0]).toMatchObject({ method: 'desktop-notify', sessionId: 'background', path: '/project' });
  h.item.waiting = false; h.item.status = 'completed'; h.render(); h.render();
  expect(h.calls.map(c => c.body)).toEqual(['Is waiting for you', 'Finished']);
});
test('selected question and approval use specific messages', () => {
  const q = harness(); q.item.id = 'selected'; q.state.questions = [{}]; q.render();
  expect(q.calls[0].body).toBe('Has a question for you');
  const a = harness(); a.item.id = 'selected'; a.state.approvals = [{ name: 'run_command', input: { argv: ['bun', 'test'] } }]; a.render();
  expect(a.calls[0].body).toBe('Wants to run: bun test');
});
test('focused background waits and completion are suppressed', () => {
  const h = harness(); h.document.hasFocus = () => true;
  h.item.waiting = true; h.render(); h.item.waiting = false; h.item.status = 'completed'; h.render();
  expect(h.calls).toEqual([]);
});
test('saved wait and completion opt-outs suppress both', () => {
  const h = harness(); h.preferences.wait = false; h.preferences.done = false;
  h.item.waiting = true; h.render(); h.item.waiting = false; h.item.status = 'completed'; h.render();
  expect(h.calls).toEqual([]);
});
test('confirmed defect: second input request in the same turn is lost', () => {
  const h = harness(); h.item.waiting = true; h.render();
  h.item.waiting = false; h.render(); // First approval answered.
  h.item.waiting = true; h.render(); // Next approval/question, same session updatedAt.
  expect(h.calls.map(c => c.body)).toEqual(['Is waiting for you']);
});
test('confirmed defect: a turn begun before app startup cannot notify a new wait', () => {
  const h = harness(true); h.item.waiting = true; h.render();
  expect(h.calls).toEqual([]);
});
