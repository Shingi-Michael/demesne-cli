# Prompt caching

Every model round resends the whole chat. A provider keeps the work it did on
the previous request for a while, and reuses it for the part of the next
request that repeats it **from the first byte**: the instructions, then the
tool list, then the conversation. One changed character near the start and
everything after it is read again at full price and full time. On a model on
your own machine a miss costs no money, it costs the wait.

So the rule for Demesne is: the start of a chat stays the same, new things go
at the end, and nothing already sent is rewritten while the cache is warm.

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
(loading a tool, plan mode, a Foundry page, the permission mode, stepping
away), and prints what each request kept. It runs with the tests.

`KNOWN` in that script lists the breaks that exist today, each with the step
of the caching plan that removes it. The check fails when a request breaks
the prefix and is not listed, and when a listed break no longer happens, so
the list only gets shorter.

If your change fails it: keep the instructions and the tool list as they
were, and add what changed as a message at the end of the conversation.

## The report

`bun scripts/cache-report.ts [--db state.sqlite] [--days 14]` reads your own
history, read-only: the share of input read from cache per model, how that
share falls with the time a chat sat idle (how long each provider really
keeps its cache), and the requests that lost a cache, grouped by why.

## Read more

- [How Claude Code uses prompt caching](https://code.claude.com/docs/en/prompt-caching): prefixes, what breaks them, what keeps them.
- [Lessons from building Claude Code: prompt caching is everything](https://claude.com/blog/lessons-from-building-claude-code-prompt-caching-is-everything)
- [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)
- [Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- [Context engineering for AI agents: lessons from building Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)
