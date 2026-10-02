import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { TerminalHarness } from "../../experiments/ghostty-ui/test/terminal-harness.ts";
import { fixture, eventually } from "./test/fixture.ts";

const directory = resolve(
  process.argv[2] ?? "/tmp/demesne-display-scale-check",
);
mkdirSync(directory, { recursive: true });
const f = await fixture();
for (const mode of [
  {
    name: "standard",
    cell: { width: 8, height: 18 },
    scale: 1,
    pixelMouse: true,
  },
  {
    name: "retina-auto",
    cell: { width: 16, height: 36 },
    scale: 2,
    pixelMouse: true,
  },
  {
    name: "retina-cell-mouse",
    cell: { width: 16, height: 36 },
    scale: 2,
    pixelMouse: false,
  },
  {
    name: "retina-explicit",
    cell: { width: 16, height: 36 },
    scale: 1.5,
    pixelMouse: true,
    explicit: "1.5",
  },
]) {
  const captures = join(directory, mode.name);
  mkdirSync(captures, { recursive: true });
  const app = new TerminalHarness({
    entry: resolve(import.meta.dir, "terminal.ts"),
    env: f.env,
    cell: mode.cell,
    pixelMouse: mode.pixelMouse,
    args: [
      "--live",
      `--server=${f.server.url}`,
      `--workspace=${f.workspace}`,
      `--capture-dir=${captures}`,
      ...(mode.explicit ? ["--scale", mode.explicit] : []),
    ],
  });
  let current: any;
  async function state(check: (state: any) => boolean) {
    await eventually(() => {
      try {
        current = JSON.parse(
          readFileSync(join(captures, "state.json"), "utf8"),
        );
        return check(current);
      } catch {
        return false;
      }
    }, 8000);
    return current;
  }
  async function pixels(label: string) {
    await Bun.sleep(100);
    await eventually(async () => {
      try {
        const actual = await app.raw(),
          expected = await sharp(join(captures, "latest.png"))
            .ensureAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true });
        return (
          actual.width === expected.info.width &&
          actual.height === expected.info.height &&
          actual.data.every(
            (value, i) => Math.abs(value - expected.data[i]!) <= 2,
          )
        );
      } catch {
        return false;
      }
    }, 6000);
    await app.png(join(captures, `${label}.png`));
  }
  async function clickEditor(scale: number) {
    const box = current.live.controls.find((c: any) => c.tag === "TEXTAREA");
    assert(box);
    app.click(Math.round(box.x * scale), Math.round(box.y * scale));
    await state((s) => s.focus === "TEXTAREA");
  }
  try {
    await app.after(0);
    await state(
      (s) =>
        s.live?.connection === "online" &&
        Math.abs(s.scale - mode.scale) < 0.001,
    );
    assert.equal(
      current.width,
      Math.round((150 * mode.cell.width) / mode.scale),
    );
    assert.equal(
      current.height,
      Math.round((40 * mode.cell.height) / mode.scale),
    );
    await pixels("initial");
    await clickEditor(mode.scale);
    app.paste("Scale stays readable ✓");
    await state((s) => s.value === "Scale stays readable ✓");
    await pixels("typed");
    if (mode.name === "standard") {
      // Cell size and grid change together while the physical bitmap stays
      // 1200×720. A size-only cache would wrongly reuse the old tiny UI here.
      app.cell = { width: 16, height: 36 };
      app.resize(75, 20);
      await state(
        (s) =>
          Math.abs(s.scale - 2) < 0.001 && s.width === 600 && s.height === 360,
      );
      assert.equal(current.value, "Scale stays readable ✓");
      await pixels("same-pixels-larger-font");
      await clickEditor(2);
      app.paste(" after zoom");
      await state((s) => s.value.endsWith("after zoom"));
      // Increase font size again without an integer device-density factor.
      app.cell = { width: 20, height: 45 };
      app.resize(90, 26);
      await state(
        (s) =>
          Math.abs(s.scale - 2.5) < 0.001 &&
          s.width === 720 &&
          s.height === 468,
      );
      await pixels("fractional-font-zoom");
      app.cell = { width: 8, height: 18 };
      app.resize(150, 40);
      await state(
        (s) =>
          Math.abs(s.scale - 1) < 0.001 && s.width === 1200 && s.height === 720,
      );
      await pixels("restored");
    }
    if (mode.explicit) {
      app.cell = { width: 20, height: 45 };
      app.resize(90, 26);
      await state(
        (s) =>
          Math.abs(s.scale - 1.5) < 0.001 &&
          s.width === 1200 &&
          s.height === 780,
      );
      await pixels("explicit-preserved");
    }
    app.write("\x11");
    assert.equal(await app.child.exited, 0);
    assert(app.restored);
    assert.equal(app.images.size, 0);
    console.log(
      JSON.stringify({
        result: "passed",
        mode: mode.name,
        logicalSize: current.width + "×" + current.height,
        checked: [
          "apparent UI size",
          "click mapping",
          "Unicode input",
          "decoded pixels",
          "cleanup",
        ],
      }),
    );
  } catch (error) {
    throw new Error(
      `${mode.name}: ${error}\n${app.error}\n${JSON.stringify({ width: current?.width, height: current?.height, scale: current?.scale, value: current?.value })}`,
    );
  } finally {
    app.kill();
  }
}
await f.close();
