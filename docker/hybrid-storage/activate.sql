\set ON_ERROR_STOP on

BEGIN;
SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('noosphere-hybrid-storage-activation-v1', 0)
);
SELECT pg_catalog.set_config('noosphere.activation.provenance_kind', :'provenance_kind', true);
SELECT pg_catalog.set_config('noosphere.activation.source_url', :'source_url', true);
SELECT pg_catalog.set_config('noosphere.activation.source_sha256', :'source_sha256', true);
SELECT pg_catalog.set_config('noosphere.activation.pgvector_version', :'pgvector_version', true);
SELECT pg_catalog.set_config('noosphere.activation.spdx_identifier', :'spdx_identifier', true);
SELECT pg_catalog.set_config('noosphere.activation.built_image_digest', :'built_image_digest', true);
SELECT pg_catalog.set_config('noosphere.activation.sql_sha256', :'activation_sql_sha256', true);
SELECT pg_catalog.set_config('noosphere.activation.public_fingerprint', :'public_schema_fingerprint', true);

DO $block$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles
    WHERE rolname = current_user
      AND rolsuper
  ) THEN
    RAISE EXCEPTION 'hybrid extension provisioning requires a PostgreSQL superuser';
  END IF;
END;
$block$;

SELECT
  pg_catalog.to_regclass('noosphere_hybrid.feature_state') IS NULL AS first_activation
\gset

\if :first_activation
  DO $block$
  DECLARE
    existing_role text;
    invalid_login text;
  BEGIN
    IF EXISTS (
      SELECT 1
      FROM pg_catalog.pg_namespace
      WHERE nspname IN ('noosphere_vector', 'noosphere_crypto', 'noosphere_hybrid')
    ) OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_extension
      WHERE extname IN ('vector', 'pgcrypto')
    ) THEN
      RAISE EXCEPTION 'refusing partial or attacker-precreated hybrid/extension state';
    END IF;

    SELECT rolname INTO existing_role
    FROM pg_catalog.pg_roles
    WHERE rolname IN (
      'noosphere_hybrid_extension_owner',
      'noosphere_hybrid_owner',
      'noosphere_hybrid_activator',
      'noosphere_hybrid_admin',
      'noosphere_hybrid_worker'
    )
    LIMIT 1;
    IF existing_role IS NOT NULL THEN
      RAISE EXCEPTION 'refusing pre-existing hybrid capability role %', existing_role;
    END IF;

    SELECT role.rolname INTO invalid_login
    FROM pg_catalog.pg_roles AS role
    WHERE role.rolname IN (
        'noosphere_hybrid_admin_login',
        'noosphere_hybrid_worker_login'
      )
      AND (
        NOT role.rolcanlogin OR role.rolsuper OR role.rolcreatedb OR
        role.rolcreaterole OR NOT role.rolinherit OR
        role.rolreplication OR role.rolbypassrls
      )
    LIMIT 1;
    IF invalid_login IS NOT NULL
      OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_roles
        WHERE rolname = 'noosphere_hybrid_admin_login'
      )
      OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_roles
        WHERE rolname = 'noosphere_hybrid_worker_login'
      )
    THEN
      RAISE EXCEPTION 'hybrid administration and worker logins are missing or unsafe';
    END IF;
  END;
  $block$;

  CREATE ROLE noosphere_hybrid_extension_owner
    NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  CREATE ROLE noosphere_hybrid_owner
    NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  CREATE ROLE noosphere_hybrid_activator
    NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  CREATE ROLE noosphere_hybrid_admin
    NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  CREATE ROLE noosphere_hybrid_worker
    NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;

  -- pgvector 0.8.1 is not a trusted extension. The bootstrap session grants
  -- superuser only to an unloginable extension owner for extension creation,
  -- then removes it before any application feature DDL is run.
  ALTER ROLE noosphere_hybrid_extension_owner SUPERUSER;
  SET LOCAL ROLE noosphere_hybrid_extension_owner;
  CREATE SCHEMA noosphere_vector AUTHORIZATION noosphere_hybrid_extension_owner;
  CREATE EXTENSION vector WITH SCHEMA noosphere_vector VERSION :'pgvector_version';
  CREATE SCHEMA noosphere_crypto AUTHORIZATION noosphere_hybrid_extension_owner;
  CREATE EXTENSION pgcrypto WITH SCHEMA noosphere_crypto;
  RESET ROLE;
  ALTER ROLE noosphere_hybrid_extension_owner NOSUPERUSER;

  GRANT USAGE ON SCHEMA noosphere_vector, noosphere_crypto TO noosphere_hybrid_owner;
  -- Feature-table foreign keys and the initial revision-state backfill need
  -- only the Article identifier before feature DDL. The exact steady-state
  -- table SELECT grant is installed after the schema is complete.
  GRANT SELECT (id), REFERENCES (id)
    ON public."Article" TO noosphere_hybrid_owner;

  -- The feature activator is a separate, unloginable capability. Its database
  -- CREATE privilege and membership in the locked feature owner exist only
  -- within this transaction and are revoked before commit.
  GRANT noosphere_hybrid_owner TO noosphere_hybrid_activator;
  DO $block$
  BEGIN
    EXECUTE pg_catalog.format(
      'GRANT CREATE ON DATABASE %I TO noosphere_hybrid_activator',
      pg_catalog.current_database()
    );
  END;
  $block$;

  -- Block concurrent article writes from the pre-schema snapshot until the
  -- row trigger exists. Without this lock, an INSERT committed between those
  -- two operations would have neither revision state nor a trigger event.
  LOCK TABLE public."Article" IN SHARE ROW EXCLUSIVE MODE;
  SET LOCAL ROLE noosphere_hybrid_activator;
  CREATE SCHEMA noosphere_hybrid AUTHORIZATION noosphere_hybrid_owner;
  SET LOCAL ROLE noosphere_hybrid_owner;
  \ir feature-schema.sql
  RESET ROLE;

  REVOKE ALL ON SCHEMA noosphere_vector, noosphere_crypto, noosphere_hybrid FROM PUBLIC;

  CREATE TRIGGER noosphere_hybrid_article_dirty
  AFTER INSERT OR UPDATE OF title, excerpt, content, "deletedAt", "recallQuarantinedAt", "restrictedTags"
  ON public."Article"
  FOR EACH ROW EXECUTE FUNCTION noosphere_hybrid.article_dirty_trigger();

  CREATE TRIGGER noosphere_hybrid_article_epoch
  AFTER INSERT OR UPDATE OR DELETE ON public."Article"
  FOR EACH STATEMENT EXECUTE FUNCTION noosphere_hybrid.cache_epoch_trigger();

  CREATE TRIGGER noosphere_hybrid_topic_epoch
  AFTER INSERT OR UPDATE OR DELETE ON public."Topic"
  FOR EACH STATEMENT EXECUTE FUNCTION noosphere_hybrid.cache_epoch_trigger();

  CREATE TRIGGER noosphere_hybrid_tag_epoch
  AFTER INSERT OR UPDATE OR DELETE ON public."Tag"
  FOR EACH STATEMENT EXECUTE FUNCTION noosphere_hybrid.cache_epoch_trigger();

  CREATE TRIGGER noosphere_hybrid_article_tag_epoch
  AFTER INSERT OR UPDATE OR DELETE ON public."ArticleTag"
  FOR EACH STATEMENT EXECUTE FUNCTION noosphere_hybrid.cache_epoch_trigger();

  WITH semantics AS (
    SELECT
      -- This is an exact textual drift fingerprint from PostgreSQL's stable
      -- non-pretty deparser, not a substitute for the behavioral matrix.
      pg_catalog.pg_get_viewdef(
        'noosphere_hybrid.worker_eligibility'::pg_catalog.regclass,
        false
      ) AS view_definition,
      (
        SELECT pg_catalog.string_agg(
          pg_catalog.pg_get_triggerdef(trigger.oid, false),
          E'\n'
          ORDER BY namespace.nspname, relation.relname, trigger.tgname
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
      ) AS trigger_manifest,
      (
        -- Routine DDL is fingerprinted for the pinned PostgreSQL runtime.
        -- A future database-image transition must establish fresh evidence.
        SELECT pg_catalog.string_agg(
          pg_catalog.pg_get_functiondef(procedure.oid),
          E'\n'
          ORDER BY procedure.oid::pg_catalog.regprocedure::text
        )
        FROM pg_catalog.pg_proc AS procedure
        JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
        WHERE namespace.nspname = 'noosphere_hybrid'
      ) AS routine_manifest
  )
  INSERT INTO noosphere_hybrid.feature_state (
    singleton,
    feature_version,
    provenance_kind,
    source_url,
    source_sha256,
    pgvector_version,
    spdx_identifier,
    built_image_digest,
    activation_sql_sha256,
    public_schema_fingerprint,
    worker_eligibility_sha256,
    trigger_manifest_sha256,
    routine_manifest_sha256
  )
  SELECT
    true,
    1,
    :'provenance_kind',
    :'source_url',
    :'source_sha256',
    :'pgvector_version',
    :'spdx_identifier',
    :'built_image_digest',
    :'activation_sql_sha256',
    :'public_schema_fingerprint',
    pg_catalog.encode(
      noosphere_crypto.digest(pg_catalog.convert_to(view_definition, 'UTF8'), 'sha256'),
      'hex'
    ),
    pg_catalog.encode(
      noosphere_crypto.digest(pg_catalog.convert_to(trigger_manifest, 'UTF8'), 'sha256'),
      'hex'
    ),
    pg_catalog.encode(
      noosphere_crypto.digest(pg_catalog.convert_to(routine_manifest, 'UTF8'), 'sha256'),
      'hex'
    )
  FROM semantics;

  REVOKE CREATE ON SCHEMA noosphere_vector, noosphere_crypto, noosphere_hybrid FROM PUBLIC;
  REVOKE ALL ON ALL TABLES IN SCHEMA noosphere_hybrid FROM PUBLIC;
  REVOKE ALL ON ALL SEQUENCES IN SCHEMA noosphere_hybrid FROM PUBLIC;
  REVOKE ALL ON ALL FUNCTIONS IN SCHEMA noosphere_hybrid FROM PUBLIC;

  -- The locked feature owner is the definer for eligibility/trigger routines
  -- and needs read access to the canonical Article source. PostgreSQL requires
  -- one UPDATE-capable column for SELECT ... FOR SHARE; the inert id-only grant
  -- exists solely for claim_jobs row locking. Runtime capability roles never
  -- receive either public-table grant.
  GRANT SELECT ON public."Article" TO noosphere_hybrid_owner;
  GRANT UPDATE (id) ON public."Article" TO noosphere_hybrid_owner;
  GRANT USAGE ON SCHEMA noosphere_hybrid TO noosphere_hybrid_admin, noosphere_hybrid_worker;
  GRANT USAGE ON SCHEMA noosphere_vector TO noosphere_hybrid_worker;
  GRANT noosphere_hybrid_admin TO noosphere_hybrid_admin_login;
  GRANT noosphere_hybrid_worker TO noosphere_hybrid_worker_login;

  GRANT EXECUTE ON FUNCTION noosphere_hybrid.create_profile(
    text,
    noosphere_hybrid.profile_locality,
    text,
    text,
    integer,
    noosphere_hybrid.distance_metric,
    noosphere_hybrid.normalization_policy,
    integer,
    bytea
  ) TO noosphere_hybrid_admin;
  GRANT EXECUTE ON FUNCTION noosphere_hybrid.set_profile_state(
    uuid,
    noosphere_hybrid.profile_state
  ) TO noosphere_hybrid_admin;
  -- Canonical bytes are exposed only through claim_jobs, whose Article row
  -- lock is the restriction/quarantine revocation linearization point.
  GRANT EXECUTE ON FUNCTION noosphere_hybrid.claim_jobs(integer, integer)
    TO noosphere_hybrid_worker;
  GRANT EXECUTE ON FUNCTION noosphere_hybrid.publish_embedding(
    uuid, uuid, bigint, bigint, bytea, noosphere_vector.vector
  ) TO noosphere_hybrid_worker;
  GRANT EXECUTE ON FUNCTION noosphere_hybrid.fail_job(
    uuid, uuid, bigint, text, timestamptz, boolean
  ) TO noosphere_hybrid_worker;

  ALTER DEFAULT PRIVILEGES FOR ROLE noosphere_hybrid_owner IN SCHEMA noosphere_hybrid
    REVOKE ALL ON TABLES FROM PUBLIC;
  ALTER DEFAULT PRIVILEGES FOR ROLE noosphere_hybrid_owner IN SCHEMA noosphere_hybrid
    REVOKE ALL ON SEQUENCES FROM PUBLIC;
  -- Function EXECUTE is a global PostgreSQL default. A per-schema REVOKE does
  -- not subtract that global grant, so lock it at the owner level.
  ALTER DEFAULT PRIVILEGES FOR ROLE noosphere_hybrid_owner
    REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

  DO $block$
  BEGIN
    EXECUTE pg_catalog.format(
      'REVOKE CREATE ON DATABASE %I FROM noosphere_hybrid_activator',
      pg_catalog.current_database()
    );
  END;
  $block$;
  REVOKE noosphere_hybrid_owner FROM noosphere_hybrid_activator;

  ALTER ROLE noosphere_hybrid_extension_owner
    NOSUPERUSER NOLOGIN NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  ALTER ROLE noosphere_hybrid_owner
    NOSUPERUSER NOLOGIN NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  ALTER ROLE noosphere_hybrid_activator
    NOSUPERUSER NOLOGIN NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  ALTER ROLE noosphere_hybrid_admin
    NOSUPERUSER NOLOGIN NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  ALTER ROLE noosphere_hybrid_worker
    NOSUPERUSER NOLOGIN NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
\endif

-- First activation and exact repeat activation converge on the same validation
-- path. Repeat activation performs no repair: any catalog, ACL, owner, role,
-- trigger, provenance, or public-schema mismatch aborts the transaction.
\ir validate.sql

COMMIT;
