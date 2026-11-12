import { isRecord, type Routine } from "@demesne/protocol";
import { parseRoutine, whenWords, type Routines } from "./routines.ts";
import { toolError, type AgentTool, type ToolContext } from "./tools.ts";

/// Routines from the chat: "check my PRs every morning" said in any chat
/// makes the routine the Scheduled page would, in this chat's project (or as
/// Just a chat outside one). Making, pausing and removing ask first, like an
/// edit; listing doesn't.

export const ROUTINE_TOOL = "routine";
const ACTIONS = ["add", "list", "pause", "resume", "remove"] as const;
type Action = typeof ACTIONS[number];

/// What a result says about one routine; the chat's card reads it back.
export function routineView(routine: Routine) {
  return { id: routine.id, when: routine.when ?? whenWords(routine), prompt: routine.prompt, on: routine.on, project: routine.workspace, next: routine.next ?? null, runs: routine.runs.length };
}

export function routineTool(routines: () => Routines | undefined, projectOf: (context: ToolContext) => string | null): AgentTool {
  return {
    definition: {
      name: ROUTINE_TOOL,
      description: "Routines: chats that start on their own at a set time (the Scheduled page). Use when the user asks for something to happen on a schedule (\"every morning…\", \"each Friday at 5…\", \"remind me weekdays at 9…\"). add takes one sentence, when first then what: \"Every weekday at 9, list the PRs waiting on me\". Days: every day/morning/evening, weekdays, weekends, or named days; a time like 9, 17:30, 8am, noon. The what is the first message of a fresh chat in this project at that time, so write it to stand alone. list shows this project's routines with their ids; pause, resume and remove take an id. Not for one-off waits inside this turn.",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: [...ACTIONS] },
          text: { type: "string", minLength: 1, maxLength: 600, description: "add: the routine sentence, when first then what" },
          id: { type: "string", description: "pause, resume, remove: the routine's id from list" },
        },
        required: ["action"],
        additionalProperties: false,
      },
    },
    permission(input) {
      if (!isRecord(input) || input.action === "list") return null;
      if (input.action === "add") {
        const text = typeof input.text === "string" ? input.text : "";
        const parsed = parseRoutine(text);
        return { kind: "write", summary: "error" in parsed ? `Make a routine: ${text.slice(0, 100)}` : `Make a routine: ${whenWords(parsed)}, ${parsed.prompt.slice(0, 90)}` };
      }
      const verb = input.action === "pause" ? "Pause" : input.action === "resume" ? "Resume" : "Remove";
      const found = typeof input.id === "string" ? routines()?.list().find((routine) => routine.id === input.id) : undefined;
      return { kind: "write", summary: `${verb} the routine ${found ? `${found.when}, ${found.prompt.slice(0, 80)}` : String(input.id ?? "").slice(0, 40)}` };
    },
    async execute(input, context) {
      const all = routines();
      if (!all) throw toolError("NO_ROUTINES", "routines aren't running in this daemon", "tell the user to use the Scheduled page");
      if (!isRecord(input) || !ACTIONS.includes(input.action as Action)) throw toolError("BAD_ACTION", "routine needs an action", `use one of ${ACTIONS.join(", ")}`);
      const action = input.action as Action, project = projectOf(context);
      const here = () => all.list().filter((routine) => !routine.assistant && routine.workspace === project);
      if (action === "list") {
        const mine = here();
        return JSON.stringify({ project, routines: mine.map(routineView), ...(mine.length ? {} : { note: "No routines here yet." }) });
      }
      if (action === "add") {
        if (typeof input.text !== "string" || !input.text.trim()) throw toolError("MISSING_TEXT", "add needs the routine sentence", "pass text like \"Every weekday at 9, list the PRs waiting on me\"");
        const added = all.add(input.text, project);
        if ("error" in added) throw toolError("CANT_READ", added.error, "say when first, then a comma, then what to do");
        return JSON.stringify({ routine: "added", ...routineView(added) });
      }
      const id = typeof input.id === "string" ? input.id.trim() : "";
      if (!id) throw toolError("MISSING_ID", `${action} needs the routine's id`, "call routine with action list to find it");
      if (!here().some((routine) => routine.id === id)) throw toolError("NOT_FOUND", "no routine here has that id", "call routine with action list; another project's routines are changed there or on the Scheduled page");
      if (action === "remove") {
        const gone = all.list().find((routine) => routine.id === id)!;
        all.remove(id);
        return JSON.stringify({ routine: "removed", ...routineView(gone) });
      }
      const changed = all.set(id, action === "resume")!;
      return JSON.stringify({ routine: action === "pause" ? "paused" : "resumed", ...routineView(changed) });
    },
  };
}
