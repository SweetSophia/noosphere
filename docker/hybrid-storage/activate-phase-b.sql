\set ON_ERROR_STOP on

BEGIN;
SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('noosphere-hybrid-phase-b-activation-v1', 0)
);
SELECT pg_catalog.set_config('noosphere.phase_b.source_sha256', :'phase_b_source_sha256', true);

DO $block$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = current_user AND rolsuper
  ) THEN
    RAISE EXCEPTION 'Phase B activation requires the bootstrap PostgreSQL superuser';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM noosphere_hybrid.feature_state
    WHERE singleton AND feature_version = 1
  ) THEN
    RAISE EXCEPTION 'exact Phase A3 activation is required before Phase B';
  END IF;
END;
$block$;

-- Phase B is an extension of an exact A3 installation, not an alternate repair
-- path. Rehydrate the persisted provenance settings and run the complete A3
-- validator before creating or accepting any B object.
SELECT
  pg_catalog.set_config('noosphere.activation.provenance_kind', state.provenance_kind, true),
  pg_catalog.set_config('noosphere.activation.postgresql_server_version_num', state.postgresql_server_version_num::text, true),
  pg_catalog.set_config('noosphere.activation.source_url', state.source_url, true),
  pg_catalog.set_config('noosphere.activation.source_sha256', state.source_sha256, true),
  pg_catalog.set_config('noosphere.activation.pgvector_version', state.pgvector_version, true),
  pg_catalog.set_config('noosphere.activation.spdx_identifier', state.spdx_identifier, true),
  pg_catalog.set_config('noosphere.activation.built_image_digest', state.built_image_digest, true),
  pg_catalog.set_config('noosphere.activation.sql_sha256', :'a3_source_sha256', true),
  pg_catalog.set_config('noosphere.activation.public_fingerprint', state.public_schema_fingerprint, true)
FROM noosphere_hybrid.feature_state AS state
WHERE state.singleton;

-- A3's exact validator predates B and requires its original capability ACL.
-- Restore that ACL only inside this uncommitted activation transaction, prove
-- every A3 object/manifest/ACL, then withdraw the superseded entry points before
-- any Phase B state can commit. Other sessions can never observe the transient
-- grants.
GRANT EXECUTE ON FUNCTION noosphere_hybrid.set_profile_state(
  uuid, noosphere_hybrid.profile_state
) TO noosphere_hybrid_admin;
GRANT EXECUTE ON FUNCTION noosphere_hybrid.create_profile(
  text, noosphere_hybrid.profile_locality, text, text, integer,
  noosphere_hybrid.distance_metric, noosphere_hybrid.normalization_policy,
  integer, bytea
) TO noosphere_hybrid_admin;
GRANT EXECUTE ON FUNCTION noosphere_hybrid.claim_jobs(integer, integer)
  TO noosphere_hybrid_worker;
GRANT EXECUTE ON FUNCTION noosphere_hybrid.publish_embedding(
  uuid, uuid, bigint, bigint, bytea, noosphere_vector.vector
) TO noosphere_hybrid_worker;
GRANT EXECUTE ON FUNCTION noosphere_hybrid.fail_job(
  uuid, uuid, bigint, text, timestamptz, boolean
) TO noosphere_hybrid_worker;
\ir validate.sql
REVOKE EXECUTE ON FUNCTION noosphere_hybrid.set_profile_state(
  uuid, noosphere_hybrid.profile_state
) FROM noosphere_hybrid_admin;
REVOKE EXECUTE ON FUNCTION noosphere_hybrid.create_profile(
  text, noosphere_hybrid.profile_locality, text, text, integer,
  noosphere_hybrid.distance_metric, noosphere_hybrid.normalization_policy,
  integer, bytea
) FROM noosphere_hybrid_admin;
REVOKE EXECUTE ON FUNCTION noosphere_hybrid.claim_jobs(integer, integer)
  FROM noosphere_hybrid_worker;
REVOKE EXECUTE ON FUNCTION noosphere_hybrid.publish_embedding(
  uuid, uuid, bigint, bigint, bytea, noosphere_vector.vector
) FROM noosphere_hybrid_worker;
REVOKE EXECUTE ON FUNCTION noosphere_hybrid.fail_job(
  uuid, uuid, bigint, text, timestamptz, boolean
) FROM noosphere_hybrid_worker;

SELECT pg_catalog.to_regclass('noosphere_hybrid_b.feature_state') IS NULL AS first_activation
\gset

\if :first_activation
  DO $block$
  BEGIN
    IF EXISTS (
      SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = 'noosphere_hybrid_b'
    ) THEN
      RAISE EXCEPTION 'refusing partial or attacker-precreated Phase B schema';
    END IF;
  END;
  $block$;

  CREATE SCHEMA noosphere_hybrid_b AUTHORIZATION noosphere_hybrid_owner;
  SET LOCAL ROLE noosphere_hybrid_owner;
  \ir phase-b-schema.sql
  RESET ROLE;

  CREATE TRIGGER noosphere_hybrid_b_article_guard
  BEFORE INSERT OR UPDATE OF title, excerpt, content, "deletedAt", "recallQuarantinedAt", "restrictedTags" OR DELETE
  ON public."Article"
  FOR EACH ROW EXECUTE FUNCTION noosphere_hybrid_b.article_write_guard();

  CREATE TRIGGER zz_noosphere_hybrid_b_article_dirty
  AFTER INSERT OR UPDATE OF title, excerpt, content, "deletedAt", "recallQuarantinedAt", "restrictedTags"
  ON public."Article"
  FOR EACH ROW EXECUTE FUNCTION noosphere_hybrid_b.article_dirty_trigger();

  REVOKE ALL ON SCHEMA noosphere_hybrid_b FROM PUBLIC;
  REVOKE ALL ON ALL TABLES IN SCHEMA noosphere_hybrid_b FROM PUBLIC;
  REVOKE ALL ON ALL SEQUENCES IN SCHEMA noosphere_hybrid_b FROM PUBLIC;
  REVOKE ALL ON ALL FUNCTIONS IN SCHEMA noosphere_hybrid_b FROM PUBLIC;
  GRANT USAGE ON SCHEMA noosphere_hybrid_b TO noosphere_hybrid_admin, noosphere_hybrid_worker;

  GRANT EXECUTE ON FUNCTION noosphere_hybrid_b.set_embedding_consent(boolean, boolean)
    TO noosphere_hybrid_admin;
  GRANT EXECUTE ON FUNCTION noosphere_hybrid_b.create_profile(
    text, noosphere_hybrid.profile_locality, text, text, integer,
    noosphere_hybrid.distance_metric, noosphere_hybrid.normalization_policy,
    integer, bytea
  ) TO noosphere_hybrid_admin;
  GRANT EXECUTE ON FUNCTION noosphere_hybrid_b.profile_coverage(uuid)
    TO noosphere_hybrid_admin;
  GRANT EXECUTE ON FUNCTION noosphere_hybrid_b.profile_status(uuid)
    TO noosphere_hybrid_admin;
  GRANT EXECUTE ON FUNCTION noosphere_hybrid_b.set_profile_state(uuid, noosphere_hybrid.profile_state)
    TO noosphere_hybrid_admin;
  GRANT EXECUTE ON FUNCTION noosphere_hybrid_b.enqueue_profile_backfill(uuid, integer)
    TO noosphere_hybrid_admin;
  GRANT EXECUTE ON FUNCTION noosphere_hybrid_b.queue_health()
    TO noosphere_hybrid_admin, noosphere_hybrid_worker;
  GRANT EXECUTE ON FUNCTION noosphere_hybrid_b.worker_readiness()
    TO noosphere_hybrid_worker;
  GRANT EXECUTE ON FUNCTION noosphere_hybrid_b.claim_jobs(integer, integer, integer, uuid[])
    TO noosphere_hybrid_worker;
  GRANT EXECUTE ON FUNCTION noosphere_hybrid_b.authorize_dispatch(uuid, uuid, bigint)
    TO noosphere_hybrid_worker;
  GRANT EXECUTE ON FUNCTION noosphere_hybrid_b.release_stale_job(uuid, uuid, bigint, integer)
    TO noosphere_hybrid_worker;
  GRANT EXECUTE ON FUNCTION noosphere_hybrid_b.publish_embedding(
    uuid, uuid, bigint, bigint, bytea, noosphere_vector.vector
  ) TO noosphere_hybrid_worker;
  GRANT EXECUTE ON FUNCTION noosphere_hybrid_b.fail_job(
    uuid, uuid, bigint, text, timestamptz, boolean
  ) TO noosphere_hybrid_worker;

  SET LOCAL ROLE noosphere_hybrid_owner;
  INSERT INTO noosphere_hybrid_b.feature_state (
    singleton, feature_version, source_sha256, manifest_sha256, structure_sha256
  )
  VALUES (
    true,
    2,
    pg_catalog.current_setting('noosphere.phase_b.source_sha256'),
    pg_catalog.encode(
      noosphere_crypto.digest(
        pg_catalog.convert_to(noosphere_hybrid_b.routine_manifest(), 'UTF8'),
        'sha256'
      ),
      'hex'
    ),
    pg_catalog.encode(
      noosphere_crypto.digest(
        pg_catalog.convert_to(noosphere_hybrid_b.structural_manifest(), 'UTF8'),
        'sha256'
      ),
      'hex'
    )
  );
  RESET ROLE;
\else
  \ir upgrade-phase-b-v1-to-v2.sql
\endif

\ir validate-phase-b.sql
COMMIT;
