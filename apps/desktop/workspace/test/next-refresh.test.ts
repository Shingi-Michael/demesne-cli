import { expect, test } from "bun:test";
import { WorkspaceHost } from "../host.ts";
import { eventually, fixture } from "./fixture.ts";

for (const fails of [false, true]) {
  test(`forced Next refreshes coalesce after an in-flight ${fails ? "failure" : "success"}`, async () => {
    const f = await fixture();
    const host = new WorkspaceHost({ workspace: f.workspace, settings: f.settings, client: f.client, changed() {} });
    type Result = Awaited<ReturnType<typeof f.client.driveNext>>;
    const result: Result = { workspace: f.workspace, fingerprint: "test", cached: false, proposals: [], signals: [], generatedAt: new Date().toISOString(), model: "test" };
    const first = Promise.withResolvers<Result>();
    const second = Promise.withResolvers<Result>();
    const calls: boolean[] = [];
    let active = 0, maximum = 0;
    f.client.driveNext = async (input) => {
      calls.push(input.force === true);
      maximum = Math.max(maximum, ++active);
      try {
        return await (calls.length === 1 ? first.promise : second.promise);
      } finally { active--; }
    };
    let refresh: Promise<void> | undefined;
    try {
      refresh = host.refreshNext();
      await host.refreshNext(); // Ordinary overlapping refreshes do not queue.
      await host.refreshNext(true);
      await host.refreshNext(true);
      expect(calls).toEqual([false]);
      if (fails) first.reject(new Error("planner failed"));
      else first.resolve(result);
      await eventually(() => calls.length === 2, 1000);
      expect(calls).toEqual([false, true]);
      expect(host.nextQueue.loading).toBe(true);
      second.resolve(result);
      await refresh;
      expect(maximum).toBe(1);
      expect(host.nextQueue).toMatchObject({ loading: false, error: null, model: "test" });
      // Draining clears the latch; later ordinary work stays ordinary.
      await host.refreshNext();
      expect(calls).toEqual([false, true, false]);
    } finally {
      first.resolve(result);
      second.resolve(result);
      await refresh;
      host.dispose();
      await f.close();
    }
  });
}
