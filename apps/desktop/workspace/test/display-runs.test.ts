import { expect, test } from "bun:test";
import type { ToolEntry } from "@demesne/workbench/entries.ts";
import { DisplayRuns, deferredChanges } from "../display-runs.ts";
import { WorkspaceHost } from "../host.ts";
import type { WorkspaceRun } from "../session-model.ts";
import { StateEncoder, StateReceiver } from "../state-wire.ts";
import { fixture } from "./fixture.ts";

function example(): WorkspaceRun {
  const before = 'unchanged line\n'.repeat(70000), after = before + 'new line\n';
  return { id: 'turn', number: 1, content: 'Edit files', status: 'completed', createdAt: new Date().toISOString(), completedAt: new Date().toISOString(), planOnly: false,
    entries: Array.from({length: 10}, (_,i): ToolEntry => ({ id: i, type: 'tool', toolCallId: 'edit-'+i, name: 'edit_file', phase: 'change', state: 'done', startedAt: 0, input: {path: 'file-'+i},
      changes: [{path:'file-'+i,before,after,beforeExists:true,afterExists:true}] })) };
}
test('large recorded files stay out of snapshots while paths, counts and exact history survive', () => {
  const run=example(), projector=new DisplayRuns();
  const full=JSON.stringify(run), started=performance.now(), [light]=projector.project([run]);
  const bytes=Buffer.byteLength(JSON.stringify(light));
  console.log(`Display projection: ${Math.round(Buffer.byteLength(full)/1024/1024)} MiB → ${bytes} bytes in ${Math.round(performance.now()-started)} ms`);
  expect(bytes).toBeLessThan(10000);
  expect(JSON.stringify(run)).toBe(full);
  expect(deferredChanges(light!.entries[0] as ToolEntry)).toMatchObject({added:1,removed:0});
  expect(projector.project([run])[0]).toBe(light);
  const rebuilt={...run,entries:structuredClone(run.entries)};
  expect(deferredChanges(projector.project([rebuilt])[0]!.entries[0] as ToolEntry)).toBe(deferredChanges(light!.entries[0] as ToolEntry));
  (rebuilt.entries[0] as ToolEntry).changes![0]!.after += 'another line\n';
  const changed={...rebuilt};
  expect(deferredChanges(projector.project([changed])[0]!.entries[0] as ToolEntry)).toMatchObject({added:2,removed:0});
  expect(deferredChanges(light!.entries[0] as ToolEntry)).toMatchObject({added:1,removed:0});
});

test('host detail requests are scoped to the current chat and never hydrate state-wire snapshots', async () => {
  const f=await fixture(), id=(await f.client.createSession({workspacePath:f.workspace})).session.id;
  const host=new WorkspaceHost({client:f.client,settings:f.settings,workspace:f.workspace,sessionId:id,headless:true,changed(){}});
  try {
    await host.connect();
    const run=example(); host.current!.runs=()=>[run];
    const encoder=new StateEncoder(), receiver=new StateReceiver();
    const initial=host.snapshot(); receiver.apply(encoder.encode(initial));
    const details=await host.handle('file-edit-details',{sessionId:id,turnId:run.id,toolCallId:'edit-0'});
    expect(details).toEqual((run.entries[0] as ToolEntry).changes);
    await expect(host.handle('file-edit-details',{sessionId:'other',turnId:run.id,toolCallId:'edit-0'})).rejects.toThrow('session changed');
    await expect(host.handle('file-edit-details',{sessionId:id,turnId:'missing',toolCallId:'edit-0'})).rejects.toThrow('no longer available');
    host.publish(); const patch=encoder.encode(host.snapshot()); receiver.apply(patch);
    expect(Buffer.byteLength(JSON.stringify(receiver.state!.runs))).toBeLessThan(10000);
    expect(receiver.state!.runs[0]).toBe(initial.runs[0]!);
  } finally {host.dispose();await f.close();}
});
