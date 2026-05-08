# OpenClaw Noosphere Phase 8 Release Checklist

Status: **PASSING WITH FIX** — root cause narrowed and patched; integrated marker test passes after query boilerplate stripping.

Date: 2026-05-07
Branch: `feat/phase-8-release-checklist`

## Completed gates

- [x] Root memory tests pass: `npm run test:memory` → 156/156 passing.
- [x] Root production build passes: `npm run build` completed successfully.
- [x] Plugin package builds: `openclaw-noosphere-memory npm run build` completed successfully.
- [x] Plugin package archive builds: `npm pack` produced `sweetsophia-openclaw-noosphere-memory-1.3.0.tgz`.
- [x] Plugin package archive installs: `openclaw plugins install ./sweetsophia-openclaw-noosphere-memory-1.3.0.tgz --force` completed.
- [x] Plugin runtime inspect shows expected registrations:
  - Tools: `noosphere_status`, `noosphere_recall`, `noosphere_get`, `noosphere_save`
  - Hook: `before_prompt_build`
  - CLI command group: `noosphere`
- [x] `openclaw noosphere doctor --json` passes after Gateway recovery.
- [x] `openclaw noosphere status --json` passes after Gateway recovery.
- [x] `noosphere_status` tool works.
- [x] `noosphere_save` tool works by creating a draft memory candidate.
- [x] `noosphere_get` tool works for the saved candidate.
- [x] `noosphere_recall` tool works for the saved candidate.
- [x] Docker image builds locally when supplied the documented build arg:
  - `docker build --build-arg DATABASE_URL=postgresql://placeholder@localhost/placeholder -t noosphere:phase8-local .`
- [x] GHCR image pulls:
  - `docker pull ghcr.io/sweetsophia/noosphere:latest`
  - Pulled digest: `sha256:53ac53b8ce09755ed8b94a8a9ddb797d61f6b44b210c4a75401d9a1c9793fbbf`
- [x] Production Compose starts app + DB on fresh volumes using the GHCR image.
- [x] Health endpoint works on `127.0.0.1:6578` in the isolated Compose test.
- [x] DB/bootstrap works on fresh volumes.
- [x] Admin/API key bootstrap works; memory status API authenticated successfully.
- [x] Installer/Compose idempotency path verified by rerunning app startup and init with the same `.env` credentials.

## Auto-recall injection marker gate

- [x] Auto-recall injection marker test passes after patch.

### Evidence

A marker memory was saved to Noosphere and direct API recall works:

- Query: `Phase 8 auto-recall marker answer`
- Direct `noosphere_recall` auto mode returns prompt injection containing:
  - `Phase 8 auto-recall marker answer: cobalt-lattice-6821.`
- Direct invocation of `createNoosphereAutoRecallHook(...)` against the live Noosphere client returns `prependSystemContext` containing the expected `<noosphere_auto_recall>` block and marker answer.

Integrated diagnosis on 2026-05-08 narrowed the failure:

- The `before_prompt_build` hook **was invoked** during integrated OpenClaw runs.
- Direct exact query `Phase 8 auto-recall marker answer` returned the marker.
- The real OpenClaw prompt included timestamp and reply-control boilerplate, e.g. `[Fri 2026-05-08 07:53 GMT+2] ... Reply with only ...`; this over-constrained PostgreSQL `websearch_to_tsquery` and returned 0 results.
- Patch: strip OpenClaw timestamp/retry preludes and marker-test reply-control suffixes before building the Noosphere recall query.
- Retest: integrated `openclaw agent --agent cylena --message ...` returned `cobalt-lattice-6821`; prompt context contained the Noosphere recall block when using `recallInjectionPosition: "prepend"` for visibility.

Remaining caveat:

- `sessions_spawn` is not a valid marker harness for this exact test because the assigned task is placed in subagent system context while `before_prompt_build` sees the generic subagent user prompt. Use `openclaw agent --message ...` or a real user turn for the marker gate.

## Operational notes

- A stale running task from 2026-04-30 (`7430d755-b9be-4b8d-a01d-6604adffeb62`) blocked Gateway restarts; it was cancelled and task maintenance pruned stale flows.
- `openclaw gateway restart` twice left systemd in a deactivating/stopped state; `openclaw gateway start` recovered the service.
- During debugging, `recallInjectionPosition` was temporarily changed to `prepend`; the persisted config has been restored to `system-prepend`, but a Gateway restart/start cycle may be required before runtime reflects that restored value.
- CLI JSON output is currently polluted by plugin startup/config warning logs; parse defensively or use saved raw output when validating.
