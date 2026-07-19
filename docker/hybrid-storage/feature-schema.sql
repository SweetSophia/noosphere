-- Phase A3 optional hybrid-storage schema.
--
-- This file is included by activate.sql while the session is SET ROLE
-- noosphere_hybrid_owner. It must never be run directly: activate.sql owns the
-- privileged extension provisioning, exact-state checks, public-table trigger
-- attachment, grants, and steady-state privilege teardown.

CREATE TYPE noosphere_hybrid.profile_locality AS ENUM ('local', 'remote');
CREATE TYPE noosphere_hybrid.profile_state AS ENUM ('inactive', 'preparing', 'serving');
CREATE TYPE noosphere_hybrid.distance_metric AS ENUM ('cosine', 'l2', 'inner_product');
CREATE TYPE noosphere_hybrid.normalization_policy AS ENUM ('none', 'l2');
CREATE TYPE noosphere_hybrid.job_state AS ENUM ('queued', 'leased', 'failed', 'cancelled');

CREATE TABLE noosphere_hybrid.feature_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  feature_version integer NOT NULL CHECK (feature_version = 1),
  provenance_kind text NOT NULL CHECK (provenance_kind IN ('bundled', 'external')),
  source_url text NOT NULL,
  source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[a-f0-9]{64}$'),
  pgvector_version text NOT NULL,
  spdx_identifier text NOT NULL,
  built_image_digest text NOT NULL,
  activation_sql_sha256 text NOT NULL CHECK (activation_sql_sha256 ~ '^[a-f0-9]{64}$'),
  public_schema_fingerprint text NOT NULL CHECK (public_schema_fingerprint ~ '^[a-f0-9]{64}$'),
  worker_eligibility_sha256 text NOT NULL CHECK (worker_eligibility_sha256 ~ '^[a-f0-9]{64}$'),
  trigger_manifest_sha256 text NOT NULL CHECK (trigger_manifest_sha256 ~ '^[a-f0-9]{64}$'),
  routine_manifest_sha256 text NOT NULL CHECK (routine_manifest_sha256 ~ '^[a-f0-9]{64}$'),
  activated_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp()
);

CREATE TABLE noosphere_hybrid.search_cache_epoch (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  epoch bigint NOT NULL CHECK (epoch >= 1)
);

INSERT INTO noosphere_hybrid.search_cache_epoch (singleton, epoch)
VALUES (true, 1);

CREATE TABLE noosphere_hybrid.embedding_profile (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  provider_protocol text NOT NULL CHECK (provider_protocol IN ('openai-compatible')),
  locality noosphere_hybrid.profile_locality NOT NULL,
  model_identifier text NOT NULL CHECK (model_identifier = pg_catalog.btrim(model_identifier) AND model_identifier <> ''),
  model_revision text NOT NULL CHECK (model_revision = pg_catalog.btrim(model_revision) AND model_revision <> ''),
  dimensions integer NOT NULL CHECK (dimensions BETWEEN 1 AND 16000),
  distance_metric noosphere_hybrid.distance_metric NOT NULL,
  normalization_policy noosphere_hybrid.normalization_policy NOT NULL,
  document_schema_version text NOT NULL CHECK (document_schema_version = 'noosphere-article-v1'),
  document_normalization text NOT NULL CHECK (
    document_normalization = 'NFKC;CRLF_CR_TO_LF;FINAL_LF;UTF8_CODEPOINT_PREFIX'
  ),
  max_input_bytes integer NOT NULL CHECK (max_input_bytes BETWEEN 1 AND 1048576),
  endpoint_identity_sha256 bytea NOT NULL CHECK (pg_catalog.octet_length(endpoint_identity_sha256) = 32),
  state noosphere_hybrid.profile_state NOT NULL DEFAULT 'inactive',
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  UNIQUE (id, dimensions)
);

CREATE TABLE noosphere_hybrid.article_embedding_state (
  article_id text PRIMARY KEY
    REFERENCES public."Article"(id) ON DELETE CASCADE,
  revision bigint NOT NULL CHECK (revision >= 1),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp()
);

CREATE TABLE noosphere_hybrid.embedding_job (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  article_id text NOT NULL
    REFERENCES public."Article"(id) ON DELETE CASCADE,
  profile_id uuid NOT NULL
    REFERENCES noosphere_hybrid.embedding_profile(id) ON DELETE CASCADE,
  desired_revision bigint NOT NULL CHECK (desired_revision >= 1),
  desired_content_hash bytea NOT NULL CHECK (pg_catalog.octet_length(desired_content_hash) = 32),
  claimed_revision bigint,
  claimed_content_hash bytea,
  lease_token uuid,
  lease_generation bigint NOT NULL DEFAULT 0 CHECK (lease_generation >= 0),
  state noosphere_hybrid.job_state NOT NULL DEFAULT 'queued',
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  available_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  lease_expires_at timestamptz,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  UNIQUE (article_id, profile_id),
  CHECK (
    (
      state = 'leased'
      AND claimed_revision IS NOT NULL
      AND claimed_content_hash IS NOT NULL
      AND pg_catalog.octet_length(claimed_content_hash) = 32
      AND lease_token IS NOT NULL
      AND lease_expires_at IS NOT NULL
    )
    OR
    (
      state <> 'leased'
      AND claimed_revision IS NULL
      AND claimed_content_hash IS NULL
      AND lease_token IS NULL
      AND lease_expires_at IS NULL
    )
  )
);

CREATE INDEX embedding_job_claim_idx
  ON noosphere_hybrid.embedding_job (available_at, created_at, id)
  WHERE state IN ('queued', 'leased');

CREATE TABLE noosphere_hybrid.article_embedding (
  article_id text NOT NULL
    REFERENCES public."Article"(id) ON DELETE CASCADE,
  profile_id uuid NOT NULL,
  revision bigint NOT NULL CHECK (revision >= 1),
  content_hash bytea NOT NULL CHECK (pg_catalog.octet_length(content_hash) = 32),
  dimensions integer NOT NULL,
  embedding noosphere_vector.vector NOT NULL,
  ready_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  PRIMARY KEY (article_id, profile_id),
  FOREIGN KEY (profile_id, dimensions)
    REFERENCES noosphere_hybrid.embedding_profile(id, dimensions) ON DELETE CASCADE,
  CHECK (noosphere_vector.vector_dims(embedding) = dimensions)
);

CREATE FUNCTION noosphere_hybrid.truncate_utf8_prefix(
  input_text text,
  max_bytes integer
)
RETURNS bytea
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  low integer := 0;
  high integer := pg_catalog.char_length(input_text);
  midpoint integer;
  candidate text;
BEGIN
  IF max_bytes < 0 THEN
    RAISE EXCEPTION 'max_bytes must be non-negative' USING ERRCODE = '22023';
  END IF;

  WHILE low < high LOOP
    midpoint := (low + high + 1) / 2;
    candidate := pg_catalog.substr(input_text, 1, midpoint);
    IF pg_catalog.octet_length(pg_catalog.convert_to(candidate, 'UTF8')) <= max_bytes THEN
      low := midpoint;
    ELSE
      high := midpoint - 1;
    END IF;
  END LOOP;

  RETURN pg_catalog.convert_to(pg_catalog.substr(input_text, 1, low), 'UTF8');
END;
$function$;

CREATE FUNCTION noosphere_hybrid.canonical_document(
  article_title text,
  article_excerpt text,
  article_content text,
  max_bytes integer
)
RETURNS bytea
LANGUAGE plpgsql
IMMUTABLE
SECURITY DEFINER
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  serialized text;
BEGIN
  IF max_bytes < 1 OR max_bytes > 1048576 THEN
    RAISE EXCEPTION 'max_bytes is outside the Phase A3 profile bound'
      USING ERRCODE = '22023';
  END IF;

  serialized :=
    'noosphere-article-v1' || chr(10) ||
    'TITLE' || chr(10) ||
    replace(replace(normalize(coalesce(article_title, ''), NFKC), chr(13) || chr(10), chr(10)), chr(13), chr(10)) || chr(10) ||
    'EXCERPT' || chr(10) ||
    replace(replace(normalize(coalesce(article_excerpt, ''), NFKC), chr(13) || chr(10), chr(10)), chr(13), chr(10)) || chr(10) ||
    'CONTENT' || chr(10) ||
    replace(replace(normalize(coalesce(article_content, ''), NFKC), chr(13) || chr(10), chr(10)), chr(13), chr(10)) || chr(10);

  RETURN noosphere_hybrid.truncate_utf8_prefix(serialized, max_bytes);
END;
$function$;

CREATE FUNCTION noosphere_hybrid.canonical_hash(
  article_title text,
  article_excerpt text,
  article_content text,
  max_bytes integer
)
RETURNS bytea
LANGUAGE sql
IMMUTABLE
SECURITY DEFINER
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
RETURN noosphere_crypto.digest(
  noosphere_hybrid.canonical_document(article_title, article_excerpt, article_content, max_bytes),
  'sha256'
);

CREATE FUNCTION noosphere_hybrid.vector_is_finite(input_vector noosphere_vector.vector)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
RETURN NOT EXISTS (
  SELECT 1
  FROM pg_catalog.unnest(input_vector::real[]) AS component(value)
  WHERE value::text IN ('NaN', 'Infinity', '-Infinity')
);

ALTER TABLE noosphere_hybrid.article_embedding
  ADD CONSTRAINT article_embedding_finite_check
  CHECK (noosphere_hybrid.vector_is_finite(embedding));

CREATE FUNCTION noosphere_hybrid.bump_search_cache_epoch()
RETURNS bigint
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  UPDATE noosphere_hybrid.search_cache_epoch
  SET epoch = epoch + 1
  WHERE singleton
  RETURNING epoch
$function$;

CREATE FUNCTION noosphere_hybrid.cache_epoch_trigger()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  PERFORM noosphere_hybrid.bump_search_cache_epoch();
  RETURN NULL;
END;
$function$;

CREATE FUNCTION noosphere_hybrid.profile_identity_guard()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF NEW.provider_protocol IS DISTINCT FROM OLD.provider_protocol
    OR NEW.locality IS DISTINCT FROM OLD.locality
    OR NEW.model_identifier IS DISTINCT FROM OLD.model_identifier
    OR NEW.model_revision IS DISTINCT FROM OLD.model_revision
    OR NEW.dimensions IS DISTINCT FROM OLD.dimensions
    OR NEW.distance_metric IS DISTINCT FROM OLD.distance_metric
    OR NEW.normalization_policy IS DISTINCT FROM OLD.normalization_policy
    OR NEW.document_schema_version IS DISTINCT FROM OLD.document_schema_version
    OR NEW.document_normalization IS DISTINCT FROM OLD.document_normalization
    OR NEW.max_input_bytes IS DISTINCT FROM OLD.max_input_bytes
    OR NEW.endpoint_identity_sha256 IS DISTINCT FROM OLD.endpoint_identity_sha256
  THEN
    RAISE EXCEPTION 'embedding profile identity is immutable'
      USING ERRCODE = '55000';
  END IF;

  NEW.updated_at := pg_catalog.clock_timestamp();
  RETURN NEW;
END;
$function$;

CREATE TRIGGER embedding_profile_identity_guard
BEFORE UPDATE ON noosphere_hybrid.embedding_profile
FOR EACH ROW EXECUTE FUNCTION noosphere_hybrid.profile_identity_guard();

CREATE TRIGGER embedding_profile_epoch
AFTER INSERT OR UPDATE OR DELETE ON noosphere_hybrid.embedding_profile
FOR EACH STATEMENT EXECUTE FUNCTION noosphere_hybrid.cache_epoch_trigger();

CREATE TRIGGER article_embedding_epoch
AFTER INSERT OR UPDATE OR DELETE ON noosphere_hybrid.article_embedding
FOR EACH STATEMENT EXECUTE FUNCTION noosphere_hybrid.cache_epoch_trigger();

CREATE FUNCTION noosphere_hybrid.enqueue_article(
  target_article_id text,
  target_revision bigint
)
RETURNS void
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  INSERT INTO noosphere_hybrid.embedding_job (
    article_id,
    profile_id,
    desired_revision,
    desired_content_hash,
    state,
    attempt_count,
    available_at,
    last_error_code,
    updated_at
  )
  SELECT
    article.id,
    profile.id,
    target_revision,
    noosphere_hybrid.canonical_hash(
      article.title,
      article.excerpt,
      article.content,
      profile.max_input_bytes
    ),
    'queued'::noosphere_hybrid.job_state,
    0,
    pg_catalog.clock_timestamp(),
    NULL,
    pg_catalog.clock_timestamp()
  FROM public."Article" AS article
  JOIN noosphere_hybrid.embedding_profile AS profile
    ON profile.state IN ('preparing', 'serving')
   AND profile.locality = 'local'
  WHERE article.id = target_article_id
    AND article."deletedAt" IS NULL
    AND article."recallQuarantinedAt" IS NULL
  ON CONFLICT (article_id, profile_id) DO UPDATE
  SET
    desired_revision = EXCLUDED.desired_revision,
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
      THEN noosphere_hybrid.embedding_job.claimed_revision
      ELSE NULL
    END,
    claimed_content_hash = CASE
      WHEN noosphere_hybrid.embedding_job.state = 'leased'
        AND noosphere_hybrid.embedding_job.lease_expires_at > pg_catalog.clock_timestamp()
      THEN noosphere_hybrid.embedding_job.claimed_content_hash
      ELSE NULL
    END,
    lease_token = CASE
      WHEN noosphere_hybrid.embedding_job.state = 'leased'
        AND noosphere_hybrid.embedding_job.lease_expires_at > pg_catalog.clock_timestamp()
      THEN noosphere_hybrid.embedding_job.lease_token
      ELSE NULL
    END,
    lease_expires_at = CASE
      WHEN noosphere_hybrid.embedding_job.state = 'leased'
        AND noosphere_hybrid.embedding_job.lease_expires_at > pg_catalog.clock_timestamp()
      THEN noosphere_hybrid.embedding_job.lease_expires_at
      ELSE NULL
    END,
    attempt_count = 0,
    available_at = pg_catalog.clock_timestamp(),
    last_error_code = NULL,
    updated_at = pg_catalog.clock_timestamp()
  WHERE noosphere_hybrid.embedding_job.desired_revision IS DISTINCT FROM EXCLUDED.desired_revision
     OR noosphere_hybrid.embedding_job.desired_content_hash IS DISTINCT FROM EXCLUDED.desired_content_hash
$function$;

CREATE FUNCTION noosphere_hybrid.article_dirty_trigger()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  next_revision bigint;
  relevant_change boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO noosphere_hybrid.article_embedding_state (article_id, revision)
    VALUES (NEW.id, 1)
    ON CONFLICT (article_id) DO NOTHING
    RETURNING revision INTO next_revision;

    IF next_revision IS NULL THEN
      SELECT state.revision INTO next_revision
      FROM noosphere_hybrid.article_embedding_state AS state
      WHERE state.article_id = NEW.id;
    END IF;

    IF NEW."deletedAt" IS NULL AND NEW."recallQuarantinedAt" IS NULL THEN
      PERFORM noosphere_hybrid.enqueue_article(NEW.id, next_revision);
    END IF;
    RETURN NEW;
  END IF;

  relevant_change :=
    NEW.title IS DISTINCT FROM OLD.title
    OR NEW.excerpt IS DISTINCT FROM OLD.excerpt
    OR NEW.content IS DISTINCT FROM OLD.content
    OR NEW."deletedAt" IS DISTINCT FROM OLD."deletedAt"
    OR NEW."recallQuarantinedAt" IS DISTINCT FROM OLD."recallQuarantinedAt"
    OR NEW."restrictedTags" IS DISTINCT FROM OLD."restrictedTags";

  IF NOT relevant_change THEN
    RETURN NEW;
  END IF;

  INSERT INTO noosphere_hybrid.article_embedding_state (article_id, revision)
  VALUES (NEW.id, 1)
  ON CONFLICT (article_id) DO UPDATE
  SET revision = noosphere_hybrid.article_embedding_state.revision + 1,
      updated_at = pg_catalog.clock_timestamp()
  RETURNING revision INTO next_revision;

  IF NEW."deletedAt" IS NOT NULL OR NEW."recallQuarantinedAt" IS NOT NULL THEN
    DELETE FROM noosphere_hybrid.article_embedding WHERE article_id = NEW.id;
    DELETE FROM noosphere_hybrid.embedding_job WHERE article_id = NEW.id;
    RETURN NEW;
  END IF;

  -- A scope transition invalidates every remote artifact in Phase A3. Remote
  -- dispatch remains unreachable until Phase B adds dynamic consent.
  IF NEW."restrictedTags" IS DISTINCT FROM OLD."restrictedTags" THEN
    DELETE FROM noosphere_hybrid.article_embedding AS embedding
    USING noosphere_hybrid.embedding_profile AS profile
    WHERE embedding.article_id = NEW.id
      AND embedding.profile_id = profile.id
      AND profile.locality = 'remote';
    DELETE FROM noosphere_hybrid.embedding_job AS job
    USING noosphere_hybrid.embedding_profile AS profile
    WHERE job.article_id = NEW.id
      AND job.profile_id = profile.id
      AND profile.locality = 'remote';
  END IF;

  PERFORM noosphere_hybrid.enqueue_article(NEW.id, next_revision);
  RETURN NEW;
END;
$function$;

CREATE FUNCTION noosphere_hybrid.create_profile(
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
DECLARE
  profile_id uuid;
BEGIN
  INSERT INTO noosphere_hybrid.embedding_profile (
    provider_protocol,
    locality,
    model_identifier,
    model_revision,
    dimensions,
    distance_metric,
    normalization_policy,
    document_schema_version,
    document_normalization,
    max_input_bytes,
    endpoint_identity_sha256,
    state
  )
  VALUES (
    provider_protocol_arg,
    locality_arg,
    model_identifier_arg,
    model_revision_arg,
    dimensions_arg,
    distance_metric_arg,
    normalization_policy_arg,
    'noosphere-article-v1',
    'NFKC;CRLF_CR_TO_LF;FINAL_LF;UTF8_CODEPOINT_PREFIX',
    max_input_bytes_arg,
    endpoint_identity_sha256_arg,
    'inactive'
  )
  RETURNING id INTO profile_id;

  RETURN profile_id;
END;
$function$;

CREATE FUNCTION noosphere_hybrid.set_profile_state(
  target_profile_id uuid,
  target_state noosphere_hybrid.profile_state
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF target_state <> 'inactive' THEN
    RAISE EXCEPTION 'preparing and serving are unavailable until Phase B installs worker, consent, readiness, and backfill gates'
      USING ERRCODE = '55000';
  END IF;

  UPDATE noosphere_hybrid.embedding_profile
  SET state = 'inactive'
  WHERE id = target_profile_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'embedding profile does not exist' USING ERRCODE = 'P0002';
  END IF;

  UPDATE noosphere_hybrid.embedding_job
  SET state = 'cancelled',
      claimed_revision = NULL,
      claimed_content_hash = NULL,
      lease_token = NULL,
      lease_expires_at = NULL,
      updated_at = pg_catalog.clock_timestamp()
  WHERE profile_id = target_profile_id
    AND state <> 'cancelled';
END;
$function$;

CREATE VIEW noosphere_hybrid.worker_eligibility
WITH (security_barrier = true, security_invoker = false)
AS
SELECT
  job.id AS job_id,
  job.article_id,
  job.profile_id,
  job.desired_revision,
  job.desired_content_hash,
  profile.dimensions,
  profile.model_identifier,
  profile.model_revision,
  noosphere_hybrid.canonical_document(
    article.title,
    article.excerpt,
    article.content,
    profile.max_input_bytes
  ) AS canonical_document
FROM noosphere_hybrid.embedding_job AS job
JOIN noosphere_hybrid.embedding_profile AS profile ON profile.id = job.profile_id
JOIN public."Article" AS article ON article.id = job.article_id
WHERE profile.state IN ('preparing', 'serving')
  AND profile.locality = 'local'
  AND article."deletedAt" IS NULL
  AND article."recallQuarantinedAt" IS NULL
  AND noosphere_hybrid.canonical_hash(
    article.title,
    article.excerpt,
    article.content,
    profile.max_input_bytes
  ) = job.desired_content_hash;

CREATE FUNCTION noosphere_hybrid.claim_jobs(
  claim_limit integer,
  lease_seconds integer
)
RETURNS TABLE (
  job_id uuid,
  lease_token uuid,
  lease_generation bigint,
  article_id text,
  profile_id uuid,
  claimed_revision bigint,
  claimed_content_hash bytea,
  dimensions integer,
  model_identifier text,
  model_revision text,
  canonical_document bytea
)
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  WITH claimable AS (
    SELECT job.id
    FROM noosphere_hybrid.embedding_job AS job
    JOIN noosphere_hybrid.worker_eligibility AS eligible ON eligible.job_id = job.id
    WHERE (
        job.state = 'queued'
        OR (job.state = 'leased' AND job.lease_expires_at <= pg_catalog.clock_timestamp())
      )
      AND job.available_at <= pg_catalog.clock_timestamp()
    ORDER BY job.available_at, job.created_at, job.id
    FOR UPDATE OF job SKIP LOCKED
    LIMIT CASE WHEN claim_limit BETWEEN 1 AND 100 THEN claim_limit ELSE 0 END
  ),
  claimed AS (
    UPDATE noosphere_hybrid.embedding_job AS job
    SET state = 'leased',
        claimed_revision = job.desired_revision,
        claimed_content_hash = job.desired_content_hash,
        lease_token = pg_catalog.gen_random_uuid(),
        lease_generation = job.lease_generation + 1,
        lease_expires_at = pg_catalog.clock_timestamp() + pg_catalog.make_interval(secs => lease_seconds),
        attempt_count = job.attempt_count + 1,
        updated_at = pg_catalog.clock_timestamp()
    FROM claimable
    WHERE job.id = claimable.id
      AND lease_seconds BETWEEN 1 AND 3600
    RETURNING job.*
  )
  SELECT
    claimed.id,
    claimed.lease_token,
    claimed.lease_generation,
    claimed.article_id,
    claimed.profile_id,
    claimed.claimed_revision,
    claimed.claimed_content_hash,
    eligible.dimensions,
    eligible.model_identifier,
    eligible.model_revision,
    eligible.canonical_document
  FROM claimed
  JOIN noosphere_hybrid.worker_eligibility AS eligible ON eligible.job_id = claimed.id
$function$;

CREATE FUNCTION noosphere_hybrid.publish_embedding(
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
  locked_job noosphere_hybrid.embedding_job%ROWTYPE;
  profile_dimensions integer;
BEGIN
  SELECT * INTO locked_job
  FROM noosphere_hybrid.embedding_job AS job
  WHERE job.id = target_job_id
  FOR UPDATE;

  IF NOT FOUND
    OR locked_job.state <> 'leased'
    OR locked_job.lease_token IS DISTINCT FROM target_lease_token
    OR locked_job.lease_generation IS DISTINCT FROM target_lease_generation
    OR locked_job.claimed_revision IS DISTINCT FROM target_revision
    OR locked_job.claimed_content_hash IS DISTINCT FROM target_content_hash
    OR locked_job.lease_expires_at <= pg_catalog.clock_timestamp()
  THEN
    RETURN false;
  END IF;

  -- A write while the provider call was in flight leaves desired_* newer than
  -- claimed_*. The stale completion may only release the lease.
  IF locked_job.desired_revision IS DISTINCT FROM locked_job.claimed_revision
    OR locked_job.desired_content_hash IS DISTINCT FROM locked_job.claimed_content_hash
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

  SELECT eligible.dimensions INTO profile_dimensions
  FROM noosphere_hybrid.worker_eligibility AS eligible
  WHERE eligible.job_id = target_job_id
    AND eligible.desired_revision = target_revision
    AND eligible.desired_content_hash = target_content_hash;

  IF profile_dimensions IS NULL
    OR noosphere_vector.vector_dims(target_embedding) <> profile_dimensions
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
    article_id,
    profile_id,
    revision,
    content_hash,
    dimensions,
    embedding
  )
  VALUES (
    locked_job.article_id,
    locked_job.profile_id,
    target_revision,
    target_content_hash,
    profile_dimensions,
    target_embedding
  )
  ON CONFLICT (article_id, profile_id) DO UPDATE
  SET revision = EXCLUDED.revision,
      content_hash = EXCLUDED.content_hash,
      dimensions = EXCLUDED.dimensions,
      embedding = EXCLUDED.embedding,
      ready_at = pg_catalog.clock_timestamp();

  DELETE FROM noosphere_hybrid.embedding_job
  WHERE id = target_job_id
    AND lease_token = target_lease_token
    AND lease_generation = target_lease_generation;

  RETURN FOUND;
END;
$function$;

CREATE FUNCTION noosphere_hybrid.fail_job(
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
DECLARE
  locked_job noosphere_hybrid.embedding_job%ROWTYPE;
BEGIN
  SELECT * INTO locked_job
  FROM noosphere_hybrid.embedding_job AS job
  WHERE job.id = target_job_id
  FOR UPDATE;

  IF NOT FOUND
    OR locked_job.state <> 'leased'
    OR locked_job.lease_token IS DISTINCT FROM target_lease_token
    OR locked_job.lease_generation IS DISTINCT FROM target_lease_generation
    OR locked_job.lease_expires_at <= pg_catalog.clock_timestamp()
  THEN
    RETURN false;
  END IF;

  UPDATE noosphere_hybrid.embedding_job
  SET state = CASE
        WHEN desired_revision IS DISTINCT FROM claimed_revision
          OR desired_content_hash IS DISTINCT FROM claimed_content_hash
        THEN 'queued'::noosphere_hybrid.job_state
        WHEN terminal THEN 'failed'::noosphere_hybrid.job_state
        ELSE 'queued'::noosphere_hybrid.job_state
      END,
      claimed_revision = NULL,
      claimed_content_hash = NULL,
      lease_token = NULL,
      lease_expires_at = NULL,
      available_at = CASE
        WHEN desired_revision IS DISTINCT FROM claimed_revision
          OR desired_content_hash IS DISTINCT FROM claimed_content_hash
        THEN pg_catalog.clock_timestamp()
        ELSE retry_at
      END,
      last_error_code = pg_catalog.left(coalesce(error_code, 'unknown'), 64),
      attempt_count = CASE
        WHEN desired_revision IS DISTINCT FROM claimed_revision
          OR desired_content_hash IS DISTINCT FROM claimed_content_hash
        THEN 0
        ELSE attempt_count
      END,
      updated_at = pg_catalog.clock_timestamp()
  WHERE id = target_job_id;

  RETURN true;
END;
$function$;

INSERT INTO noosphere_hybrid.article_embedding_state (article_id, revision)
SELECT article.id, 1
FROM public."Article" AS article
ON CONFLICT (article_id) DO NOTHING;
