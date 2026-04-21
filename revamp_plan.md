# Frontend Redesign Blueprint

## Goal
Improve the frontend in a way that is:
- visually more polished
- easier to maintain
- safe to implement incrementally
- consistent across wiki, editor, search, and admin

---

# 1. Recommended first PR scope

Start with a **foundation PR**, not a page redesign PR.

## PR 1 — Design system + shell foundation
### Files
- `src/app/layout.tsx`
- `src/app/globals.css`
- `src/app/wiki/layout.tsx`
- `src/app/wiki/wiki.css`

### Objectives
- fix app metadata
- unify theme tokens
- introduce consistent spacing/type/container rules
- improve header styling and structure
- add shared page-shell utilities
- fix obvious broken token usage groundwork

### Why first
Every later page improvement gets easier and cleaner.

---

# 2. File-by-file plan

## A. `src/app/layout.tsx`
### Changes
- replace default metadata
- set proper app title/description
- optionally add title template

### Example direction
- title: `Noosphere`
- description: `Agent-authored documentation, designed for human browsing and editing.`

---

## B. `src/app/globals.css`
### Purpose
Make this the **source of truth for tokens**.

### Add/standardize
- color tokens
- spacing scale
- radius scale
- shadow scale
- typography scale
- layout/container widths
- focus ring token
- transition token

### Suggested token groups
- `--color-bg`
- `--color-surface`
- `--color-surface-muted`
- `--color-text`
- `--color-text-muted`
- `--color-border`
- `--color-accent`
- `--color-accent-strong`
- `--color-danger`
- `--color-success`
- `--color-warning`

- `--space-1` to `--space-8`
- `--radius-sm/md/lg/xl`
- `--shadow-sm/md/lg`

- `--container-sm/md/lg/xl`
- `--content-reading`

### Also
- switch body font to use the loaded Geist font var instead of Arial
- add global `:focus-visible`
- add selection styling
- improve dark mode parity

---

## C. `src/app/wiki/wiki.css`
### Purpose
Convert this from “big page-specific CSS file” into a **UI layer**.

### Refactor into sections
1. shell
2. layout/container utilities
3. typography
4. buttons
5. forms
6. cards
7. badges
8. tables
9. empty states
10. markdown content
11. responsive rules

### Add shared utilities/classes
- `.wiki-shell`
- `.page-shell`
- `.page-header`
- `.page-header__content`
- `.page-header__actions`
- `.section-card`
- `.stack-sm/md/lg`
- `.cluster`
- `.meta-row`
- `.badge-row`

### Remove/replace
- reliance on scattered inline spacing and width values
- undefined styles assumptions

### Fix immediately
Admin-log-related missing patterns:
- `.activity-timeline`
- `.activity-entry`
- `.activity-dot`
- `.activity-content`
- `.activity-type-badge`

---

## D. `src/app/wiki/layout.tsx`
### Purpose
Upgrade the app shell.

### Changes
- improve header grouping
- make nav more structured
- add admin log link
- make search feel integrated
- improve responsive wrapping
- prepare for role-aware action clarity

### Recommended structure
- left: brand
- center: search
- right: primary nav + auth state

### Nav recommendation
- Browse
- Search
- API Keys (admin)
- Trash (admin)
- Activity Log (admin)
- Sign In / user menu area

---

# 3. Component extraction plan

After PR 1, start extracting reusable layout pieces.

## Create these components next
Possible location: `src/components/wiki/`

### `PageHeader.tsx`
Reusable page title/subtitle/actions wrapper

Used by:
- home
- topic
- article history
- search
- admin pages
- editor pages

### `Breadcrumbs.tsx`
Standard breadcrumb renderer with consistent spacing/styling

Used by:
- topic
- article
- edit
- new
- history
- admin pages

### `EmptyState.tsx`
Shared empty-state block

Used by:
- home
- topic
- search
- trash
- keys
- history

### `Badge.tsx`
Reusable badge styles for:
- status
- confidence
- tags
- activity type

### `Card` patterns
At minimum shared CSS patterns for:
- article cards
- topic cards
- admin cards
- editor utility cards

---

# 4. Page redesign order

## PR 2 — Home page
### Files
- `src/app/wiki/page.tsx`
- maybe small CSS additions in `wiki.css`

### Goals
- make landing page feel premium
- improve topic hierarchy readability
- better separate “recently updated” from “topics”
- reduce inline styles

### UX upgrades
- stronger hero/title region
- cleaner section headers
- topic tree as vertical structure, not tag-like wrapping
- recent articles as more polished cards

---

## PR 3 — Topic page
### Files
- `src/app/wiki/[topicSlug]/page.tsx`

### Goals
- improve topic context and navigation
- better article list readability
- better subtopic display

### UX upgrades
- consistent page header
- role-aware “New Article”
- better metadata rows
- more obvious subtopic section

---

## PR 4 — Article page
### Files
- `src/app/wiki/[topicSlug]/[articleSlug]/page.tsx`

### Goals
- make reading experience feel excellent
- improve metadata and related content

### UX upgrades
- cleaner article header
- tags become links
- stronger status/confidence presentation
- better related article section
- reduce inline styles
- maybe add sticky or visible article actions

### Important fix
Hide edit/delete actions for unauthorized users.

---

## PR 5 — Editor experience
### Files
- `src/app/wiki/[topicSlug]/new/page.tsx`
- `src/app/wiki/[topicSlug]/[articleSlug]/edit/page.tsx`
- `src/components/wiki/MarkdownPreviewTabs.tsx`
- `src/components/wiki/MarkdownToolbar.tsx`
- `src/components/wiki/ImageUploadPanel.tsx`

### Goals
- make editing feel intentional, not assembled

### UX upgrades
- real write/preview mode or split layout
- preview closer to final article rendering
- better grouping of metadata/content/media tools
- more polished toolbar and utility panels

---

## PR 6 — Search + admin normalization
### Files
- `src/app/wiki/search/page.tsx`
- `src/app/wiki/admin/keys/page.tsx`
- `src/app/wiki/admin/trash/page.tsx`
- `src/app/wiki/admin/log/page.tsx`

### Goals
- consistent data-view language
- make admin feel like part of the same product

### Priority
Fix `/wiki/admin/log` early if it currently looks broken.

---

# 5. Specific UX rules to apply

## Role-aware UI
Only show:
- `New Article` to `EDITOR` / `ADMIN`
- `Edit` / `Move to Trash` to allowed roles
- admin nav only to admins

This prevents misleading UI.

## Navigation depth
Improve breadcrumbs to support full ancestry where possible.

## Clickable metadata
Make:
- tags clickable
- related articles more prominent
- topic links clearer

## Accessibility
Add:
- `:focus-visible`
- better button/input focus states
- accessible tab semantics if keeping tabs
- larger hit targets in header/nav

---

# 6. Styling strategy recommendation

## Keep CSS, don’t introduce a new styling library yet
You already have a working CSS setup.
Best move:
- clean it up
- strengthen tokens
- extract reusable classes/components

No need to add Tailwind or a component library unless you explicitly want that shift.

---

# 7. What I would implement first, exactly

## First implementation slice
1. update metadata in `src/app/layout.tsx`
2. redesign token system in `src/app/globals.css`
3. improve base wiki shell in `src/app/wiki/layout.tsx`
4. refactor `src/app/wiki/wiki.css` into clearer system sections
5. fix admin log styling mismatch
6. add shared page header/breadcrumb/empty-state structure
7. then start on `/wiki`

---

# 8. Recommended milestone structure

## Milestone 1
**Foundation + shell**
- tokens
- typography
- header
- shared primitives
- admin log fix

## Milestone 2
**Core browse flow**
- home
- topic
- article

## Milestone 3
**Authoring flow**
- new
- edit
- history
- preview behavior

## Milestone 4
**Search/admin polish**
- search
- keys
- trash
- log

## Milestone 5
**Final polish**
- mobile
- dark mode
- accessibility
- cleanup of remaining inline styles

---

# 9. Suggested first PR title
**refine wiki design system and app shell**
