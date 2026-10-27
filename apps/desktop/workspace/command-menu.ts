import { SLASH_COMMAND_SECTIONS } from "@demesne/brand";

/// The menu that / and @ open (pass 83 A): one quiet panel like the model
/// picker. Each row has an icon for what the command does, its plain name
/// without the slash, a faint argument, and a short description. Groups are
/// in sentence case; there is no footer.

const ICONS: Record<string, string> = {
  new: "M12 5v14M5 12h14",
  sessions: "M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01",
  resume: "M4 12h13M12 6l6 6-6 6",
  rename: "M4 20h4L19 9l-4-4L4 16zM13 7l4 4",
  delete: "M3 6h18v4H3zM5 10v10h14V10M10 14h4",
  cleanup: "M12 3l1.8 4.2L18 9l-4.2 1.8L12 15l-1.8-4.2L6 9l4.2-1.8zM18 15l.9 2.1L21 18l-2.1.9L18 21l-.9-2.1L15 18l2.1-.9z",
  model: "M7 7h10v10H7zM10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4",
  subagent: "M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM3 20c0-3.3 2.7-5 6-5s6 1.7 6 5M16 5.2a3 3 0 0 1 0 5.6M18 15c2 .6 3 2.2 3 5",
  theme: "M12 3a9 9 0 1 0 0 18c1.1 0 1.5-.8 1.5-1.6 0-1.4.9-2.4 2.3-2.4H18a3 3 0 0 0 3-3c0-6-4.5-11-9-11zM7.5 11h.01M10 7h.01M15 7.5h.01",
  themefy: "M4 20 15 9M14 4v2M18 6h2M19 10v2M16 3l1 1",
  providers: "M15 7a4 4 0 1 1-3.4 6.1L5 19.7V17h2v-2h2l2.6-2.6A4 4 0 0 1 15 7z",
  status: "M3 12h4l3-8 4 16 3-8h4",
  context: "M21 12a9 9 0 1 1-9-9M12 12l6-6M21 3v6h-6",
  export: "M12 4v11M7 10l5 5 5-5M5 20h14",
  diff: "M12 4v16M5 8h4M7 6v4M15 15h4",
  plan: "M10 6h10M10 12h10M10 18h10M4 6l1.2 1.2L7.5 5M4 12l1.2 1.2L7.5 11M4 18l1.2 1.2L7.5 17",
  drive: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM3.5 10.5 9 11.5M15 11.5l5.5-1M12 15v6",
  undo: "M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11",
  compact: "M4 6h16M4 10h16M8 15l4 4 4-4M12 13v6",
  clear: "M20 11a8 8 0 0 0-14.6-4.5L4 8M4 13a8 8 0 0 0 14.6 4.5L20 16M4 4v4h4M20 20v-4h-4",
  help: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9.5 9.5a2.5 2.5 0 1 1 3.3 2.4c-.5.2-.8.6-.8 1.1v.5M12 17h.01",
  exit: "M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10",
  // Your own workflows and commands, files for @, and anything new.
  workflow: "M6 4v6a4 4 0 0 0 4 4h8M14 10l4 4-4 4M6 20h.01",
  custom: "M8 9l-4 3 4 3M16 9l4 3-4 3M13 6l-2 12",
  file: "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5",
  command: "M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3z",
};

/** The icon for a command id ("compact", "workflow:ship", "custom:x"), a
 *  file, or anything else. */
export function commandIcon(id: string): string {
  const key = id.startsWith("workflow:") ? "workflow" : id.startsWith("custom:") ? "custom" : ICONS[id] ? id : "command";
  return `<svg class="cm-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="${ICONS[key]}"/></svg>`;
}

/** A command's name as the menu draws it: no leading slash. */
export const plainName = (name: string) => name.replace(/^\//, "");

/** A section name in sentence case: "SESSION" → "Session", "YOUR WORKFLOWS" → "Your workflows". */
export const groupWords = (group: string) => (group ? group[0]!.toUpperCase() + group.slice(1).toLowerCase() : "");

/** A command group's heading ("turn" → "The last turn"), and its place in
 *  the menu's fixed order; unknown groups go last. */
export const sectionTitle = (id: string) => SLASH_COMMAND_SECTIONS.find((section) => section.id === id)?.title ?? groupWords(id);
export const sectionRank = (id: string) => { const at = SLASH_COMMAND_SECTIONS.findIndex((section) => section.id === id); return at < 0 ? SLASH_COMMAND_SECTIONS.length : at; };
