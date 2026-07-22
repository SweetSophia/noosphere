DO $validation$
DECLARE
  state noosphere_hybrid_c.feature_state%ROWTYPE;
  actual_manifest_sha256 text;
  actual_structure_sha256 text;
  acl_drift text;
BEGIN
  SELECT * INTO STRICT state FROM noosphere_hybrid_c.feature_state WHERE singleton;
  IF state.feature_version <> 1
    OR state.a3_source_sha256 <> pg_catalog.current_setting('noosphere.phase_a3.source_sha256')
    OR state.phase_b_source_sha256 <> pg_catalog.current_setting('noosphere.phase_b.source_sha256')
    OR state.source_sha256 <> pg_catalog.current_setting('noosphere.phase_c.source_sha256')
  THEN
    RAISE EXCEPTION 'Phase C provenance does not exactly match';
  END IF;

  SELECT pg_catalog.encode(
    noosphere_crypto.digest(
      pg_catalog.convert_to(
        pg_catalog.string_agg(
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
          ),
          E'\n' ORDER BY procedure.oid::pg_catalog.regprocedure::text
        ),
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  ) INTO actual_manifest_sha256
  FROM pg_catalog.pg_proc AS procedure
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
  WHERE namespace.nspname = 'noosphere_hybrid_c';
  IF actual_manifest_sha256 <> state.manifest_sha256 THEN
    RAISE EXCEPTION 'Phase C routine manifest drifted';
  END IF;

  SELECT pg_catalog.encode(
    noosphere_crypto.digest(
      pg_catalog.convert_to(noosphere_hybrid_c.structural_manifest(), 'UTF8'),
      'sha256'
    ),
    'hex'
  ) INTO actual_structure_sha256;
  IF actual_structure_sha256 <> state.structure_sha256 THEN
    RAISE EXCEPTION 'Phase C table, constraint, or index structure drifted';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_namespace AS namespace
    JOIN pg_catalog.pg_roles AS owner ON owner.oid = namespace.nspowner
    WHERE namespace.nspname = 'noosphere_hybrid_c'
      AND owner.rolname = 'noosphere_hybrid_owner'
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    JOIN pg_catalog.pg_roles AS owner ON owner.oid = relation.relowner
    WHERE namespace.nspname = 'noosphere_hybrid_c'
      AND owner.rolname <> 'noosphere_hybrid_owner'
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS procedure
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
    JOIN pg_catalog.pg_roles AS owner ON owner.oid = procedure.proowner
    WHERE namespace.nspname = 'noosphere_hybrid_c'
      AND (
        owner.rolname <> 'noosphere_hybrid_owner'
        OR procedure.prosecdef IS DISTINCT FROM true
        OR NOT (procedure.proconfig @> ARRAY['search_path=pg_catalog, pg_temp'])
      )
  ) THEN
    RAISE EXCEPTION 'Phase C ownership or SECURITY DEFINER configuration drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_namespace AS namespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      coalesce(namespace.nspacl, pg_catalog.acldefault('n', namespace.nspowner))
    ) AS acl
    WHERE namespace.nspname = 'noosphere_hybrid_c' AND acl.grantee = 0
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      coalesce(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
    ) AS acl
    WHERE namespace.nspname = 'noosphere_hybrid_c' AND acl.grantee = 0
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS procedure
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      coalesce(procedure.proacl, pg_catalog.acldefault('f', procedure.proowner))
    ) AS acl
    WHERE namespace.nspname = 'noosphere_hybrid_c' AND acl.grantee = 0
  ) THEN
    RAISE EXCEPTION 'PUBLIC retains Phase C privileges';
  END IF;

  SELECT pg_catalog.string_agg(drift.description, '; ' ORDER BY drift.description)
  INTO acl_drift
  FROM (
    SELECT pg_catalog.format(
      'schema noosphere_hybrid_c: %I has %s', grantee.rolname, acl.privilege_type
    ) AS description
    FROM pg_catalog.pg_namespace AS namespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      coalesce(namespace.nspacl, pg_catalog.acldefault('n', namespace.nspowner))
    ) AS acl
    JOIN pg_catalog.pg_roles AS grantee ON grantee.oid = acl.grantee
    WHERE namespace.nspname = 'noosphere_hybrid_c'
      AND NOT (
        grantee.rolname = 'noosphere_hybrid_owner'
        OR (
          grantee.rolname = 'noosphere_app'
          AND acl.privilege_type = 'USAGE'
          AND NOT acl.is_grantable
        )
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
    WHERE namespace.nspname = 'noosphere_hybrid_c'
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
    WHERE namespace.nspname = 'noosphere_hybrid_c'
      AND NOT (
        grantee.rolname = 'noosphere_hybrid_owner'
        OR (
          grantee.rolname = 'noosphere_app'
          AND procedure.oid::pg_catalog.regprocedure::text IN (
            'noosphere_hybrid_c.query_profile_snapshot(uuid)',
            'noosphere_hybrid_c.authorize_query_dispatch(uuid)',
            'noosphere_hybrid_c.vector_candidates(uuid,text,text[])',
            'noosphere_hybrid_c.current_vector_membership(uuid,text[])'
          )
          AND NOT acl.is_grantable
        )
      )
  ) AS drift;
  IF acl_drift IS NOT NULL THEN
    RAISE EXCEPTION 'Phase C ACLs exceed the exact owner and application allowlist'
      USING DETAIL = acl_drift;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'noosphere_hybrid_c'
      AND pg_catalog.has_table_privilege(
        'noosphere_app', relation.oid,
        'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
      )
  ) THEN
    RAISE EXCEPTION 'Phase C application role has direct table privileges';
  END IF;

  IF NOT pg_catalog.has_schema_privilege('noosphere_app', 'noosphere_hybrid_c', 'USAGE')
    OR NOT pg_catalog.has_function_privilege('noosphere_app', 'noosphere_hybrid_c.query_profile_snapshot(uuid)', 'EXECUTE')
    OR NOT pg_catalog.has_function_privilege('noosphere_app', 'noosphere_hybrid_c.authorize_query_dispatch(uuid)', 'EXECUTE')
    OR NOT pg_catalog.has_function_privilege('noosphere_app', 'noosphere_hybrid_c.vector_candidates(uuid,text,text[])', 'EXECUTE')
    OR NOT pg_catalog.has_function_privilege('noosphere_app', 'noosphere_hybrid_c.current_vector_membership(uuid,text[])', 'EXECUTE')
    OR pg_catalog.has_function_privilege('noosphere_app', 'noosphere_hybrid_c.structural_manifest()', 'EXECUTE')
    OR pg_catalog.has_schema_privilege('noosphere_hybrid_admin', 'noosphere_hybrid_c', 'USAGE')
    OR pg_catalog.has_schema_privilege('noosphere_hybrid_worker', 'noosphere_hybrid_c', 'USAGE')
  THEN
    RAISE EXCEPTION 'Phase C application capability grants do not exactly match';
  END IF;
END;
$validation$;
