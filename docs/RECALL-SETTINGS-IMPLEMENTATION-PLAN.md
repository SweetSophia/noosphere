# RecallSettings UI Implementation Plan

## Overview

The RecallSettings system was designed but never fully wired to persistence. Currently, `getMemoryStatusSnapshot()` returns hardcoded defaults from `normalizeRecallSettings({})`. This plan adds:

1. **Database persistence** for settings
2. **API endpoints** for CRUD operations
3. **Web UI** at `/wiki/admin/settings`
4. **Wiring** to read settings from DB instead of defaults

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

## Phase 3: Web UI (`/wiki/admin/settings/page.tsx`)

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

## Phase 4: Wiring Changes ✅ DONE (partial)

**Status:** Completed 2026-05-02

**Files modified:**
- `src/app/api/memory/status/route.ts` - Updated to read settings from DB
  - Now calls `getRecallSettingsFromDB()` and passes settings to `getMemoryStatusSnapshot()`

**Remaining wiring (Phase 5):**
- Auto-recall hook needs to read from DB settings
- Orchestrator wiring for provider weights

---

## Phase 5: Web UI (`/wiki/admin/settings/page.tsx`)

**Status:** Pending

**Files to create:**
- `src/app/wiki/admin/settings/page.tsx` - Admin settings UI page
- `src/app/wiki/admin/settings/actions.ts` - Server actions for form submission

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

1. **Cache invalidation**: Settings changes take effect immediately on next request since they're read at request time. No cache invalidation needed.

2. **Provider registry**: `enabledProviders` and `providerPriorityWeights` assume a fixed list of providers. Future: dynamic provider discovery.

3. **Provider priority weight UI**: The key-value editor for provider weights is complex. MVP: show as JSON textarea.

4. **Activity logging**: Consider logging settings changes to ActivityLog for audit trail.

5. **Auto-recall wiring**: The `before_prompt_build` hook currently reads from hardcoded defaults. It should read from DB settings.

---

## Implementation Summary

| Phase | Status | Files |
|-------|--------|-------|
| 1. Database Schema | ✅ Done | `prisma/schema.prisma` |
| 2. API Endpoints | ✅ Done | `src/lib/memory/api/settings.ts`, `src/app/api/memory/settings/route.ts` |
| 3. Web UI | ⏳ Pending | `src/app/wiki/admin/settings/page.tsx`, `actions.ts` |
| 4. Wiring | ✅ Partial | `src/app/api/memory/status/route.ts` updated |
| 5. Auto-recall wiring | ⏳ Pending | `before_prompt_build` hook update |

---

## Effort Estimate (Remaining)

- **Admin UI**: ~3 hours
- **Auto-recall wiring**: ~1 hour
- **Testing**: ~1 hour
- **Total remaining**: ~5 hours
