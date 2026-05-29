# Design: Input Validation for Search and Query Parameters

**Date:** 2026-05-29
**Status:** Approved
**Issue:** #137 — [HIGH] Weak/no validation on search and query parameters

## Problem

Multiple API endpoints accept user-controlled query parameters with weak or no validation, creating DoS vectors and potential abuse:

| Endpoint | Parameter | Issue |
|----------|-----------|-------|
| `GET /api/articles` | `q` | No length clamp, could cause large FTS queries |
| `GET /api/log` | `author` | No length/type check |
| `GET /api/log` | `from`, `to` | `new Date()` can throw on invalid input |
| `GET /api/graph` | `topic` | No slug format validation |
| `POST /api/lint` | `staleDays`, `tagMin` | No type/bounds validation, can cause O(N²) unlinked mention check |

## Solution

Extend existing validation patterns in `src/lib/validation.ts` with new helpers, then apply them consistently across affected endpoints.

## Changes

### 1. `src/lib/validation.ts`

Add query param validation helpers:

```typescript
export const QUERY_LIMITS = {
  maxSearchLength: 256,
  maxAuthorLength: 100,
} as const;

export function validateSearchQuery(q: string | null): { ok: true; query: string } | { ok: false; error: string } {
  if (!q) return { ok: true, query: "" };
  const trimmed = q.trim();
  if (trimmed.length > QUERY_LIMITS.maxSearchLength) {
    return { ok: false, error: `Query exceeds maximum length of ${QUERY_LIMITS.maxSearchLength} characters` };
  }
  return { ok: true, query: trimmed };
}
```

### 2. `src/app/api/articles/route.ts` — GET

Apply `validateSearchQuery()` to `q` param:

```typescript
const rawQ = searchParams.get("q");
const qValidation = validateSearchQuery(rawQ);
if (!qValidation.ok) {
  return NextResponse.json({ error: qValidation.error }, { status: 400 });
}
const q = qValidation.query;
```

### 3. `src/app/api/log/route.ts` — GET

- Apply `sanitizeAuthorName()` to `author` param (already exists, use it)
- Wrap `new Date(from)` / `new Date(to)` in try/catch

```typescript
const rawAuthor = searchParams.get("author");
const author = sanitizeAuthorName(rawAuthor); // already clamps to 100 chars

if (from || to) {
  const createdAt: Prisma.DateTimeFilter = {};
  if (from) {
    try {
      createdAt.gte = new Date(from);
    } catch {
      return NextResponse.json({ error: "Invalid 'from' date format" }, { status: 400 });
    }
  }
  if (to) {
    try {
      createdAt.lt = new Date(to);
    } catch {
      return NextResponse.json({ error: "Invalid 'to' date format" }, { status: 400 });
    }
  }
  where.createdAt = createdAt;
}
```

### 4. `src/app/api/graph/route.ts` — GET

Apply `validateSlug()` to `topic` param:

```typescript
const rawTopicSlug = searchParams.get("topic");
if (rawTopicSlug) {
  const topicValidation = validateSlug(rawTopicSlug);
  if (!topicValidation.ok) {
    return NextResponse.json({ error: topicValidation.error }, { status: 400 });
  }
  topicSlug = topicValidation.slug;
}
```

### 5. `src/app/api/lint/route.ts` — POST

Add type and bounds validation for `staleDays` and `tagMin`:

```typescript
const LINT_STALE_DAYS_MIN = 1;
const LINT_STALE_DAYS_MAX = 3650; // ~10 years
const LINT_TAG_MIN_MIN = 1;
const LINT_TAG_MIN_MAX = 100;

// Parse and validate staleDays
const rawStaleDays = body.staleDays;
if (rawStaleDays !== undefined && typeof rawStaleDays !== "number") {
  return NextResponse.json({ error: "staleDays must be a number" }, { status: 400 });
}
const staleDays = rawStaleDays !== undefined
  ? Math.min(Math.max(LINT_STALE_DAYS_MIN, Math.floor(rawStaleDays)), LINT_STALE_DAYS_MAX)
  : 90;

// Parse and validate tagMin
const rawTagMin = body.tagMin;
if (rawTagMin !== undefined && typeof rawTagMin !== "number") {
  return NextResponse.json({ error: "tagMin must be a number" }, { status: 400 });
}
const tagMin = rawTagMin !== undefined
  ? Math.min(Math.max(LINT_TAG_MIN_MIN, Math.floor(rawTagMin)), LINT_TAG_MIN_MAX)
  : 2;
```

## Error Responses

Use consistent error format `{ "error": "Descriptive message" }` with 400 status, matching existing API conventions in the codebase.

## Testing

- Add unit tests for `validateSearchQuery()` in `src/__tests__/validation.test.ts` (or similar)
- Existing integration tests should continue to pass
- Manual verification: curl commands with oversized/malformed inputs return 400

## Security Considerations

- Length limits prevent DoS via oversized FTS queries
- Slug validation prevents injection via Prisma queries
- Type validation prevents NaN/undefined behavior
- Date parsing errors are caught instead of thrown
- Bounds validation prevents resource exhaustion (O(N²) unlinked mention check)