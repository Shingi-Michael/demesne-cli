import { expect, test } from "bun:test";
import { brokeNews, brokeSeen } from "../broke-news";

const ci = { id: "ci:main", title: "CI failure on main", detail: "Latest run exit 1 at 10:02.", source: "ci" };
const check = { id: "check:lint", title: "lint", source: "checks" };

test("nothing is news on the first look, or in another project", () => {
  expect(brokeNews(null, "/a", [ci])).toBeNull();
  expect(brokeNews(brokeSeen("/b", []), "/a", [ci])).toBeNull();
});

test("a failure that was not there at the last look is said once", () => {
  expect(brokeNews(brokeSeen("/a", []), "/a", [ci])).toBe("CI failed on main");
  expect(brokeNews(brokeSeen("/a", [ci]), "/a", [ci])).toBeNull();
  expect(brokeNews(brokeSeen("/a", [ci]), "/a", [ci, check])).toBe("A check is failing");
});

test("several at once are counted, and a fix is not news", () => {
  expect(brokeNews(brokeSeen("/a", []), "/a", [ci, check])).toBe("2 things broke");
  expect(brokeNews(brokeSeen("/a", [ci]), "/a", [])).toBeNull();
});
