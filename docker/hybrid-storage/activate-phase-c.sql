\set ON_ERROR_STOP on

BEGIN;
SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('noosphere-hybrid-phase-c-activation-v1', 0)
);
SELECT pg_catalog.set_config('noosphere.phase_c.source_sha256', :'phase_c_source_sha256', true);
SELECT pg_catalog.set_config('noosphere.phase_b.source_sha256', :'phase_b_source_sha256', true);
SELECT pg_catalog.set_config('noosphere.phase_a3.source_sha256', :'a3_source_sha256', true);

DO $block$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = current_user AND rolsuper
  ) THEN
    RAISE EXCEPTION 'Phase C activation requires the bootstrap PostgreSQL superuser';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM noosphere_hybrid.feature_state
    WHERE singleton AND feature_version = 1
      AND activation_sql_sha256 = pg_catalog.current_setting('noosphere.phase_a3.source_sha256')
  ) THEN
    RAISE EXCEPTION 'exact Phase A3 activation is required before Phase C';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM noosphere_hybrid_b.feature_state
    WHERE singleton AND feature_version = 1
      AND source_sha256 = pg_catalog.current_setting('noosphere.phase_b.source_sha256')
  ) THEN
    RAISE EXCEPTION 'exact Phase B activation is required before Phase C';
  END IF;
END;
$block$;

-- Coverage snapshots are initialized from, and remain synchronized with, the
-- same eligibility domain used by Phase B. Hold its transaction lock across
-- schema creation, snapshot initialization, validation, and commit so no
-- mutation can fall between the initial corpus scan and trigger installation.
SELECT noosphere_hybrid_b.serialize_eligibility();

-- Re-run both prerequisite validators in this transaction. A3's validator
-- requires its original capability grants, so temporarily restore them before
-- proving A3 and then return to Phase B's narrowed execution surface.
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
\ir validate-phase-b.sql

SELECT pg_catalog.to_regclass('noosphere_hybrid_c.feature_state') IS NULL AS first_activation
\gset

\if :first_activation
  DO $block$
  BEGIN
    IF EXISTS (
      SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = 'noosphere_hybrid_c'
    ) THEN
      RAISE EXCEPTION 'refusing partial or attacker-precreated Phase C schema';
    END IF;
  END;
  $block$;

  CREATE SCHEMA noosphere_hybrid_c AUTHORIZATION noosphere_hybrid_owner;
  SET LOCAL ROLE noosphere_hybrid_owner;
  \ir phase-c-schema.sql
  RESET ROLE;

  CREATE TRIGGER zz_noosphere_hybrid_c_article_coverage
  AFTER INSERT OR DELETE OR UPDATE OF
    title, excerpt, content, "deletedAt", "recallQuarantinedAt", "restrictedTags"
  ON public."Article"
  FOR EACH ROW EXECUTE FUNCTION noosphere_hybrid_c.article_coverage_trigger();

  CREATE TRIGGER zz_noosphere_hybrid_c_embedding_coverage
  AFTER INSERT OR UPDATE OR DELETE ON noosphere_hybrid.article_embedding
  FOR EACH ROW EXECUTE FUNCTION noosphere_hybrid_c.embedding_coverage_trigger();

  CREATE TRIGGER zz_noosphere_hybrid_c_profile_coverage
  AFTER INSERT OR UPDATE OF state ON noosphere_hybrid.embedding_profile
  FOR EACH ROW EXECUTE FUNCTION noosphere_hybrid_c.profile_coverage_trigger();

  CREATE TRIGGER zz_noosphere_hybrid_c_consent_coverage
  AFTER INSERT OR UPDATE OR DELETE ON noosphere_hybrid_b.embedding_consent
  FOR EACH STATEMENT EXECUTE FUNCTION noosphere_hybrid_c.consent_coverage_trigger();

  SELECT noosphere_hybrid_c.refresh_all_profile_coverage();

  REVOKE ALL ON SCHEMA noosphere_hybrid_c FROM PUBLIC;
  REVOKE ALL ON ALL TABLES IN SCHEMA noosphere_hybrid_c FROM PUBLIC;
  REVOKE ALL ON ALL SEQUENCES IN SCHEMA noosphere_hybrid_c FROM PUBLIC;
  REVOKE ALL ON ALL FUNCTIONS IN SCHEMA noosphere_hybrid_c FROM PUBLIC;

  GRANT USAGE ON SCHEMA noosphere_hybrid_c TO noosphere_app;
  GRANT EXECUTE ON FUNCTION noosphere_hybrid_c.query_profile_snapshot(uuid)
    TO noosphere_app;
  GRANT EXECUTE ON FUNCTION noosphere_hybrid_c.authorize_query_dispatch(uuid)
    TO noosphere_app;
  GRANT EXECUTE ON FUNCTION noosphere_hybrid_c.vector_candidates(uuid, text, text[])
    TO noosphere_app;
  GRANT EXECUTE ON FUNCTION noosphere_hybrid_c.current_vector_membership(uuid, text[])
    TO noosphere_app;

  SET LOCAL ROLE noosphere_hybrid_owner;
  WITH manifest AS (
    SELECT pg_catalog.string_agg(
      pg_catalog.pg_get_functiondef(procedure.oid),
      E'\n' ORDER BY procedure.oid::pg_catalog.regprocedure::text
    ) AS body
    FROM pg_catalog.pg_proc AS procedure
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
    WHERE namespace.nspname = 'noosphere_hybrid_c'
  )
  INSERT INTO noosphere_hybrid_c.feature_state (
    singleton,
    feature_version,
    a3_source_sha256,
    phase_b_source_sha256,
    source_sha256,
    manifest_sha256,
    structure_sha256
  )
  SELECT
    true,
    1,
    :'a3_source_sha256',
    :'phase_b_source_sha256',
    pg_catalog.current_setting('noosphere.phase_c.source_sha256'),
    pg_catalog.encode(
      noosphere_crypto.digest(pg_catalog.convert_to(manifest.body, 'UTF8'), 'sha256'),
      'hex'
    ),
    pg_catalog.encode(
      noosphere_crypto.digest(
        pg_catalog.convert_to(noosphere_hybrid_c.structural_manifest(), 'UTF8'),
        'sha256'
      ),
      'hex'
    )
  FROM manifest;
  RESET ROLE;
\endif

\ir validate-phase-c.sql
COMMIT;
