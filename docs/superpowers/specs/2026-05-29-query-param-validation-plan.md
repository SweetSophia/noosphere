# Implementation Plan: Input Validation for Search and Query Parameters

**Issue:** #137 — [HIGH] Weak/no validation on search and query parameters
**Design:** `docs/superpowers/specs/2026-05-29-query-param-validation-design.md`

## Steps

### Step 1: Add query validation helpers to `src/lib/validation.ts`

- Add `QUERY_LIMITS` constant with `maxSearchLength: 256`, `maxAuthorLength: 100`
- Add `validateSearchQuery(q: string | null)` function that:
  - Returns `{ ok: true, query: "" }` if null or empty
  - Trims whitespace
  - Returns error if trimmed length exceeds 256 chars
  - Returns `{ ok: true, query: trimmed }` on success

### Step 2: Fix `GET /api/articles` — `q` param validation

In `src/app/api/articles/route.ts`:
- Import `validateSearchQuery` from `@/lib/validation`
- In GET handler, replace `const q = searchParams.get("q")` with:
  - Call `validateSearchQuery(searchParams.get("q"))`
  - Return 400 if validation fails
  - Use validated query string

### Step 3: Fix `GET /api/log` — `author` param and date parsing

In `src/app/api/log/route.ts`:
- Import `sanitizeAuthorName` from `@/lib/validation` (already available)
- Apply `sanitizeAuthorName()` to `author` param (clamps to 100 chars)
- Wrap `new Date(from)` and `new Date(to)` in try/catch blocks
- Return 400 with descriptive error on invalid date format

### Step 4: Fix `GET /api/graph` — `topic` slug validation

In `src/app/api/graph/route.ts`:
- Import `validateSlug` from `@/lib/validation` (already imported in lib/graph.ts but not in route)
- If `topicSlug` is provided, call `validateSlug(topicSlug)`
- Return 400 if validation fails
- Use validated slug string

### Step 5: Fix `POST /api/lint` — `staleDays` and `tagMin` bounds

In `src/app/api/lint/route.ts`:
- Add constants:
  - `LINT_STALE_DAYS_MIN = 1`, `LINT_STALE_DAYS_MAX = 3650`
  - `LINT_TAG_MIN_MIN = 1`, `LINT_TAG_MIN_MAX = 100`
- Add type checks: if `staleDays` or `tagMin` is provided but not a number, return 400
- Clamp values to their respective ranges using `Math.min(Math.max())`
- Use `Math.floor()` for integer values

### Step 6: Run lint and typecheck

```bash
npm run lint
npm run typecheck
```

Fix any issues found.

### Step 7: Run tests

```bash
npm run test
```

All tests should pass.

## Files to Modify

1. `src/lib/validation.ts` — add `validateSearchQuery` and `QUERY_LIMITS`
2. `src/app/api/articles/route.ts` — validate `q` param
3. `src/app/api/log/route.ts` — sanitize `author`, catch date parsing errors
4. `src/app/api/graph/route.ts` — validate `topic` slug
5. `src/app/api/lint/route.ts` — validate `staleDays` and `tagMin`

## Verification

- Manual: Send oversized/malformed inputs via curl, expect 400 responses
- Automated: `npm run test` passes