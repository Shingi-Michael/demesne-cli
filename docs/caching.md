# Prompt caching

Every model round resends the whole chat. A provider keeps the work it did on
the previous request for a while, and reuses it for the part of the next
request that repeats it **from the first byte**: the instructions, then the
tool list, then the conversation. One changed character near the start and
everything after it is read again at full price and full time. On a model on
your own machine a miss costs no money, it costs the wait.

So the rule for Demesne is: the start of a chat stays the same, new things go
at the end, and nothing already sent is rewritten while the cache is warm.

## One fixed start per chat

A chat's instructions and its tool list are the same for every request, from
its first message to its last. Nothing that can change during a chat lives
there. What changes is told to the model as a **note**: a short
`<system-note>` after the text of the message it came with, kept with that
message from then on (`apps/daemon/src/chat-notes.ts`). The conversation only
grows at its end, so the provider's cache of everything before it holds.

| What changed | How the model learns it |
| --- | --- |
| Plan mode on or off | a note with every message while it is on, one when it goes off |
| Auto-approve, Accept edits | a note when it changes |
| Nobody is at the window (Drive, a routine, a turn that runs on its own) | a note when it changes |
| What Drive and the other agents are doing | a note when it changes |
| The sources you keep with the chat | a note when the list changes |
| An ask that reads like an overview | a hint with that message |
| A chat long enough to need its hidden turn notes | a note with every message from then on |

A note says what changed; it does not decide what is allowed. Plan mode,
`open`, `show` and `ask_user` stay in the tool list on every turn, and a call
that the turn may not make is refused where it runs, with a reason the model
can act on. A switch flipped while the model is working applies to its next
action at once; the model is told with the next message.

Notes are stored beside the message, not in it, so search, exports and the
notes of a compacted turn read only what you wrote. When older turns are
compacted away, the notes they carried go with them and are said again.

Not fixed yet: Orchestrate turned on or off mid-chat, and the last request
of a turn that ran out of its allowance.

## Tools never join the list later

The tool list is at the very start of a request, before the conversation. A
tool added to it mid-chat makes the provider read the whole chat again, so
the list a chat starts with is the list it keeps:

- On a model with a large window (about 85k tokens and up) all of Demesne's
  own tools go out whole from the first request, Foundry's and its design
  guide included. That is about 7,500 more tokens per request, read from
  cache after the first at a tenth of the price (on the Codex plan cached
  input counts a tenth of fresh input, and cache writes are free), where
  loading one tool used to cost the whole chat once.
- On a small window, where the descriptions would crowd the conversation,
  the tools beyond the everyday ones still wait behind `tool_search`
  (`apps/daemon/src/tool-search.ts`), and a load still costs the cache once.
- `recall_turn` and `read_source` are in every chat's list from the start,
  not added when a chat first compacts or gets its first source.
- Tools from MCP servers always wait behind `tool_search`: there can be any
  number of them. Loading one still changes the list; that is the next part
  of this step.

## The cache meter

Each model request is compared with the one before it in the same chat
(`apps/daemon/src/cache-prefix.ts`). The provider call keeps the finding
(`provider_calls.prefix_json`, `prefix` on the call's snapshot):

- `keptChars` of `previousChars`: how much of the previous request this one
  repeats from its first byte, which is all a cache can reuse;
- `brokeAt`: `instructions`, `tools` or `history` when something earlier
  changed, with a `cause` in a sentence ("The tool list changed: added
  git_history");
- `idleMs`: how long since the previous request.

Where a provider reports what it wrote to its cache, that is kept too
(`cache_write_tokens`), so a first write can be told from a miss.

## The prefix check

`bun scripts/check-cache-prefix.ts` runs one scripted chat through the real
engine with a stand-in model, flipping everything that could change a request
(a tool beyond the everyday ones, plan mode, auto-approve, a Foundry page,
the permission mode, stepping away), and prints what each request kept. It
runs with the tests. Today a cache could reuse 94% of what that chat sends
(56% at first, 86% with the fixed start); 95% is the most it could with
nothing rewritten.

`KNOWN` in that script lists the breaks that exist today, each with the step
of the caching plan that removes it. The check fails when a request breaks
the prefix and is not listed, and when a listed break no longer happens, so
the list only gets shorter.

If your change fails it: keep the instructions and the tool list as they
were, and say what changed in a note (`noteStates` in
`apps/daemon/src/chat-notes.ts`).

## The report

`bun scripts/cache-report.ts [--db demesne.sqlite] [--days 14]` reads your own
history, read-only: the share of input read from cache per model, how that
share falls with the time a chat sat idle (how long each provider really
keeps its cache), and the requests that lost a cache, grouped by why.

## Read more

- [How Claude Code uses prompt caching](https://code.claude.com/docs/en/prompt-caching): prefixes, what breaks them, what keeps them. Its `<system-reminder>` messages are what Demesne's notes are modelled on.
- [Lessons from building Claude Code: prompt caching is everything](https://claude.com/blog/lessons-from-building-claude-code-prompt-caching-is-everything)
- [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)
- [Codex rate card](https://help.openai.com/en/articles/20001106-codex-rate-card-2): what cached input costs against a plan.
- [Tool search](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool): deferring rarely used tools, and why the list they join matters.
- [Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- [Context engineering for AI agents: lessons from building Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)
