/// Step 4 of pass 273 A: whiteboards, JSON the model writes and Demesne draws.
import { expect, test } from "bun:test";
import { BOARD_MAX_NOTES, boardProblem, boardWords, readBoard } from "../src/foundry-board.ts";

const ok = (source: string) => {
  const read = readBoard(source);
  if ("problem" in read) throw new Error(read.problem);
  return read.board;
};

test("a board keeps notes, arrows and groups; places are clamped and tones default to plain", () => {
  const board = ok(JSON.stringify({
    notes: [{ id: "who", text: " Who books ", x: 40, y: 60, tone: "sand" }, { id: "why", text: "Why", x: -20, y: 99999, tone: "neon" }],
    arrows: [{ from: "who", to: "why", label: "because" }],
    groups: [{ label: "Today", x: 20, y: 20, w: 10, h: 10 }],
  }));
  expect(board.notes[0]).toEqual({ id: "who", text: "Who books", x: 40, y: 60, tone: "sand" });
  expect(board.notes[1]).toEqual({ id: "why", text: "Why", x: 0, y: 8000, tone: "plain" });
  expect(board.arrows).toEqual([{ from: "who", to: "why", label: "because" }]);
  expect(board.groups).toEqual([{ label: "Today", x: 20, y: 20, w: 80, h: 60 }]);
});

test("notes without a place go in rows of four under the placed ones; ids are made when missing", () => {
  const board = ok(JSON.stringify({ notes: [{ id: "a", text: "A", x: 10, y: 100 }, ...["b", "c", "d", "e", "f"].map((text) => ({ text }))] }));
  expect(board.notes.map((note) => note.id)).toEqual(["a", "n2", "n3", "n4", "n5", "n6"]);
  expect(board.notes.slice(1).map((note) => [note.x, note.y])).toEqual([[40, 260], [260, 260], [480, 260], [700, 260], [40, 420]]);
});

test("a board that can't be drawn says why", () => {
  expect(boardProblem("not json")).toContain("doesn't parse");
  expect(boardProblem("{}")).toContain("list of notes");
  expect(boardProblem('{"notes":[]}')).toContain("at least one note");
  expect(boardProblem('{"notes":[{"text":" "}]}')).toContain("Note 1 needs its words");
  expect(boardProblem('{"notes":[{"id":"a","text":"A"},{"id":"a","text":"B"}]}')).toContain('Two notes are called "a"');
  expect(boardProblem('{"notes":[{"id":"a","text":"A"}],"arrows":[{"from":"a","to":"z"}]}')).toContain('"z" isn\'t a note\'s id');
  expect(boardProblem('{"notes":[{"text":"A"}],"groups":[{"label":"G","x":0,"y":0}]}')).toContain("Group 1 needs x, y, w and h");
  expect(boardProblem(JSON.stringify({ notes: Array.from({ length: BOARD_MAX_NOTES + 1 }, (_, at) => ({ text: `n${at}` })) }))).toContain(`up to ${BOARD_MAX_NOTES} notes`);
  expect(boardProblem('{"notes":[{"text":"A"}]}')).toBeNull();
});

test("a board's words are its group names, notes and arrow labels", () => {
  expect(boardWords('{"notes":[{"id":"a","text":"Who books"},{"id":"b","text":"Why"}],"arrows":[{"from":"a","to":"b","label":"because"}],"groups":[{"label":"Today","x":0,"y":0,"w":300,"h":200}]}')).toBe("Today Who books Why because");
  expect(boardWords("broken")).toBe("broken");
});
