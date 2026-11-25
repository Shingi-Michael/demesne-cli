import { expect, test } from "bun:test";
import { assembleDrawings, cleanHTML, drawSystem, drawWithModels, modelLabel, modelsDefinitionFor, MODELS_MAX_OTHERS, parseModelsInput, readDrawing, scopedCSS, tabNames } from "../src/foundry-models.ts";

// Piece 3 of pass 274, every model draws it: one brief, a take from each
// connected model, back as tabs of one mockup named by who drew them.

const MODELS = [{ id: "claude-opus-5", provider: "anthropic" }, { id: "claude-haiku-5", provider: "anthropic" }, { id: "openai/gpt-6.2", provider: "openai" }, { id: "gpt-6.2-mini", provider: "openai" }, { id: "gemini-3-pro", provider: "google" }];
const drawing = (name: string, accent = "#0f766e") => ({ name, html: `<main><h1>Book a visit</h1><button class="go">Book 10:30</button></main>`, css: `:root{--accent:${accent}} body{padding:40px} .go{background:var(--accent)}`,
  what: "A booking page for patients.", parts: [{ name: "Heading", says: "Says what you are doing." }, { name: "Book button", says: "Books the time." }], why: "One thing to do." });
const BRIEF = "A booking page for Harbor Clinic's patients: pick a day and a time with Dr. Okafor in two taps, at desktop width.";

test("the tool is offered only when another model is connected, and lists the others", () => {
  expect(modelsDefinitionFor([MODELS[0]!], "claude-opus-5")).toBeNull();
  const definition = modelsDefinitionFor(MODELS, "claude-opus-5")!;
  expect(definition.name).toBe("foundry_models");
  expect(definition.description).toContain("never use it unasked");
  expect(JSON.stringify(definition.inputSchema)).toContain('"enum":["claude-haiku-5","openai/gpt-6.2","gpt-6.2-mini","gemini-3-pro"]');
});

test("by default one model of each other provider draws; named models are used as named; unknown ones are refused", () => {
  const input = { title: "Booking page", description: "Pick a time and book it.", brief: BRIEF, mine: drawing("Days first") };
  expect(parseModelsInput(input, MODELS, "claude-opus-5").ask.map((model) => model.id)).toEqual(["openai/gpt-6.2", "gemini-3-pro"]);
  expect(parseModelsInput({ ...input, models: ["gpt-6.2-mini"] }, MODELS, "claude-opus-5").ask.map((model) => model.id)).toEqual(["gpt-6.2-mini"]);
  // Only one provider: its other models stand in.
  expect(parseModelsInput(input, MODELS.slice(0, 2), "claude-opus-5").ask.map((model) => model.id)).toEqual(["claude-haiku-5"]);
  expect(() => parseModelsInput({ ...input, models: ["llama"] }, MODELS, "claude-opus-5")).toThrow("llama is not another model here");
  expect(() => parseModelsInput({ ...input, brief: "A page." }, MODELS, "claude-opus-5")).toThrow("brief is too short");
  expect(() => parseModelsInput({ ...input, mine: { name: "x" } }, MODELS, "claude-opus-5")).toThrow("mine: the drawing has no html");
  expect(() => parseModelsInput(input, [MODELS[0]!], "claude-opus-5")).toThrow("[unavailable]");
  expect(MODELS_MAX_OTHERS).toBe(3);
});

test("a model's answer is read as a drawing, with or without a fence or words around it", () => {
  const json = JSON.stringify(drawing("Slots first"));
  expect(readDrawing(json).name).toBe("Slots first");
  expect(readDrawing("Here is my take:\n```json\n" + json + "\n```\n\n(Sub-agent on gpt-6.2 used 0 tool calls.)").parts).toHaveLength(2);
  expect(() => readDrawing("I would rather not.")).toThrow("answered without a drawing");
  expect(() => readDrawing("{ not json }")).toThrow("not valid JSON");
  expect(() => readDrawing('{"name":"x","html":"<script>1</script>"}')).toThrow("no html");
  // Missing words are filled in so the walkthrough holds.
  expect(readDrawing('{"html":"<p>Hi</p>"}')).toMatchObject({ name: "Take", css: "", what: "One take on the brief." });
});

test("a fragment is cleaned: no document wrappers, scripts, stylesheets, handlers or options of its own", () => {
  expect(cleanHTML(`<!doctype html><html><head><title>x</title><link rel="stylesheet" href="a.css"><style>p{color:red}</style></head><body class="b"><script>alert(1)</script><main onclick="go()" data-option="A"><p>Hi</p></main><d-compare></d-compare></body></html>`))
    .toBe("<main><p>Hi</p></main>");
});

test("a stylesheet is held under its own tab: rules inside @scope, :root and body as :scope, keyframes outside, imports dropped", () => {
  const scoped = scopedCSS(`@import url("https://x/y.css"); /* note */ :root{--accent:#7c3aed} html, body { margin:0; background:var(--paper) } .go{color:red} @keyframes rise{from{opacity:0}to{opacity:1}} @media (max-width:700px){ body .card{padding:8px} } </style><b>`);
  expect(scoped.startsWith("@keyframes rise{from{opacity:0}to{opacity:1}}\n@scope{")).toBe(true);
  expect(scoped).toContain(":scope{--accent:#7c3aed}");
  expect(scoped).toContain(":scope, :scope { margin:0; background:var(--paper) }");
  expect(scoped).toContain(":scope .card{padding:8px}");
  expect(scoped).toContain(".go{color:red}");
  expect(scoped).not.toContain("@import");
  expect(scoped).not.toContain("</style");
  // Words that merely contain "body" are left alone.
  expect(scopedCSS(".tbody-row{color:red} .card body-copy{x:1}")).toContain(".tbody-row{color:red}");
});

test("every take becomes a tab named by its model, with its own walkthrough", () => {
  expect(modelLabel("openai/gpt-6.2")).toBe("GPT-6.2");
  expect(modelLabel("claude-opus-5-20261101")).toBe("Claude-opus-5");
  const drawn = [{ model: "claude-opus-5", drawing: drawing("Days first") }, { model: "openai/gpt-6.2", drawing: drawing("Slots first", "#155e75") }, { model: "gpt-6.2", drawing: drawing("Slots first") }];
  expect(tabNames(drawn)).toEqual(["Claude-opus-5 · Days first", "GPT-6.2 · Slots first", "GPT-6.2 · Slots first 2"]);
  const { source, walkthrough } = assembleDrawings('Booking "page"', drawn);
  expect(source).toContain("<title>Booking &quot;page&quot;</title>");
  expect(source).toContain('<d-compare recommended="Claude-opus-5 · Days first">');
  expect(source.match(/<section data-option=/g)).toHaveLength(3);
  expect(source).toContain('<section data-option="GPT-6.2 · Slots first" data-by="openai/gpt-6.2"><style>\n@scope{\n:scope{--accent:#155e75}');
  expect(walkthrough.map((one) => one.option)).toEqual(tabNames(drawn));
  expect(walkthrough[1]).toMatchObject({ what: "A booking page for patients.", why: "One thing to do." });
});

test("the round: all asked models draw at once, a model that fails is left out and named, and the mockup is saved once", async () => {
  const input = parseModelsInput({ title: "Booking page", description: "Pick a time and book it.", brief: BRIEF, mine: drawing("Days first"), models: ["openai/gpt-6.2", "gemini-3-pro", "gpt-6.2-mini"] }, MODELS, "claude-opus-5");
  const asked: string[] = [], saves: string[] = [];
  const result = JSON.parse(await drawWithModels(input, "claude-opus-5", {
    draw: async (model, prompt) => {
      asked.push(model.id);
      expect(prompt).toContain(BRIEF);
      if (model.id === "gemini-3-pro") throw new Error("the provider is resting");
      if (model.id === "gpt-6.2-mini") return "Sorry, no.";
      return JSON.stringify(drawing("Slots first"));
    },
    save: async (source, walkthrough) => { saves.push(source); expect(walkthrough).toHaveLength(2); return JSON.stringify({ id: "a1", title: "Booking page", kind: "html", version: 1 }); },
  }));
  expect(asked.sort()).toEqual(["gemini-3-pro", "gpt-6.2-mini", "openai/gpt-6.2"]);
  expect(saves).toHaveLength(1);
  expect(result).toMatchObject({ id: "a1", version: 1, drawn_by: ["Claude-opus-5 · Days first", "GPT-6.2 · Slots first"], could_not_draw: ["Gemini-3-pro: the provider is resting", "GPT-6.2-mini: it answered without a drawing"] });
  // Nobody else could draw: nothing is saved, and the chat's model is told to save its own.
  await expect(drawWithModels(input, "claude-opus-5", { draw: async () => { throw new Error("offline"); }, save: async () => { throw new Error("never"); } })).rejects.toThrow(/\[unavailable\] No other model could draw it[\s\S]*foundry_save/);
});

test("what another model is told: one page, one JSON object, the design guide after", () => {
  const system = drawSystem("# Design guide\n1. Direction first");
  expect(system).toContain("Draw ONE page");
  expect(system).toContain("Reply with one JSON object and nothing else");
  expect(system.endsWith("# Design guide\n1. Direction first")).toBe(true);
});
