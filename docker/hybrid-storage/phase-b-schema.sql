-- Phase B provider/worker layer. Included by activate-phase-b.sql while the
-- session is SET ROLE noosphere_hybrid_owner. A3 remains byte-for-byte intact;
-- this schema is an independently evidenced, activation-gated layer.

CREATE TABLE noosphere_hybrid_b.feature_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  feature_version integer NOT NULL CHECK (feature_version = 1),
  source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[a-f0-9]{64}$'),
  manifest_sha256 text NOT NULL CHECK (manifest_sha256 ~ '^[a-f0-9]{64}$'),
  structure_sha256 text NOT NULL CHECK (structure_sha256 ~ '^[a-f0-9]{64}$'),
  activated_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp()
);

CREATE TABLE noosphere_hybrid_b.embedding_consent (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  remote_egress boolean NOT NULL DEFAULT false,
  restricted_remote_egress boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  CONSTRAINT embedding_consent_restricted_requires_remote
    CHECK (NOT restricted_remote_egress OR remote_egress)
);

INSERT INTO noosphere_hybrid_b.embedding_consent (
  singleton, remote_egress, restricted_remote_egress
) VALUES (true, false, false);

CREATE TABLE noosphere_hybrid_b.profile_backfill_state (
  profile_id uuid PRIMARY KEY REFERENCES noosphere_hybrid.embedding_profile(id) ON DELETE CASCADE,
  generation bigint NOT NULL CHECK (generation >= 1),
  cursor text,
  completed boolean NOT NULL DEFAULT false,
  started_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  completed_at timestamptz,
  CHECK ((completed AND completed_at IS NOT NULL) OR (NOT completed AND completed_at IS NULL))
);

CREATE FUNCTION noosphere_hybrid_b.serialize_eligibility()
RETURNS void
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('noosphere-hybrid-phase-b-eligibility-v1', 0)
  )
$function$;

CREATE FUNCTION noosphere_hybrid_b.structural_manifest()
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
  SELECT pg_catalog.string_agg(evidence.definition, E'\n' ORDER BY evidence.identity)
  FROM evidence
$function$;

CREATE FUNCTION noosphere_hybrid_b.article_write_guard()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  -- This BEFORE trigger acquires the global eligibility lock before A3's AFTER
  -- trigger can touch a job. Provider publication takes the same lock without
  -- taking an Article row lock, avoiding the Article->job/job->Article cycle.
  PERFORM noosphere_hybrid_b.serialize_eligibility();
  RETURN coalesce(NEW, OLD);
END;
$function$;

CREATE FUNCTION noosphere_hybrid_b.profile_article_is_eligible(
  profile_locality noosphere_hybrid.profile_locality,
  article_deleted_at timestamptz,
  article_quarantined_at timestamptz,
  article_restricted_tags text[]
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT
    article_deleted_at IS NULL
    AND article_quarantined_at IS NULL
    AND (
      profile_locality = 'local'::noosphere_hybrid.profile_locality
      OR EXISTS (
        SELECT 1
        FROM noosphere_hybrid_b.embedding_consent AS consent
        WHERE consent.singleton
          AND consent.remote_egress
          AND (
            pg_catalog.cardinality(article_restricted_tags) = 0
            OR consent.restricted_remote_egress
          )
      )
    )
$function$;

CREATE FUNCTION noosphere_hybrid_b.enqueue_article_for_profile(
  target_article_id text,
  target_revision bigint,
  target_profile_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  affected integer;
BEGIN
  INSERT INTO noosphere_hybrid.embedding_job (
    article_id, profile_id, desired_revision, desired_content_hash,
    state, attempt_count, available_at, last_error_code, updated_at
  )
  SELECT
    article.id,
    profile.id,
    target_revision,
    noosphere_hybrid.canonical_hash(
      article.title, article.excerpt, article.content, profile.max_input_bytes
    ),
    'queued'::noosphere_hybrid.job_state,
    0,
    pg_catalog.clock_timestamp(),
    NULL,
    pg_catalog.clock_timestamp()
  FROM public."Article" AS article
  JOIN noosphere_hybrid.embedding_profile AS profile
    ON profile.id = target_profile_id
   AND profile.state IN ('preparing', 'serving')
  WHERE article.id = target_article_id
    AND noosphere_hybrid_b.profile_article_is_eligible(
      profile.locality,
      article."deletedAt",
      article."recallQuarantinedAt",
      article."restrictedTags"
    )
  ON CONFLICT (article_id, profile_id) DO UPDATE
  SET desired_revision = EXCLUDED.desired_revision,
      desired_content_hash = EXCLUDED.desired_content_hash,
      state = CASE
        WHEN noosphere_hybrid.embedding_job.state = 'leased'
          AND noosphere_hybrid.embedding_job.lease_expires_at > pg_catalog.clock_timestamp()
        THEN 'leased'::noosphere_hybrid.job_state
        ELSE 'queued'::noosphere_hybrid.job_state
      END,
      claimed_revision = CASE
        WHEN noosphere_hybrid.embedding_job.state = 'leased'
          AND noosphere_hybrid.embedding_job.lease_expires_at > pg_catalog.clock_timestamp()
        THEN noosphere_hybrid.embedding_job.claimed_revision ELSE NULL END,
      claimed_content_hash = CASE
        WHEN noosphere_hybrid.embedding_job.state = 'leased'
          AND noosphere_hybrid.embedding_job.lease_expires_at > pg_catalog.clock_timestamp()
        THEN noosphere_hybrid.embedding_job.claimed_content_hash ELSE NULL END,
      lease_token = CASE
        WHEN noosphere_hybrid.embedding_job.state = 'leased'
          AND noosphere_hybrid.embedding_job.lease_expires_at > pg_catalog.clock_timestamp()
        THEN noosphere_hybrid.embedding_job.lease_token ELSE NULL END,
      lease_expires_at = CASE
        WHEN noosphere_hybrid.embedding_job.state = 'leased'
          AND noosphere_hybrid.embedding_job.lease_expires_at > pg_catalog.clock_timestamp()
        THEN noosphere_hybrid.embedding_job.lease_expires_at ELSE NULL END,
      lease_generation = CASE
        WHEN noosphere_hybrid.embedding_job.state = 'leased'
          AND noosphere_hybrid.embedding_job.lease_expires_at > pg_catalog.clock_timestamp()
        THEN noosphere_hybrid.embedding_job.lease_generation ELSE 0 END,
      attempt_count = CASE
        WHEN noosphere_hybrid.embedding_job.state = 'leased'
          AND noosphere_hybrid.embedding_job.lease_expires_at > pg_catalog.clock_timestamp()
        -- A3's earlier AFTER trigger preserves the live lease generation but
        -- predates Phase B's durable cap and resets attempt_count. Reconstitute
        -- the invariant here without modifying the exact A3 base. Phase B
        -- increments both counters together on every claim.
        THEN GREATEST(
          noosphere_hybrid.embedding_job.attempt_count::bigint,
          noosphere_hybrid.embedding_job.lease_generation
        )::integer
        ELSE 0 END,
      available_at = CASE
        WHEN noosphere_hybrid.embedding_job.state = 'leased'
          AND noosphere_hybrid.embedding_job.lease_expires_at > pg_catalog.clock_timestamp()
        THEN noosphere_hybrid.embedding_job.available_at
        ELSE pg_catalog.clock_timestamp() END,
      last_error_code = NULL,
      updated_at = pg_catalog.clock_timestamp()
  WHERE noosphere_hybrid.embedding_job.desired_revision IS DISTINCT FROM EXCLUDED.desired_revision
     OR noosphere_hybrid.embedding_job.desired_content_hash IS DISTINCT FROM EXCLUDED.desired_content_hash
     OR noosphere_hybrid.embedding_job.state IN ('failed', 'cancelled')
     OR (
       noosphere_hybrid.embedding_job.state = 'leased'
       AND noosphere_hybrid.embedding_job.lease_expires_at > pg_catalog.clock_timestamp()
       AND noosphere_hybrid.embedding_job.attempt_count
         < noosphere_hybrid.embedding_job.lease_generation
     );

  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected > 0;
END;
$function$;

CREATE FUNCTION noosphere_hybrid_b.enqueue_article(
  target_article_id text,
  target_revision bigint
)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  profile record;
  enqueued integer := 0;
BEGIN
  FOR profile IN
    SELECT id
    FROM noosphere_hybrid.embedding_profile
    WHERE state IN ('preparing', 'serving')
    ORDER BY id
  LOOP
    IF noosphere_hybrid_b.enqueue_article_for_profile(
      target_article_id, target_revision, profile.id
    ) THEN
      enqueued := enqueued + 1;
    END IF;
  END LOOP;
  RETURN enqueued;
END;
$function$;

CREATE FUNCTION noosphere_hybrid_b.article_dirty_trigger()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  current_revision bigint;
BEGIN
  -- The BEFORE guard already owns the eligibility advisory lock. A3 has run
  -- first among AFTER triggers and owns the monotonic revision increment.
  IF NEW."deletedAt" IS NOT NULL OR NEW."recallQuarantinedAt" IS NOT NULL THEN
    RETURN NEW;
  END IF;
  SELECT state.revision INTO current_revision
  FROM noosphere_hybrid.article_embedding_state AS state
  WHERE state.article_id = NEW.id;
  IF current_revision IS NULL THEN
    RAISE EXCEPTION 'article embedding revision state is missing'
      USING ERRCODE = '55000';
  END IF;
  PERFORM noosphere_hybrid_b.enqueue_article(NEW.id, current_revision);
  RETURN NEW;
END;
$function$;

CREATE FUNCTION noosphere_hybrid_b.set_embedding_consent(
  allow_remote_egress boolean,
  allow_restricted_remote_egress boolean
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  previous noosphere_hybrid_b.embedding_consent%ROWTYPE;
BEGIN
  IF allow_restricted_remote_egress AND NOT allow_remote_egress THEN
    RAISE EXCEPTION 'restricted remote egress requires general remote egress consent'
      USING ERRCODE = '22023';
  END IF;
  PERFORM noosphere_hybrid_b.serialize_eligibility();
  SELECT * INTO previous
  FROM noosphere_hybrid_b.embedding_consent
  WHERE singleton
  FOR UPDATE;
  UPDATE noosphere_hybrid_b.embedding_consent
  SET remote_egress = allow_remote_egress,
      restricted_remote_egress = allow_restricted_remote_egress,
      updated_at = pg_catalog.clock_timestamp()
  WHERE singleton;

  IF previous.remote_egress AND NOT allow_remote_egress THEN
    DELETE FROM noosphere_hybrid.article_embedding AS embedding
    USING noosphere_hybrid.embedding_profile AS profile
    WHERE embedding.profile_id = profile.id AND profile.locality = 'remote';
    DELETE FROM noosphere_hybrid.embedding_job AS job
    USING noosphere_hybrid.embedding_profile AS profile
    WHERE job.profile_id = profile.id AND profile.locality = 'remote';
    UPDATE noosphere_hybrid.embedding_profile
    SET state = 'inactive'
    WHERE locality = 'remote' AND state <> 'inactive';
  ELSIF previous.restricted_remote_egress AND NOT allow_restricted_remote_egress THEN
    DELETE FROM noosphere_hybrid.article_embedding AS embedding
    USING noosphere_hybrid.embedding_profile AS profile, public."Article" AS article
    WHERE embedding.profile_id = profile.id
      AND embedding.article_id = article.id
      AND profile.locality = 'remote'
      AND pg_catalog.cardinality(article."restrictedTags") > 0;
    DELETE FROM noosphere_hybrid.embedding_job AS job
    USING noosphere_hybrid.embedding_profile AS profile, public."Article" AS article
    WHERE job.profile_id = profile.id
      AND job.article_id = article.id
      AND profile.locality = 'remote'
      AND pg_catalog.cardinality(article."restrictedTags") > 0;
    UPDATE noosphere_hybrid.embedding_profile
    SET state = 'inactive'
    WHERE locality = 'remote' AND state <> 'inactive';
  ELSIF previous.remote_egress
    AND NOT previous.restricted_remote_egress
    AND allow_restricted_remote_egress THEN
    -- Restricted consent expands the eligible set for every active remote
    -- profile. Serving profiles must leave candidate generation until a fresh
    -- complete backfill proves coverage for that larger set.
    UPDATE noosphere_hybrid.embedding_profile
    SET state = 'preparing'
    WHERE locality = 'remote' AND state IN ('preparing', 'serving');

    INSERT INTO noosphere_hybrid_b.profile_backfill_state (
      profile_id, generation, cursor, completed, started_at, updated_at, completed_at
    )
    SELECT
      profile.id, 1, NULL, false,
      pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(), NULL
    FROM noosphere_hybrid.embedding_profile AS profile
    WHERE profile.locality = 'remote' AND profile.state = 'preparing'
    ON CONFLICT (profile_id) DO UPDATE
    SET generation = noosphere_hybrid_b.profile_backfill_state.generation + 1,
        cursor = NULL,
        completed = false,
        started_at = pg_catalog.clock_timestamp(),
        updated_at = pg_catalog.clock_timestamp(),
        completed_at = NULL;
  END IF;
  PERFORM noosphere_hybrid.bump_search_cache_epoch();
END;
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

CREATE FUNCTION noosphere_hybrid_b.profile_coverage(target_profile_id uuid)
RETURNS TABLE (eligible_count bigint, ready_count bigint, coverage numeric)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  WITH target AS (
    SELECT * FROM noosphere_hybrid.embedding_profile WHERE id = target_profile_id
  ), eligible AS (
    SELECT
      article.id,
      state.revision,
      noosphere_hybrid.canonical_hash(
        article.title, article.excerpt, article.content, target.max_input_bytes
      ) AS content_hash
    FROM target
    JOIN public."Article" AS article ON true
    JOIN noosphere_hybrid.article_embedding_state AS state ON state.article_id = article.id
    WHERE noosphere_hybrid_b.profile_article_is_eligible(
      target.locality,
      article."deletedAt",
      article."recallQuarantinedAt",
      article."restrictedTags"
    )
  ), aggregate AS (
    SELECT
      pg_catalog.count(*) AS eligible_count,
      pg_catalog.count(embedding.article_id) AS ready_count
    FROM eligible
    LEFT JOIN noosphere_hybrid.article_embedding AS embedding
      ON embedding.article_id = eligible.id
     AND embedding.profile_id = target_profile_id
     AND embedding.revision = eligible.revision
     AND embedding.content_hash = eligible.content_hash
  )
  SELECT
    aggregate.eligible_count,
    aggregate.ready_count,
    CASE WHEN aggregate.eligible_count = 0 THEN 1::numeric
      ELSE aggregate.ready_count::numeric / aggregate.eligible_count::numeric END
  FROM aggregate
$function$;

CREATE FUNCTION noosphere_hybrid_b.set_profile_state(
  target_profile_id uuid,
  target_state noosphere_hybrid.profile_state
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  profile noosphere_hybrid.embedding_profile%ROWTYPE;
  profile_coverage numeric;
BEGIN
  PERFORM noosphere_hybrid_b.serialize_eligibility();
  SELECT * INTO profile
  FROM noosphere_hybrid.embedding_profile
  WHERE id = target_profile_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'embedding profile does not exist' USING ERRCODE = 'P0002';
  END IF;

  IF target_state = 'inactive' THEN
    UPDATE noosphere_hybrid.embedding_profile SET state = 'inactive' WHERE id = target_profile_id;
    DELETE FROM noosphere_hybrid.embedding_job WHERE profile_id = target_profile_id;
    RETURN;
  END IF;

  IF target_state = 'preparing' THEN
    IF profile.state <> 'inactive' THEN
      RAISE EXCEPTION 'a profile can enter preparing only from inactive'
        USING ERRCODE = '55000';
    END IF;
    IF profile.locality = 'remote' AND NOT EXISTS (
      SELECT 1 FROM noosphere_hybrid_b.embedding_consent
      WHERE singleton AND remote_egress
    ) THEN
      RAISE EXCEPTION 'remote egress consent is required before preparing a remote profile'
        USING ERRCODE = '55000';
    END IF;
    UPDATE noosphere_hybrid.embedding_profile SET state = 'preparing' WHERE id = target_profile_id;
    INSERT INTO noosphere_hybrid_b.profile_backfill_state (
      profile_id, generation, cursor, completed, started_at, updated_at, completed_at
    ) VALUES (
      target_profile_id, 1, NULL, false,
      pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(), NULL
    )
    ON CONFLICT (profile_id) DO UPDATE
    SET generation = noosphere_hybrid_b.profile_backfill_state.generation + 1,
        cursor = NULL,
        completed = false,
        started_at = pg_catalog.clock_timestamp(),
        updated_at = pg_catalog.clock_timestamp(),
        completed_at = NULL;
    RETURN;
  END IF;

  IF profile.state <> 'preparing' THEN
    RAISE EXCEPTION 'a profile can enter serving only from preparing'
      USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM noosphere_hybrid_b.profile_backfill_state
    WHERE profile_id = target_profile_id AND completed
  ) THEN
    RAISE EXCEPTION 'profile backfill must complete before serving'
      USING ERRCODE = '55000';
  END IF;
  SELECT coverage INTO profile_coverage
  FROM noosphere_hybrid_b.profile_coverage(target_profile_id);
  IF profile_coverage < 0.95 THEN
    RAISE EXCEPTION 'profile coverage % is below the 0.95 serving threshold', profile_coverage
      USING ERRCODE = '55000';
  END IF;
  UPDATE noosphere_hybrid.embedding_profile SET state = 'serving' WHERE id = target_profile_id;
END;
$function$;

CREATE FUNCTION noosphere_hybrid_b.enqueue_profile_backfill(
  target_profile_id uuid,
  chunk_limit integer
)
RETURNS TABLE (
  next_cursor text,
  scanned_count integer,
  enqueued_count integer,
  done boolean
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  profile noosphere_hybrid.embedding_profile%ROWTYPE;
  backfill noosphere_hybrid_b.profile_backfill_state%ROWTYPE;
  candidate record;
  scanned integer := 0;
  enqueued integer := 0;
BEGIN
  IF chunk_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'backfill chunk must be between 1 and 1000' USING ERRCODE = '22023';
  END IF;
  PERFORM noosphere_hybrid_b.serialize_eligibility();
  SELECT * INTO profile
  FROM noosphere_hybrid.embedding_profile
  WHERE id = target_profile_id
  FOR SHARE;
  IF NOT FOUND OR profile.state NOT IN ('preparing', 'serving') THEN
    RAISE EXCEPTION 'backfill requires a preparing or serving profile'
      USING ERRCODE = '55000';
  END IF;
  SELECT * INTO backfill
  FROM noosphere_hybrid_b.profile_backfill_state
  WHERE profile_id = target_profile_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'profile has no durable backfill generation'
      USING ERRCODE = '55000';
  END IF;
  IF backfill.completed THEN
    next_cursor := backfill.cursor;
    scanned_count := 0;
    enqueued_count := 0;
    done := true;
    RETURN NEXT;
    RETURN;
  END IF;

  FOR candidate IN
    SELECT article.id, state.revision
    FROM public."Article" AS article
    JOIN noosphere_hybrid.article_embedding_state AS state ON state.article_id = article.id
    WHERE (backfill.cursor IS NULL OR article.id > backfill.cursor)
      AND noosphere_hybrid_b.profile_article_is_eligible(
        profile.locality,
        article."deletedAt",
        article."recallQuarantinedAt",
        article."restrictedTags"
      )
    ORDER BY article.id
    LIMIT chunk_limit
  LOOP
    scanned := scanned + 1;
    next_cursor := candidate.id;
    IF noosphere_hybrid_b.enqueue_article_for_profile(
      candidate.id, candidate.revision, target_profile_id
    ) THEN
      enqueued := enqueued + 1;
    END IF;
  END LOOP;

  scanned_count := scanned;
  enqueued_count := enqueued;
  done := scanned < chunk_limit;
  UPDATE noosphere_hybrid_b.profile_backfill_state
  SET cursor = coalesce(next_cursor, cursor),
      completed = done,
      updated_at = pg_catalog.clock_timestamp(),
      completed_at = CASE WHEN done THEN pg_catalog.clock_timestamp() ELSE NULL END
  WHERE profile_id = target_profile_id AND generation = backfill.generation;
  RETURN NEXT;
END;
$function$;

CREATE FUNCTION noosphere_hybrid_b.claim_jobs(
  claim_limit integer,
  lease_seconds integer,
  max_attempts integer,
  allowed_profile_ids uuid[]
)
RETURNS TABLE (
  job_id uuid,
  lease_token uuid,
  lease_generation bigint,
  article_id text,
  profile_id uuid,
  claimed_revision bigint,
  claimed_content_hash bytea,
  attempt_count integer,
  provider_protocol text,
  locality text,
  endpoint_identity_sha256 text,
  dimensions integer,
  normalization_policy text,
  model_identifier text,
  model_revision text,
  canonical_document bytea
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  candidate record;
  job noosphere_hybrid.embedding_job%ROWTYPE;
  profile noosphere_hybrid.embedding_profile%ROWTYPE;
  article public."Article"%ROWTYPE;
  claimed_count integer := 0;
BEGIN
  IF claim_limit NOT BETWEEN 1 AND 100
    OR lease_seconds NOT BETWEEN 30 AND 900
    OR max_attempts NOT BETWEEN 1 AND 20
    OR allowed_profile_ids IS NULL
    OR pg_catalog.cardinality(allowed_profile_ids) NOT BETWEEN 1 AND 100
  THEN
    RETURN;
  END IF;
  PERFORM noosphere_hybrid_b.serialize_eligibility();
  UPDATE noosphere_hybrid.embedding_job AS exhausted_job
  SET state = 'failed',
      claimed_revision = NULL,
      claimed_content_hash = NULL,
      lease_token = NULL,
      lease_expires_at = NULL,
      last_error_code = 'lease_expired_max_attempts',
      updated_at = pg_catalog.clock_timestamp()
  WHERE exhausted_job.profile_id = ANY(allowed_profile_ids)
    AND exhausted_job.state = 'leased'
    AND exhausted_job.lease_expires_at <= pg_catalog.clock_timestamp()
    AND exhausted_job.attempt_count >= max_attempts;
  FOR candidate IN
    SELECT candidate_job.id, candidate_job.profile_id
    FROM noosphere_hybrid.embedding_job AS candidate_job
    WHERE candidate_job.available_at <= pg_catalog.clock_timestamp()
      AND candidate_job.profile_id = ANY(allowed_profile_ids)
      AND candidate_job.attempt_count < max_attempts
      AND (
        candidate_job.state = 'queued'
        OR (candidate_job.state = 'leased' AND candidate_job.lease_expires_at <= pg_catalog.clock_timestamp())
      )
    ORDER BY candidate_job.available_at, candidate_job.created_at, candidate_job.id
    LIMIT claim_limit * 4
  LOOP
    EXIT WHEN claimed_count >= claim_limit;
    SELECT * INTO profile
    FROM noosphere_hybrid.embedding_profile
    WHERE id = candidate.profile_id
    FOR SHARE;
    IF NOT FOUND OR profile.state NOT IN ('preparing', 'serving') THEN CONTINUE; END IF;

    SELECT * INTO job
    FROM noosphere_hybrid.embedding_job AS locked_job
    WHERE locked_job.id = candidate.id
      AND locked_job.available_at <= pg_catalog.clock_timestamp()
      AND locked_job.attempt_count < max_attempts
      AND (
        locked_job.state = 'queued'
        OR (locked_job.state = 'leased' AND locked_job.lease_expires_at <= pg_catalog.clock_timestamp())
      )
    FOR UPDATE SKIP LOCKED;
    IF NOT FOUND THEN CONTINUE; END IF;

    SELECT * INTO article FROM public."Article" WHERE id = job.article_id;
    IF NOT FOUND OR NOT noosphere_hybrid_b.profile_article_is_eligible(
      profile.locality, article."deletedAt", article."recallQuarantinedAt", article."restrictedTags"
    ) OR noosphere_hybrid.canonical_hash(
      article.title, article.excerpt, article.content, profile.max_input_bytes
    ) IS DISTINCT FROM job.desired_content_hash THEN
      CONTINUE;
    END IF;

    UPDATE noosphere_hybrid.embedding_job AS claimed_job
    SET state = 'leased',
        claimed_revision = claimed_job.desired_revision,
        claimed_content_hash = claimed_job.desired_content_hash,
        lease_token = pg_catalog.gen_random_uuid(),
        lease_generation = claimed_job.lease_generation + 1,
        lease_expires_at = pg_catalog.clock_timestamp() + pg_catalog.make_interval(secs => lease_seconds),
        attempt_count = claimed_job.attempt_count + 1,
        updated_at = pg_catalog.clock_timestamp()
    WHERE claimed_job.id = job.id
    RETURNING * INTO job;

    job_id := job.id;
    lease_token := job.lease_token;
    lease_generation := job.lease_generation;
    article_id := job.article_id;
    profile_id := job.profile_id;
    claimed_revision := job.claimed_revision;
    claimed_content_hash := job.claimed_content_hash;
    attempt_count := job.attempt_count;
    provider_protocol := profile.provider_protocol;
    locality := profile.locality::text;
    endpoint_identity_sha256 := pg_catalog.encode(profile.endpoint_identity_sha256, 'hex');
    dimensions := profile.dimensions;
    normalization_policy := profile.normalization_policy::text;
    model_identifier := profile.model_identifier;
    model_revision := profile.model_revision;
    canonical_document := noosphere_hybrid.canonical_document(
      article.title, article.excerpt, article.content, profile.max_input_bytes
    );
    claimed_count := claimed_count + 1;
    RETURN NEXT;
  END LOOP;
END;
$function$;

CREATE FUNCTION noosphere_hybrid_b.authorize_dispatch(
  target_job_id uuid,
  target_lease_token uuid,
  target_lease_generation bigint
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  job noosphere_hybrid.embedding_job%ROWTYPE;
  profile noosphere_hybrid.embedding_profile%ROWTYPE;
  article record;
BEGIN
  -- This short transaction is the dispatch linearization point. Eligibility
  -- mutations take the same exclusive lock. The worker commits immediately
  -- after this recheck and only then performs HTTP, so provider latency never
  -- blocks unrelated Article writes.
  PERFORM noosphere_hybrid_b.serialize_eligibility();
  SELECT * INTO job
  FROM noosphere_hybrid.embedding_job
  WHERE id = target_job_id
  FOR SHARE;
  IF NOT FOUND
    OR job.state <> 'leased'
    OR job.lease_token IS DISTINCT FROM target_lease_token
    OR job.lease_generation IS DISTINCT FROM target_lease_generation
    OR job.lease_expires_at <= pg_catalog.clock_timestamp()
    OR job.desired_revision IS DISTINCT FROM job.claimed_revision
    OR job.desired_content_hash IS DISTINCT FROM job.claimed_content_hash
  THEN
    RETURN false;
  END IF;

  SELECT * INTO profile
  FROM noosphere_hybrid.embedding_profile
  WHERE id = job.profile_id;
  SELECT article_record.*, state.revision AS embedding_revision
  INTO article
  FROM public."Article" AS article_record
  JOIN noosphere_hybrid.article_embedding_state AS state
    ON state.article_id = article_record.id
  WHERE article_record.id = job.article_id;

  RETURN FOUND
    AND profile.state IN ('preparing', 'serving')
    AND article.embedding_revision = job.claimed_revision
    AND noosphere_hybrid_b.profile_article_is_eligible(
      profile.locality,
      article."deletedAt",
      article."recallQuarantinedAt",
      article."restrictedTags"
    )
    AND noosphere_hybrid.canonical_hash(
      article.title, article.excerpt, article.content, profile.max_input_bytes
    ) = job.claimed_content_hash;
END;
$function$;

CREATE FUNCTION noosphere_hybrid_b.release_stale_job(
  target_job_id uuid,
  target_lease_token uuid,
  target_lease_generation bigint,
  max_attempts integer
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  affected integer;
BEGIN
  IF max_attempts NOT BETWEEN 1 AND 20 THEN
    RETURN false;
  END IF;
  PERFORM noosphere_hybrid_b.serialize_eligibility();
  UPDATE noosphere_hybrid.embedding_job AS stale_job
  SET state = CASE WHEN stale_job.attempt_count >= max_attempts
        THEN 'failed'::noosphere_hybrid.job_state
        ELSE 'queued'::noosphere_hybrid.job_state END,
      claimed_revision = NULL,
      claimed_content_hash = NULL,
      lease_token = NULL,
      lease_expires_at = NULL,
      available_at = pg_catalog.clock_timestamp(),
      last_error_code = CASE WHEN stale_job.attempt_count >= max_attempts
        THEN 'stale_max_attempts' ELSE stale_job.last_error_code END,
      updated_at = pg_catalog.clock_timestamp()
  WHERE stale_job.id = target_job_id
    AND stale_job.state = 'leased'
    AND stale_job.lease_token = target_lease_token
    AND stale_job.lease_generation = target_lease_generation;
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected = 1;
END;
$function$;

CREATE FUNCTION noosphere_hybrid_b.publish_embedding(
  target_job_id uuid,
  target_lease_token uuid,
  target_lease_generation bigint,
  target_revision bigint,
  target_content_hash bytea,
  target_embedding noosphere_vector.vector
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  initial_job record;
  job noosphere_hybrid.embedding_job%ROWTYPE;
  profile noosphere_hybrid.embedding_profile%ROWTYPE;
  article public."Article"%ROWTYPE;
BEGIN
  PERFORM noosphere_hybrid_b.serialize_eligibility();
  SELECT profile_id INTO initial_job
  FROM noosphere_hybrid.embedding_job WHERE id = target_job_id;
  IF NOT FOUND THEN RETURN false; END IF;

  SELECT * INTO profile
  FROM noosphere_hybrid.embedding_profile
  WHERE id = initial_job.profile_id
  FOR SHARE;
  IF NOT FOUND THEN RETURN false; END IF;

  SELECT * INTO job
  FROM noosphere_hybrid.embedding_job
  WHERE id = target_job_id
  FOR UPDATE;
  IF NOT FOUND
    OR job.state <> 'leased'
    OR job.lease_token IS DISTINCT FROM target_lease_token
    OR job.lease_generation IS DISTINCT FROM target_lease_generation
    OR job.claimed_revision IS DISTINCT FROM target_revision
    OR job.claimed_content_hash IS DISTINCT FROM target_content_hash
    OR job.lease_expires_at <= pg_catalog.clock_timestamp()
  THEN RETURN false; END IF;

  -- A concurrent article or scope mutation may have advanced desired_* while
  -- this provider call still owns the older lease. Release only the stale
  -- claim; the coalesced latest revision must remain queued.
  IF job.desired_revision IS DISTINCT FROM job.claimed_revision
    OR job.desired_content_hash IS DISTINCT FROM job.claimed_content_hash
  THEN
    UPDATE noosphere_hybrid.embedding_job
    SET state = 'queued',
        claimed_revision = NULL,
        claimed_content_hash = NULL,
        lease_token = NULL,
        lease_expires_at = NULL,
        available_at = pg_catalog.clock_timestamp(),
        updated_at = pg_catalog.clock_timestamp()
    WHERE id = target_job_id;
    RETURN false;
  END IF;

  SELECT * INTO article FROM public."Article" WHERE id = job.article_id;
  IF NOT FOUND
    OR profile.state NOT IN ('preparing', 'serving')
    OR NOT noosphere_hybrid_b.profile_article_is_eligible(
      profile.locality, article."deletedAt", article."recallQuarantinedAt", article."restrictedTags"
    )
    OR noosphere_hybrid.canonical_hash(
      article.title, article.excerpt, article.content, profile.max_input_bytes
    ) IS DISTINCT FROM target_content_hash
  THEN
    DELETE FROM noosphere_hybrid.embedding_job WHERE id = target_job_id;
    RETURN false;
  END IF;

  IF noosphere_vector.vector_dims(target_embedding) <> profile.dimensions
    OR NOT noosphere_hybrid.vector_is_finite(target_embedding)
  THEN
    UPDATE noosphere_hybrid.embedding_job
    SET state = 'cancelled',
        claimed_revision = NULL,
        claimed_content_hash = NULL,
        lease_token = NULL,
        lease_expires_at = NULL,
        updated_at = pg_catalog.clock_timestamp()
    WHERE id = target_job_id;
    RETURN false;
  END IF;

  INSERT INTO noosphere_hybrid.article_embedding (
    article_id, profile_id, revision, content_hash, dimensions, embedding
  ) VALUES (
    job.article_id, job.profile_id, target_revision, target_content_hash,
    profile.dimensions, target_embedding
  )
  ON CONFLICT (article_id, profile_id) DO UPDATE
  SET revision = EXCLUDED.revision,
      content_hash = EXCLUDED.content_hash,
      dimensions = EXCLUDED.dimensions,
      embedding = EXCLUDED.embedding,
      ready_at = pg_catalog.clock_timestamp();
  DELETE FROM noosphere_hybrid.embedding_job WHERE id = target_job_id;
  RETURN true;
END;
$function$;

CREATE FUNCTION noosphere_hybrid_b.fail_job(
  target_job_id uuid,
  target_lease_token uuid,
  target_lease_generation bigint,
  error_code text,
  retry_at timestamptz,
  terminal boolean
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  PERFORM noosphere_hybrid_b.serialize_eligibility();
  RETURN noosphere_hybrid.fail_job(
    target_job_id,
    target_lease_token,
    target_lease_generation,
    error_code,
    retry_at,
    terminal
  );
END;
$function$;

CREATE FUNCTION noosphere_hybrid_b.queue_health()
RETURNS TABLE (
  pending_depth bigint,
  oldest_pending_age_seconds bigint,
  leased_count bigint,
  failed_count bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT
    pg_catalog.count(*) FILTER (
      WHERE state = 'queued'
         OR (state = 'leased' AND lease_expires_at <= pg_catalog.statement_timestamp())
    ),
    coalesce(pg_catalog.date_part('epoch', (
      pg_catalog.statement_timestamp() - pg_catalog.min(created_at) FILTER (
        WHERE state = 'queued'
           OR (state = 'leased' AND lease_expires_at <= pg_catalog.statement_timestamp())
      )
    ))::bigint, 0),
    pg_catalog.count(*) FILTER (
      WHERE state = 'leased' AND lease_expires_at > pg_catalog.statement_timestamp()
    ),
    pg_catalog.count(*) FILTER (WHERE state = 'failed')
  FROM noosphere_hybrid.embedding_job
$function$;

CREATE FUNCTION noosphere_hybrid_b.worker_readiness()
RETURNS TABLE (feature_version integer, active_profiles integer, active_profile_ids uuid[])
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT
    state.feature_version,
    (SELECT pg_catalog.count(*)::integer
     FROM noosphere_hybrid.embedding_profile
     WHERE state IN ('preparing', 'serving')),
    (SELECT coalesce(pg_catalog.array_agg(id ORDER BY id), ARRAY[]::uuid[])
     FROM noosphere_hybrid.embedding_profile
     WHERE state IN ('preparing', 'serving'))
  FROM noosphere_hybrid_b.feature_state AS state
  WHERE state.singleton
$function$;

CREATE FUNCTION noosphere_hybrid_b.profile_status(target_profile_id uuid)
RETURNS TABLE (
  profile_id uuid,
  profile_state text,
  profile_locality text,
  backfill_generation bigint,
  backfill_completed boolean,
  eligible_count bigint,
  ready_count bigint,
  coverage numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT
    profile.id,
    profile.state::text,
    profile.locality::text,
    backfill.generation,
    coalesce(backfill.completed, false),
    metrics.eligible_count,
    metrics.ready_count,
    metrics.coverage
  FROM noosphere_hybrid.embedding_profile AS profile
  CROSS JOIN LATERAL noosphere_hybrid_b.profile_coverage(profile.id) AS metrics
  LEFT JOIN noosphere_hybrid_b.profile_backfill_state AS backfill
    ON backfill.profile_id = profile.id
  WHERE profile.id = target_profile_id
$function$;
