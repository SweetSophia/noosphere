# Item #3 Execution Controller Verification Plan

## Claim

The one-time PostgreSQL source-to-candidate transition can be launched under
systemd without creating an unowned state between candidate Compose publication
and the pinned guard journal, and can be resumed after signals or reboot without
guessing whether source restoration or candidate closure owns the next action.

The controller must not weaken or replace `switch-pgvector-compose.sh`. The
pinned guard remains the only database, authorization, and transition-journal
mutator.

## Scope

- Add a separate execution controller and focused fixture suite.
- Do not change the pinned guard, verifier, installer, image digests, or Compose
  policy in this stage.
- Keep production execution, downtime, and Phase C out of scope.

## State model

The controller owns one stable, owner-only state file per Docker engine and
PostgreSQL volume. Its durable phases are:

1. `prepared` — artifacts, environment model, command identities, source
   snapshot, and guard arguments are verified and persisted; live Compose is
   unchanged.
2. `candidate-published` — recovery ownership is durably committed immediately
   before candidate Compose is atomically published while the controller holds
   the guard's engine-plus-volume lock. A stop between the state commit and the
   rename safely restores the already-live source snapshot on resume.
3. `guard-exited` — deferred guard exit status, process evidence, and the
   completed transition journal are durably recorded.
4. `authorization-running` — the pinned guard's writer-authorization mode is
   running; successful process evidence is bound before activation.
5. `activation-running` — authorization evidence is durable and candidate app
   activation is pending or in progress.
6. `closure-running` — the activated deployment's full verification is in
   progress.
7. `complete` — guard, authorization, and verifier evidence are durably
   committed with the unchanged completed journal.
8. `incident` — no automatic next action is safe; candidate/source state and
   evidence are preserved for operator diagnosis.

The stable state file is created before Compose publication. On a later
invocation, `candidate-published` without a guard journal restores the exact
source-staged Compose file only after source container and authorization checks
pass. Any valid guard journal delegates recovery or completed-journal
revalidation to the pinned guard.

## Evidence path

### Focused fixture suite

1. **Pre-journal interruption**
   - Inject failure immediately after candidate Compose publication.
   - Verify controller state is durable and source Compose is restored.
   - Repeat from a fresh process to model reboot recovery.

2. **Shared lock ownership**
   - Hold the exact engine-plus-volume lock in one fixture process.
   - Verify a second controller fails before changing Compose.
   - Verify the guard child receives and validates the inherited lock FD/path.
   - Treat participation in this lock as the publication trust boundary for
     controller state, Compose, and the guard journal. A malicious
     non-cooperating same-UID writer requires a separate OS identity or
     capability and is outside this shell-controller plan.

3. **Hermetic execution inputs**
   - Seed hostile Docker/Compose environment variables and an implicit `.env`.
   - Verify the controller uses the recorded local Unix endpoint, explicit
     env/config paths, minimal PATH, isolated Docker config, and recorded
     Docker/Compose command identities.
   - Mutate each recorded command/config input after preparation and verify
     failure before Compose publication.

4. **Signal and stop races**
   - Inject TERM before child PID assignment, while the guard runs, after guard
     exit, and during cleanup.
   - Verify traps are idempotent, later signals cannot re-enter cleanup, and the
     durable state selects exactly one next action.
   - Verify the systemd launch contract has no start/runtime kill timeout and an
     explicit infinite stop timeout; reboot recovery is a next-invocation rule,
     not a claim that shutdown traps always finish.

5. **Closure and evidence failures**
   - Bind verifier stdout, stderr, exit status, InvocationID, boot ID, PID, and
     start/end journal cursors to owner-only files.
   - Verify identity/extension/count/infrastructure failures stop the app and
     commit `incident` without rollback.
   - Permit completed-journal guard revalidation only for isolated app-health
     failure after all other checks are independently green.
   - Fail evidence fsync/storage as a fixture and verify there is no false
     `complete` state.

### Integration evidence

- Run the controller against disposable fake commands for every phase/fault.
- Run the existing full guarded-switch matrix unchanged.
- Run one disposable Docker transition/recovery rehearsal through the controller
  on linux/amd64 before any production proposal.
- Run syntax, policy, privacy, and staged-diff checks.

The linux/amd64 controller rehearsal must bind a unique loopback app-health
endpoint in the prepared manifest, run the real controller as the transient
unit MainPID, invoke the pinned guard and real verifier against uniquely named
Docker resources, and prove exact cleanup. A fake-dependency systemd fixture is
process-ownership evidence only and cannot satisfy this item by itself.

## Success criteria

- Every injected interruption ends in one durable and diagnosable controller
  phase.
- No second controller or guard can run outside the shared lock.
- Candidate Compose is never left published without either a valid guard journal
  or controller-owned recovery state.
- No verifier or evidence failure can be reported as success.
- Existing guarded-switch tests remain green without changing the immutable
  helper/installer chain.

## Stronger fallback

If shell fixtures cannot prove signal/reboot behavior directly enough, run the
controller in a disposable user-manager namespace or VM and kill the wrapper and
guard at each durable phase. Production remains excluded until that evidence is
green and the change passes sequential review and the PR gate.

### Stage 5b — Review 2 correction batch (4 BLOCKER + 3 HIGH)

Review 2 (fresh Codex native subagent on the Stage-5-corrected worktree) found
seven further substantive findings that bypass Stage 5. The integration gate is
NOT green for production. The next bounded stage implements these seven
corrections and re-verifies with a fresh third review before commit/push/PR.

1. **BLOCKER** — Prepare/execute boundary leak. `sanitize_execution_environment`
   does not unset `NOOSPHERE_CONTROLLER_TEST_*`. Inherited envvars can flip
   evidence persistence, signal behavior, or terminal outcome after the pinned
   guard has mutated the transition. (lines 308, 356–358, 453–455, 675–677, 1026–1028)
2. **BLOCKER** — Path-separation covers only state↔journal. Derived log/evidence
   paths are never checked against `liveCompose`, `sourceSnapshot`,
   `candidateCompose`, `envFile`, guard, verifier, Docker config, or each
   other. A collision such as `liveCompose == ${state%.json}.guard.stdout.log`
   truncates the live Compose to zero bytes via tee before the guard runs.
   (lines 869–871, 1019–1023, 1055–1059)
3. **BLOCKER** — Guard/verifier TOCTOU. Scripts are hashed once at verify time
   and then executed by pathname later. A same-user writer can swap bytes
   between verify and exec without registering a digest failure. Bind exec to
   a rehash right before invocation, or to a copy under a private path.
   (lines 833–857, 1030–1031, 1063–1064)
4. **BLOCKER** — Real signal discards child evidence. After a forwarded TERM
   returns from `wait`, `abort_if_interrupted` exits at lines 1032 or 1065
   before end timestamp/cursor capture, log fsync, or process-evidence binding.
   A fresh interrupted run has only `lastInterruption`; its child outcome and
   logs are not durably bound. (lines 1030–1042, 1063–1075)
5. **HIGH** — Final guard-journal digest check is not atomic with
   `phase=complete`. The journal is hashed, then the controller performs more
   shell work before atomically writing `phase=complete`. Volume flock does
   not lock the journal file; a non-cooperating same-user writer can change
   the journal between the hash and the write. (lines 669–679)
6. **HIGH** — Phase-dependent terminal invariants are not validated.
   `validate_controller_state` accepts `phase=complete` without
   `guardEvidence`, `closureEvidence`, or `guardJournalEvidence`, and accepts
   `phase=incident` without an incident class. (lines 86–108, 172–181)
7. **HIGH** — Preparation resolves Docker/Compose identity through ambient
   configuration. `verify_execution_inputs` runs before
   `sanitize_execution_environment`; inherited `DOCKER_HOST`,
   `DOCKER_CONTEXT`, `DOCKER_CONFIG`, and `COMPOSE_*` can determine the
   engine/plugin/model accepted into the prepared state. Hermetic
   sanitization occurs only at execute, so preparation can certify a context
   different from the recorded production execution context. (lines 824–858,
   860–868, 983–997)

Threat-model resolution (Aug 16): finding 5 is enforced at the cooperative
engine-volume lock boundary. The controller retains and re-asserts that exact
lock through the final completed-journal validation and `complete` state
publication; fixtures prove a separately opened lock descriptor cannot acquire
the lock at that boundary and can acquire it after controller exit. Protection
from a malicious non-cooperating same-UID process would require the explicitly
deferred identity/capability split rather than a shell-level digest recheck.

Plan for Stage 5b: write seven RED fixtures first (each red for the specific
mechanism), confirm RED, then implement the seven corrections in one bounded
batch, re-verify with 32 focused fixtures + guarded-switch matrix + policy
check + production source verification, then run a fresh third review before
commit/push/PR.

### Two-step writer closure — post-full-gate Review 1 corrections

The fresh Review 1 of the durable transition → authorization → activation →
verification lifecycle accepted three further blockers:

1. A signal latched after app activation but before verifier launch could
   return while the writer remained running and restartable.
2. Resuming `closure-evidence-pending` selected normal closure and reactivated
   the writer that the prior failed closure had already stopped.
3. A missing or unsafe live Compose file exited from the restore helper instead
   of returning to the recovery owner for durable incident classification.

Verification is RED-first with one independent fixture per mechanism. The
corrected artifact must stop and verify the writer before a post-activation
signal returns, keep pending-evidence resumes activation-free, and classify
unsafe pre-journal restoration as a durable incident. The focused suite,
policy check, real transient-systemd fixture, pinned-guard Docker rehearsal,
residue checks, and explicit production source-mode verification must all pass
before a replacement fresh Review 1. Review 2 remains sequentially blocked
until that Review 1 is clean.

### Replacement Review 1 — four post-full-gate corrections

The replacement Review 1 accepted four additional state/identity blockers:

1. Verifier artifact allocation after application activation allowed a path or
   storage failure to strand an active writer without durable verifier
   evidence.
2. `closure-evidence-pending` could be persisted before the writer stop was
   inspect-verified, so failed stop verification could leave a misleading
   evidence-retry phase.
3. Prepared state named the PostgreSQL volume but did not bind its canonical
   Docker metadata, allowing a same-name replacement between preparation and
   execution.
4. Preparation and execution performed live Docker/Compose identity queries
   before acquiring the shared engine-volume lock, allowing cooperating
   transition owners to race the certified identity.

The corrected controller allocates verifier artifacts before activation,
persists `closure-stop-pending` and verifies the stop before
`closure-evidence-pending`, binds and rechecks the canonical
`{Name,Driver,Mountpoint,CreatedAt,Scope,Labels,Options}` volume fingerprint,
and acquires the shared operation lock before every live prepare/execute
identity query. Four independent RED owners, twelve affected legacy owners,
and the complete 86-owner focused aggregate must be GREEN before the full
policy/systemd/pinned-Docker/residue/production-source gate and replacement
fresh Review 1. Review 2 remains sequentially blocked until Review 1 is clean.

## 2026-08-17 — Six-owner implementation complete

All six RED owners from the corrected Review 1 are GREEN, plus the three
review-adjacent legacy corrections:

1. Execute-entry fail-closed rejection of ambient `NOOSPHERE_CONTROLLER_TEST_*`
   hooks (six-variable explicit diagnostic contract; unset retained as
   defense-in-depth).
2. Durable engine-volume state authority: runtime claim in `lockRoot` mirrored
   to the XDG state root (`XDG_STATE_HOME` when set, else `$HOME/.local/state`)
   under `noosphere-pgvector-controller/authority/`; duplicate prepare rejected
   while the recorded state path exists in a non-terminal phase; execution
   revalidates, so a copied state at a second path cannot execute. Stale
   records (missing or `complete` state files) are reclaimed under the lock.
3. Post-authorization pre-activation failures (latched signal, verifier
   artifact-storage failure) commit `closure-stop-pending`, stop and
   inspect-verify the writer with bound `writerStopEvidence`, then publish the
   exact `closure-interruption` / `closure-artifact-storage` incident — never
   before the verified stop.
4. Source-recovery derived artifacts joined the controlled-path collision
   matrix.
5. Source-recovery retry allocates InvocationID-distinct artifact paths via
   `select_process_artifact_base`, so prior unbound evidence/logs survive a
   publication/bind crash byte-identically.
6. Phase-owned state proofs inlined into `validate_controller_state`
   (extraction-compatible) with per-key diagnostics; `writer-stop.evidence.json`
   joined the controlled namespace.

Fixture corrections required by the corrected contracts:
`test_closure_outcome_never_false_completes` baseline now carries
`guardEvidence` + `writerStopEvidence`; the crafted state's phase-authority
tests assert incident classification instead of the superseded resumable
`activation-running` outcome.

Test-isolation hardening: durable authority records now honor
`XDG_STATE_HOME`; the focused suite isolates its state root per run, the
systemd fixture passes the same root into both transient units, and the Docker
rehearsal relocates it into its disposable `tmp_dir` with a residue assertion.
The invoking user's real state namespace is no longer touched by fixtures.

Gate status (2026-08-17 22:4x): focused, systemd, and Docker suites re-running
after the isolation change; controller + fixtures previously byte-stable GREEN
across all three. Next: hygiene scan, sequential fresh Reviews 1 and 2,
privacy scan, commit/push/PR #300 update, 20-minute CI/bot gate.


## 2026-08-18 — Re-review round 2 stage (operator review comment 5321434858)

Applied corrections per Sophie's round-2 re-review: (1) jq escaped-quote fix in the closure-stop-pending resume die; (2) writer-stop evidence retry-distinct allocation via `select_process_artifact_base`; (3) invocation-suffixed artifact paths added to the collision matrix. Two new regression fixtures cover the retry-distinct stop evidence and the suffixed-path collision rejection. Gate after corrections: policy GREEN, focused suite 102/102 GREEN, real transient-systemd GREEN, pinned-Docker GREEN, residue 0, production-source verify GREEN (50 topics / 512 articles / 15 keys). Findings 2-5 from the review recorded as follow-ups (dead `bootId` field wiring, `NOOSPHERE_CONTROLLER_TEST_CURSOR` deny-list symmetry, dead `--setenv` fixture lines, suffixed-path matrix completeness beyond writer-stop).
