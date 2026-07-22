DO $validation$
DECLARE
  state noosphere_hybrid_b.feature_state%ROWTYPE;
  actual_manifest_sha256 text;
  actual_structure_sha256 text;
  acl_drift text;
BEGIN
  SELECT * INTO STRICT state FROM noosphere_hybrid_b.feature_state WHERE singleton;
  IF state.feature_version <> 1
    OR state.source_sha256 <> pg_catalog.current_setting('noosphere.phase_b.source_sha256')
  THEN
    RAISE EXCEPTION 'Phase B provenance does not exactly match';
  END IF;

  SELECT pg_catalog.encode(
    noosphere_crypto.digest(pg_catalog.convert_to(pg_catalog.string_agg(definition, E'\n' ORDER BY identity), 'UTF8'), 'sha256'),
    'hex'
  ) INTO actual_manifest_sha256
  FROM (
    SELECT
      procedure.oid::pg_catalog.regprocedure::text AS identity,
      pg_catalog.format(
        '%s|lang=%s|ret=%s|args=%s|vol=%s|strict=%s|secdef=%s|parallel=%s|config=%s|src=%s',
        procedure.oid::pg_catalog.regprocedure::text,
        (SELECT lanname FROM pg_catalog.pg_language WHERE oid = procedure.prolang),
        pg_catalog.format_type(procedure.prorettype, NULL),
        COALESCE((
          SELECT pg_catalog.string_agg(pg_catalog.format_type(arg.oid, NULL), ',' ORDER BY arg.ord)
          FROM pg_catalog.unnest(COALESCE(procedure.proallargtypes, procedure.proargtypes::oid[]))
            WITH ORDINALITY AS arg(oid, ord)
        ), ''),
        procedure.provolatile,
        procedure.proisstrict,
        procedure.prosecdef,
        COALESCE(procedure.proparallel, 'u'),
        COALESCE(pg_catalog.array_to_string(procedure.proconfig, ','), ''),
        procedure.prosrc
      ) AS definition
    FROM pg_catalog.pg_proc AS procedure
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
    WHERE namespace.nspname = 'noosphere_hybrid_b'
    UNION ALL
    SELECT
      namespace.nspname || '.' || relation.relname || '.' || trigger.tgname,
      pg_catalog.pg_get_triggerdef(trigger.oid, false)
    FROM pg_catalog.pg_trigger AS trigger
    JOIN pg_catalog.pg_class AS relation ON relation.oid = trigger.tgrelid
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE NOT trigger.tgisinternal
      AND trigger.tgname IN (
        'noosphere_hybrid_b_article_guard',
        'zz_noosphere_hybrid_b_article_dirty'
      )
  ) AS evidence(identity, definition);
  IF actual_manifest_sha256 <> state.manifest_sha256 THEN
    RAISE EXCEPTION 'Phase B routine or trigger manifest drifted';
  END IF;

  SELECT pg_catalog.encode(
    noosphere_crypto.digest(
      pg_catalog.convert_to(noosphere_hybrid_b.structural_manifest(), 'UTF8'),
      'sha256'
    ),
    'hex'
  ) INTO actual_structure_sha256;
  IF actual_structure_sha256 <> state.structure_sha256 THEN
    RAISE EXCEPTION 'Phase B table, constraint, index, or trigger structure drifted';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_namespace AS namespace
    JOIN pg_catalog.pg_roles AS owner ON owner.oid = namespace.nspowner
    WHERE namespace.nspname = 'noosphere_hybrid_b'
      AND owner.rolname = 'noosphere_hybrid_owner'
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    JOIN pg_catalog.pg_roles AS owner ON owner.oid = relation.relowner
    WHERE namespace.nspname = 'noosphere_hybrid_b'
      AND owner.rolname <> 'noosphere_hybrid_owner'
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS procedure
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
    JOIN pg_catalog.pg_roles AS owner ON owner.oid = procedure.proowner
    WHERE namespace.nspname = 'noosphere_hybrid_b'
      AND (
        owner.rolname <> 'noosphere_hybrid_owner'
        OR procedure.prosecdef IS DISTINCT FROM true
        OR NOT (procedure.proconfig @> ARRAY['search_path=pg_catalog, pg_temp'])
      )
  ) THEN
    RAISE EXCEPTION 'Phase B ownership or SECURITY DEFINER configuration drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_namespace AS namespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      coalesce(namespace.nspacl, pg_catalog.acldefault('n', namespace.nspowner))
    ) AS acl
    WHERE namespace.nspname = 'noosphere_hybrid_b' AND acl.grantee = 0
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      coalesce(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
    ) AS acl
    WHERE namespace.nspname = 'noosphere_hybrid_b' AND acl.grantee = 0
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS procedure
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      coalesce(procedure.proacl, pg_catalog.acldefault('f', procedure.proowner))
    ) AS acl
    WHERE namespace.nspname = 'noosphere_hybrid_b' AND acl.grantee = 0
  ) THEN
    RAISE EXCEPTION 'PUBLIC retains Phase B privileges';
  END IF;

  SELECT pg_catalog.string_agg(drift.description, '; ' ORDER BY drift.description)
  INTO acl_drift
  FROM (
    SELECT pg_catalog.format(
      'schema noosphere_hybrid_b: %I has %s', grantee.rolname, acl.privilege_type
    ) AS description
    FROM pg_catalog.pg_namespace AS namespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      coalesce(namespace.nspacl, pg_catalog.acldefault('n', namespace.nspowner))
    ) AS acl
    JOIN pg_catalog.pg_roles AS grantee ON grantee.oid = acl.grantee
    WHERE namespace.nspname = 'noosphere_hybrid_b'
      AND NOT (
        grantee.rolname = 'noosphere_hybrid_owner'
        OR (grantee.rolname IN ('noosphere_hybrid_admin', 'noosphere_hybrid_worker') AND acl.privilege_type = 'USAGE')
      )
    UNION ALL
    SELECT pg_catalog.format(
      'relation %I.%I: %I has %s', namespace.nspname, relation.relname,
      grantee.rolname, acl.privilege_type
    )
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      coalesce(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
    ) AS acl
    JOIN pg_catalog.pg_roles AS grantee ON grantee.oid = acl.grantee
    WHERE namespace.nspname = 'noosphere_hybrid_b'
      AND grantee.rolname <> 'noosphere_hybrid_owner'
    UNION ALL
    SELECT pg_catalog.format(
      'routine %s: %I has %s', procedure.oid::pg_catalog.regprocedure::text,
      grantee.rolname, acl.privilege_type
    )
    FROM pg_catalog.pg_proc AS procedure
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      coalesce(procedure.proacl, pg_catalog.acldefault('f', procedure.proowner))
    ) AS acl
    JOIN pg_catalog.pg_roles AS grantee ON grantee.oid = acl.grantee
    WHERE namespace.nspname = 'noosphere_hybrid_b'
      AND NOT (
        grantee.rolname = 'noosphere_hybrid_owner'
        OR (
          grantee.rolname = 'noosphere_hybrid_admin'
          AND procedure.oid::pg_catalog.regprocedure::text IN (
            'noosphere_hybrid_b.set_embedding_consent(boolean,boolean)',
            'noosphere_hybrid_b.create_profile(text,noosphere_hybrid.profile_locality,text,text,integer,noosphere_hybrid.distance_metric,noosphere_hybrid.normalization_policy,integer,bytea)',
            'noosphere_hybrid_b.profile_coverage(uuid)',
            'noosphere_hybrid_b.profile_status(uuid)',
            'noosphere_hybrid_b.set_profile_state(uuid,noosphere_hybrid.profile_state)',
            'noosphere_hybrid_b.enqueue_profile_backfill(uuid,integer)',
            'noosphere_hybrid_b.queue_health()'
          )
        )
        OR (
          grantee.rolname = 'noosphere_hybrid_worker'
          AND procedure.oid::pg_catalog.regprocedure::text IN (
            'noosphere_hybrid_b.queue_health()',
            'noosphere_hybrid_b.worker_readiness()',
            'noosphere_hybrid_b.claim_jobs(integer,integer,integer,uuid[])',
            'noosphere_hybrid_b.authorize_dispatch(uuid,uuid,bigint)',
            'noosphere_hybrid_b.release_stale_job(uuid,uuid,bigint,integer)',
            'noosphere_hybrid_b.publish_embedding(uuid,uuid,bigint,bigint,bytea,noosphere_vector.vector)',
            'noosphere_hybrid_b.fail_job(uuid,uuid,bigint,text,timestamp with time zone,boolean)'
          )
        )
      )
  ) AS drift;
  IF acl_drift IS NOT NULL THEN
    RAISE EXCEPTION 'Phase B ACLs exceed the exact owner and capability allowlist'
      USING DETAIL = acl_drift;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'noosphere_hybrid_b'
      AND (
        pg_catalog.has_table_privilege('noosphere_hybrid_admin', relation.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        OR pg_catalog.has_table_privilege('noosphere_hybrid_worker', relation.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      )
  ) THEN
    RAISE EXCEPTION 'Phase B capability roles have direct table privileges';
  END IF;

  IF NOT pg_catalog.has_schema_privilege('noosphere_hybrid_admin', 'noosphere_hybrid_b', 'USAGE')
    OR NOT pg_catalog.has_schema_privilege('noosphere_hybrid_worker', 'noosphere_hybrid_b', 'USAGE')
    OR NOT pg_catalog.has_function_privilege('noosphere_hybrid_admin', 'noosphere_hybrid_b.set_embedding_consent(boolean,boolean)', 'EXECUTE')
    OR NOT pg_catalog.has_function_privilege('noosphere_hybrid_admin', 'noosphere_hybrid_b.create_profile(text,noosphere_hybrid.profile_locality,text,text,integer,noosphere_hybrid.distance_metric,noosphere_hybrid.normalization_policy,integer,bytea)', 'EXECUTE')
    OR NOT pg_catalog.has_function_privilege('noosphere_hybrid_admin', 'noosphere_hybrid_b.profile_coverage(uuid)', 'EXECUTE')
    OR NOT pg_catalog.has_function_privilege('noosphere_hybrid_admin', 'noosphere_hybrid_b.profile_status(uuid)', 'EXECUTE')
    OR NOT pg_catalog.has_function_privilege('noosphere_hybrid_admin', 'noosphere_hybrid_b.set_profile_state(uuid,noosphere_hybrid.profile_state)', 'EXECUTE')
    OR NOT pg_catalog.has_function_privilege('noosphere_hybrid_admin', 'noosphere_hybrid_b.enqueue_profile_backfill(uuid,integer)', 'EXECUTE')
    OR NOT pg_catalog.has_function_privilege('noosphere_hybrid_admin', 'noosphere_hybrid_b.queue_health()', 'EXECUTE')
    OR NOT pg_catalog.has_function_privilege('noosphere_hybrid_worker', 'noosphere_hybrid_b.claim_jobs(integer,integer,integer,uuid[])', 'EXECUTE')
    OR NOT pg_catalog.has_function_privilege('noosphere_hybrid_worker', 'noosphere_hybrid_b.authorize_dispatch(uuid,uuid,bigint)', 'EXECUTE')
    OR NOT pg_catalog.has_function_privilege('noosphere_hybrid_worker', 'noosphere_hybrid_b.release_stale_job(uuid,uuid,bigint,integer)', 'EXECUTE')
    OR NOT pg_catalog.has_function_privilege('noosphere_hybrid_worker', 'noosphere_hybrid_b.publish_embedding(uuid,uuid,bigint,bigint,bytea,noosphere_vector.vector)', 'EXECUTE')
    OR NOT pg_catalog.has_function_privilege('noosphere_hybrid_worker', 'noosphere_hybrid_b.fail_job(uuid,uuid,bigint,text,timestamptz,boolean)', 'EXECUTE')
    OR NOT pg_catalog.has_function_privilege('noosphere_hybrid_worker', 'noosphere_hybrid_b.queue_health()', 'EXECUTE')
    OR NOT pg_catalog.has_function_privilege('noosphere_hybrid_worker', 'noosphere_hybrid_b.worker_readiness()', 'EXECUTE')
    OR pg_catalog.has_function_privilege('noosphere_hybrid_admin', 'noosphere_hybrid.set_profile_state(uuid,noosphere_hybrid.profile_state)', 'EXECUTE')
    OR pg_catalog.has_function_privilege('noosphere_hybrid_admin', 'noosphere_hybrid.create_profile(text,noosphere_hybrid.profile_locality,text,text,integer,noosphere_hybrid.distance_metric,noosphere_hybrid.normalization_policy,integer,bytea)', 'EXECUTE')
    OR pg_catalog.has_function_privilege('noosphere_hybrid_worker', 'noosphere_hybrid.claim_jobs(integer,integer)', 'EXECUTE')
    OR pg_catalog.has_function_privilege('noosphere_hybrid_worker', 'noosphere_hybrid.publish_embedding(uuid,uuid,bigint,bigint,bytea,noosphere_vector.vector)', 'EXECUTE')
    OR pg_catalog.has_function_privilege('noosphere_hybrid_worker', 'noosphere_hybrid.fail_job(uuid,uuid,bigint,text,timestamptz,boolean)', 'EXECUTE')
    OR pg_catalog.has_schema_privilege('noosphere_app', 'noosphere_hybrid_b', 'USAGE')
  THEN
    RAISE EXCEPTION 'Phase B capability grants do not exactly include the required boundary';
  END IF;

  IF EXISTS (
    SELECT 1
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
      AND NOT (
        trigger_record.tgenabled = 'O'
        AND (
          (trigger_record.tgname = 'noosphere_hybrid_b_article_guard'
           AND procedure.oid = 'noosphere_hybrid_b.article_write_guard()'::pg_catalog.regprocedure)
          OR
          (trigger_record.tgname = 'zz_noosphere_hybrid_b_article_dirty'
           AND procedure.oid = 'noosphere_hybrid_b.article_dirty_trigger()'::pg_catalog.regprocedure)
        )
      )
  ) OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_trigger AS trigger_record
    JOIN pg_catalog.pg_class AS relation ON relation.oid = trigger_record.tgrelid
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE NOT trigger_record.tgisinternal
      AND namespace.nspname = 'public'
      AND relation.relname = 'Article'
      AND trigger_record.tgname IN ('noosphere_hybrid_b_article_guard', 'zz_noosphere_hybrid_b_article_dirty')
      AND trigger_record.tgenabled = 'O'
  ) <> 2 THEN
    RAISE EXCEPTION 'Phase B Article trigger inventory does not exactly match';
  END IF;
END;
$validation$;
