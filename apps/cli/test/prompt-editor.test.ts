import { describe, expect, test } from "bun:test";
import { SLASH_COMMANDS, type SlashCommand } from "@demesne/brand";
import {
  createPromptEditorState,
  mentionMatches,
  draftMentions,
  expandMentions,
  mentionLabel,
  resolveMention,
  mentionTokenAt,
  reducePromptEditor,
  setPromptValue,
  type PromptEditorKey,
  type PromptEditorResult,
  type PromptEditorState,
} from "../src/prompt-editor.ts";

function state(value: string, cursor = value.length): PromptEditorState {
  return { ...createPromptEditorState(), value, cursor };
}

function press(
  current: PromptEditorState,
  key: PromptEditorKey,
  text = "",
  options: { commands?: readonly SlashCommand[]; history?: readonly string[]; mentions?: readonly string[] } = {},
): PromptEditorResult {
  return reducePromptEditor(current, {
    key,
    text,
    commands: options.commands ?? [],
    history: options.history ?? [],
    mentions: options.mentions ?? [],
  });
}

function type(current: PromptEditorState, text: string): PromptEditorState {
  let next = current;
  for (const character of text) next = press(next, { name: character }, character).state;
  return next;
}

const commands: readonly SlashCommand[] = SLASH_COMMANDS;
const newCommand = commands.find((command) => command.name === "/new")!;
const resumeCommand = commands.find((command) => command.name === "/resume")!;
const statusCommand = commands.find((command) => command.name === "/status")!;

describe("prompt editor typing", () => {
  test("inserts text at the cursor and tracks the position", () => {
    let current = type(createPromptEditorState(), "hello");
    expect(current.value).toBe("hello");
    expect(current.cursor).toBe(5);
    current = press(current, { name: "left" }, "").state;
    current = type(current, "!");
    expect(current.value).toBe("hell!o");
    expect(current.cursor).toBe(5);
  });

  test("normalizes tabs and strips control characters from pasted text", () => {
    const current = type(createPromptEditorState(), "a\tb\u0007c");
    expect(current.value).toBe("a  bc");
  });

  test("deletes by grapheme in both directions", () => {
    let current = type(createPromptEditorState(), "a👍b");
    current = press(current, { name: "backspace" }, "").state;
    expect(current.value).toBe("a👍");
    current = press(current, { name: "backspace" }, "").state;
    expect(current.value).toBe("a");
    current = press(current, { name: "left" }, "").state;
    current = press(current, { name: "delete" }, "").state;
    expect(current.value).toBe("");
  });
});

describe("prompt editor movement", () => {
  test("moves by grapheme with arrows and by word with ctrl or alt", () => {
    let current = state("fix the bug");
    current = press(current, { name: "left" }, "").state;
    expect(current.cursor).toBe(10);
    current = press(current, { name: "left", ctrl: true }, "").state;
    expect(current.cursor).toBe(8);
    current = press(current, { name: "left", ctrl: true }, "").state;
    expect(current.cursor).toBe(4);
    current = press(current, { name: "right", meta: true }, "").state;
    expect(current.cursor).toBe(7);
    current = press(current, { name: "b", meta: true }, "").state;
    expect(current.cursor).toBe(4);
    current = press(current, { name: "f", meta: true }, "").state;
    expect(current.cursor).toBe(7);
  });

  test("uses line-based home, end, ctrl+a, and ctrl+e", () => {
    let current = state("one\ntwo three");
    current = press(current, { name: "home" }, "").state;
    expect(current.cursor).toBe(4);
    current = press(current, { name: "end" }, "").state;
    expect(current.cursor).toBe(13);
    current = press(current, { name: "a", ctrl: true }, "").state;
    expect(current.cursor).toBe(4);
    current = press(current, { name: "e", ctrl: true }, "").state;
    expect(current.cursor).toBe(13);
  });

  test("moves between explicit lines with up and down", () => {
    let current = state("one\ntwo");
    current = press(current, { name: "up" }, "").state;
    expect(current.cursor).toBe(3);
    current = press(current, { name: "down" }, "").state;
    expect(current.cursor).toBe(7);
    current = press(current, { name: "up" }, "").state;
    current = press(current, { name: "up" }, "").state;
    expect(current.cursor).toBe(0);
  });
});

describe("prompt editor history", () => {
  const history = ["recent", "older"];

  test("walks history and restores the draft", () => {
    let current = state("draft");
    current = press(current, { name: "up" }, "", { history }).state;
    expect(current.value).toBe("recent");
    expect(current.historyIndex).toBe(0);
    current = press(current, { name: "up" }, "", { history }).state;
    expect(current.value).toBe("older");
    current = press(current, { name: "down" }, "", { history }).state;
    expect(current.value).toBe("recent");
    current = press(current, { name: "down" }, "", { history }).state;
    expect(current.value).toBe("draft");
    expect(current.historyIndex).toBeNull();
  });

  test("supports ctrl+p and ctrl+n aliases", () => {
    let current = createPromptEditorState();
    current = press(current, { name: "p", ctrl: true }, "", { history }).state;
    expect(current.value).toBe("recent");
    current = press(current, { name: "n", ctrl: true }, "", { history }).state;
    expect(current.value).toBe("");
  });

  test("editing a recalled entry stops navigation", () => {
    let current = press(createPromptEditorState(), { name: "up" }, "", { history }).state;
    current = type(current, "!");
    expect(current.historyIndex).toBeNull();
    expect(current.value).toBe("recent!");
  });
});

describe("prompt editor kill ring and undo", () => {
  test("kills to the line edges and yanks", () => {
    let current = state("hello world", 5);
    current = press(current, { name: "k", ctrl: true }, "").state;
    expect(current.value).toBe("hello");
    expect(current.killRing).toBe(" world");
    current = press(current, { name: "y", ctrl: true }, "").state;
    expect(current.value).toBe("hello world");

    const atStart = press(state("hello world", 5), { name: "u", ctrl: true }, "").state;
    expect(atStart.value).toBe(" world");
    expect(atStart.killRing).toBe("hello");
  });

  test("kills the previous word with ctrl+w", () => {
    const current = press(state("fix the bug"), { name: "w", ctrl: true }, "").state;
    expect(current.value).toBe("fix the ");
    expect(current.killRing).toBe("bug");
  });

  test("undoes edits in order", () => {
    let current = type(createPromptEditorState(), "abc");
    current = press(current, { name: "_", ctrl: true }, "").state;
    expect(current.value).toBe("ab");
    current = press(current, { name: "underscore", ctrl: true }, "").state;
    expect(current.value).toBe("a");
    current = press(current, { name: "/", ctrl: true }, "").state;
    expect(current.value).toBe("");
    expect(press(current, { name: "_", ctrl: true }, "").state.value).toBe("");
  });

  test("setPromptValue is undoable", () => {
    const edited = setPromptValue(state("draft"), "from editor");
    expect(edited.value).toBe("from editor");
    expect(edited.cursor).toBe(11);
    const undone = press(edited, { name: "_", ctrl: true }, "").state;
    expect(undone.value).toBe("draft");
  });
});

describe("prompt editor menu", () => {
  test("navigates and completes an argument command with tab", () => {
    const listed = [newCommand, resumeCommand];
    let current = state("/res");
    current = press(current, { name: "down" }, "", { commands: listed }).state;
    expect(current.menuSelected).toBe(1);
    current = press(current, { name: "up" }, "", { commands: listed }).state;
    expect(current.menuSelected).toBe(0);
    current = press(current, { name: "down" }, "", { commands: listed }).state;
    current = press(current, { name: "tab" }, "", { commands: listed }).state;
    expect(current.value).toBe(`${resumeCommand.name} `);
    expect(current.menuDismissed).toBe(true);
  });

  test("submits an argument-free command with tab or enter", () => {
    const selected = { ...state("/sta"), menuSelected: 0 };
    expect(press(selected, { name: "tab" }, "", { commands: [statusCommand] }).action)
      .toEqual({ type: "submit", value: statusCommand.name });
    expect(press(selected, { name: "enter" }, "", { commands: [statusCommand] }).action)
      .toEqual({ type: "submit", value: statusCommand.name });
  });

  test("completes an optional argument command on enter", () => {
    const current = press(state("/new"), { name: "enter" }, "", { commands: [newCommand] }).state;
    expect(current.value).toBe(`${newCommand.name} `);
  });

  test("shift+enter inserts a newline even with the menu open", () => {
    const current = press(state("/new"), { name: "return", shift: true }, "", { commands: [newCommand] }).state;
    expect(current.value).toBe("/new\n");
    expect(current.menuDismissed).toBe(true);
  });

  test("escape dismisses the menu without deleting the draft; editing opens it again", () => {
    const current = press(state("/res", 0), { name: "escape" }, "", { commands }).state;
    expect(current.value).toBe("/res");
    expect(current.cursor).toBe(0);
    expect(current.menuDismissed).toBe(true);
    expect(press(current, { name: "right" }).state.menuDismissed).toBe(true);
    const edited = press({ ...current, cursor: 4 }, {}, "u", { commands }).state;
    expect(edited.value).toBe("/resu");
    expect(edited.menuDismissed).toBe(false);
    expect(press(current, { name: "escape" }, "", { commands }).state.value).toBe("");
  });
});

describe("prompt editor submission and cancellation", () => {
  test("submits the trimmed draft on enter", () => {
    expect(press(state("hello"), { name: "return" }, "").action).toEqual({ type: "submit", value: "hello" });
  });

  test("inserts newlines for shift+enter and alt+enter", () => {
    let current = press(state("a"), { name: "return", shift: true }, "").state;
    expect(current.value).toBe("a\n");
    current = press(current, { name: "enter", meta: true }, "").state;
    expect(current.value).toBe("a\n\n");
    current = press(current, { name: "j", ctrl: true }, "").state;
    expect(current.value).toBe("a\n\n\n");
  });

  test("cancels on ctrl+c and on ctrl+d with an empty draft", () => {
    expect(press(state("text"), { name: "c", ctrl: true }, "").action).toEqual({ type: "cancel" });
    expect(press(createPromptEditorState(), { name: "d", ctrl: true }, "").action).toEqual({ type: "cancel" });
    expect(press(state("text"), { name: "d", ctrl: true }, "").action).toEqual({ type: "none" });
  });

  test("requests an external editor on ctrl+o", () => {
    expect(press(state("text"), { name: "o", ctrl: true }, "").action).toEqual({ type: "compose" });
  });
});

describe("prompt editor mentions", () => {
  const mentions = ["src/main.ts", "src/cli/main.ts", "packages/brand/src/index.ts", "README.md"];

  test("detects mention tokens only at word boundaries", () => {
    expect(mentionTokenAt("fix @src", 8)).toEqual({ start: 4, query: "src" });
    expect(mentionTokenAt("@", 1)).toEqual({ start: 0, query: "" });
    expect(mentionTokenAt("user@host", 9)).toBeNull();
    expect(mentionTokenAt("fix @a b", 7)).toBeNull();
    expect(mentionTokenAt("no mention", 10)).toBeNull();
  });

  test("ranks basename prefixes first, then earlier and shorter paths", () => {
    expect(mentionMatches(mentions, "main")[0]).toBe("src/main.ts");
    expect(mentionMatches(mentions, "index")[0]).toBe("packages/brand/src/index.ts");
    expect(mentionMatches(mentions, "")[0]).toBe("README.md");
    expect(mentionMatches(mentions, "zzz")).toEqual([]);
  });

  test("completes the selected mention with tab or enter", () => {
    const tabbed = press(state("fix @src"), { name: "tab" }, "", { mentions }).state;
    expect(tabbed.value).toBe("fix @src/main.ts ");
    const entered = press(state("@read"), { name: "enter" }, "", { mentions }).state;
    expect(entered.value).toBe("@README.md ");
  });

  test("navigates mentions with up and down, ahead of history", () => {
    let current = press(state("@"), { name: "down" }, "", { mentions, history: ["older"] }).state;
    expect(current.mentionSelected).toBe(1);
    expect(current.historyIndex).toBeNull();
    current = press(current, { name: "up" }, "", { mentions, history: ["older"] }).state;
    expect(current.mentionSelected).toBe(0);
  });

  test("shift+enter still inserts a newline while a mention is open", () => {
    const current = press(state("@read"), { name: "return", shift: true }, "", { mentions }).state;
    expect(current.value).toBe("@read\n");
  });
});

describe("prompt editor reverse search", () => {
  const history = ["Fix parser", "Run tests", "fix docs"];

  test("searches, cycles matches, and accepts one", () => {
    let current = press(createPromptEditorState(), { name: "r", ctrl: true }, "", { history }).state;
    expect(current.search).toEqual({ query: "", index: 0 });
    current = type(current, "fix");
    expect(current.search?.query).toBe("fix");
    current = press(current, { name: "r", ctrl: true }, "", { history }).state;
    expect(current.search?.index).toBe(1);
    current = press(current, { name: "enter" }, "", { history }).state;
    expect(current.value).toBe("fix docs");
    expect(current.search).toBeNull();
  });

  test("cancelling restores the draft", () => {
    let current = state("draft");
    current = press(current, { name: "r", ctrl: true }, "", { history }).state;
    current = type(current, "run");
    current = press(current, { name: "escape" }, "", { history }).state;
    expect(current.search).toBeNull();
    expect(current.value).toBe("draft");
  });

  test("backspace edits the query and ctrl+g cancels", () => {
    let current = press(createPromptEditorState(), { name: "r", ctrl: true }, "", { history }).state;
    current = type(current, "fix");
    current = press(current, { name: "backspace" }, "", { history }).state;
    expect(current.search?.query).toBe("fi");
    current = press(current, { name: "g", ctrl: true }, "", { history }).state;
    expect(current.search).toBeNull();
  });

  test("accepting with no matches keeps the draft", () => {
    let current = state("draft");
    current = press(current, { name: "r", ctrl: true }, "", { history }).state;
    current = type(current, "zzz");
    current = press(current, { name: "enter" }, "", { history }).state;
    expect(current.value).toBe("draft");
  });
});

describe("mention labels and expansion", () => {
  const files = ["src/lexer.ts", "tests/lexer.test.ts", "src/index.ts", "tests/index.ts", "README.md"];
  test("a unique name is inserted short; a shared one keeps its path", () => {
    expect(mentionLabel("src/lexer.ts", files)).toBe("lexer.ts");
    expect(mentionLabel("src/index.ts", files)).toBe("src/index.ts");
    expect(mentionLabel("README.md", files)).toBe("README.md");
  });
  test("only tokens naming a workspace file count, and sending expands them to paths", () => {
    const draft = "Why does @lexer.ts fail but @src/index.ts pass? cc @someone and user@host";
    expect(draftMentions(draft, files).map((mention) => mention.path)).toEqual(["src/lexer.ts", "src/index.ts"]);
    expect(resolveMention("index.ts", files)).toBeNull();
    expect(expandMentions(draft, files)).toBe("Why does @src/lexer.ts fail but @src/index.ts pass? cc @someone and user@host");
  });
});
