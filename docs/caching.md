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
| A turn that ran out of its allowance | a note on its own before the last request |

A note says what changed; it does not decide what is allowed. Plan mode,
`open`, `show` and `ask_user` stay in the tool list on every turn, and a call
that the turn may not make is refused where it runs, with a reason the model
can act on. A switch flipped while the model is working applies to its next
action at once; the model is told with the next message.

Notes are stored beside the message, not in it, so search, exports and the
notes of a compacted turn read only what you wrote. When older turns are
compacted away, the notes they carried go with them and are said again.

## The last request of a turn

A turn may make only so many model requests and tool calls (`[agent]` in the
config). When it runs out, one more request asks the model to report where it
stands. That request used to go out with no tools and with a sentence added
to the instructions: both are at the very start, so the longest request of
the turn was read again whole, and so was the first request of the follow-up.

Now it starts exactly like the request before it, tools and all. What is new
is a note at the end: this is the last request, tools are not run in it,
report what was done and what is left. A tool the model asks for anyway is
not run, and what it wrote beside the call is the turn's last word. A
sub-agent's last round keeps its tools the same way.

Two side requests deliberately do not share a chat's start. Naming a chat
sends only the first message and its answer, which is cheaper than reading
the chat from cache. Compaction is stitched from each turn's hidden notes, and a model is
asked only when those are too long.

Not fixed yet: Orchestrate turned on or off mid-chat.

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
- `recall_turn` and `read_source` are in every chat's list from the start,
  not added when a chat first compacts or gets its first source.
- Some tools still wait as one line each in the instructions: tools from MCP
  servers always (there can be any number of them), and Demesne's own beyond
  the everyday ones on a small window, where their descriptions would crowd
  the conversation. A waiting tool never joins the list. Two tools that are
  in the list from the start stand in for all of them
  (`apps/daemon/src/tool-search.ts`):
  - `tool_search` answers with how a tool is called (its description and
    parameters). That answer is a tool result at the end of the
    conversation, so it is cached from then on like any other.
  - `use_tool` calls it: `{"name": "mcp__linear__list_issues", "input": {…}}`.
    A first call for a tool the chat has not been shown is answered with its
    parameters and not run.
  - What a tool needs said with it comes the same way: Foundry's design
    guide is in the instructions when `foundry_save` is in the list, and in
    the answer that shows how it is called when it waits.

  Everything past the model's call sees the real tool: the step in the chat,
  its approval, plan mode, the checks, and what later reads the conversation
  (notes, what to forget). What a chat has been shown is read from the
  conversation itself, so it holds across a restart and is shown again after
  compaction took those turns away. This matters most for a local model:
  there a changed start is not a higher price but a wait, while the machine
  reads the whole chat again.

## Old turns are shortened only when the cache is cold

A chat can't carry everything forever: long file reads, a Foundry page's
whole source and pictures all take room. But a provider's cache holds the
conversation as it was sent, so shortening a turn it still holds makes it
read everything after that turn again. Two rules follow:

- **Shorten when it costs nothing.** Old reads and the source of old Foundry
  pages leave together, at one cut that moves only when the chat has sat
  idle long enough for the cache to be gone anyway, and never into the last
  two turns (`apps/daemon/src/forget-reads.ts`). A warm cache is given up
  only when the pile a cut would take off is huge: 480k characters, or 40%
  of the model's window on a smaller one, where the alternative is a
  compaction that rewrites everything. A page's source used to
  leave as soon as its turn was over, which cost the request after every
  page.
- **Shorten in blocks.** A model that sees gets the newest pictures with the
  conversation. Keeping "the latest two" dropped one each time a new one
  arrived, a rewrite per picture. Now two to four ride along and the older
  ones leave three at a time (`apps/daemon/src/image-inputs.ts`), so a turn
  that looks at a page again and again rewrites a third as often.

## The cache clock

"Cold" used to be a guess: 15 minutes before old turns were cut, 10 before
a chat compacted while you were away, the same for every provider. Now one
place knows how long each provider keeps its cache
(`apps/daemon/src/cache-clock.ts`), and both wait for it.

| Provider | Keeps its cache |
| --- | --- |
| GPT-5.6 and later | 30 minutes; 12 hours when asked, which Demesne does on the Codex and ChatGPT plan routes |
| Claude, Gemini, earlier GPT models, anything else by key | 5 minutes |
| A model on your own machine | until another request takes its slot: time alone never makes it cold |

- **The published figure comes first.** Each provider adapter says what its
  provider promises (`cacheLifeMs`).
- **Demesne asks for the long lifetime.** On GPT-5.6 and later every request
  carries `prompt_cache_options: {"ttl": "12h"}`, so a chat you come back to
  after lunch still reads from its cache. The plan routes are not the public
  API, so the first request that asks is watched: if it is refused before
  the model says anything, the same request goes out once more without the
  option, and it is not asked for again until Demesne restarts. A request
  that fails for a reason nobody can name counts against the option too:
  two of those and the asking stops, so it can never keep a provider failing.
- **What is measured corrects it.** The cache meter records how long a chat
  sat idle before each request and whether the request repeated the one
  before it. A request that repeated everything and still read nothing
  shows the cache was gone by then; one that read it shows it was alive.
  From the last 14 days, per provider and model: the cache is taken to be
  gone from the first wait after which most requests missed (at least three
  of them), and alive at least as long as most were seen to hit. A provider
  that never reports a cache read is left at its published figure.

With this, 20 minutes away from a GPT-6 chat no longer costs anything: the
old turns stay as they were and the whole chat is read from cache.

## Every provider

A provider caches only what it is asked to, on the machine the request
lands on. So each chat carries its own key, and the models that do not cache
by themselves are asked to (`packages/providers/src/index.ts`):

| Where | What goes with each request |
| --- | --- |
| Codex and the ChatGPT plan | the chat's key, and the 12-hour cache (above) |
| OpenRouter, any model | the chat's key as `session_id`, so the chat stays on the provider that holds its cache: OpenRouter spreads a model over several, each with a cache of its own |
| OpenRouter, Claude | `cache_control` at the top of the request: OpenRouter marks the last block and moves the mark on as the chat grows |
| OpenRouter, Qwen and DeepSeek served by Alibaba | the instructions and the newest message marked with `cache_control` |
| OpenAI by key | the chat's key as `prompt_cache_key` |
| Gemini, DeepSeek, Grok and the rest by key | nothing: they cache a repeated start by themselves |
| A model on your own machine | nothing: llama.cpp, LM Studio and Ollama keep the last prompt in the slot that served it |

If a model refuses a request that asks it to cache, the same request goes
out once more without the ask, and that model is not asked again until
Demesne restarts. A request that fails both ways reports its own error.

Old tool results are no longer shortened below the window on any provider:
that used to happen for providers by key, as if they had no cache, and made
them read everything after the shortened turn again.

What each provider wrote to its cache is kept where it says so
(`cache_write_tokens`; OpenRouter reports Claude's and Qwen's).

Not done: pinning each chat to its own slot on llama.cpp. The server already
sends a request to the slot whose prompt it repeats most, and a pinned slot
would take another chat's place when there are more chats than slots.

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
pictures, the permission mode, stepping away for less and for more than the
cache's lifetime), then a short second chat on a small
window that calls a waiting tool through `use_tool` and a third whose turn
runs out of its allowance, and prints what each
request kept. It runs with the tests. Today a cache could reuse 93% of what
those chats send, of the 94% that repeats at all: the first request of each
of the three chats has nothing before it (one chat alone: 95%; 56% at first,
86% with the fixed start). One request still
breaks the prefix, by design: the first after 45 minutes away from a model
that keeps its cache 30, when the cache is gone and the old turns are
shortened. The one after 20 minutes away keeps everything.

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
- [Code execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp): why a tool's definition is better read when it is needed than sent with every request.
- [Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- [OpenRouter prompt caching](https://openrouter.ai/docs/guides/best-practices/prompt-caching): which models cache by themselves, `cache_control`, and sticky routing by `session_id`.
- [KV cache reuse with llama-server](https://github.com/ggml-org/llama.cpp/discussions/13606): slots, and how a request finds the one that holds its prompt.
- [Context engineering for AI agents: lessons from building Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)
