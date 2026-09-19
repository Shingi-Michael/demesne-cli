import { describe, expect, test } from "bun:test";
import { createPainter } from "@demesne/brand";
import { formatAmbientMemory, parseSwapUsedMiB } from "../src/ambient.ts";

const painter = createPainter(false, "dark");

describe("parseSwapUsedMiB", () => {
  test("parses the sysctl swapusage format", () => {
    expect(parseSwapUsedMiB("total = 5120.00M  used = 3161.25M  free = 1958.75M  (encrypted)")).toBeCloseTo(3161.25, 1);
    expect(parseSwapUsedMiB("total = 4.00G  used = 1.50G  free = 2.50G")).toBeCloseTo(1536, 1);
  });

  test("returns null for unexpected output", () => {
    expect(parseSwapUsedMiB("")).toBeNull();
    expect(parseSwapUsedMiB("no swap here")).toBeNull();
  });
});

describe("formatAmbientMemory", () => {
  test("formats MiB and GiB with pressure colors", () => {
    expect(formatAmbientMemory(512, painter)).toEqual(["MEMORY", "swap 512 MiB"]);
    expect(formatAmbientMemory(1_536, painter)).toEqual(["MEMORY", "swap 1.5 GiB"]);
  });
});
