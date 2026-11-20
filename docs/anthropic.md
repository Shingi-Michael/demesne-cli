# Direct Anthropic API access

Set `ANTHROPIC_API_KEY` in the environment of the Demesne daemon, then add this section to your user TOML config and reload or restart the daemon. A desktop app launched from Finder may not inherit your terminal environment; alternatively set `api_key` in the private user config, never in a shared project. This uses Anthropic API billing, not a Claude Code subscription or OpenRouter balance.

```toml
[additional_providers.anthropic]
id = "Anthropic"
url = "https://api.anthropic.com/v1"
model = "claude-sonnet-4-6"
context_window = 200000
max_output_tokens = 8192
```

Choose a model available to your key and limits it supports. To use Anthropic as the primary provider, use `[provider]` instead of `[additional_providers.anthropic]`.

The native Messages adapter asks for automatic five-minute prompt caching. Anthropic matches the unchanged prefix (tools, system, then message history); eligibility depends on the model’s minimum prompt length. A short first request may show neither reads nor writes. Demesne counts cache reads and writes separately and includes both in total input tokens. See [Anthropic’s prompt caching guide](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) for thresholds and pricing.
