/// Pass 273 A: Foundry's front page searches the words on each page too.
import { expect, test } from "bun:test";
import { DemesneStore } from "@demesne/storage";
import { pageWords, searchFoundry } from "../src/foundry.ts";

test("the words on a page leave out its scripts, styles and tags", () => {
  const words = pageWords("html", `<style>.a{color:red}</style><h1>Yearly&nbsp;plan</h1><script>var secret = "x"</script><p>Save &amp; skip</p><!-- hidden -->`);
  expect(words).toBe("Yearly plan Save & skip");
  expect(pageWords("markdown", "# Field guide\n\nTake a sample")).toBe("# Field guide Take a sample");
});

test("a search finds a mockup by a word only its newest page shows", () => {
  const store = new DemesneStore(":memory:");
  const plans = store.saveFoundryArtifact({ title: "Plans page", kind: "html", source: "<h1>Monthly</h1>" });
  store.saveFoundryArtifact({ id: plans.id, source: "<h1>Yearly first</h1><p>Gift a bag</p>" });
  store.saveFoundryArtifact({ title: "Soil samples", kind: "markdown", source: "pH by plot" });
  expect(searchFoundry(store, "gift").map((item) => item.title)).toEqual(["Plans page"]);
  expect(searchFoundry(store, "monthly")).toEqual([]);
  expect(searchFoundry(store, "ph plot").map((item) => item.title)).toEqual(["Soil samples"]);
  expect(searchFoundry(store, "plans").map((item) => item.title)).toEqual(["Plans page"]);
});
