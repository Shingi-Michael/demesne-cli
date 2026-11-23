/// Step 6: a picture dropped on a mockup is a note that carries it.
import { expect, test } from "bun:test";
import { DROPPED_SAYS, keptNote, notePictureFile, notesMessage, readGiven, readKeptNote, type FoundryNote, type NotePart } from "../foundry-notes.ts";

const part: NotePart = { tag: "header", role: "", type: "", cls: "top", label: "", text: "Café Rosa", heading: "Café Rosa", kids: 2, selector: "header.top", html: "<header class=\"top\">…</header>" };
const dropped: FoundryNote = { part, name: "Top header", text: DROPPED_SAYS, spot: { fx: 0.1, fy: 0.5 }, picture: "iVBORw0KGgo=", given: { name: "rosa logo.svg", type: "image/png" } };
const pinned: FoundryNote = { part, name: "Top header", text: "Calmer", spot: { fx: 0.5, fy: 0.5 }, picture: "iVBORw0KGgo=", around: { x: 40, y: 60 } };

test("a dropped picture goes to the chat under its own name, as it was kept", () => {
  expect(notePictureFile(dropped, 0)).toEqual({ name: "rosa logo.png", mimeType: "image/png" });
  expect(notePictureFile({ ...dropped, given: { name: "shop.jpeg", type: "image/jpeg" } }, 0)).toEqual({ name: "shop.jpg", mimeType: "image/jpeg" });
  expect(notePictureFile(pinned, 2)).toEqual({ name: "note-3.png", mimeType: "image/png" });
});

test("the message says a dropped picture is one to use there, by its id", () => {
  const message = notesMessage({ id: "m1", title: "Café board", version: 3 }, [pinned, dropped], [0, 1]);
  expect(message).toContain(`2 · Top header: ${DROPPED_SAYS}`);
  expect(message).toContain("named note-… shows the place around pin 1");
  expect(message).toContain("dropped a picture on the mockup at pin 2 to use there");
  expect(message).toContain("as picture:IMAGE_ID");
  expect(message).toContain("dropped picture: attached as rosa logo.png");
  expect(message).not.toContain("in its picture the pin is 50%");
  // Not attached (the box was full): no word of it.
  expect(notesMessage({ id: "m1", title: "Café board", version: 3 }, [dropped], [])).not.toContain("picture:IMAGE_ID");
});

test("a dropped picture's name and type come back from the daemon checked", () => {
  expect(readKeptNote(keptNote(dropped))?.given).toEqual({ name: "rosa logo.svg", type: "image/png" });
  expect(readGiven({ name: "../../etc/x.png", type: "image/png" })).toEqual({ name: "x.png", type: "image/png" });
  expect(readGiven({ name: "x.svg", type: "image/svg+xml" })).toBeNull();
  expect(readGiven({ name: "", type: "image/png" })).toBeNull();
});
