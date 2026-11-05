# Skills

A skill is saved know-how: a folder with a `SKILL.md` that says when to use it and lists the steps.

```markdown
---
name: rebuild-demesne
description: Use when Mike asks to rebuild, reinstall or update the Mac app.
---
1. Build in ~/projects/demesne-cli-build from origin/main.
2. Keep the old app as Demesne.app.prev-<time>.
3. Open the new app and check /healthz shows the new commit.
```

## Where they live

- The project's skills are in `.demesne/skills/<name>/SKILL.md`.
- Your skills are in `~/.demesne/skills/<name>/SKILL.md` and apply in every project.
- When a project skill and one of yours share a name, the project's skill is used.

## How the model uses them

- Every request carries only each skill's name and its `description` line.
- When a task matches, the model calls `use_skill` with the name, gets the steps and follows them. The step shows in the chat as **Using skill** with the skill's name.
- Each use is counted in `~/.demesne/skill-uses.json`.
- If the steps name a path in `code` that no longer exists, the model is told so and offers to update the skill.

## Saving one

- Ask the model to save something as a skill.
- The model also offers on its own, in one line, when the same steps work in a chat for the second time.
- On yes, it writes the `SKILL.md` into the project.

## Editing

**Customize** lists every skill under **Skills**. Each row shows:

- what the skill is for
- whether it belongs to the project or is yours
- how often it was used, and when it was last used
- any path it names that is gone

Edit unfolds the file in place. The row at the bottom starts a new skill.
