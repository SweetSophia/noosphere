# Restricted Tags — Access Control for Multi-Agent Wiki

## 1. Overview and Goals

### What this solves
Noosphere is designed for multiple agents (OpenClaw, OpenCode, Cyberlogis, etc.) and humans (Sophie) to share a wiki. Some content is personal, health-related, intimate, or project-sensitive — it must not leak to agents that aren't explicitly permitted.

**The core problem:** A single shared API key gives any connected agent full read/write access to all articles. There's no per-article access control.

### Solution: Restricted Tag Scoping

Every article can carry zero or more **restricted tags**. An API key can carry zero or more **allowed scopes**. Access to a restricted article requires at least one match between the article's restricted tags and the key's allowed scopes.

- **Unrestricted articles** — visible and writable by all API keys (backward compatible)
- **Restricted articles** — invisible and inaccessible to keys without a matching scope
- **Scope management** — Sophie controls which key has which scopes via the admin GUI
- **Agents suggest, Sophie approves** — agents can propose restricted tags at creation time but cannot assign themselves scopes

### Non-goals
- Per-user ACLs (humans use session auth, not API keys)
- Row-level encryption (not yet)
- Audit logging of access events (deferred)
- Automatic scope propagation between keys

---

## 2. Data Model

### 2.1 Schema Changes

#### `Article` model — add `restrictedTags` field

```prisma
model Article {
  // ... existing fields ...

  // Restricted access scopes — e.g. ["health", "company-x", "intimate"]
  // Empty array = article is unrestricted (visible to all keys)
  restrictedTags String[] @default([])

  @@index([restrictedTags])
}
```

**Behavior:**
- Default `[]` — article is unrestricted (backward compatible)
- Tags must be non-empty strings matching pattern `^[a-z0-9-]+$`
- Tags are stored in insertion order (not alphabetically) for deterministic diffs

#### `ApiKey` model — add `allowedScopes` field

```prisma
model ApiKey {
  // ... existing fields ...
  permissions Permissions @default(WRITE)

  // Scopes this key is allowed to access. Empty = can only access unrestricted articles.
  // Example: ["health", "intimate", "company-x"]
  allowedScopes String[] @default([])

  @@index([allowedScopes])
}
```

**Behavior:**
- Default `[]` — key can read/write only unrestricted articles
- Adding `"*"` to allowedScopes grants access to ALL restricted articles (Sophie-only, admin keys)

#### New `RestrictedScope` model (enum table)

```prisma
model RestrictedScope {
  id          String   @id @default(cuid())
  tag         String   @unique  // "health", "intimate", "company-x", etc.
  description String?           // Human-readable description
  createdAt   DateTime @default(now())

  // Optional: is this a system scope (cannot be deleted)?
  isSystem    Boolean  @default(false)
}
```

System scopes (pre-seeded): `health`, `intimate`, `identity`, `financial`

---

### 2.2 Access Rule

```
article.restrictedTags = []          →  accessible to ALL keys (unrestricted)
article.restrictedTags = ["health"]  →  accessible only to keys where
                                         allowedScopes ∩ restrictedTags ≠ ∅
```

**Examples:**

| Article restrictedTags | Key allowedScopes | Access |
|---|---|---|
| `[]` | `[]` | ✅ Full |
| `[]` | `["health"]` | ✅ Full |
| `["health"]` | `[]` | 🚫 404 (invisible) |
| `["health"]` | `["health"]` | ✅ Full |
| `["health", "intimate"]` | `["health"]` | ✅ Full |
| `["health"]` | `["intimate"]` | 🚫 404 (invisible) |
| `["health"]` | `["*"]` | ✅ Full (admin) |

**Why 404 instead of 403?** If a key can't access an article, the existence of that article should not be revealed. Returning 404 prevents enumeration attacks — an agent cannot probe for sensitive articles by iterating IDs.

---

## 3. API Changes

### 3.1 New Endpoints

#### `GET /api/scopes` — List all available restricted scopes

```json
{
  "scopes": [
    { "tag": "health",    "description": "Personal health information",  "isSystem": true  },
    { "tag": "intimate", "description": "Intimate/relationship content", "isSystem": true  },
    { "tag": "identity",  "description": "Personal identity information",  "isSystem": true  },
    { "tag": "financial", "description": "Financial data",                "isSystem": true  },
    { "tag": "company-x", "description": "Company X project material",    "isSystem": false }
  ]
}
```

Auth: Any valid API key (READ minimum).

#### `POST /api/keys` — Create a new API key

```json
// Request
{
  "name": "opencode-cli",
  "permissions": "WRITE",
  "allowedScopes": ["health", "company-x"]
}

// Response
{
  "id": "key_01HX...",
  "name": "opencode-cli",
  "key": "noo_live_abc123...",       // shown ONLY once at creation
  "keyPrefix": "noo_live_abc1",
  "permissions": "WRITE",
  "allowedScopes": ["health", "company-x"],
  "createdAt": "2026-05-14T..."
}
```

**Auth:** Requires existing ADMIN API key or ADMIN session.

**Validation:**
- `name`: required, 1-64 chars, alphanumeric + hyphen
- `permissions`: must be `READ`, `WRITE`, or `ADMIN`
- `allowedScopes`: optional array; each tag must exist in `RestrictedScope` table

#### `GET /api/keys` — List all API keys (metadata only — never expose the actual key)

```json
{
  "keys": [
    {
      "id": "key_01HX...",
      "name": "cyberlogis",
      "keyPrefix": "noo_live_abc1",
      "permissions": "WRITE",
      "allowedScopes": ["health", "intimate", "identity"],
      "lastUsedAt": "2026-05-14T...",
      "createdAt": "2026-04-11T..."
    },
    {
      "id": "key_01HY...",
      "name": "opencode-cli",
      "keyPrefix": "noo_live_xyz7",
      "permissions": "WRITE",
      "allowedScopes": [],
      "lastUsedAt": null,
      "createdAt": "2026-05-14T..."
    }
  ]
}
```

**Auth:** ADMIN API key or ADMIN session.

#### `PATCH /api/keys/:id` — Update allowed scopes on a key

```json
// Request
{
  "allowedScopes": ["health", "company-x", "intimate"]
}

// Response
{ "id": "...", "allowedScopes": ["health", "company-x", "intimate"], ... }
```

**Auth:** ADMIN API key or ADMIN session.
**Constraint:** Non-admin keys cannot add scopes they don't already have.

#### `DELETE /api/keys/:id` — Revoke an API key

```json
// Response
{ "success": true }
```

**Auth:** ADMIN API key or ADMIN session.
**Behavior:** Sets `revokedAt` on the key (soft delete).

#### `POST /api/scopes` — Register a new custom scope

```json
// Request
{ "tag": "company-x", "description": "Company X project material" }

// Response
{ "tag": "company-x", "description": "Company X project material", "isSystem": false }
```

**Auth:** ADMIN only.
**Constraint:** Cannot create a scope with a tag that already exists (including system scopes).

---

### 3.2 Modified Endpoints

#### `POST /api/articles` — Article creation

Add `restrictedTags` to request body and response:

```json
// Request body (new field)
{
  "title": "Sophie's Health Profile",
  "content": "...",
  "topicId": "...",
  "restrictedTags": ["health"],     // optional, default []
  "tags": ["hrv", "sleep"]
}

// Response (new field)
{
  "id": "...",
  "title": "Sophie's Health Profile",
  "restrictedTags": ["health"],
  ...
}
```

**Validation:**
- Each tag in `restrictedTags` must exist in `RestrictedScope` table
- If an agent passes a tag not in `RestrictedScope`, return 400 with helpful message listing valid tags
- Sophie can set any tags she pre-approved; agents are encouraged to suggest tags and let Sophie add them to the scope registry first

#### `PATCH /api/articles/:id` — Article update

Add `restrictedTags` to updatable fields:

```json
// Request
{ "restrictedTags": ["health", "intimate"] }
```

**Constraint:** Only ADMIN keys or the article's author via session can modify `restrictedTags`.

#### `GET /api/articles` — List articles

**Always excludes articles where `allowedScopes ∩ restrictedTags = ∅`** — a key only sees articles it can access. No changes needed to the query interface; filtering happens inside the resolver.

#### `GET /api/articles/:id` — Get single article

Returns 404 if the key has no matching scope. No indication the article exists.

#### `POST /api/recall` — Recall tool (OpenClaw plugin)

**Before search:** Inject `allowedScopes` into the Prisma query so restricted articles without a matching scope are never returned — regardless of query match score.

```prisma
// Before (current):
where: { deletedAt: null, ...filters }

// After:
where: {
  deletedAt: null,
  OR: [
    { restrictedTags: { isEmpty: true } },           // unrestricted articles
    { restrictedTags: { hasSome: keyAllowedScopes } } // restricted, but key has scope
  ],
  ...filters
}
```

If `keyAllowedScopes` is empty, only unrestricted articles are returned.

#### `GET /api/articles/:id` — Get with scope check

If article has `restrictedTags` and no intersection with key's `allowedScopes`, return 404.

---

## 4. Access Control Middleware

Implement a reusable `requireScopeAccess` guard used by all article-related routes:

```typescript
async function requireScopeAccess(
  request: NextRequest,
  articleId: string
): Promise<{ authorized: true; scopes: string[] } | { authorized: false; status: 401 | 404 }> {
  // 1. Validate API key
  // 2. Fetch article
  // 3. If article.restrictedTags is empty → authorized
  // 4. If key.allowedScopes includes "*" → authorized (admin)
  // 5. If intersection(article.restrictedTags, key.allowedScopes) is non-empty → authorized
  // 6. Otherwise → 404
}
```

This should be applied to: GET article, PATCH article, DELETE article, and the recall query builder.

---

## 5. GUI Changes (Admin Panel)

### 5.1 API Keys Page (`/admin/keys`)

- **List view:** Name, prefix, permissions, scopes, last used, created
- **Create key modal:** Name, permissions, scope picker (checkboxes for each scope)
- **Edit key:** Update name, permissions, allowed scopes
- **Delete key:** Soft revoke with confirmation

### 5.2 Scopes Management Page (`/admin/scopes`)

- **List all scopes:** System scopes shown as locked, custom scopes editable
- **Create custom scope:** Tag name + description
- **Delete custom scope:** Only if no articles use it

### 5.3 Article Editor

- **Restricted tag picker:** Multi-select dropdown showing all available scopes
- **Visual indicator:** Small lock icon on articles with restricted tags in list views
- **Unrestricted badge:** Green "Public" badge on fully open articles

---

## 6. Agent Workflow

### 5.1 Agent Creates a Restricted Article

```
1. Agent: creates article with suggested restrictedTags
2. System: validates tags exist in RestrictedScope table
   → If unknown tag: return 400 listing valid scopes
3. System: checks key.allowedScopes
   → If key has matching scope: article created and immediately accessible
   → If key has no matching scope: article created BUT key cannot read it
     (Sophie must grant scope to key to make it accessible)
4. Sophie: reviews article, updates key scopes via admin panel if needed
```

### 5.2 OpenCode Connects for the First Time

```
1. Sophie: generates a key named "opencode" via admin panel
   → allowedScopes: [] (default — no access to restricted content)
2. Sophie: shares the key secret with the OpenCode instance
3. OpenCode: uses key for all API calls
   → All restricted articles → 404 (invisible)
   → All unrestricted articles → fully accessible
```

### 5.3 OpenCode Needs Access to a Specific Project

```
1. Sophie: PATCH /api/keys/:id → { allowedScopes: ["company-x"] }
2. OpenCode: now sees articles with restrictedTags: ["company-x"]
```

### 5.4 Agent Creates a Custom Scope

```
1. Sophie: POST /api/scopes { tag: "company-x", description: "..." }
2. Agent: can now tag articles with "company-x"
```

---

## 7. OpenCode CLI Integration

OpenCode uses its own API key (e.g., `noo_live_opencode_xxx`). OpenCode connects to Noosphere the same way OpenClaw does — via `noosphere-memory` plugin or direct REST API. The restricted tags system works identically regardless of which tool is making the request.

**Onboarding OpenCode:**
1. Sophie creates `opencode` key with `allowedScopes: []`
2. OpenCode is pointed at Noosphere API URL + key
3. OpenCode sees all unrestricted articles, zero restricted ones

**Expanding OpenCode's access:**
1. Sophie adds `company-x` to the opencode key's `allowedScopes`
2. OpenCode can now read/write `restrictedTags: ["company-x"]` articles
3. No changes to OpenCode itself needed

---

## 8. Migration Plan

### Phase 1: Schema + Core Gating (this PR)
- [ ] Add `restrictedTags` to Article model
- [ ] Add `allowedScopes` to ApiKey model
- [ ] Create `RestrictedScope` model + seed system scopes
- [ ] Implement `requireScopeAccess` middleware
- [ ] Apply scope filtering to: GET article list, GET single article, recall query
- [ ] Add `restrictedTags` to article create/edit
- [ ] Add new endpoints: `GET /api/scopes`, `POST /api/keys`, `GET /api/keys`, `PATCH /api/keys/:id`, `DELETE /api/keys/:id`, `POST /api/scopes`

### Phase 2: GUI (follow-up PR)
- [ ] Admin: Keys management page
- [ ] Admin: Scopes management page
- [ ] Article editor: restricted tag picker
- [ ] Article list: privacy indicators (lock icon, public badge)

### Phase 3: Polish
- [ ] Update OpenClaw plugin to read `allowedScopes` from `~/.openclaw/secrets/noosphere-memory.json`
- [ ] CLI: `openclaw noosphere keys list` command
- [ ] Activity log entries for scope changes
- [ ] OpenCode integration documentation

---

## 9. Backward Compatibility

- **Existing articles:** `restrictedTags: []` by default — fully backward compatible
- **Existing API keys:** `allowedScopes: []` by default — can only access unrestricted articles
- **No breaking changes** to any existing API contract
- Agents without restricted tag scopes simply don't see restricted articles (the 404 behavior ensures no leakage)

---

## 10. Error Handling

| Scenario | Response |
|---|---|
| Article exists but key has no matching scope | `404 Not Found` |
| Article tag not in `RestrictedScope` table | `400 Bad Request` with list of valid tags |
| Creating key with unknown scope | `400 Bad Request` |
| Non-admin key tries to modify scope | `403 Forbidden` |
| Revoked key used | `401 Unauthorized` |
| Scope used in article but doesn't exist | `500 Internal Server Error` (data integrity issue — should not happen if validation is correct) |

---

## 11. Open Questions for Sophie

1. **Should agents be able to read their own restricted articles?**
   e.g., Cylena creates an article tagged `restricted:intimate` — should Cylena's own key be able to read it even without `:intimate` scope? Proposal: yes — the creating agent can always access their own articles.

2. **What scopes should Sophie pre-create before the Social topic cluster?**
   Suggested: `identity`, `intimate`, `health`, `social`, `financial`

3. **Should there be a "Sophie-only" scope?**
   e.g., `restricted:private` that only Sophie's ADMIN key can access, not even individual agent keys with broad scopes?

4. **Auto-sync behavior with restricted tags:**
   The Obsidian sync (`POST /api/sync/obsidian`) mirrors articles to the local vault. Should restricted articles be excluded from sync, included with a `[RESTRICTED]` prefix in the filename, or included normally (with vault access being the user's concern)?
