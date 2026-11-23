# The plan checklist

On a task of several steps the model calls `update_plan` with its steps, then
again as each one completes. The chat draws the newest list as the checklist
ribbon at the top of the turn (pass 226 A, `apps/desktop/workspace/plan-ribbon.ts`);
once the turn ends it shrinks into a small pill ("5 steps").

## How many steps

The count is the model's own call, sized to the work: two steps for a small
fix, ten or more for a large change, up to 20. A quick or one-step ask gets no
checklist at all.

Until 2026-11-23 the system prompt and the tool's description both said "on a
task of 3 or more distinct steps". Models read that threshold as a target, and
nearly every plan came out with exactly three steps. Nothing in the window
clamped the list; the number in the words did. Both now say there is no set
or target count, and a test (`apps/daemon/test/plan.test.ts`) fails if a
threshold like "3 or more" comes back.

The schema still allows 1 to 20 steps; over 20 the tool asks the model to group
them into fewer, larger ones.

## Read more

- [Anchoring effect](https://en.wikipedia.org/wiki/Anchoring_effect): why a number in the instructions pulls answers toward it, in people and in language models.
- [Plan-and-Solve prompting (Wang et al., 2023)](https://arxiv.org/abs/2305.04091): asking a model to split a task into its own subtasks before solving it.
- [Least-to-most prompting (Zhou et al., 2022)](https://arxiv.org/abs/2205.10625): breaking a problem into as many simpler subproblems as it needs.
- [Be clear and direct (Anthropic prompt engineering guide)](https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering/be-clear-and-direct): writing instructions that say what you mean, without accidental examples or numbers.
- [Task analysis](https://en.wikipedia.org/wiki/Task_analysis): the human-factors idea of breaking work into steps at the right grain.
