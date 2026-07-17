# OpenClaw Official Plugin Development Plan

**Project:** Noosphere ↔ OpenClaw official plugin/productization  
**Repo:** `SweetSophia/noosphere`  
**Created:** 2026-05-05  
**Status:** Implemented through Phase 8 release checklist; see `OPENCLAW-PHASE-8-RELEASE-CHECKLIST.md` for verification evidence.

## 1. Goal

Turn the working Noosphere ↔ OpenClaw memory bridge into a clean, official/easy-install OpenClaw plugin experience.

The final user experience should allow an OpenClaw user to:

1. Install the OpenClaw Noosphere memory plugin.
2. Start a local Noosphere server via Docker Compose.
3. Automatically configure OpenClaw with the Noosphere API endpoint/key.
4. Use Noosphere tools and auto-recall without manually cloning/building the repo.

Target UX examples:

```bash
openclaw plugins install clawhub:noosphere-memory
openclaw noosphere setup
```

or:

```bash
# Installer commit: 5a4c120777d9f986e37b488850b4e236102735e7
# Expected SHA-256: a07d6fd0732d1229a4034190046745b279f01582e99c31628a0abc0bec0a7c43
installer="$(mktemp)"
curl -fsSL https://raw.githubusercontent.com/SweetSophia/noosphere/5a4c120777d9f986e37b488850b4e236102735e7/install-openclaw.sh -o "$installer"
printf '%s  %s\n' 'a07d6fd0732d1229a4034190046745b279f01582e99c31628a0abc0bec0a7c43' "$installer" | sha256sum -c -
bash "$installer" && rm -f "$installer"
```

## 2. Decisions Already Made

| Question | Decision |
| --- | --- |
| Container registry | Use GHCR first: `ghcr.io/sweetsophia/noosphere`. Docker Hub can be added later. |
| Plugin package scope | Use npm scope `@sweetsophia/openclaw-noosphere-memory`. |
| Commit plugin `dist/`? | Yes. Commit built plugin runtime output for reliable OpenClaw archive/path installs. |
| Default bind address | Localhost-only by default for safety. |
| Default app URL | Prefer `http://127.0.0.1:6578`. |
| Default port | Use `6578` unless testing finds a conflict or a better convention. |
| Architecture split | Plugin owns OpenClaw integration; Docker Compose owns Noosphere runtime; setup script glues them together. |

## 3. Existing State / Prior Context

Existing working pieces:

- Noosphere app already has a Dockerfile.
- Noosphere app already has a Docker Compose setup with Postgres.
- OpenClaw plugin exists in `openclaw-noosphere-memory/`.
- Plugin currently provides memory tools and auto-recall hook behavior.
- Auto-recall injection has been verified working after PR #49.
- PR #49 merged Hindsight-inspired auto-recall fixes.

Known repo/package issues before productization:

- `openclaw-noosphere-memory/package.json` is still private.
- Plugin package currently exports TypeScript source.
- Local plugin build artifacts exist but need intentional handling.
- Default Compose has environment/deployment assumptions that need cleanup for public use.
- Default Compose currently uses port `4400`; official install should move to localhost-only `6578`.
- Production migration/bootstrap story needs to be hardened.

## 4. Target Architecture

### 4.1 Artifact A — Noosphere Docker Image

Published image:

```bash
ghcr.io/sweetsophia/noosphere:latest
ghcr.io/sweetsophia/noosphere:<semver>
ghcr.io/sweetsophia/noosphere:<git-sha>
```

Responsibilities:

- Run the Noosphere Next.js app.
- Connect to a Postgres database supplied by Docker Compose.
- Expose HTTP on container port `3000`.
- Store uploads in a mounted volume.
- Never bake secrets into the image.

### 4.2 Artifact B — OpenClaw Plugin Package

Published package:

```bash
@sweetsophia/openclaw-noosphere-memory
```

Future ClawHub entry:

```bash
openclaw plugins install clawhub:noosphere-memory
```

Responsibilities:

- Provide OpenClaw tools:
  - `noosphere_status`
  - `noosphere_recall`
  - `noosphere_get`
  - `noosphere_save`
- Provide auto-recall `before_prompt_build` hook.
- Provide memory capture instructions.
- Optionally provide CLI helpers:
  - `openclaw noosphere setup`
  - `openclaw noosphere status`
  - `openclaw noosphere doctor`
  - `openclaw noosphere logs`
  - `openclaw noosphere upgrade`

### 4.3 Artifact C — Bootstrap Installer

Installer script:

```bash
install-openclaw.sh
```

Responsibilities:

- Check Docker, Docker Compose, and OpenClaw CLI availability.
- Create `~/.noosphere/` runtime directory.
- Generate `.env` with safe local secrets.
- Write production `docker-compose.yml` using GHCR image.
- Start Noosphere and Postgres.
- Wait for health.
- Initialize database/admin/API key.
- Install or update OpenClaw plugin.
- Patch OpenClaw plugin config.
- Restart OpenClaw Gateway.
- Print verification commands.

## 5. Development Phases

## Phase 0 — Repo Hygiene and Packaging Baseline ✅ DONE

### Goal

Make the repository ready for intentional release work before changing runtime behavior.

### Tasks

1. Review `.gitignore` and ensure local junk is excluded:
   - `node_modules/`
   - local `.tgz` archives
   - local `.env` files
   - temporary Docker/runtime files
2. Decide final handling of plugin build output:
   - Commit `openclaw-noosphere-memory/dist/`.
   - Do not commit `openclaw-noosphere-memory/node_modules/`.
   - Do not commit local `.tgz` package artifacts.
3. Keep or create plugin `package-lock.json` if reproducible plugin builds are desired.
4. Make sure root app tests still pass before productization changes.

### Verification

```bash
cd ~/github/noosphere
git status --short
npm test
npm run build
```

### Completion Criteria

- Working tree only shows intentional files.
- No local dependency/vendor junk is staged.
- Tests/build still pass.

---

## Phase 1 — Production Docker Compose Design ✅ DONE

### Goal

Create a public-user Compose setup that pulls the published GHCR image instead of building locally.

### Tasks

1. Add production Compose template, likely one of:
   - `docker-compose.noosphere.yml`
   - `deploy/openclaw/docker-compose.yml`
   - generated template embedded in `install-openclaw.sh`
2. Use image reference:

```yaml
image: ghcr.io/sweetsophia/noosphere:${NOOSPHERE_VERSION:-latest}
```

3. Bind to localhost-only by default:

```yaml
ports:
  - "127.0.0.1:${NOOSPHERE_PORT:-6578}:3000"
```

4. Use safe default app URL:

```env
APP_URL=http://127.0.0.1:6578
NEXTAUTH_URL=http://127.0.0.1:6578
```

5. Remove hardcoded machine-specific mounts from public defaults.
6. Keep uploads as named or local volume.
7. Keep Postgres bound to localhost only, or internal-only if host DB access is not required.
8. Add health checks for app and database.

### Verification

```bash
docker compose -f docker-compose.noosphere.yml up -d
curl -fsS http://127.0.0.1:6578/api/health
curl -fsS http://127.0.0.1:6578/wiki
```

### Completion Criteria

- Compose starts from image mode.
- No user-specific host paths are required.
- Noosphere health endpoint passes.
- Noosphere is not publicly exposed by default.

---

## Phase 2 — Container Image Publishing via GHCR ✅ DONE

### Goal

Publish Noosphere as a downloadable container image.

### Tasks

1. Add GitHub Actions workflow for Docker image builds.
2. Push to GHCR:

```bash
ghcr.io/sweetsophia/noosphere
```

3. Tag images with:
   - semver tag, e.g. `0.1.0`
   - git SHA
   - `latest` for stable master release
4. Add OCI metadata labels.
5. Confirm image visibility/pull permissions.

### Verification

```bash
docker pull ghcr.io/sweetsophia/noosphere:latest
```

Then run via production Compose and check:

```bash
curl -fsS http://127.0.0.1:6578/api/health
```

### Completion Criteria

- GHCR image builds in CI.
- Image can be pulled without local source checkout.
- Image runs successfully with Compose.

---

## Phase 3 — Database Migration and Bootstrap Strategy ✅ DONE

### Goal

Make first-run and upgrades safe for public users.

### Tasks

1. Decide migration strategy:
   - Prefer Prisma migrations for official release.
   - Avoid requiring `prisma db push --accept-data-loss` for users.
2. Add startup/bootstrap command or setup script step that applies migrations safely.
   - Use `docker/migrate-or-baseline.mjs` to baseline old `db push` schemas before `migrate deploy`.
3. Add a first-run bootstrap mechanism for:
   - initial admin user
   - API key with required permissions
   - seed topics
4. Make bootstrap idempotent.
5. Ensure secrets are generated locally, not committed.

### Verification

Fresh volume test:

```bash
docker compose down -v
docker compose up -d
curl -fsS http://127.0.0.1:6578/api/health
curl -fsS http://127.0.0.1:6578/wiki
```

Then verify:

- Admin exists.
- API key exists or was printed once.
- Topics exist.
- Memory status API works with generated API key.

### Completion Criteria

- Fresh install works without manual DB commands.
- Re-running installer does not corrupt data.
- Upgrade path is clear and safe.

---

## Phase 4 — Publishable OpenClaw Plugin Package ✅ DONE

### Goal

Make `openclaw-noosphere-memory` installable as a normal OpenClaw plugin package.

### Tasks

1. Update `openclaw-noosphere-memory/package.json`:
   - set `private: false`
   - keep name `@sweetsophia/openclaw-noosphere-memory`
   - export/use compiled `dist/index.js`
   - add `files` whitelist
   - add `build` script
   - add `prepack` script
2. Commit `dist/` as agreed.
3. Ensure `openclaw.plugin.json` points to compiled runtime.
4. Create package release workflow or manual release checklist.
5. Test archive install before publishing.

### Verification

```bash
cd openclaw-noosphere-memory
npm run build
npm pack
openclaw plugins install ./sweetsophia-openclaw-noosphere-memory-*.tgz --force
openclaw plugins inspect noosphere-memory --runtime --json
```

### Completion Criteria

- Plugin archive installs cleanly.
- Runtime inspect shows tools/hooks registered.
- Auto-recall still works after install from package artifact.

---

## Phase 5 — OpenClaw Setup Automation ✅ DONE

### Goal

Create the one-command setup path.

### Tasks

1. Add `install-openclaw.sh`.
2. Script checks prerequisites:
   - Docker
   - Docker Compose
   - OpenClaw CLI
3. Script creates:

```bash
~/.noosphere/docker-compose.yml
~/.noosphere/.env
~/.openclaw/secrets/noosphere-memory.json
```

4. Script starts containers:

```bash
cd ~/.noosphere
docker compose up -d
```

5. Script waits for app health.
6. Script initializes database/admin/API key.
7. Script installs plugin:

```bash
openclaw plugins install npm:@sweetsophia/openclaw-noosphere-memory
```

8. Script patches OpenClaw config using safe config mechanisms where possible.
9. Script enables mandatory hook setting:

```json
{
  "plugins": {
    "entries": {
      "noosphere-memory": {
        "hooks": {
          "allowPromptInjection": true
        }
      }
    }
  }
}
```

10. Script restarts Gateway.
11. Script prints status and next commands.

### Verification

Run on a clean test machine/session:

```bash
bash install-openclaw.sh
openclaw plugins inspect noosphere-memory --runtime --json
curl -fsS http://127.0.0.1:6578/api/health
```

### Completion Criteria

- One command brings up Noosphere.
- Plugin is installed and configured.
- Auto-recall works with marker test.
- Script is idempotent.

---

## Phase 6 — Plugin CLI Helpers ✅ DONE

### Goal

Make the integration feel native to OpenClaw.

### Target Commands

```bash
openclaw noosphere setup
openclaw noosphere status
openclaw noosphere doctor
openclaw noosphere logs
openclaw noosphere upgrade
```

### Tasks

1. Confirm OpenClaw plugin CLI registration API.
2. Add CLI command registration if stable.
3. Implement `doctor` checks:
   - Docker available
   - Compose file exists
   - containers healthy
   - Noosphere health endpoint works
   - API key works
   - plugin config baseUrl is correct
   - `allowPromptInjection` enabled
   - auto-recall enabled
   - enabledAgents includes expected agents
4. Implement `status` and `logs` helpers.

### Verification

```bash
openclaw noosphere doctor
openclaw noosphere status
```

### Completion Criteria

- Doctor output is clear and actionable.
- Common setup failures are detected automatically.

---

## Phase 7 — Documentation ✅ DONE

### Goal

Make installation, operation, troubleshooting, and upgrades understandable.

### Tasks

1. Add or update docs:
   - `README.md`
   - `docs/OPENCLAW-OFFICIAL-PLUGIN-SETUP.md`
   - `docs/NOOSPHERE-MEMORY-ARCHITECTURE.md`
2. Document quick install.
3. Document manual install.
4. Document Docker Compose options.
5. Document OpenClaw config fields.
6. Document security model:
   - localhost default
   - API key permissions
   - prompt injection requirement
   - secret storage
7. Document upgrade path:

```bash
cd ~/.noosphere
docker compose pull
docker compose up -d
openclaw plugins update noosphere-memory
```

8. Document uninstall path.

### Verification

Follow docs exactly from a clean environment and fix every mismatch.

### Completion Criteria

- Docs match real commands.
- No stale local paths remain.
- Troubleshooting covers known blockers.

---

## Phase 8 — Release Checklist ✅ DONE

Before the first official release:

- [x] Root tests pass.
- [x] Root build passes.
- [x] Docker image builds locally.
- [x] Docker image builds in CI.
- [x] Docker image pulls from GHCR.
- [x] Production Compose starts app + DB.
- [x] Health endpoint works on `127.0.0.1:6578`.
- [x] DB bootstrap works on fresh volume.
- [x] Admin/API key bootstrap works.
- [x] Plugin package builds.
- [x] Plugin package archive installs.
- [x] Plugin runtime inspect shows tools/hooks.
- [x] `noosphere_status` works.
- [x] `noosphere_recall` works.
- [x] `noosphere_save` works.
- [x] Auto-recall injection passes marker test.
- [x] Installer is idempotent.
- [x] Docs are tested from scratch.
- [ ] GitHub release notes written for the first tagged release.

Detailed evidence is maintained in `docs/OPENCLAW-PHASE-8-RELEASE-CHECKLIST.md`.

## 6. Risks and Mitigations

| Risk | Mitigation |
| --- | --- |
| Port conflict | Default to uncommon localhost port `6578`; allow `NOOSPHERE_PORT` override. |
| Exposing memory server publicly | Bind to `127.0.0.1` by default. Document public exposure separately. |
| Unsafe DB migration | Use Prisma migrations for official releases; avoid destructive db push for users. |
| Plugin installed but hook does not inject | Installer must set `hooks.allowPromptInjection: true`; doctor must check it. |
| API key leakage | Store API key in OpenClaw secrets file, not inline docs/config examples. |
| Setup script mutates config incorrectly | Prefer OpenClaw config tooling where possible; backup config before raw edits if needed. |
| Docker unavailable | Installer should fail early with clear instructions. |
| Image/package version skew | Pin compatible versions in release notes and installer defaults. |

## 7. Remaining Release Follow-up

1. Open and merge the Phase 8 release-checklist PR.
2. Write GitHub release notes for the first tagged release.
3. Cut/push the release tag once Sophie approves the release boundary.

## 8. Working Branch Proposal

```bash
git checkout -b feat/official-openclaw-plugin-distribution
```

## 9. Verification Strategy

Use layered verification:

1. Static checks:
   - TypeScript build
   - tests
   - lint if available
2. Package checks:
   - `npm pack`
   - OpenClaw plugin install from `.tgz`
   - runtime inspect
3. Container checks:
   - Docker build
   - GHCR image pull
   - Compose up/down
4. Integration checks:
   - Noosphere health
   - memory status/recall/save APIs
   - OpenClaw tools
   - auto-recall marker test
5. Installer checks:
   - clean install
   - re-run idempotency
   - upgrade path

## 10. Notes

- Keep OpenClaw plugin lightweight. It should integrate with Noosphere, not own container lifecycle during normal prompt execution.
- Setup/doctor commands may manage Docker, but recall/save hooks should only call the Noosphere HTTP API.
- Default to secure local operation first. Public network exposure is an advanced configuration.
