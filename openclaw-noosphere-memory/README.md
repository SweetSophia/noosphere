# Noosphere Memory for OpenClaw

OpenClaw plugin for Noosphere memory over HTTP. It provides explicit memory
tools, optional prompt-time auto-recall, and an optional shared memory corpus
supplement.

## Install

Use OpenClaw's plugin installer:

```bash
openclaw plugins install npm:@sweetsophia/openclaw-noosphere-memory
```

For the full local Noosphere + OpenClaw setup, use the repository installer:

```bash
curl -fsSL https://raw.githubusercontent.com/SweetSophia/noosphere/master/install-openclaw.sh | bash
```

## Configuration

Store API keys outside repository files. The plugin accepts a default API key and
per-agent keys:

```json5
{
  plugins: {
    entries: {
      "noosphere-memory": {
        enabled: true,
        config: {
          baseUrl: "http://127.0.0.1:6578",
          apiKey: { source: "file", provider: "noosphere-memory", id: "/apiKey" },
          autoRecall: true,
          autoProviders: ["noosphere"],
          maxInjectedMemories: 10,
          maxInjectedTokens: 1000,
          recallInjectionPosition: "system-prepend",
          autoRecallTimeoutMs: 5000
        },
        hooks: {
          allowPromptInjection: true
        }
      }
    }
  }
}
```

For multi-agent installs, prefer environment variables:

```bash
NOOSPHERE_API_KEY_CYLENA=noo_...
NOOSPHERE_API_KEY_SHODAN=noo_...
```

The plugin resolves keys in this order:

1. `NOOSPHERE_API_KEY_<AGENT_ID>`
2. `config.apiKeys[agentId]`
3. default `config.apiKey` / `OPENCLAW_NOOSPHERE_API_KEY` / `NOOSPHERE_API_KEY`

Use `OPENCLAW_NOOSPHERE_*` for OpenClaw-wide defaults on machines that also run
Opencode, Kilo Code, or Hermes. The generic `NOOSPHERE_*` variables remain
compatibility fallbacks.

## Tools

- `noosphere_recall` searches durable memory.
- `noosphere_get` retrieves one memory result by canonical ref or provider/id.
- `noosphere_save` creates a draft memory candidate.
- `noosphere_article_create` creates a curated wiki article.
- `noosphere_topics` lists visible topics for the caller's scopes.
- `noosphere_topic_create` creates a topic or subtopic. It requires an ADMIN
  Noosphere API key because topic taxonomy changes affect every caller.
- `noosphere_status` checks health/status. Full memory status requires ADMIN.

Scoped API keys can only assign scopes they already have. When a scoped key saves
without `restrictedTags`, Noosphere defaults the saved content to that key's
allowed scopes.

A narrow key is a READ or WRITE key whose `allowedScopes` contain only the agent,
project, or corpus segment that should be visible to that caller. Avoid using an
ADMIN key or a key with `*` scope for routine agent recall/save operations.

## Auto-Recall

Set `autoRecall: true` and `hooks.allowPromptInjection: true` to enable
`before_prompt_build` recall injection. The plugin config is the local enable
gate: Noosphere DB settings can further disable or tune auto-recall, but cannot
turn it on when the plugin config has `autoRecall: false`.

Auto-recall resolves the API key per agent for each hook invocation. This keeps
prompt-time recall within the same scope boundaries as explicit tool calls.

When `memoryCaptureInstructionsEnabled` is enabled, the hook keeps the static
`noosphere_save` guidance in the prompt when a successful recall returns no
matches. Empty responses that report a provider error still fail open and inject
nothing. This closes the clean recall-miss gap where agents previously received
no reminder to save genuinely new durable information. The guidance remains
advisory; it does not perform an automatic save.

## Corpus Supplement

The shared memory corpus supplement is disabled by default because some OpenClaw
hosts do not provide per-agent identity to corpus calls. To intentionally use the
default API key for shared corpus access, set:

```json5
{
  config: {
    allowDefaultCorpusSupplement: true
  }
}
```

Use a narrow default key if you enable this. The default corpus key should be
READ-only when the shared corpus is used for search only, and its scopes should
exclude private agent/project memory that other agents must not see.

## Release Tags

Package releases use package-specific tag prefixes so independent packages do
not trigger each other's publish jobs:

- `v-openclaw-1.5.7` publishes `@sweetsophia/openclaw-noosphere-memory`
- `v-opencode-0.1.0` publishes `@sweetsophia/opencode-noosphere-memory`

New plugin packages should add their own `v-{package}-*` tag prefix in CI before
they are published.
