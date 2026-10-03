import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, updateUserConfig, renderUserConfig, parseConfigDocument } from "../src/index.ts";

test("provider concurrency survives validated updates independently of the global default", () => {
 const dir=mkdtempSync(join(tmpdir(),"demesne-provider-slots-")),path=join(dir,"config.toml");
 try {
  updateUserConfig(path,{inference_slots:1,provider:{id:"qwen",inference_slots:3},additional_providers:{cloud:{url:"https://example.com/v1",model:"cloud",context_window:32768,max_output_tokens:8192,inference_slots:2}}});
  const c=loadConfig({userConfigPath:path,includeProject:false,env:{}}).config;
  expect(c.inferenceSlots).toBe(1);expect(c.provider.inferenceSlots).toBe(3);expect(c.additionalProviders?.cloud?.inferenceSlots).toBe(2);
  expect(parseConfigDocument(renderUserConfig({provider:c.provider})).provider).toMatchObject({inference_slots:3});
  for(const slots of [0,-1,1.5,1025])expect(()=>updateUserConfig(path,{provider:{inference_slots:slots}})).toThrow();
 } finally {rmSync(dir,{recursive:true,force:true});}
});
