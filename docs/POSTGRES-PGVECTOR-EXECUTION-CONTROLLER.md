# PostgreSQL pgvector execution controller

The execution controller owns the process and evidence transaction around the
pinned `switch-pgvector-compose.sh` guard. It does not replace or weaken the
guard: database, authorization-volume, backup, recovery, and transition-journal
mutations remain exclusively inside the pinned guard.

## Safety boundary

- Preparation validates an owner-only manifest and writes an owner-only durable
  state file. It does not modify Compose or Docker state.
- Execution is accepted only inside an explicitly named transient systemd
  service whose InvocationID, MainPID, safety properties, and transient
  provenance are queried from the user manager.
- The controller starts Bash in privileged mode, installs a fixed bootstrap
  PATH before its first utility call, and validates the manifest's fixed PATH
  with that bootstrap toolchain before exporting the recorded value.
- The controller executable itself, every child executable, environment file,
  source snapshot, candidate Compose file,
  Docker Compose version, and effective candidate Compose model is re-hashed
  before publication.
- Preparation and execution acquire the guard's exact
  Docker-engine-plus-volume lock before every live Docker/Compose identity
  query. The guard runs as a child and inherits that already-held descriptor;
  the wrapper never `exec`s away its signal and recovery traps.
- That same lock is the cooperative publication trust boundary for Compose,
  the guard journal, and controller state. It remains held and is re-asserted
  through the final completed-journal validation and `complete` state write.
  Every legitimate actor that can replace those artifacts must participate in
  the lock. A malicious non-cooperating same-UID writer requires a separate OS
  identity/capability and is outside this shell-controller contract.
- Every guard or verifier starts in a controller-owned process group. A trapped
  signal is forwarded to that whole group; the controller reaps the direct
  child and waits until the group is empty before writing process evidence or
  releasing the lock.
- `candidate-published` recovery ownership is fsynced before the atomic
  candidate Compose rename. A stop on either side of the rename therefore has
  one deterministic next-invocation action.
- A successful deferred guard is only the pre-authorization boundary. The
  completed guard journal and process evidence are durably bound first; the
  same pinned guard then authorizes the writer, the controller activates the
  app, and the unchanged full deployment verifier runs last. All three process
  evidence records must be durable before `complete`.

## Durable phases

`prepared` → `candidate-published` → `guard-exited` →
`authorization-running` → `activation-running` → `closure-running` →
`complete`.

A closure failure first enters resumable `closure-stop-pending`. The controller
stops the app writer and verifies it is not running before committing terminal
`incident`. A reboot or failed first stop therefore retries the required stop
instead of stranding an unsafe writer behind a terminal state.

If verifier evidence cannot be persisted after a failed closure check, the
controller retains `closure-evidence-pending` with the writer verified stopped.
A later invocation may retry evidence collection while the writer remains
stopped, but it cannot run the activation step again. A signal latched after
activation likewise commits fail-closed stop intent and verifies the writer is
stopped before the controller returns.

Any state for which automatic continuation is unsafe enters `incident`. A
pre-journal interruption restores only the recorded source Compose snapshot and
only after the source deployment verifier passes. Once a guard journal exists,
the pinned guard owns recovery and revalidation.

## Preparation

Create the private controller, backup, and runtime-lock directories with mode
`0700`. Build a mode-`0600` JSON manifest containing the paths, arguments,
digests, Docker engine/endpoint, volume/container identities, and effective
Compose signature required by `validate_execution_manifest`. Then run:

```bash
scripts/run-pgvector-transition-controller.sh \
  --prepare \
  --manifest /absolute/private/controller/manifest.json \
  --state /absolute/private/controller/state.json
```

Preparation must finish with phase `prepared`. An existing prepared state is
accepted only when it is byte-identical to the manifest, and its inode is not
rewritten. A different manifest or any active/terminal phase is refused. If a
recorded input changes, resolve or preserve the existing state and prepare a
new manifest/state pair; never edit a prepared state file. The prepared state
also binds the canonical SHA-256 fingerprint of the live PostgreSQL volume's
`{Name,Driver,Mountpoint,CreatedAt,Scope,Labels,Options}` document. Execution
re-inspects and compares that fingerprint while holding the same operation
lock, rejecting a same-name replacement volume before any Compose action.

## systemd execution contract

Preflight the exact transient unit name as absent. The user manager must have
linger enabled so reboot recovery can be initiated without an interactive
login. The controller queries `Transient=yes`; a persistent installed service
cannot satisfy this contract. Start the controller with these properties:

```text
Type=exec
RemainAfterExit=no
Restart=no
KillMode=mixed
TimeoutStartSec=infinity
TimeoutStopSec=infinity
RuntimeMaxSec=infinity
UMask=0077
WorkingDirectory=/absolute/repository/path
```

Set `CONTROLLER_UNIT` to that exact service name and pass only the prepared
state path to execution:

```bash
scripts/run-pgvector-transition-controller.sh \
  --execute \
  --state /absolute/private/controller/state.json
```

Do not impose a systemd start, runtime, or stop timeout. TERM, INT, and HUP are
latched once, forwarded to the active guard or verifier process group, and
enforced at the next controller phase boundary. The controller does not return
or release the inherited transition lock until that process group is empty.
The interrupted process exits with the signal-derived status; deterministic
recovery belongs to the next invocation.

## Closure and recovery

- Guard failure before a journal: verify the source runtime, atomically restore
  the source snapshot, and commit `incident/pre-journal-source-restored`.
- Guard journal present: invoke the pinned guard again under the inherited lock;
  it decides recovery or completed-journal revalidation.
- Deferred guard success: bind the completed journal and guard evidence, invoke
  the same pinned guard with `--authorize-writer`, bind authorization evidence,
  activate the app from the invocation-private candidate Compose model, then
  run the unchanged full verifier.
- Writer authorization or app activation failure: preserve the completed
  candidate transition, keep or restore the app-stopped boundary, and commit a
  closure incident. Never run the final verifier after failed activation.
- Verifier failure after the guard journal completes: preserve candidate
  database and Compose state, commit `closure-stop-pending`, stop and verify the
  app writer, then commit the terminal incident. Never automatically roll back
  a completed database transition.
- Evidence-write/fsync failure: no `complete` transition is possible. Preserve
  the state directory and resume from the existing durable phase.
- Verifier failure: durably commit the stop requirement and verify that the app
  writer stopped before terminal incident handling or fallible verifier-evidence
  persistence.

Production execution remains a separately approved item. A green controller PR
and disposable fault matrix do not authorize downtime or the database switch.


## Execution-time invariants added after Review 1 (Aug 10)

- **Terminal-state precedence**: `incident` and `complete` phases refuse
  before any guard-journal delegation; resume never silently re-runs the
  guard from a terminal state.
- **Systemd identity is queried, not asserted**: `require_systemd_execution_context`
  binds `INVOCATION_ID`, `MainPID`, and `ActiveState` from `systemctl --user show`,
  rejecting matches where the environment claims an identity the unit does not
  corroborate. Focused fixtures override `query_systemd_unit_identity`.
- **Preparation never orphans an active or terminal state**:
  `prepare_execution_state` refuses to overwrite any existing state whose phase
  is not `prepared`; an existing prepared state is accepted only when its bytes
  already equal the manifest, without replacing the state inode.
- **Live engine and lock-root rebinding**: `assert_live_engine_binding` queries
  the recorded Docker executable for `info --format '{{.ID}}'` and compares it
  to the recorded `engineId`; it also compares the recorded `lockRoot` to the
  guard's `${XDG_RUNTIME_DIR:-/run/user/uid}` contract. Both checks run at
  prepare and at execute while the engine-volume operation lock is already
  held and before any Compose action.

These guarantees do not weaken the pinned guard; they ensure the wrapper never
enters a phase the guard has not authorised.

## Execution-time invariants added after Review 1 (Aug 11)

- **Hermetic child execution**: guard and verifier children start through
  `env -i` with an explicit Docker endpoint/config, controller home,
  Compose-env-file suppression, lock root, locale, and PATH. The PATH prepends
  the recorded Docker executable's directory and must resolve `docker` back to
  that exact recorded file.
- **Bound verifier target**: the prepared manifest records a loopback-only
  `appUrl`, and the verifier child receives that exact value as
  `NOOSPHERE_APP_URL`. A disposable rehearsal therefore cannot accidentally
  validate the production app endpoint.
- **Signal latch enforcement**: the first TERM/INT/HUP is durably recorded and
  stored in the controller latch. It is forwarded to whichever child is active,
  and every later phase boundary refuses to continue with the corresponding
  signal exit status. Repeated signals cannot re-enter persistence.
- **Fail-closed verifier ordering**: a non-zero verifier result commits
  `incident/closure-verification`, stops the app, and verifies
  `State.Running=false` before any verifier-evidence storage.
- **Durable closure evidence**: stdout and stderr are fsynced before hashing;
  owner-only process-evidence files are atomically persisted; transition-guard,
  writer-authorization, and closure-verifier evidence/log paths and hashes are
  bound into controller state before the final atomic `complete` phase write.
- **Semantic guard binding**: the source-transition controller accepts only
  the recorded switch arguments and rejects
  alternate modes, unknown options, duplicates, or mismatched targets.
- **Compose/config identity**: the resolved Compose plugin executable and the
  private one-file Docker config are path- and digest-bound at preparation and
  rechecked before candidate publication.
- **Durable recovery failures**: pre-journal recovery first records a recovery
  intent; verification or restoration failure becomes a terminal, classified
  incident instead of an automatically retryable transition phase.
- **Chronological process evidence**: process timestamps must be canonical UTC
  RFC3339 values and cannot end before they start.
- **Publication recovery proof**: candidate publication re-hashes both the live
  Compose file and the separate source-recovery snapshot while holding the
  engine-volume lock, before committing publication intent.
- **Canonical journal ownership**: `guardJournal` must resolve to the pinned
  guard's deterministic `backupDir/volume.phase-a2b.json` path, and the
  controller state path must resolve elsewhere.
- **Trusted fixed PATH**: every configured PATH directory must resolve to a
  root-owned directory without group/world write permission. This prevents the
  deployment user from introducing a replacement critical utility after
  preparation; the same check is repeated before publication.
- **Host-derived evidence**: boot identity and journal cursors come from the
  running host and user journal. Ambient test override variables cannot enter
  durable production evidence.
- **Truthful source-recovery evidence**: ordinary and signal-interrupted source
  verifier runs preserve the exact child stdout/stderr bytes, including Bash's
  deterministic `Terminated … sleep 0.1` diagnostic, and bind them with the
  real host boot ID and independently sampled user-journal cursor.
- **Integral process identity**: exit codes and controller/child PIDs must be
  non-negative or positive JSON integers as appropriate; fractional numeric
  values are rejected.

## Publication-blocker corrections (Aug 12)

- **Production-only hook sanitization**: direct controller execution resets the
  internal fixture seam and removes every controller fault/signal hook before
  execution. The fixture shim must explicitly opt in, so ambient user-manager
  variables cannot synthesize a failure, signal, or evidence result.
- **Artifact namespace separation**: controller state, guard/verifier logs, and
  process-evidence files are canonically checked against every bound input,
  executable, Compose file, journal, manifest, and Docker config at preparation
  and execution. Derived outputs cannot truncate or overwrite transition inputs.
- **Interruption evidence ordering**: after a child receives TERM/INT/HUP, the
  controller records, fsyncs, and binds that child's exit/log evidence and its
  durable phase before returning the signal-derived status. Verifier
  interruption cannot falsely commit `complete`.
- **Phase-specific terminal validity**: `complete` requires bound guard,
  authorization, closure, and complete-journal evidence; `incident` requires a
  non-empty incident class. A syntactically valid but evidentially incomplete
  terminal state is rejected.
- **Hermetic preparation**: preparation installs the recorded endpoint, PATH,
  home, and Docker config and clears Compose/Docker overrides before any live
  engine, plugin, version, or effective-model query. The certified preparation
  context therefore matches the later execution context.
- **Hermetic bootstrap**: the executable uses privileged `/bin/bash -p`, which
  suppresses `BASH_ENV` and imported shell functions, and installs a fixed
  system PATH before resolving itself or reading any manifest value.
- **Pre-install PATH trust**: preparation and execution validate the recorded
  fixed PATH with the bootstrap toolchain before assigning it to `PATH`; a
  manifest-controlled directory cannot supply the utilities that judge its own
  trust.
- **Owned descendant lifecycle**: guard and verifier work runs in separate
  process groups. Signal delivery and completion wait cover the entire group,
  including descendants that inherit the transition lock descriptor.
- **Resumable closure stop**: closure failures persist
  `closure-stop-pending`; resume retries and verifies the app stop before the
  state becomes terminal `incident`.
- **Transient unit provenance**: execution requires the live systemd unit to
  report `Transient=yes` in addition to the existing InvocationID, MainPID,
  working-directory, restart, timeout, kill-mode, and umask checks.
- **Docker-config namespace isolation**: state, logs, evidence, backups, and
  locks cannot be equal to, descend from, or contain the one-file Docker config
  directory.
- **Terminal evidence revalidation**: accepting `complete` requires all three
  zero-exit process-evidence files, their bound logs and hashes, and the
  completed guard journal to remain present and unchanged.
- **Recovery evidence preservation**: a resumed systemd invocation allocates
  invocation-distinct process artifacts whenever prior evidence paths exist,
  preserving the original transition child's provenance.

## Final post-full-gate Review 1 corrections (Aug 13)

- **Deferred writer restart is mandatory**: source-transition guard arguments
  must include `--defer-app-restart`. The pinned guard therefore cannot restart
  or authorize the candidate app writer before the controller has durably
  bound the completed transition journal and pre-authorization guard evidence.
- **Two-step writer closure is mandatory**: after that durable boundary, the
  controller invokes the pinned guard's `--authorize-writer` mode, binds its
  evidence, activates the app, and only then runs the unchanged full verifier.
  Neither authorization nor activation can be skipped on resume.
- **Invocation-private execution inputs**: each systemd invocation copies the
  verified guard, verifier, Docker client, Compose plugin, Docker config,
  environment file, source snapshot, and candidate Compose file into a private
  bundle. The copies are re-hashed and their Compose/plugin identity is checked
  before use, closing hash-then-pathname replacement races.
- **Trusted system-executable ownership**: production Docker and Compose
  executables may be root-owned or deployment-user-owned, but must be regular
  non-symlink files without group/world write permission before they are copied
  into the private bundle. Other transition inputs remain caller-owned.
- **Serialized first preparation**: a deterministic, owner-only preparation
  lock serializes the absent-state decision. Concurrent first preparations
  cannot both publish a different initial controller state; only one exact
  manifest wins.
- **Stable fixed PATH names**: fixed-PATH components must be trusted canonical
  directories or root-owned symlink aliases. A deployment-user-controlled
  symlink cannot be retargeted after its resolved directory passed validation.
- **Resumable verifier-evidence persistence**: once verifier failure requires
  closure, the controller records `closure-stop-pending`, stops and verifies
  the app writer, and only then records `closure-evidence-pending`. It next
  binds verifier evidence and commits terminal `incident`. Evidence-storage
  failure remains safely retryable with the writer already stopped; retry
  never re-enters application activation.
- **Post-activation signal closure**: TERM, INT, or HUP latched while activation
  completes commits durable closure-stop intent and stops and verifies the
  writer before returning the signal-derived exit status.
- **Classified pre-journal restoration failures**: source-Compose safety checks
  return control to the recovery owner. A missing, symlinked, or wrongly owned
  live Compose file therefore commits a durable incident instead of exiting
  from inside the restore helper.
- **No-follow deterministic locks**: preparation and engine-volume lock files
  are created through an atomic hard-link publication path, opened read/write
  without truncation, and validated as owner-only regular non-symlink files
  before `flock`. A pre-existing symlink cannot redirect or truncate a target.
- **Trusted bootstrap utility resolution**: the privileged bootstrap PATH is
  limited to system directories and excludes `/usr/local`. No bootstrap utility
  is resolved through an unproven mutable directory before the recorded PATH
  trust boundary is established.

## Replacement Review 1 corrections (Aug 15)

- **Pre-activation verifier artifacts**: every verifier log/evidence path and
  initial owner-only file is selected and created before application
  activation. A collision, unsafe path, or storage failure is therefore
  rejected while the writer remains stopped.
- **Stop-before-evidence ordering**: `closure-evidence-pending` is reachable
  only after durable `closure-stop-pending` intent and an inspect-verified
  stopped application. A failed stop or failed stop verification remains in
  the retryable stop phase and cannot advance to evidence persistence.
- **Prepared PostgreSQL volume identity**: preparation stores the canonical
  Docker volume fingerprint, and execution revalidates all canonical fields
  under the shared lock. Recreating a volume under the same name cannot reuse
  prepared transition authority.
- **Lock-first live identity checks**: engine ID, PostgreSQL volume inspection,
  Compose plugin/version, and effective Compose-model queries in both prepare
  and execute occur only after the exact engine-volume lock descriptor/path is
  held. No live identity call can race a cooperating transition owner.

Focused verification:

```bash
scripts/test-pgvector-transition-controller.sh
scripts/test-pgvector-transition-controller-systemd.sh
scripts/test-pgvector-transition-controller-docker.sh linux/amd64
```

The second command proves the controller's real transient-unit identity,
MainPID, InvocationID, and collection boundary, then sends TERM to a second
real unit and proves one child delivery, exit 143, and no false completion using
disposable fake Docker/guard/verifier commands. It intentionally does not
replace the stronger disposable Docker rehearsal through the pinned guard,
which remains a separate pre-production verification stage.

The third command supplies that stronger evidence. It creates uniquely named
source containers and volumes, seeds the minimal Noosphere schema (including
the round-trip-sensitive CHECK constraint), prepares the controller manifest,
and launches the actual controller under a collected user unit. The controller
publishes candidate Compose, invokes the pinned guard with the inherited
engine-plus-volume lock, runs the real verifier against a unique loopback health
port, and commits complete evidence. Cleanup proves that no fixture unit,
container, volume, network, or switch-labeled resource remains. Production
containers, volumes, Compose, and health endpoint are never targets.

## Six-owner Review 1 implementation (Aug 17)

The six RED owners accepted by the corrected native review are implemented;
controller and fixtures are green across the focused, real-systemd, and
disposable-Docker suites.

- **Execution entry rejects ambient test hooks**: `execute_prepared_state`
  fails closed before any state mutation when a `NOOSPHERE_CONTROLLER_TEST_*`
  variable is set outside explicitly enabled fixture mode. Inherited hooks can
  no longer steer production evidence or transitions.
- **Durable engine-volume state authority**: preparation keeps the runtime
  claim in `lockRoot` and additionally mirrors the engine-plus-volume binding
  to `<user state>/noosphere-pgvector-controller/authority/state-<key>.json`
  (key: SHA-256 of engine and volume). A duplicate prepare for the same
  identity is rejected while the recorded state path exists in a non-terminal
  phase, even after the entire runtime directory is replaced. Records whose
  state file is gone are reclaimed under the same lock; a `complete` state is
  reclaimable only after its bound guard, authorization, closure, and journal
  evidence validates. A retained runtime claim for that proven stale record
  is atomically replaced while the operation lock is held.
  Execution revalidates the claim before any mutation, so a byte-identical
  state copy at another path cannot execute. The durable root is captured from
  the invoking user's home before the hermetic execution environment replaces
  `HOME`.
- **Pre-activation failures are fail-closed**: a latched signal after writer
  authorization (real trap or fixture hook) and a verifier-artifact storage
  failure at the allocation boundary both commit durable
  `closure-stop-pending`, freshly stop and inspect-verify the writer, then
  publish `incident/closure-interruption` or `incident/closure-artifact-storage`
  before returning. The incident is never published before the verified stop.
- **Source-recovery artifacts are controlled paths**: the derived
  `source-recovery.stdout.log`, `stderr.log`, and `evidence.json` paths join
  the controller's collision matrix; a derived path overlapping any bound
  transition input is rejected at preparation.
- **Bound transition inputs are pairwise distinct**: preparation rejects any
  two semantically distinct inputs that canonicalize to the same path, so
  candidate publication cannot overwrite the sole source snapshot or another
  recovery dependency.
- **Unbound source-recovery evidence cannot be trusted**: retry binding is
  keyed to the complete new evidence/log/provenance set; a retry that
  republishes new evidence but fails to rebind is rejected rather than
  silently accepted, so a crash between publication and binding cannot leak an
  unbound path into a trusted state.
- **Phase-owned state proofs**: `validate_controller_state` requires each
  non-trivial phase to carry its own mechanism's proof with key-specific
  diagnostics: `guardEvidence` for `authorization-running`,
  `activation-running`, and `closure-running`; `authorizationEvidence` for
  `closure-stop-pending`; `writerStopEvidence` for `closure-evidence-pending`
  and every `closure-*` incident; `sourceRecoveryEvidence` for
  `incident/pre-journal-source-verification`. Every inspect-verified
  `stop_application_fail_closed` writes and binds
  `writer-stop.evidence.json` before those phases are reachable, and the
  writer-stop evidence path joins the controlled artifact namespace.
- **Fixture corrections required by the corrected contracts**: the crafted
  `closure-running` baseline in `test_closure_outcome_never_false_completes`
  now carries `guardEvidence` and `writerStopEvidence` (as every real
  closure-running state does), and
  `test_authorization_evidence_is_durable_before_activation` asserts the
  fail-closed incident contract for a pre-activation latched TERM instead of
  the superseded resumable `activation-running` outcome.


## 2026-08-18 — Re-review round 2 corrections

- **Incident-class diagnostic (resume die)**: the `closure-stop-pending` resume die now compiles its jq program correctly (`.incidentClass // "unknown"`), so the operator always sees the real incident class instead of an empty jq error.
- **Writer-stop evidence is retry-distinct**: `stop_application_fail_closed` allocates its evidence path through `select_process_artifact_base` (writer-stop role). The first stop owns the canonical `.writer-stop.evidence.json`; a later invocation that finds it allocates an InvocationID-suffixed path, so a crash between evidence publication and phase advance can never overwrite a prior truthful stop record — the same contract the source-recovery role already enforces.
- **Invocation-suffixed paths join the collision matrix**: whenever an InvocationID is present (always at execute), `assert_controller_artifact_paths_separate` also checks the `.<InvocationID>` suffixed guard/authorization/verify/source-recovery/writer-stop paths against every bound input, matching what a retrying invocation actually writes.
- **New regression fixtures**: `test_writer_stop_evidence_is_retry_distinct` (canonical-first, InvocationID-distinct retry, prior bytes survive, unsafe InvocationID rejected) and `test_invocation_suffixed_artifacts_cannot_collide_with_bound_inputs` (suffixed writer-stop path rejected as bound input with collision diagnostic; clean control passes).
