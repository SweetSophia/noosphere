DO $validation$
DECLARE
  state noosphere_hybrid.feature_state%ROWTYPE;
  mismatch text;
BEGIN
  SELECT * INTO STRICT state
  FROM noosphere_hybrid.feature_state
  WHERE singleton;

  IF state.feature_version <> 1
    OR state.provenance_kind <> pg_catalog.current_setting('noosphere.activation.provenance_kind')
    OR state.source_url <> pg_catalog.current_setting('noosphere.activation.source_url')
    OR state.source_sha256 <> pg_catalog.current_setting('noosphere.activation.source_sha256')
    OR state.pgvector_version <> pg_catalog.current_setting('noosphere.activation.pgvector_version')
    OR state.spdx_identifier <> pg_catalog.current_setting('noosphere.activation.spdx_identifier')
    OR state.built_image_digest <> pg_catalog.current_setting('noosphere.activation.built_image_digest')
    OR state.activation_sql_sha256 <> pg_catalog.current_setting('noosphere.activation.sql_sha256')
    OR state.public_schema_fingerprint <> pg_catalog.current_setting('noosphere.activation.public_fingerprint')
  THEN
    RAISE EXCEPTION 'hybrid activation provenance does not exactly match the requested version';
  END IF;

  SELECT extension.extname INTO mismatch
  FROM pg_catalog.pg_extension AS extension
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = extension.extnamespace
  JOIN pg_catalog.pg_roles AS owner ON owner.oid = extension.extowner
  WHERE extension.extname IN ('vector', 'pgcrypto')
    AND NOT (
      namespace.nspname = CASE extension.extname
        WHEN 'vector' THEN 'noosphere_vector'
        ELSE 'noosphere_crypto'
      END
      AND owner.rolname = 'noosphere_hybrid_extension_owner'
      AND (
        extension.extname <> 'vector'
        OR extension.extversion = pg_catalog.current_setting('noosphere.activation.pgvector_version')
      )
    )
  LIMIT 1;
  IF mismatch IS NOT NULL
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_extension WHERE extname IN ('vector', 'pgcrypto')) <> 2
  THEN
    RAISE EXCEPTION 'hybrid extension catalog state does not exactly match';
  END IF;

  SELECT role.rolname INTO mismatch
  FROM pg_catalog.pg_roles AS role
  WHERE role.rolname IN (
      'noosphere_hybrid_extension_owner',
      'noosphere_hybrid_owner',
      'noosphere_hybrid_activator',
      'noosphere_hybrid_admin',
      'noosphere_hybrid_worker'
    )
    AND (
      role.rolcanlogin OR role.rolsuper OR role.rolcreatedb OR
      role.rolcreaterole OR role.rolinherit OR role.rolreplication OR role.rolbypassrls
    )
  LIMIT 1;
  IF mismatch IS NOT NULL
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_roles WHERE pg_catalog.starts_with(rolname, 'noosphere_hybrid_') AND NOT rolcanlogin) <> 5
  THEN
    RAISE EXCEPTION 'hybrid capability role state does not exactly match';
  END IF;

  SELECT member.rolname || '->' || granted.rolname INTO mismatch
  FROM pg_catalog.pg_auth_members AS membership
  JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
  JOIN pg_catalog.pg_roles AS granted ON granted.oid = membership.roleid
  WHERE (
      pg_catalog.starts_with(member.rolname, 'noosphere_hybrid_')
      OR pg_catalog.starts_with(granted.rolname, 'noosphere_hybrid_')
    )
    AND NOT (
      (
        member.rolname = 'noosphere_hybrid_admin_login'
        AND granted.rolname = 'noosphere_hybrid_admin'
        AND NOT membership.admin_option
        AND membership.inherit_option
        AND membership.set_option
      )
      OR
      (
        member.rolname = 'noosphere_hybrid_worker_login'
        AND granted.rolname = 'noosphere_hybrid_worker'
        AND NOT membership.admin_option
        AND membership.inherit_option
        AND membership.set_option
      )
    )
  LIMIT 1;
  IF mismatch IS NOT NULL
    OR NOT pg_catalog.pg_has_role('noosphere_hybrid_admin_login', 'noosphere_hybrid_admin', 'MEMBER')
    OR NOT pg_catalog.pg_has_role('noosphere_hybrid_worker_login', 'noosphere_hybrid_worker', 'MEMBER')
  THEN
    RAISE EXCEPTION 'hybrid role membership state does not exactly match: %', coalesce(mismatch, 'missing expected membership');
  END IF;

  SELECT namespace.nspname INTO mismatch
  FROM pg_catalog.pg_namespace AS namespace
  JOIN pg_catalog.pg_roles AS owner ON owner.oid = namespace.nspowner
  WHERE namespace.nspname IN ('noosphere_vector', 'noosphere_crypto', 'noosphere_hybrid')
    AND owner.rolname <> CASE namespace.nspname
      WHEN 'noosphere_hybrid' THEN 'noosphere_hybrid_owner'
      ELSE 'noosphere_hybrid_extension_owner'
    END
  LIMIT 1;
  IF mismatch IS NOT NULL
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_namespace WHERE nspname IN ('noosphere_vector', 'noosphere_crypto', 'noosphere_hybrid')) <> 3
    OR pg_catalog.has_schema_privilege('noosphere_hybrid_admin', 'noosphere_hybrid', 'CREATE')
    OR pg_catalog.has_schema_privilege('noosphere_hybrid_worker', 'noosphere_hybrid', 'CREATE')
    OR pg_catalog.has_schema_privilege('noosphere_hybrid_worker', 'noosphere_vector', 'CREATE')
  THEN
    RAISE EXCEPTION 'hybrid schema ownership or CREATE privileges do not exactly match';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_namespace AS namespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      coalesce(namespace.nspacl, pg_catalog.acldefault('n', namespace.nspowner))
    ) AS acl
    WHERE namespace.nspname IN ('noosphere_vector', 'noosphere_crypto', 'noosphere_hybrid')
      AND acl.grantee = 0
  ) THEN
    RAISE EXCEPTION 'PUBLIC retains hybrid schema privileges';
  END IF;

  SELECT relation.relname INTO mismatch
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
  JOIN pg_catalog.pg_roles AS owner ON owner.oid = relation.relowner
  WHERE namespace.nspname = 'noosphere_hybrid'
    AND relation.relkind IN ('r', 'p', 'v', 'm')
    AND (
      owner.rolname <> 'noosphere_hybrid_owner'
      OR relation.relrowsecurity
      OR relation.relforcerowsecurity
    )
  LIMIT 1;
  IF mismatch IS NOT NULL
    OR (SELECT pg_catalog.count(*)
        FROM pg_catalog.pg_class AS relation
        JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'noosphere_hybrid'
          AND relation.relkind IN ('r', 'p', 'v', 'm')) <> 7
  THEN
    RAISE EXCEPTION 'hybrid relation ownership, inventory, or row-security state does not exactly match';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'noosphere_hybrid'
      AND relation.relname = 'worker_eligibility'
      AND relation.reloptions @> ARRAY['security_barrier=true', 'security_invoker=false']
  ) THEN
    RAISE EXCEPTION 'worker eligibility view security semantics do not exactly match';
  END IF;

  IF pg_catalog.encode(
      noosphere_crypto.digest(
        pg_catalog.convert_to(
          pg_catalog.pg_get_viewdef(
            'noosphere_hybrid.worker_eligibility'::pg_catalog.regclass,
            false
          ),
          'UTF8'
        ),
        'sha256'
      ),
      'hex'
    ) <> state.worker_eligibility_sha256
  THEN
    RAISE EXCEPTION 'worker eligibility view definition does not exactly match activation evidence';
  END IF;

  SELECT procedure.proname INTO mismatch
  FROM pg_catalog.pg_proc AS procedure
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
  JOIN pg_catalog.pg_roles AS owner ON owner.oid = procedure.proowner
  WHERE namespace.nspname = 'noosphere_hybrid'
    AND (
      owner.rolname <> 'noosphere_hybrid_owner'
      OR procedure.proconfig IS NULL
      OR NOT procedure.proconfig @> ARRAY['search_path=pg_catalog, pg_temp']
    )
  LIMIT 1;
  IF mismatch IS NOT NULL THEN
    RAISE EXCEPTION 'hybrid routine owner or search_path does not exactly match: %', mismatch;
  END IF;

  IF (
    SELECT pg_catalog.encode(
      noosphere_crypto.digest(
        pg_catalog.convert_to(
          pg_catalog.string_agg(
            pg_catalog.pg_get_functiondef(procedure.oid),
            E'\n'
            ORDER BY procedure.oid::pg_catalog.regprocedure::text
          ),
          'UTF8'
        ),
        'sha256'
      ),
      'hex'
    )
    FROM pg_catalog.pg_proc AS procedure
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
    WHERE namespace.nspname = 'noosphere_hybrid'
  ) <> state.routine_manifest_sha256
  THEN
    RAISE EXCEPTION 'hybrid routine definitions do not exactly match activation evidence';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      coalesce(relation.relacl, pg_catalog.acldefault(
        CASE relation.relkind WHEN 'S' THEN 's'::"char" ELSE 'r'::"char" END,
        relation.relowner
      ))
    ) AS acl
    WHERE namespace.nspname = 'noosphere_hybrid'
      AND relation.relkind IN ('r', 'p', 'v', 'm', 'S')
      AND acl.grantee = 0
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS procedure
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      coalesce(procedure.proacl, pg_catalog.acldefault('f', procedure.proowner))
    ) AS acl
    WHERE namespace.nspname = 'noosphere_hybrid'
      AND acl.grantee = 0
  ) THEN
    RAISE EXCEPTION 'PUBLIC retains hybrid relation or routine privileges';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_namespace AS namespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      coalesce(namespace.nspacl, pg_catalog.acldefault('n', namespace.nspowner))
    ) AS acl
    JOIN pg_catalog.pg_roles AS grantee ON grantee.oid = acl.grantee
    WHERE namespace.nspname IN ('noosphere_vector', 'noosphere_crypto', 'noosphere_hybrid')
      AND grantee.rolname IN (
        'noosphere_hybrid_admin_login',
        'noosphere_hybrid_worker_login',
        'noosphere_app',
        'noosphere_migrator'
      )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      coalesce(relation.relacl, pg_catalog.acldefault(
        CASE relation.relkind WHEN 'S' THEN 's'::"char" ELSE 'r'::"char" END,
        relation.relowner
      ))
    ) AS acl
    JOIN pg_catalog.pg_roles AS grantee ON grantee.oid = acl.grantee
    WHERE namespace.nspname = 'noosphere_hybrid'
      AND grantee.rolname IN (
        'noosphere_hybrid_admin_login',
        'noosphere_hybrid_worker_login',
        'noosphere_app',
        'noosphere_migrator'
      )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS procedure
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      coalesce(procedure.proacl, pg_catalog.acldefault('f', procedure.proowner))
    ) AS acl
    JOIN pg_catalog.pg_roles AS grantee ON grantee.oid = acl.grantee
    WHERE namespace.nspname = 'noosphere_hybrid'
      AND grantee.rolname IN (
        'noosphere_hybrid_admin_login',
        'noosphere_hybrid_worker_login',
        'noosphere_app',
        'noosphere_migrator'
      )
  ) THEN
    RAISE EXCEPTION 'runtime logins retain direct hybrid privileges instead of capability-only membership';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_default_acl AS defaults
    JOIN pg_catalog.pg_roles AS owner ON owner.oid = defaults.defaclrole
    CROSS JOIN LATERAL pg_catalog.aclexplode(defaults.defaclacl) AS acl
    WHERE owner.rolname = 'noosphere_hybrid_owner'
      AND acl.grantee = 0
  ) THEN
    RAISE EXCEPTION 'PUBLIC retains hybrid default privileges';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_default_acl AS defaults
    JOIN pg_catalog.pg_roles AS owner ON owner.oid = defaults.defaclrole
    WHERE owner.rolname = 'noosphere_hybrid_owner'
      AND defaults.defaclobjtype = 'f'
      AND defaults.defaclnamespace = 0
  ) THEN
    RAISE EXCEPTION 'hybrid function default privileges are not locked';
  END IF;

  IF NOT pg_catalog.has_function_privilege(
      'noosphere_hybrid_admin',
      'noosphere_hybrid.create_profile(text,noosphere_hybrid.profile_locality,text,text,integer,noosphere_hybrid.distance_metric,noosphere_hybrid.normalization_policy,integer,bytea)',
      'EXECUTE'
    )
    OR NOT pg_catalog.has_function_privilege(
      'noosphere_hybrid_admin',
      'noosphere_hybrid.set_profile_state(uuid,noosphere_hybrid.profile_state)',
      'EXECUTE'
    )
    OR NOT pg_catalog.has_table_privilege(
      'noosphere_hybrid_worker',
      'noosphere_hybrid.worker_eligibility',
      'SELECT'
    )
    OR NOT pg_catalog.has_function_privilege(
      'noosphere_hybrid_worker',
      'noosphere_hybrid.claim_jobs(integer,integer)',
      'EXECUTE'
    )
    OR NOT pg_catalog.has_function_privilege(
      'noosphere_hybrid_worker',
      'noosphere_hybrid.fail_job(uuid,uuid,bigint,text,timestamptz,boolean)',
      'EXECUTE'
    )
    OR NOT pg_catalog.has_function_privilege(
      'noosphere_hybrid_worker',
      'noosphere_hybrid.publish_embedding(uuid,uuid,bigint,bigint,bytea,noosphere_vector.vector)',
      'EXECUTE'
    )
    OR NOT pg_catalog.has_function_privilege(
      'noosphere_hybrid_worker',
      'noosphere_hybrid.canonical_document(text,text,text,integer)',
      'EXECUTE'
    )
    OR NOT pg_catalog.has_function_privilege(
      'noosphere_hybrid_worker',
      'noosphere_hybrid.canonical_hash(text,text,text,integer)',
      'EXECUTE'
    )
    OR pg_catalog.has_function_privilege(
      'noosphere_hybrid_admin',
      'noosphere_hybrid.claim_jobs(integer,integer)',
      'EXECUTE'
    )
    OR pg_catalog.has_function_privilege(
      'noosphere_hybrid_worker',
      'noosphere_hybrid.create_profile(text,noosphere_hybrid.profile_locality,text,text,integer,noosphere_hybrid.distance_metric,noosphere_hybrid.normalization_policy,integer,bytea)',
      'EXECUTE'
    )
    OR pg_catalog.has_table_privilege(
      'noosphere_hybrid_worker',
      'public."Article"',
      'SELECT'
    )
    OR pg_catalog.has_schema_privilege('noosphere_app', 'noosphere_hybrid', 'USAGE')
  THEN
    RAISE EXCEPTION 'hybrid administrative or worker capability grants do not exactly match';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'noosphere_hybrid'
      AND relation.relkind IN ('r', 'p', 'v', 'm', 'S')
      AND (
        pg_catalog.has_table_privilege(
          'noosphere_hybrid_admin', relation.oid,
          'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
        )
        OR pg_catalog.has_table_privilege(
          'noosphere_hybrid_worker', relation.oid,
          'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
        )
        OR (
          relation.relname <> 'worker_eligibility'
          AND pg_catalog.has_table_privilege(
            'noosphere_hybrid_worker', relation.oid, 'SELECT'
          )
        )
      )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS procedure
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
    WHERE namespace.nspname = 'noosphere_hybrid'
      AND (
        pg_catalog.has_function_privilege(
          'noosphere_hybrid_admin', procedure.oid, 'EXECUTE'
        ) <> (
          procedure.oid IN (
            'noosphere_hybrid.create_profile(text,noosphere_hybrid.profile_locality,text,text,integer,noosphere_hybrid.distance_metric,noosphere_hybrid.normalization_policy,integer,bytea)'::pg_catalog.regprocedure,
            'noosphere_hybrid.set_profile_state(uuid,noosphere_hybrid.profile_state)'::pg_catalog.regprocedure
          )
        )
        OR pg_catalog.has_function_privilege(
          'noosphere_hybrid_worker', procedure.oid, 'EXECUTE'
        ) <> (
          procedure.oid IN (
            'noosphere_hybrid.claim_jobs(integer,integer)'::pg_catalog.regprocedure,
            'noosphere_hybrid.canonical_document(text,text,text,integer)'::pg_catalog.regprocedure,
            'noosphere_hybrid.canonical_hash(text,text,text,integer)'::pg_catalog.regprocedure,
            'noosphere_hybrid.fail_job(uuid,uuid,bigint,text,timestamptz,boolean)'::pg_catalog.regprocedure,
            'noosphere_hybrid.publish_embedding(uuid,uuid,bigint,bigint,bytea,noosphere_vector.vector)'::pg_catalog.regprocedure
          )
        )
      )
  ) THEN
    RAISE EXCEPTION 'hybrid capability roles retain privileges outside the exact allowlist';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public'
      AND relation.relkind IN ('r', 'p', 'v', 'm', 'S')
      AND (
        pg_catalog.has_table_privilege(
          'noosphere_hybrid_admin', relation.oid,
          'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
        )
        OR pg_catalog.has_table_privilege(
          'noosphere_hybrid_worker', relation.oid,
          'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
        )
      )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS procedure
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
    WHERE namespace.nspname = 'public'
      AND (
        pg_catalog.has_function_privilege(
          'noosphere_hybrid_admin', procedure.oid, 'EXECUTE'
        )
        OR pg_catalog.has_function_privilege(
          'noosphere_hybrid_worker', procedure.oid, 'EXECUTE'
        )
      )
  ) THEN
    RAISE EXCEPTION 'hybrid capability roles retain privileges on public application objects';
  END IF;

  IF NOT pg_catalog.has_table_privilege(
      'noosphere_hybrid_owner', 'public."Article"', 'SELECT'
    )
    OR pg_catalog.has_table_privilege(
      'noosphere_hybrid_owner', 'public."Article"',
      'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
    )
    OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS relation
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public'
        AND relation.relname <> 'Article'
        AND relation.relkind IN ('r', 'p', 'v', 'm', 'S')
        AND pg_catalog.has_table_privilege(
          'noosphere_hybrid_owner', relation.oid,
          'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
        )
    )
  THEN
    RAISE EXCEPTION 'hybrid feature owner public-table privileges do not exactly match';
  END IF;

  SELECT expected.trigger_name INTO mismatch
  FROM (
    VALUES
      ('public', 'Article', 'noosphere_hybrid_article_dirty', 'article_dirty_trigger'),
      ('public', 'Article', 'noosphere_hybrid_article_epoch', 'cache_epoch_trigger'),
      ('public', 'Topic', 'noosphere_hybrid_topic_epoch', 'cache_epoch_trigger'),
      ('public', 'Tag', 'noosphere_hybrid_tag_epoch', 'cache_epoch_trigger'),
      ('public', 'ArticleTag', 'noosphere_hybrid_article_tag_epoch', 'cache_epoch_trigger'),
      ('noosphere_hybrid', 'embedding_profile', 'embedding_profile_identity_guard', 'profile_identity_guard'),
      ('noosphere_hybrid', 'embedding_profile', 'embedding_profile_epoch', 'cache_epoch_trigger'),
      ('noosphere_hybrid', 'article_embedding', 'article_embedding_epoch', 'cache_epoch_trigger')
  ) AS expected(schema_name, relation_name, trigger_name, function_name)
  LEFT JOIN pg_catalog.pg_namespace AS namespace ON namespace.nspname = expected.schema_name
  LEFT JOIN pg_catalog.pg_class AS relation
    ON relation.relnamespace = namespace.oid
   AND relation.relname = expected.relation_name
  LEFT JOIN pg_catalog.pg_trigger AS trigger
    ON trigger.tgrelid = relation.oid
   AND trigger.tgname = expected.trigger_name
   AND NOT trigger.tgisinternal
  LEFT JOIN pg_catalog.pg_proc AS procedure ON procedure.oid = trigger.tgfoid
  WHERE trigger.oid IS NULL
     OR trigger.tgenabled <> 'O'
     OR procedure.proname <> expected.function_name
  LIMIT 1;
  IF mismatch IS NOT NULL THEN
    RAISE EXCEPTION 'hybrid trigger mapping does not exactly match: %', mismatch;
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_trigger AS trigger
    JOIN pg_catalog.pg_class AS relation ON relation.oid = trigger.tgrelid
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE NOT trigger.tgisinternal
      AND trigger.tgenabled = 'O'
      AND (
        (namespace.nspname = 'public' AND trigger.tgname IN (
          'noosphere_hybrid_article_dirty',
          'noosphere_hybrid_article_epoch',
          'noosphere_hybrid_topic_epoch',
          'noosphere_hybrid_tag_epoch',
          'noosphere_hybrid_article_tag_epoch'
        ))
        OR
        (namespace.nspname = 'noosphere_hybrid' AND trigger.tgname IN (
          'embedding_profile_identity_guard',
          'embedding_profile_epoch',
          'article_embedding_epoch'
        ))
      )
  ) <> 8 THEN
    RAISE EXCEPTION 'hybrid trigger inventory does not exactly match';
  END IF;

  IF (
    SELECT pg_catalog.encode(
      noosphere_crypto.digest(
        pg_catalog.convert_to(
          pg_catalog.string_agg(
            pg_catalog.pg_get_triggerdef(trigger.oid, false),
            E'\n'
            ORDER BY namespace.nspname, relation.relname, trigger.tgname
          ),
          'UTF8'
        ),
        'sha256'
      ),
      'hex'
    )
    FROM pg_catalog.pg_trigger AS trigger
    JOIN pg_catalog.pg_class AS relation ON relation.oid = trigger.tgrelid
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE NOT trigger.tgisinternal
      AND trigger.tgname IN (
        'noosphere_hybrid_article_dirty',
        'noosphere_hybrid_article_epoch',
        'noosphere_hybrid_topic_epoch',
        'noosphere_hybrid_tag_epoch',
        'noosphere_hybrid_article_tag_epoch',
        'embedding_profile_identity_guard',
        'embedding_profile_epoch',
        'article_embedding_epoch'
      )
  ) <> state.trigger_manifest_sha256
  THEN
    RAISE EXCEPTION 'hybrid trigger definitions do not exactly match activation evidence';
  END IF;

  IF pg_catalog.has_database_privilege(
    'noosphere_hybrid_activator',
    pg_catalog.current_database(),
    'CREATE'
  ) THEN
    RAISE EXCEPTION 'hybrid activator retained database CREATE privilege';
  END IF;
END;
$validation$;
