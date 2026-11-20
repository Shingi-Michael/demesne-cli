import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { anthropicSettings } from "../anthropic-settings.ts";
import { ProviderAccounts } from "../providers.ts";

test("checking is read-only; saving and removing a key updates the private provider and scrubs the backup", async () => {
  const dir = mkdtempSync(join(tmpdir(), "demesne-claude-"));
  const path = join(dir, "config.toml"), signal = new AbortController().signal;
  const transport = (async () => Response.json({ data:[{id:"claude-test"}],has_more:false })) as unknown as typeof fetch;
  const args = { apiKey:"fixture-key-only", key:"new:anthropic", model:"claude-test" };
  try {
    expect((await anthropicSettings(path,args,false,signal,transport)).models?.[0]?.id).toBe(args.model);
    expect(existsSync(path)).toBe(false);
    await expect(anthropicSettings(path,args,true,signal,transport)).rejects.toThrow("locally");
    await anthropicSettings(path,{...args,remember:true},true,signal,transport);
    const accounts = new ProviderAccounts({configPath:path,dataDirectory:dir,open:async()=>{}});
    expect((await accounts.list("Anthropic")).find(p=>p.kind === "anthropic")).toMatchObject({key:"provider",status:"signed-in",active:true});
    await accounts.signOut("provider");
    for (const file of [path,`${path}.bak`]) expect(readFileSync(file,"utf8")).not.toContain(args.apiKey);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
