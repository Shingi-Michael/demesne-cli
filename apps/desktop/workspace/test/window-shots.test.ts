import { expect, test } from "bun:test";
import { shotCardHTML, shotKey, shotPaste, shotsNote, type WindowShot } from "../window-shots.ts";
import { onPage } from "../../electron/capture-keys-math.ts";

const shot: WindowShot = { id: "att_9F3c-12", sessionId: "s", app: "Safari", title: "Settings – Acme", url: "data:image/png;base64,AA==", text: "Settings\nSave", at: 0 };

test("a waiting screenshot card shows the picture, the names, × and that it goes with the next message", () => {
  const html = shotCardHTML(shot, false);
  expect(shotKey(shot)).toBe("shot-att9f3c12");
  expect(html).toContain('data-card="shot-att9f3c12"');
  expect(html).toContain("<b>Safari</b> · Settings – Acme");
  expect(html).toContain('<img src="data:image/png;base64,AA=="');
  expect(html).toContain('data-action="detach"');
  expect(html).toContain("Goes with your next message, with its text");
  expect(html).not.toContain("card-body");
});

test("once sent, the card folds to one line and the picture shows on hover", () => {
  const html = shotCardHTML({ ...shot, sent: Date.UTC(2026, 10, 7, 10, 4) }, false);
  expect(html).toContain('<span class="card-line">Settings – Acme</span><span class="card-sum">sent ');
  expect(html).toContain('class="card-body"><button type="button" class="shot-pic"');
  expect(html).not.toContain("Goes with");
});

test("names are escaped and a missing text says why", () => {
  const html = shotCardHTML({ ...shot, title: '<img onerror="x">', text: "", textNote: "This window didn’t share its text." }, false);
  expect(html).not.toContain("<img onerror");
  expect(html).toContain("Goes with your next message. This window didn’t share its text.");
});

test("the window's text goes as a folded paste, and the composer says what goes", () => {
  expect(shotPaste(shot)).toEqual({ id: shot.id, text: "Text from Safari — Settings – Acme:\nSettings\nSave" });
  expect(shotPaste({ ...shot, text: " " })).toBeNull();
  expect(shotsNote([shot])).toContain("Safari goes with this");
  expect(shotsNote([shot, { ...shot, app: "Figma" }])).toContain("Safari and Figma go with this");
  expect(shotsNote([])).toBe("");
});

test("a window's place on screen becomes the page's pixels", () => {
  expect(onPage({ x: 300, y: 200, width: 800, height: 600 }, { x: 100, y: 50, width: 1200, height: 900 }, 1)).toEqual({ x: 200, y: 150, width: 800, height: 600 });
  expect(onPage({ x: 300, y: 250, width: 800, height: 600 }, { x: 100, y: 50, width: 1200, height: 900 }, 2)).toEqual({ x: 100, y: 100, width: 400, height: 300 });
});
