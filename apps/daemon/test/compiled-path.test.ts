import { expect, test } from "bun:test";
import { isCompiledPath } from "../src/compiled-path.ts";

test("recognizes Bun compiled virtual roots on Unix and Windows", () => {
  for (const path of ["/$bunfs/root/demesned", "B:\\~BUN\\root\\demesned.exe", "B:/~BUN/root/demesned.exe"]) {
    expect(isCompiledPath(path)).toBe(true);
  }
});

test("source modules resolve native packages normally", () => {
  for (const path of ["/project/apps/daemon/src/artifacts.ts", "D:\\project\\apps\\daemon\\src\\artifacts.ts"]) {
    expect(isCompiledPath(path)).toBe(false);
  }
});
