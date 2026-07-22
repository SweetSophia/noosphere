-- Upgrade an exact historical Phase B v1 activation to the v2 capability
-- boundary required by Phase C. This file is included inside the caller's
-- transaction and deliberately has no BEGIN/COMMIT of its own.

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('noosphere-hybrid-phase-b-activation-v1', 0)
);

DO $validation$
DECLARE
  state noosphere_hybrid_b.feature_state%ROWTYPE;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = current_user AND rolsuper
  ) THEN
    RAISE EXCEPTION 'Phase B upgrade requires the bootstrap PostgreSQL superuser';
  END IF;

  SELECT * INTO STRICT state
  FROM noosphere_hybrid_b.feature_state
  WHERE singleton;

  IF state.feature_version = 2
    AND state.source_sha256 = pg_catalog.current_setting('noosphere.phase_b.source_sha256')
  THEN
    RETURN;
  END IF;

  IF state.feature_version <> 1
    OR state.source_sha256 <> '5a5cb62c29deceb44b91c0a0252607ce9460b2761dbeca7724963ad7043fca98'
  THEN
    RAISE EXCEPTION 'Phase B upgrade requires the exact v1 artifact set';
  END IF;

  IF pg_catalog.to_regclass('noosphere_hybrid_c.feature_state') IS NOT NULL THEN
    RAISE EXCEPTION 'refusing to upgrade Phase B beneath an existing Phase C activation';
  END IF;
END;
$validation$;

SELECT feature_version = 1 AS phase_b_v1_upgrade_required
FROM noosphere_hybrid_b.feature_state
WHERE singleton
\gset

\if :phase_b_v1_upgrade_required
  -- Prove the old installation before changing it. The historical validator
  -- expects the original A3 create-profile grant, so expose it only inside
  -- this uncommitted transaction and withdraw it immediately afterwards.
  SELECT noosphere_hybrid_b.serialize_eligibility();
  -- Historical v1 profile creation does not participate in the Phase B
  -- eligibility advisory lock. Block its INSERT until the v2 wrapper and the
  -- Phase C coverage trigger (when this upgrade is driven by C) commit.
  LOCK TABLE noosphere_hybrid.embedding_profile IN SHARE MODE;
  SELECT pg_catalog.set_config(
    'noosphere.phase_b.source_sha256',
    '5a5cb62c29deceb44b91c0a0252607ce9460b2761dbeca7724963ad7043fca98',
    true
  );
  GRANT EXECUTE ON FUNCTION noosphere_hybrid.create_profile(
    text, noosphere_hybrid.profile_locality, text, text, integer,
    noosphere_hybrid.distance_metric, noosphere_hybrid.normalization_policy,
    integer, bytea
  ) TO noosphere_hybrid_admin;
  \ir validate-phase-b-v1.sql
  REVOKE EXECUTE ON FUNCTION noosphere_hybrid.create_profile(
    text, noosphere_hybrid.profile_locality, text, text, integer,
    noosphere_hybrid.distance_metric, noosphere_hybrid.normalization_policy,
    integer, bytea
  ) FROM noosphere_hybrid_admin;
  SELECT pg_catalog.set_config(
    'noosphere.phase_b.source_sha256', :'phase_b_source_sha256', true
  );

  SET LOCAL ROLE noosphere_hybrid_owner;
  \ir phase-b-routine-manifest.sql

  CREATE OR REPLACE FUNCTION noosphere_hybrid_b.structural_manifest()
  RETURNS text
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $function$
  WITH evidence AS (
    SELECT
      pg_catalog.format('column:%s.%s:%s', namespace.nspname, relation.relname, attribute.attnum) AS identity,
      pg_catalog.format(
        '%I.%I.%I|%s|notnull=%s|identity=%s|generated=%s|default=%s',
        namespace.nspname,
        relation.relname,
        attribute.attname,
        pg_catalog.format_type(attribute.atttypid, attribute.atttypmod),
        attribute.attnotnull,
        attribute.attidentity,
        attribute.attgenerated,
        coalesce(pg_catalog.pg_get_expr(default_value.adbin, default_value.adrelid, false), '')
      ) AS definition
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    JOIN pg_catalog.pg_attribute AS attribute ON attribute.attrelid = relation.oid
    LEFT JOIN pg_catalog.pg_attrdef AS default_value
      ON default_value.adrelid = relation.oid AND default_value.adnum = attribute.attnum
    WHERE namespace.nspname = 'noosphere_hybrid_b'
      AND relation.relkind IN ('r', 'p')
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped

    UNION ALL

    SELECT
      pg_catalog.format('constraint:%s.%s:%s', namespace.nspname, relation.relname, constraint_record.conname),
      pg_catalog.pg_get_constraintdef(constraint_record.oid, false)
    FROM pg_catalog.pg_constraint AS constraint_record
    JOIN pg_catalog.pg_class AS relation ON relation.oid = constraint_record.conrelid
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'noosphere_hybrid_b'

    UNION ALL

    SELECT
      pg_catalog.format('index:%s.%s:%s', namespace.nspname, relation.relname, index_relation.relname),
      pg_catalog.pg_get_indexdef(index_relation.oid, 0, false)
    FROM pg_catalog.pg_index AS index_record
    JOIN pg_catalog.pg_class AS relation ON relation.oid = index_record.indrelid
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    JOIN pg_catalog.pg_class AS index_relation ON index_relation.oid = index_record.indexrelid
    WHERE namespace.nspname = 'noosphere_hybrid_b'

    UNION ALL

    SELECT
      pg_catalog.format('trigger:public.Article:%s', trigger_record.tgname),
      pg_catalog.pg_get_triggerdef(trigger_record.oid, false)
    FROM pg_catalog.pg_trigger AS trigger_record
    JOIN pg_catalog.pg_class AS relation ON relation.oid = trigger_record.tgrelid
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    JOIN pg_catalog.pg_proc AS procedure ON procedure.oid = trigger_record.tgfoid
    JOIN pg_catalog.pg_namespace AS procedure_namespace ON procedure_namespace.oid = procedure.pronamespace
    WHERE NOT trigger_record.tgisinternal
      AND namespace.nspname = 'public'
      AND relation.relname = 'Article'
      AND (
        procedure_namespace.nspname = 'noosphere_hybrid_b'
        OR trigger_record.tgname LIKE 'noosphere_hybrid_b%'
        OR trigger_record.tgname LIKE 'zz_noosphere_hybrid_b%'
      )
  )
  SELECT pg_catalog.string_agg(
    pg_catalog.encode(pg_catalog.convert_to(evidence.identity, 'UTF8'), 'hex')
      || ':' ||
    pg_catalog.encode(pg_catalog.convert_to(evidence.definition, 'UTF8'), 'hex'),
    E'\n' ORDER BY evidence.identity
  )
  FROM evidence
$function$;

  CREATE FUNCTION noosphere_hybrid_b.create_profile(
    provider_protocol_arg text,
    locality_arg noosphere_hybrid.profile_locality,
    model_identifier_arg text,
    model_revision_arg text,
    dimensions_arg integer,
    distance_metric_arg noosphere_hybrid.distance_metric,
    normalization_policy_arg noosphere_hybrid.normalization_policy,
    max_input_bytes_arg integer,
    endpoint_identity_sha256_arg bytea
  )
  RETURNS uuid
  LANGUAGE plpgsql
  VOLATILE
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  -- Profile creation changes the Cartesian profile/article eligibility set.
  -- Serialize it with Article, consent, and lifecycle mutations so Phase C's
  -- AFTER INSERT refresh observes one complete side of every interleaving.
  PERFORM noosphere_hybrid_b.serialize_eligibility();
  RETURN noosphere_hybrid.create_profile(
    provider_protocol_arg,
    locality_arg,
    model_identifier_arg,
    model_revision_arg,
    dimensions_arg,
    distance_metric_arg,
    normalization_policy_arg,
    max_input_bytes_arg,
    endpoint_identity_sha256_arg
  );
END;
$function$;

  ALTER TABLE noosphere_hybrid_b.feature_state
    DROP CONSTRAINT feature_state_feature_version_check;
  ALTER TABLE noosphere_hybrid_b.feature_state
    ADD CONSTRAINT feature_state_feature_version_check
    CHECK (feature_version = 2) NOT VALID;
  RESET ROLE;

  REVOKE ALL ON FUNCTION noosphere_hybrid_b.routine_manifest() FROM PUBLIC;
  REVOKE ALL ON FUNCTION noosphere_hybrid_b.create_profile(
    text, noosphere_hybrid.profile_locality, text, text, integer,
    noosphere_hybrid.distance_metric, noosphere_hybrid.normalization_policy,
    integer, bytea
  ) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION noosphere_hybrid_b.create_profile(
    text, noosphere_hybrid.profile_locality, text, text, integer,
    noosphere_hybrid.distance_metric, noosphere_hybrid.normalization_policy,
    integer, bytea
  ) TO noosphere_hybrid_admin;

  SET LOCAL ROLE noosphere_hybrid_owner;
  UPDATE noosphere_hybrid_b.feature_state
  SET feature_version = 2,
      source_sha256 = pg_catalog.current_setting('noosphere.phase_b.source_sha256')
  WHERE singleton;
  ALTER TABLE noosphere_hybrid_b.feature_state
    VALIDATE CONSTRAINT feature_state_feature_version_check;
  UPDATE noosphere_hybrid_b.feature_state
  SET manifest_sha256 = pg_catalog.encode(
        noosphere_crypto.digest(
          pg_catalog.convert_to(noosphere_hybrid_b.routine_manifest(), 'UTF8'),
          'sha256'
        ),
        'hex'
      ),
      structure_sha256 = pg_catalog.encode(
        noosphere_crypto.digest(
          pg_catalog.convert_to(noosphere_hybrid_b.structural_manifest(), 'UTF8'),
          'sha256'
        ),
        'hex'
      )
  WHERE singleton;
  RESET ROLE;
\endif
