# Noosphere Memory Provider for Hermes Agent

This package contains the Hermes Agent memory-provider integration for Noosphere.

Current implementation status: Phase 4 draft save and explicit memory mirroring.

## Layout

```text
plugins/memory/noosphere/
  __init__.py
  client.py
  formatting.py
  plugin.yaml
  README.md
  schemas.py
tests/
  test_noosphere_client.py
  test_noosphere_provider_phase1.py
```

## Phase 1 Scope

Implemented:

- Hermes `MemoryProvider` registration entry point
- `hermes memory setup` config schema
- profile-scoped `$HERMES_HOME/noosphere.json` config persistence
- environment-based secret lookup through `NOOSPHERE_API_KEY`
- safe initialization without network calls
- standard-library HTTP client with redacted errors
- `noosphere_status`, `noosphere_recall`, `noosphere_get`, `noosphere_topics`, and `noosphere_save` tools
- auto-recall prefetch through Noosphere's prompt-ready recall API
- explicit Hermes memory-write mirroring through draft memory candidates
- optional `sync_turn` capture when `auto_capture=true` and `topic_id` is configured

Not implemented yet:

- direct article publication tools
- installer script

Those are intentionally left for later PRs so each step stays reviewable.

## Manual Install During Development

```bash
mkdir -p "$HERMES_HOME/plugins/memory"
cp -R hermes-noosphere-memory/plugins/memory/noosphere "$HERMES_HOME/plugins/memory/noosphere"
hermes memory setup
```

Manual fallback:

```bash
hermes config set memory.provider noosphere
printf '%s\n' 'NOOSPHERE_API_KEY=noo_...' >> "$HERMES_HOME/.env"
cat > "$HERMES_HOME/noosphere.json" <<'JSON'
{
  "base_url": "http://127.0.0.1:6578",
  "auto_recall": true,
  "auto_capture": false,
  "capture_mode": "explicit",
  "max_recall_results": 5,
  "token_budget": 1200,
  "topic_id": "",
  "author_name_template": "Hermes:{identity}",
  "api_timeout": 5.0
}
JSON
```

Do not commit real API keys.

## Verification

```bash
python3 -m unittest discover -s hermes-noosphere-memory/tests
python3 -m compileall hermes-noosphere-memory/plugins/memory/noosphere
```
