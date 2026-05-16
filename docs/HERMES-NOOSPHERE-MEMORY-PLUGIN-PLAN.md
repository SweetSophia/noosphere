# Hermes Noosphere Memory Provider Plan

## Goal

Build a first-class Hermes Agent memory provider plugin that connects Hermes to Noosphere as an independent, inspectable memory system.

The plugin should let Hermes:

- recall relevant Noosphere memory before a turn
- expose explicit Noosphere memory tools to the model
- save selected completed turns and explicit memory writes into Noosphere
- respect Noosphere API-key scopes and restricted tags
- install cleanly through Hermes' memory-provider setup flow

This is a memory provider plugin, not a generic Hermes tool plugin. Hermes' own docs and source route durable memory through `MemoryProvider` under `plugins/memory/<name>/`.

## Confirmed Interfaces

Hermes memory providers implement `agent.memory_provider.MemoryProvider`.

> **Target interface version:** this plan targets the Hermes `MemoryProvider` ABC as documented at `https://hermes-agent.nousresearch.com/docs/developer-guide/memory-provider-plugin` (verified 2026-05-15). The ABC interface is stable within minor versions;Hermes does not yet ship a formal versioned release tag. Implement against the documented interface and test against the Hermes commit that is current at install time.

Required methods:

- `name`
- `is_available()`
- `initialize(session_id, **kwargs)`
- `get_tool_schemas()`
- `handle_tool_call(tool_name, args, **kwargs)`
- `get_config_schema()`
- `save_config(values, hermes_home)`

Useful optional hooks for Noosphere:

- `system_prompt_block()`
- `prefetch(query, session_id="")`
- `queue_prefetch(query, session_id="")`
- `sync_turn(user_content, assistant_content, session_id="")`
- `on_session_end(messages)`
- `on_memory_write(action, target, content, metadata=None)`
- `on_pre_compress(messages)`
- `on_session_switch(new_session_id, ...)`
- `shutdown()`

Important Hermes constraints:

- `is_available()` must not make network calls.
- `sync_turn()` must be non-blocking; use a daemon thread for HTTP writes.
- storage must be profile-scoped through the `hermes_home` kwarg.
- only one external memory provider can be active at a time.
- memory-provider tools return JSON strings, including error responses.

## Target Repository Layout

Add a self-contained Hermes integration to this repo:

```text
hermes-noosphere-memory/
  README.md
  install-hermes.sh
  plugins/
    memory/
      noosphere/
        __init__.py
        plugin.yaml
        README.md
        client.py
        schemas.py
        formatting.py
        skills/
          noosphere/
            SKILL.md
  tests/
    test_noosphere_memory_provider.py
    test_noosphere_client.py
    fixtures/
      recall.json
      topics.json
```

Rationale:

- The `plugins/memory/noosphere/` shape matches Hermes' provider discovery model.
- Keeping it under `hermes-noosphere-memory/` avoids mixing Python Hermes code with the TypeScript OpenClaw plugin.
- The install script can copy or sync `plugins/memory/noosphere` into `$HERMES_HOME/plugins/memory/noosphere`.

## Configuration Design

Use environment variables for secrets and a profile-scoped JSON file for non-secret behavior.

Required setup schema:

```python
[
    {
        "key": "api_key",
        "description": "Noosphere API key",
        "secret": True,
        "required": True,
        "env_var": "NOOSPHERE_API_KEY",
        "url": "<NOOSPHERE_APP_URL>/wiki/admin/keys",
    },
    {
        "key": "base_url",
        "description": "Noosphere base URL",
        "required": True,
        "default": "http://127.0.0.1:6578",
    },
]
```

Write non-secret values to:

```text
$HERMES_HOME/noosphere.json
```

Suggested defaults:

```json
{
  "base_url": "http://127.0.0.1:6578",
  "auto_recall": true,
  "auto_capture": false,
  "capture_mode": "explicit",
  "max_recall_results": 5,
  "token_budget": 1200,
  "providers": ["noosphere"],
  "topic_id": "",
  "author_name_template": "Hermes:{identity}",
  "api_timeout": 5.0
}
```

Default `auto_capture` should start as `false`. Noosphere stores curated/wiki-grade knowledge, so turn capture should be conservative until extraction/summarization policy is explicitly reviewed.

## Noosphere API Mapping

Reuse the API surface already used by the OpenClaw plugin:

- `GET /api/health` for connectivity checks
- `GET /api/memory/status` for memory-system status
- `POST /api/memory/recall` for prompt-ready recall
- `POST /api/memory/get` for canonical memory lookup
- `POST /api/memory/save` for draft memory candidates
- `GET /api/topics` for topic selection
- `POST /api/articles` for direct article creation if explicitly requested

The Hermes plugin should not bypass Noosphere authorization logic. All calls use:

```text
Authorization: Bearer <NOOSPHERE_API_KEY>
```

## Tool Surface

Expose a small explicit tool set first:

- `noosphere_recall`: search durable memory
- `noosphere_save`: save a draft memory candidate
- `noosphere_get`: fetch one canonical memory result
- `noosphere_topics`: list available topics
- `noosphere_status`: check provider availability and current settings

Defer `noosphere_article_create` until the basic flow is proven. Direct publication has a higher quality bar than draft candidate saving.

Each handler must:

- validate arguments locally
- call the Noosphere HTTP API with timeout
- catch all exceptions
- return JSON string output
- avoid leaking API keys in errors or logs

## Provider Behavior

### `is_available()`

Return true only when `NOOSPHERE_API_KEY` exists. Do not call Noosphere here.

### `initialize()`

Load `$HERMES_HOME/noosphere.json`, resolve:

- `hermes_home`
- `session_id`
- `platform`
- `agent_identity`
- `agent_context`

Set `write_enabled = False` for `agent_context in {"cron", "flush", "subagent"}`, matching the safety pattern in Hermes' Supermemory provider.

### `system_prompt_block()`

Inject only static instructions:

- Noosphere memory is active
- explicit tools are available
- use save only for durable, reusable knowledge
- do not save trivial turn state or transient task status

Do not inject recalled memories here. Use `prefetch()`.

### `prefetch(query)`

If `auto_recall` is enabled:

1. call `POST /api/memory/recall`
2. use `mode: "auto"`
3. pass `resultCap`, `tokenBudget`, and configured providers
4. return Noosphere's `promptInjectionText` when present
5. strip any nested memory-context tags before returning

Noosphere already performs ranking, deduplication, conflict handling, and context budgeting. The Hermes plugin should not re-rank results.

### `sync_turn(user, assistant)`

Initial implementation should skip automatic turn capture unless `auto_capture=true`.

When enabled:

- clean any injected memory-context blocks before saving
- skip trivial/tiny turns
- save as a draft memory candidate via `POST /api/memory/save`
- run in a daemon thread
- include metadata in content/source fields where the API supports it

### `on_memory_write(action, target, content, metadata)`

**V1 behavior (conservative — draft-only, no destructive mapping):**

- `action == "add"`: save as a Noosphere draft memory candidate via `POST /api/memory/save`. Never map to `status=published`. The agent (or a human reviewing the draft candidate) decides whether to promote it.
- `action == "replace"` or `action == "delete"`: **do not map to Noosphere mutations**. Noosphere does not yet expose a scoped mutation model with access-control guarantees, so we silently ignore replace/delete to avoid accidentally exposing or deleting wiki content.
- `action` values not in `{"add"}`: silently ignore.
- `target` field: include as metadata/tags in the saved draft, not as a Noosphere article ID.
- `metadata` field: serialize as JSON and include in `source metadata`.
- `agent_identity` from `initialize()`: use as `authorName` on saves.
- `hermes_home`: use as the profile-scoped data directory prefix.

Rationale: Hermes `on_memory_write` carries intentional edits including deletes, but Noosphere's article mutation API lacks a defined access-control model for Hermes-scoped writes. Until that model exists, we only push adds as drafts and treat all other actions as no-ops. This keeps Noosphere wiki content safe from accidental Hermes-side deletes.

### `on_pre_compress(messages)`

Optional phase-two hook. Use it to preserve durable insights before compression, but only after the basic explicit save/recall path is stable.

## Install Flow

Add `hermes-noosphere-memory/install-hermes.sh`.

Installer responsibilities:

1. detect `HERMES_HOME`, defaulting to `$HOME/.hermes`
2. copy `plugins/memory/noosphere` to `$HERMES_HOME/plugins/memory/noosphere`
3. offer to run `hermes memory setup`
4. print exact manual fallback commands:

```bash
hermes config set memory.provider noosphere
echo 'NOOSPHERE_API_KEY=noo_...' >> "$HERMES_HOME/.env"
cat > "$HERMES_HOME/noosphere.json" <<'JSON'
{
  "base_url": "http://127.0.0.1:6578",
  "auto_recall": true,
  "auto_capture": false,
  "capture_mode": "explicit",
  "max_recall_results": 5,
  "token_budget": 1200
}
JSON
```

The installer must never print supplied API keys after entry.

## Documentation Updates

Update these docs after the first implementation:

- `README.md`: add Hermes Agent to the integrations section
- `docs/NOOSPHERE-SKILL.md`: add a Hermes-specific install/use section
- `hermes-noosphere-memory/README.md`: full setup, config, tool, and troubleshooting reference
- `hermes-noosphere-memory/plugins/memory/noosphere/README.md`: Hermes plugin-local reference

The Hermes bundled skill should be short and operational:

- when to recall
- when to save
- how to pick topics
- privacy/scoped-key warnings
- examples of durable vs non-durable memories

## Implementation Phases

### Phase 1: Skeleton and Config

- create `hermes-noosphere-memory/plugins/memory/noosphere/`
- add `plugin.yaml`
- add `__init__.py` with `NoosphereMemoryProvider`
- implement `get_config_schema()`, `save_config()`, `is_available()`, and `initialize()`
- add config load/save helpers

Exit criteria:

- provider loads under Hermes debug plugin discovery
- `hermes memory setup` prompts for API key and base URL
- provider can be selected as `memory.provider noosphere`

### Phase 2: HTTP Client and Status Tool

- implement `client.py` with standard-library `urllib.request`
- centralize auth headers, JSON encoding, timeout, and error formatting
- add `noosphere_status`

Exit criteria:

- status works against a local Noosphere instance
- auth failures produce redacted JSON errors
- no uncaught exception reaches Hermes

### Phase 3: Recall Tools and Auto Recall

- add `noosphere_recall`, `noosphere_get`, and `noosphere_topics`
- implement `prefetch()` using `/api/memory/recall`
- add context formatting/stripping helpers

Exit criteria:

- explicit recall returns structured JSON
- auto recall injects bounded context
- memory-context blocks do not leak recursively into saved content

### Phase 4: Save and Explicit Memory Mirroring

- add `noosphere_save`
- implement `on_memory_write()`
- optionally implement conservative `sync_turn()` behind `auto_capture=true`

Exit criteria:

- explicit memory writes create draft candidates
- trivial turns are skipped
- write hooks are disabled for cron, flush, and subagent contexts

### Phase 5: Installer, Docs, and Skill

- add `install-hermes.sh`
- add Hermes README and plugin README
- add bundled Hermes skill
- update root README and `docs/NOOSPHERE-SKILL.md`

Exit criteria:

- fresh Hermes profile can install and select Noosphere from documented commands
- docs tell users to create scoped per-agent keys in Noosphere admin

### Phase 6: Tests and Release

- unit-test config parsing, argument validation, formatter behavior, and client error handling
- add provider lifecycle tests modeled after Hermes' `MemoryManager` E2E pattern
- add mocked HTTP tests for recall/save/status
- run Noosphere repo checks
- package release notes

Exit criteria:

- Python tests pass
- Noosphere TypeScript checks still pass
- install script shellcheck passes if shellcheck is available

## Test Plan

Minimum local checks:

```bash
python -m pytest hermes-noosphere-memory/tests
bash -n hermes-noosphere-memory/install-hermes.sh
npm run lint
npm run build
```

Hermes integration checks:

```bash
HERMES_PLUGINS_DEBUG=1 hermes plugins list
hermes memory setup
hermes config get memory.provider
hermes
```

Manual prompts:

- "Search Noosphere for the Serianis deployment process."
- "Remember that this Hermes profile uses Noosphere as its durable memory layer."
- "List Noosphere topics."

Noosphere verification:

- `GET /api/memory/status` returns ok
- recall returns bounded `promptInjectionText`
- save creates a draft candidate
- scoped keys cannot read restricted articles outside their allowed scopes

## Risks and Mitigations

- **Over-capturing chat turns:** keep `auto_capture=false` by default and prioritize explicit memory writes.
- **Prompt injection through recalled content:** rely on Hermes memory-context fencing and strip nested fences from provider output.
- **Secret leakage:** never log config values from `.env`; redact Authorization headers and API keys.
- **Provider API drift:** keep the plugin close to Hermes' Supermemory provider shape and add tests around required methods.
- **Scope confusion:** document that access is controlled by Noosphere API-key scopes, not by Hermes itself.
- **Network latency:** use short timeouts and daemon threads for writes; recall failure must degrade to empty context.

## Open Questions Before Implementation

- Should direct article publication be included in v1, or stay draft-only until after field testing?
- Should Hermes profiles map to Noosphere `authorName`, tags, or restricted scopes by default?
- Should the installer support remote Noosphere instances with HTTPS health validation?
- Should Noosphere add a dedicated `/api/memory/capture-turn` endpoint later, instead of storing turns through the generic draft save endpoint?

## Recommendation

Implement v1 as a conservative provider:

- explicit recall
- auto recall
- explicit save
- explicit Hermes memory-write mirroring
- no default turn auto-capture
- draft-only writes

That gives Hermes useful Noosphere memory access without flooding the wiki or bypassing Noosphere's curation model.
