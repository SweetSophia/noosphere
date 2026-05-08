# RecallSettings UI Implementation Plan

## Overview

The RecallSettings system is now wired end-to-end. This document records the implemented phases and the current maintenance notes:

1. **Database persistence** for settings ✅
2. **API endpoints** for CRUD operations ✅
3. **Web UI** at `/wiki/admin/settings` ✅
4. **Runtime wiring** for status and OpenClaw auto-recall ✅

---

## Phase 1: Database Schema ✅ DONE

**Status:** Completed 2026-05-02

- Added `RecallSettings` model to `prisma/schema.prisma`
- Generated Prisma client
- Pushed schema to database
- Table created with all columns and defaults

**Schema columns:**
- `id` (text, PK, default "singleton")
- `autoRecallEnabled` (boolean, default true)
- `maxInjectedMemories` (integer, default 20)
- `maxInjectedTokens` (integer, default 2000)
- `recallVerbosity` (text, default "standard")
- `summaryFirst` (boolean, default true)
- `deduplicationStrategy` (text, default "best-score")
- `enabledProviders` (text array, default [])
- `providerPriorityWeights` (jsonb, default {})
- `conflictStrategy` (text, default "surface")
- `conflictThreshold` (double precision, default 0.1)
- `updatedAt` (timestamp, auto-managed)

---

## Phase 2: API Endpoints ✅ DONE

**Status:** Completed 2026-05-02

**Files created:**
- `src/lib/memory/api/settings.ts` - helper functions
  - `getRecallSettingsFromDB()` - reads from DB, falls back to defaults
  - `upsertRecallSettings()` - upserts settings using merge pattern
- `src/app/api/memory/settings/route.ts` - GET + POST handlers
  - GET: Returns current settings from DB
  - POST: Validates and merges partial updates

**Auth:** API key with ADMIN permission required for both GET and POST

**Route:** `GET/POST /api/memory/settings`

---

## Phase 3: Web UI (`/wiki/admin/settings/page.tsx`) ✅ DONE

**Status:** Completed 2026-05-08

### Page Structure

```tsx
// Sections:
// 1. Auto-Recall Toggle
// 2. Budget Limits (max memories, max tokens)
// 3. Output Control (verbosity dropdown, summaryFirst toggle)
// 4. Deduplication Strategy (dropdown)
// 5. Provider Configuration (enabled providers checklist, priority weights)
// 6. Conflict Resolution (strategy dropdown, threshold slider)
```

### Form Fields

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| autoRecallEnabled | toggle | true | Master switch |
| maxInjectedMemories | number input | 20 | 1-100 |
| maxInjectedTokens | number input | 2000 | 100-10000 |
| recallVerbosity | select | standard | minimal/standard/detailed |
| summaryFirst | toggle | true | Prefer summaries |
| deduplicationStrategy | select | best-score | best-score/provider-priority/most-recent |
| enabledProviders | checkbox group | [] | List available providers |
| providerPriorityWeights | key-value pairs | {} | Provider ID → weight (0.0-2.0) |
| conflictStrategy | select | surface | accept-highest/recent/curated/surface/suppress-low |
| conflictThreshold | range slider | 0.1 | 0.0-1.0 |

### Pattern
- Follow existing admin page patterns (keys, log pages)
- Use `getServerSession` + role check for auth
- Server actions for form submission
- Success/error flash messages
- Real-time preview of settings JSON below form

---

## Phase 4: Wiring Changes ✅ DONE

**Status:** Completed 2026-05-08

**Files modified:**
- `src/app/api/memory/status/route.ts` - Updated to read settings from DB
  - Now calls `getRecallSettingsFromDB()` and passes settings to `getMemoryStatusSnapshot()`

**Runtime wiring completed:**
- `src/app/api/memory/status/route.ts` reads DB-backed settings.
- `openclaw-noosphere-memory/src/auto-recall.ts` fetches DB-backed recall settings at runtime with a short cache/fallback path.
- Provider weights flow through recall settings and orchestrator normalization.

---

## Phase 5: Auto-recall Runtime Wiring ✅ DONE

**Status:** Completed 2026-05-08

**Files modified:**
- `openclaw-noosphere-memory/src/client.ts` - settings client helper
- `openclaw-noosphere-memory/src/auto-recall.ts` - runtime settings fetch/merge
- `src/lib/memory/orchestrator.ts` and settings helpers - provider weights/conflict settings honored

---

## Verification

```bash
# After Phase 1-2 (database + API):
curl -H "Authorization: Bearer $API_KEY" http://localhost:4400/api/memory/settings
# Should return current settings from DB (defaults if no row yet)

# Update settings via POST:
curl -X POST -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"autoRecallEnabled": false, "conflictThreshold": 0.3}' \
  http://localhost:4400/api/memory/settings
# Should return normalized merged settings

# Verify status API reflects DB settings:
curl -H "Authorization: Bearer $API_KEY" http://localhost:4400/api/memory/status
# Should show the updated settings values

# UI: Visit /wiki/admin/settings as admin user
# Change settings and verify they persist across page reloads
```

---

## Open Questions / Deferred Items

1. **Cache invalidation**: API/status requests read settings from DB. The OpenClaw plugin caches DB-backed settings briefly for prompt-build performance, so admin UI changes may take up to the plugin cache TTL to affect auto-recall.

2. **Provider registry**: `enabledProviders` and `providerPriorityWeights` assume a fixed list of providers. Future: dynamic provider discovery.

3. **Provider priority weight UI**: The MVP uses a JSON textarea for provider weights. A richer key-value editor can be added later.

4. **Activity logging**: Consider logging settings changes to ActivityLog for audit trail.

---

## Implementation Summary

| Phase | Status | Files |
|-------|--------|-------|
| 1. Database Schema | ✅ Done | `prisma/schema.prisma` |
| 2. API Endpoints | ✅ Done | `src/lib/memory/api/settings.ts`, `src/app/api/memory/settings/route.ts` |
| 3. Web UI | ✅ Done | `src/app/wiki/admin/settings/page.tsx`, `actions.ts` |
| 4. Status/API wiring | ✅ Done | `src/app/api/memory/status/route.ts` updated |
| 5. Auto-recall wiring | ✅ Done | `before_prompt_build` hook reads DB-backed settings |

---

## Remaining Maintenance Notes

- Provider discovery is still static in the admin UI; add dynamic provider registry support later if more providers are enabled.
- Activity logging for settings changes remains a nice-to-have audit enhancement.
