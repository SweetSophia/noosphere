# OpenClaw Noosphere Phase 8 Release Checklist

Status: **BLOCKED** — auto-recall prompt injection marker test is not passing in the integrated OpenClaw agent path.

Date: 2026-05-07
Branch: `feat/phase-8-release-checklist`

## Completed gates

- [x] Root memory tests pass: `npm run test:memory` → 156/156 passing.
- [x] Root production build passes: `npm run build` completed successfully.
- [x] Plugin package builds: `openclaw-noosphere-memory npm run build` completed successfully.
- [x] Plugin package archive builds: `npm pack` produced `sweetsophia-openclaw-noosphere-memory-0.1.0.tgz`.
- [x] Plugin package archive installs: `openclaw plugins install ./sweetsophia-openclaw-noosphere-memory-0.1.0.tgz --force` completed.
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

## Blocked gate

- [ ] Auto-recall injection marker test.

### Evidence

A marker memory was saved to Noosphere and direct API recall works:

- Query: `Phase 8 auto-recall marker answer`
- Direct `noosphere_recall` auto mode returns prompt injection containing:
  - `Phase 8 auto-recall marker answer: cobalt-lattice-6821.`
- Direct invocation of `createNoosphereAutoRecallHook(...)` against the live Noosphere client returns `prependSystemContext` containing the expected `<noosphere_auto_recall>` block and marker answer.

However, integrated OpenClaw agent runs do **not** receive the marker in the final prompt:

- `openclaw agent --agent cylena --message 'Phase 8 auto-recall marker answer...' --json`
- Result: `NO_MARKER`
- `finalPromptText` did not contain `cobalt-lattice-6821` or the Noosphere recall block.

A temporary runtime test with `recallInjectionPosition: "prepend"` also returned `NO_MARKER`, so this is not only a `system-prepend` visibility issue.

### Current hypothesis

The Noosphere plugin registers correctly and the hook implementation works when invoked directly, but the integrated OpenClaw prompt-build path is not applying the Noosphere `before_prompt_build` result to agent runs.

This may be an OpenClaw hook-runner/registry/runtime path issue rather than a Noosphere HTTP/API issue.

### Follow-up required

1. Add targeted logging or a minimal diagnostic hook to confirm whether `noosphere-memory`'s `before_prompt_build` handler is invoked during `openclaw agent` runs.
2. If invoked, inspect the returned hook result at the OpenClaw hook-runner merge boundary.
3. If not invoked, inspect `hookRunner.hasHooks("before_prompt_build")` and active registry synchronization after plugin install/restart.
4. Re-run the integrated marker test only after the hook path is proven.

## Operational notes

- A stale running task from 2026-04-30 (`7430d755-b9be-4b8d-a01d-6604adffeb62`) blocked Gateway restarts; it was cancelled and task maintenance pruned stale flows.
- `openclaw gateway restart` twice left systemd in a deactivating/stopped state; `openclaw gateway start` recovered the service.
- During debugging, `recallInjectionPosition` was temporarily changed to `prepend`; the persisted config has been restored to `system-prepend`, but a Gateway restart/start cycle may be required before runtime reflects that restored value.
- CLI JSON output is currently polluted by plugin startup/config warning logs; parse defensively or use saved raw output when validating.
