# Taxonomy concurrency guarantees

## Topic moves (#352)

REST topic updates and human admin-console updates share `updateTopicSafely`.
Each operation reads the existing topic and the proposed ancestor chain and writes
inside one PostgreSQL **Serializable** transaction. Opposing moves can no longer
both validate against the old hierarchy and commit a cycle. Serialization/deadlock
conflicts retry the complete transaction at most three times, including validation;
exhaustion returns a conflict (HTTP 409 for REST) for the caller to retry.

Ancestor traversal is iterative with a visited set. A pre-existing cycle is rejected
rather than recursed forever, and detaching a topic to the root remains possible.
A metadata-only PATCH does not write an old `parentId` back over a concurrent move.
The topic seed script also uses the shared helper for existing-child moves.

This is an application transaction guarantee, not a database-wide acyclicity
constraint. Trusted bootstrap/repair scripts and direct SQL are privileged
maintenance paths; do not run hierarchy-rewriting maintenance concurrently with
application traffic. They must preserve a valid tree. Authorization and explicit
full-scope requirements are unchanged.

## Tag deletion (#353)

The `ArticleTag.tagId` foreign key now uses **ON DELETE RESTRICT**, not CASCADE.
The existing association count provides a friendly error, but is not the safety
boundary: a link may be committed after that check. The database now rejects the
losing operation regardless of whether the article writer is REST, sync or another
application path. If a link commits first, tag deletion fails and the link survives;
if deletion commits first, the link fails rather than reporting success.

REST maps the foreign-key conflict to HTTP 409; the admin action presents an in-use
error. An unused tag remains deletable. Deleting an article still cascades its own
junction rows; only deletion of the shared tag changed.

### Deployment requirement

Apply migration `20261026120000_restrict_in_use_tag_deletion` through the ordinary
**init-container/migrator-role** deployment path before relying on this guarantee.
A code-only rollout against the old cascading foreign key does not close the race.
The migration preserves existing links and changes no content scopes. It takes a
DDL lock on the junction table; use the normal controlled upgrade window. No
production migration is implied by this source change or its local tests.

### Regression evidence

`src/__tests__/persistence-layer/taxonomy-concurrency.test.ts` runs as the application
role against the CI/disposable database. A rendezvous forces opposing topic moves
past validation before either writes; exactly one commits and the other rejects
as cyclic or returns the documented bounded-contention conflict. Unrelated
parallel fixture writers can consume the three retry attempts before the winner
commits; the invariant remains one successful move and no persisted cycle.
The tag test explicitly interleaves a committed link between
the zero-use count and DELETE, asserting both the conflict and the retained link.
It also covers delete-first rejection, safe detach and corrupt-cycle termination.
API tests retain the credential matrix and cover post-count HTTP error mapping
and bounded serialization retries, including pg-adapter commit-time failures.

The pgvector upgrade rehearsal baseline includes all 11 application migrations,
with exact migration names/checksums and a newly recorded deterministic fixture
integrity hash. The count and digest were updated for this actual schema change,
not disabled; physical rollback, both logical restores and value-only corruption
negative controls continue to enforce the same preservation contract.
