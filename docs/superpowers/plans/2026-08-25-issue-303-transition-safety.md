# Issue #303 Transition-Safety Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Keep the three mechanisms sequential because they share the controller and focused fixture.

**Goal:** Close the three production-safety blockers that must precede Noosphere's existing-volume PostgreSQL-to-pgvector transition.

**Architecture:** Preserve the controller's existing fail-closed state machine and make three surgical changes: run Compose activation with only bound environment values, convert authorization postprocessing failures into durable writer-closure incidents, and reject writable Compose publication parents regardless of owner. Import the preserved RED owners from `fix/item3-controller-hardening-r2` onto current `master`; do not merge or cherry-pick the stale branch wholesale. Keep the current hardening PR bounded, then integrate the reviewed controller into the existing guarded installer so repository users receive the same private artifact staging and one-command upgrade path.

**Tech Stack:** Bash 5, jq, Docker Compose, systemd user units, repository shell fixtures.

**Current status (2026-08-26):** PR #305 is open. Its public-review correction
passes six direct owners, eleven impacted siblings, the focused `132/132` suite,
standalone transient-systemd and pinned-Docker rehearsals, static gates, privacy
scan, and zero-residue inspection. Updated CI/review and all of Task 7 remain
separately gated for the corrected head.

---

### Task 1: Restore the three focused RED owners on current master

**Files:**
- Modify: `scripts/test-pgvector-transition-controller.sh`

- [x] **Step 1: Add the ambient Compose interpolation owner**

Add `test_activation_uses_only_bound_compose_interpolation_values`. Its fake Docker executable must read `APP_IMAGE` from the bound `--env-file` unless the controller leaks an ambient `APP_IMAGE`; invoke activation with `APP_IMAGE=attacker/image` and require the selected image to remain `expected/image@sha256:bound`.

- [x] **Step 2: Add the authorization-postprocessing closure owner**

Add `test_authorization_postprocessing_failure_closes_writer_durably`. Inject `NOOSPHERE_CONTROLLER_TEST_FAIL_EVIDENCE=authorization-running`, require a non-zero exit before activation, require lifecycle `transition,authorize`, require stop plus `inspect:false`, and require terminal `incident` state with a `closure-*` class and bound `writerStopEvidence`.

- [x] **Step 3: Add the root-owned writable-parent owner**

Add `test_simulated_root_rejects_root_owned_writable_compose_parent`. Simulate UID 0 for a mode-0777 publication parent, require `publish_compose_atomic` to fail, and prove the live Compose target bytes remain unchanged.

- [x] **Step 4: Register all three owners with authority isolation**

Append each owner to the focused fixture dispatch, separated by `_clear_authority_root_for_isolation`.

- [x] **Step 5: Prove all three owners are RED for their intended mechanism**

Run each owner independently:

```bash
timeout 180s bash -c '
  source scripts/test-pgvector-transition-controller.sh
  _clear_authority_root_for_isolation
  test_activation_uses_only_bound_compose_interpolation_values
'

timeout 180s bash -c '
  source scripts/test-pgvector-transition-controller.sh
  _clear_authority_root_for_isolation
  test_authorization_postprocessing_failure_closes_writer_durably
'

timeout 180s bash -c '
  source scripts/test-pgvector-transition-controller.sh
  _clear_authority_root_for_isolation
  test_simulated_root_rejects_root_owned_writable_compose_parent
'
```

Expected: each command exits non-zero with its mechanism-specific diagnostic; no controller, transient-unit, container, volume, network, or runtime-path residue remains.

### Task 2: Bind Compose activation to the prepared environment

**Files:**
- Modify: `scripts/run-pgvector-transition-controller.sh`
- Test: `scripts/test-pgvector-transition-controller.sh`

- [x] **Step 1: Run the Compose activation command under an empty environment**

In `activate_application_for_verification`, keep the bound Docker path, candidate Compose path, env file, project directory, and app service. Invoke the Compose command with only the controller's prepared environment:

```bash
env -i \
  HOME="$HOME" \
  DOCKER_CONFIG="$DOCKER_CONFIG" \
  DOCKER_HOST="$DOCKER_HOST" \
  COMPOSE_DISABLE_ENV_FILE=1 \
  PATH="$PATH" \
  "$docker_path" compose \
    --project-directory "$project_directory" \
    --env-file "$execution_env_file" \
    -f "$execution_candidate_compose" \
    up -d --no-deps --force-recreate app
```

Do not add a generic environment abstraction; this is the only Compose activation boundary being corrected.

- [x] **Step 2: Run the focused owner**

Expected: `test_activation_uses_only_bound_compose_interpolation_values` exits 0 and selects `expected/image@sha256:bound`.

### Task 3: Close the writer when authorization evidence postprocessing fails

**Files:**
- Modify: `scripts/run-pgvector-transition-controller.sh`
- Test: `scripts/test-pgvector-transition-controller.sh`

- [x] **Step 1: Make authorization postprocessing catchable**

After `--authorize-writer` returns, run the fallible end timestamp, journal cursor, evidence write, and evidence binding inside a subshell so `die` exits the subshell rather than bypassing controller closure:

```bash
if (
  ended_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  end_cursor=$(capture_journal_cursor)
  write_process_evidence_atomic ...
  bind_process_evidence_to_state ...
); then
  :
else
  postprocess_exit=$?
  begin_closure_incident "$state" postprocessing
  return "$postprocess_exit"
fi
```

The guard exit code remains evidence data; a non-zero authorization result still follows the existing `writer-authorization` incident path after evidence is durably bound.

- [x] **Step 2: Run the focused owner**

Expected: `test_authorization_postprocessing_failure_closes_writer_durably` exits 0, never activates the app, and binds inspect-verified writer-stop evidence to a closure incident.

### Task 4: Reject writable Compose publication parents for every owner

**Files:**
- Modify: `scripts/run-pgvector-transition-controller.sh`
- Test: `scripts/test-pgvector-transition-controller.sh`

- [x] **Step 1: Enforce parent mode independently of UID**

In `publish_compose_atomic`, retain the real-directory/non-symlink check, then always evaluate the parent's mode:

```bash
parent_mode=$(stat -c '%a' "$parent")
(( (8#$parent_mode & 8#022) == 0 )) ||
  die "Compose publication parent permits group/world writes: $parent"
```

Remove the current-user-only conditional. Do not weaken the existing owned-file checks or atomic install/fsync/rename sequence.

- [x] **Step 2: Run the focused owner**

Expected: `test_simulated_root_rejects_root_owned_writable_compose_parent` exits 0 and the target retains its original bytes.

### Task 5: Verify the corrected controller before review

**Files:**
- Verify: `scripts/run-pgvector-transition-controller.sh`
- Verify: `scripts/test-pgvector-transition-controller.sh`
- Verify: `scripts/test-pgvector-transition-controller-systemd.sh`
- Verify: `scripts/test-pgvector-transition-controller-docker.sh`

- [x] **Step 1: Run static checks**

```bash
bash -n scripts/run-pgvector-transition-controller.sh \
  scripts/test-pgvector-transition-controller.sh \
  scripts/test-pgvector-transition-controller-systemd.sh \
  scripts/test-pgvector-transition-controller-docker.sh
git diff --check
```

- [x] **Step 2: Run the three corrected owners together and affected siblings**

Include environment-hermeticity, authorization-evidence ordering, activation failure, successful-verifier postprocessing, publication-input permission, and production-hook rejection owners.

- [x] **Step 3: Run the full focused/controller, real transient-systemd, and pinned-Docker gates under bounded supervision**

Require explicit terminal return-code markers, definition/dispatch parity, byte-stable controller hash during each run, and zero owned residue.

- [x] **Step 4: Run three sequential native adversarial reviews**

Review the frozen diff against issue #303's three safety contracts. Reconcile every finding; any byte change returns to Step 1 and the appropriate affected/full gate.

- [x] **Step 5: Privacy and staged-diff scan**

Require no Graphify artifacts, local paths, machine identifiers, credentials, tokens, or unrelated changes.

### Task 6: Publish without touching production

**Files:**
- Modify as needed: `docs/POSTGRES-PGVECTOR-EXECUTION-CONTROLLER.md`
- Modify: `docs/MEMORY-REVAMP-STATUS.md`
- Add: `docs/superpowers/plans/2026-08-25-issue-303-transition-safety.md`

- [x] **Step 1: Update only mechanism-specific operator documentation**

Document that the three production-safety blockers are implemented and verified; keep the transition and hybrid rollout explicitly operator-gated.

- [x] **Step 2: Commit, push, and open a focused PR**

Use the `SweetSophia` GitHub account, verify exact PR scope, and leave the PR open.

- [ ] **Step 3: Observe CI and review bots for the mandatory window**

Address valid feedback within the approved definition of done. Do not merge, deploy, transition PostgreSQL, activate feature schemas, start the hybrid worker, or mutate the production volume in this implementation stage.

### Task 7: Automate the end-user upgrade in a separate bounded stage

**Files:**
- Modify: `install-openclaw.sh`
- Modify: installer regression fixtures selected after inventory
- Modify: `docs/OPENCLAW-OFFICIAL-PLUGIN-SETUP.md`
- Modify as needed: `README.md`

- [ ] **Step 1: Stage the reviewed controller and its bound helpers privately**

Extend the installer's existing checksum-pinned `prepare_guard_script` pattern to install the controller, guard, and verifier as owner-only executables. A shared repository checkout and umask `0002` must not make the installed upgrade artifacts group-writable.

- [ ] **Step 2: Route existing-volume upgrades through the controller**

Generate the controller manifest and state paths from installer-managed inputs, then execute prepare and transition through the controller. Preserve the current offline, restore-tested guard and all existing fail-closed recovery behavior.

- [ ] **Step 3: Provide one copy-ready upgrade command**

Keep the checksum-pinned installer invocation as the supported user workflow. The command must upgrade an existing Noosphere installation without requiring users to assemble controller manifests or repair checkout permissions manually.

- [ ] **Step 4: Verify new install, successful upgrade, interrupted upgrade, and rerun recovery**

Require deterministic artifact modes, byte pinning, state/evidence preservation, zero owned residue, and unchanged production opt-in boundaries. Publish this automation only after its own focused fixtures, full installer checks, sequential native reviews, and PR gate are GREEN.

---

## Evidence claim

The hardening stage is complete only when all three defect owners are GREEN, affected siblings and full supervised gates pass with zero residue, sequential native reviews are reconciled, and the published PR is terminally green. The user-facing workflow is complete only after Task 7 proves the checksum-pinned one-command installer upgrade. Database transition authorization remains a separate post-merge go/no-go.

### Review 1 correction addendum — 2026-08-26

The strict sequential review found four additional defects after the earlier
gates. Complete this addendum before restarting Review 1; Reviews 2 and 3 stay
blocked until the corrected bytes are fully re-gated.

- [x] Preserve three deterministic RED owners: controller-state fsync failure
      must not advance phase, writer-stop evidence fsync failure must not bind
      evidence, and a late authorization-evidence bind failure must remain a
      valid resumable closure incident.
- [x] Strengthen the foreign-parent fixture to prove both rejected publication
      targets retain their original bytes.
- [x] Make atomic state publication and writer-stop evidence publication return
      the exact first failure even when their callers use conditional contexts.
- [x] When authorization evidence binding reports a late durability failure,
      atomically remove the unusable binding while recording the scoped
      `authorization-evidence-unavailable` exception.
- [x] Run the direct owners and affected siblings, then the full focused,
      transient-systemd, and pinned-Docker gates under durable supervision with
      stable hashes and zero owned residue before restarting sequential review.

### Fresh Review 1 correction addendum — 2026-08-26 13:30 GMT+2

- [x] Preserve the closure-intent durability failure as an owner that requires
      exact first-status propagation, inspect-verified writer stop, and refusal
      to reauthorize a nonterminal state carrying `writerStopEvidence`.
- [x] Preserve initial activation-inspect failure as an owner that requires a
      terminal `closure-app-activation` incident and bound writer-stop proof.
- [x] Preserve ancestor retarget as an owner that substitutes attacker bytes
      after validation and requires publication to remain anchored to the
      reviewed source and target directories.
- [x] Add a simulated-UID-0, root-owned mode-0777 publication-parent owner and
      prove it detects removal of the parent-mode guard.
- [x] Apply surgical corrections only: preserve the closure-intent status,
      block reauthorization after a verified nonterminal stop, return initial
      inspect failures to the closure caller, and perform publication through
      verified directory descriptors.
- [x] Run the four direct owners and affected sibling matrix (`27/27`).
- [x] Run the full focused suite, transient-systemd fixture, and pinned-Docker
      rehearsal with stable hashes and zero residue before restarting the three
      fresh native reviews strictly sequentially.

### Final local gate addendum — 2026-08-26

- [x] Preserve deterministic owners for pre-open parent retarget, candidate-entry
      swap after digest preparation, closure-intent plus stop dual failure across
      a fresh invocation, detached target-parent publication, and post-rename
      directory-fsync failure exposing advanced state/evidence.
- [x] Bind publication to opened directory identities and exact staged bytes.
- [x] Make fresh authorization/activation phases stop-only and fail closed.
- [x] Stop a retained writer before phase-owned proof validation on a fresh
      invocation, then require full proof validation before state advancement.
- [x] Restore prior bytes or absence after post-rename durability failure and
      terminate fail-stopped if rollback cannot be made durable.
- [x] Run six direct owners, eleven impacted siblings, and focused `132/132` on
      the public-review correction with stable hashes.
- [x] Rerun standalone transient-systemd and pinned-Docker `linux/amd64` against
      the corrected head with zero owned residue.
- [x] Complete three sequential read-only reviews on the pre-publication bytes
      with zero release-floor blockers and a zero-hit privacy scan.
- [x] Publish focused PR #305 without merging or deploying.
- [ ] Observe updated CI/review through the mandatory window and keep
      merge/deployment/transition separately authorized.
