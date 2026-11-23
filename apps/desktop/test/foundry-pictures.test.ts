/// Step 6: picture:IMAGE_ID becomes where Demesne serves the picture.
import { expect, test } from "bun:test";
import { withPictures } from "../electron/policy.ts";

test("only the pictures a mockup keeps are put in; any other stays as written", () => {
  const page = '<img src="picture:logo"><div style="background:url(picture:photo)"></div><img src="picture:other">';
  expect(withPictures(page, { logo: "foundry://shot/m1/logo", photo: "data:image/png;base64,AA" }))
    .toBe('<img src="foundry://shot/m1/logo"><div style="background:url(data:image/png;base64,AA)"></div><img src="picture:other">');
  expect(withPictures(page, {})).toBe(page);
  // A name that only starts like a kept one is not it.
  expect(withPictures('<img src="picture:logo2">', { logo: "x" })).toBe('<img src="picture:logo2">');
});
