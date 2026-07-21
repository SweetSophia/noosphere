-- Phase C exact hybrid-retrieval capability layer. Included by
-- activate-phase-c.sql while SET ROLE noosphere_hybrid_owner is active.
-- The application receives EXECUTE on four content-free routines only; it
-- never receives direct access to vectors, consent rows, or feature metadata.

CREATE TABLE noosphere_hybrid_c.feature_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  feature_version integer NOT NULL CHECK (feature_version = 1),
  a3_source_sha256 text NOT NULL CHECK (a3_source_sha256 ~ '^[a-f0-9]{64}$'),
  phase_b_source_sha256 text NOT NULL CHECK (phase_b_source_sha256 ~ '^[a-f0-9]{64}$'),
  source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[a-f0-9]{64}$'),
  manifest_sha256 text NOT NULL CHECK (manifest_sha256 ~ '^[a-f0-9]{64}$'),
  structure_sha256 text NOT NULL CHECK (structure_sha256 ~ '^[a-f0-9]{64}$'),
  activated_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp()
);

-- Exact coverage is incrementally materialized on the write side. Hybrid
-- searches are far more frequent than corpus mutations, and calculating the
-- canonical hash for every eligible Article on every query is O(corpus size).
-- One owner-only membership row represents each eligible profile/article pair;
-- statement-level delta triggers maintain constant-size profile counters.
CREATE TABLE noosphere_hybrid_c.profile_coverage_snapshot (
  profile_id uuid PRIMARY KEY
    REFERENCES noosphere_hybrid.embedding_profile(id) ON DELETE CASCADE,
  eligible_count bigint NOT NULL CHECK (eligible_count >= 0),
  ready_count bigint NOT NULL CHECK (ready_count >= 0 AND ready_count <= eligible_count),
  coverage numeric GENERATED ALWAYS AS (
    CASE WHEN eligible_count = 0 THEN 1::numeric
      ELSE ready_count::numeric / eligible_count::numeric END
  ) STORED,
  refreshed_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp()
);

CREATE TABLE noosphere_hybrid_c.profile_coverage_member (
  profile_id uuid NOT NULL
    REFERENCES noosphere_hybrid.embedding_profile(id) ON DELETE CASCADE,
  article_id text NOT NULL REFERENCES public."Article"(id) ON DELETE CASCADE,
  ready boolean NOT NULL,
  PRIMARY KEY (profile_id, article_id)
);

CREATE FUNCTION noosphere_hybrid_c.structural_manifest()
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
    WHERE namespace.nspname = 'noosphere_hybrid_c'
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
    WHERE namespace.nspname = 'noosphere_hybrid_c'

    UNION ALL

    SELECT
      pg_catalog.format('index:%s.%s:%s', namespace.nspname, relation.relname, index_relation.relname),
      pg_catalog.pg_get_indexdef(index_relation.oid, 0, false)
    FROM pg_catalog.pg_index AS index_record
    JOIN pg_catalog.pg_class AS relation ON relation.oid = index_record.indrelid
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    JOIN pg_catalog.pg_class AS index_relation ON index_relation.oid = index_record.indexrelid
    WHERE namespace.nspname = 'noosphere_hybrid_c'

    UNION ALL

    SELECT
      pg_catalog.format(
        'trigger:%s.%s:%s', namespace.nspname, relation.relname, trigger_record.tgname
      ),
      pg_catalog.format(
        'enabled=%s|%s',
        trigger_record.tgenabled,
        pg_catalog.pg_get_triggerdef(trigger_record.oid, false)
      )
    FROM pg_catalog.pg_trigger AS trigger_record
    JOIN pg_catalog.pg_class AS relation ON relation.oid = trigger_record.tgrelid
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    JOIN pg_catalog.pg_proc AS procedure ON procedure.oid = trigger_record.tgfoid
    JOIN pg_catalog.pg_namespace AS procedure_namespace
      ON procedure_namespace.oid = procedure.pronamespace
    WHERE NOT trigger_record.tgisinternal
      AND (
        procedure_namespace.nspname = 'noosphere_hybrid_c'
        OR trigger_record.tgname LIKE 'zz_noosphere_hybrid_c%'
      )
  )
  SELECT pg_catalog.string_agg(evidence.definition, E'\n' ORDER BY evidence.identity)
  FROM evidence
$function$;

CREATE FUNCTION noosphere_hybrid_c.authorize_query_dispatch(target_profile_id uuid)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  profile noosphere_hybrid.embedding_profile%ROWTYPE;
  remote_allowed boolean;
BEGIN
  -- This short transaction is the query-dispatch linearization point. Profile
  -- lifecycle and consent mutations take the same Phase B eligibility lock.
  -- The application commits immediately after this recheck and only then sends
  -- query bytes, so provider latency never blocks an operator revocation.
  PERFORM noosphere_hybrid_b.serialize_eligibility();
  SELECT * INTO profile
  FROM noosphere_hybrid.embedding_profile
  WHERE id = target_profile_id;
  IF NOT FOUND OR profile.state <> 'serving' THEN
    RETURN false;
  END IF;
  IF profile.locality = 'local' THEN
    RETURN true;
  END IF;
  SELECT consent.remote_egress INTO remote_allowed
  FROM noosphere_hybrid_b.embedding_consent AS consent
  WHERE consent.singleton;
  RETURN coalesce(remote_allowed, false);
END;
$function$;

CREATE FUNCTION noosphere_hybrid_c.query_profile_coverage(target_profile_id uuid)
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
      target.distance_metric,
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
     AND (
       eligible.distance_metric <> 'cosine'
       OR noosphere_vector.vector_norm(embedding.embedding) > 0
     )
  )
  SELECT
    aggregate.eligible_count,
    aggregate.ready_count,
    CASE WHEN aggregate.eligible_count = 0 THEN 1::numeric
      ELSE aggregate.ready_count::numeric / aggregate.eligible_count::numeric END
  FROM aggregate
$function$;

CREATE FUNCTION noosphere_hybrid_c.coverage_member_insert_counter()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  INSERT INTO noosphere_hybrid_c.profile_coverage_snapshot (
    profile_id, eligible_count, ready_count, refreshed_at
  )
  SELECT
    member.profile_id,
    pg_catalog.count(*),
    pg_catalog.count(*) FILTER (WHERE member.ready),
    pg_catalog.clock_timestamp()
  FROM new_coverage_members AS member
  GROUP BY member.profile_id
  ON CONFLICT (profile_id) DO UPDATE
  SET eligible_count = noosphere_hybrid_c.profile_coverage_snapshot.eligible_count
        + EXCLUDED.eligible_count,
      ready_count = noosphere_hybrid_c.profile_coverage_snapshot.ready_count
        + EXCLUDED.ready_count,
      refreshed_at = EXCLUDED.refreshed_at;
  RETURN NULL;
END;
$function$;

CREATE FUNCTION noosphere_hybrid_c.coverage_member_delete_counter()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  WITH removed AS (
    SELECT
      member.profile_id,
      pg_catalog.count(*) AS eligible_count,
      pg_catalog.count(*) FILTER (WHERE member.ready) AS ready_count
    FROM old_coverage_members AS member
    GROUP BY member.profile_id
  )
  UPDATE noosphere_hybrid_c.profile_coverage_snapshot AS snapshot
  SET eligible_count = snapshot.eligible_count - removed.eligible_count,
      ready_count = snapshot.ready_count - removed.ready_count,
      refreshed_at = pg_catalog.clock_timestamp()
  FROM removed
  WHERE snapshot.profile_id = removed.profile_id;
  RETURN NULL;
END;
$function$;

CREATE FUNCTION noosphere_hybrid_c.coverage_member_update_counter()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  WITH deltas AS (
    SELECT member.profile_id, -1::bigint AS eligible_delta,
      CASE WHEN member.ready THEN -1::bigint ELSE 0::bigint END AS ready_delta
    FROM old_coverage_members AS member
    UNION ALL
    SELECT member.profile_id, 1::bigint,
      CASE WHEN member.ready THEN 1::bigint ELSE 0::bigint END
    FROM new_coverage_members AS member
  ), aggregated AS (
    SELECT profile_id,
      pg_catalog.sum(eligible_delta)::bigint AS eligible_delta,
      pg_catalog.sum(ready_delta)::bigint AS ready_delta
    FROM deltas
    GROUP BY profile_id
  )
  UPDATE noosphere_hybrid_c.profile_coverage_snapshot AS snapshot
  SET eligible_count = snapshot.eligible_count + aggregated.eligible_delta,
      ready_count = snapshot.ready_count + aggregated.ready_delta,
      refreshed_at = pg_catalog.clock_timestamp()
  FROM aggregated
  WHERE snapshot.profile_id = aggregated.profile_id;
  RETURN NULL;
END;
$function$;

CREATE TRIGGER profile_coverage_member_insert_counter
AFTER INSERT ON noosphere_hybrid_c.profile_coverage_member
REFERENCING NEW TABLE AS new_coverage_members
FOR EACH STATEMENT EXECUTE FUNCTION noosphere_hybrid_c.coverage_member_insert_counter();

CREATE TRIGGER profile_coverage_member_delete_counter
AFTER DELETE ON noosphere_hybrid_c.profile_coverage_member
REFERENCING OLD TABLE AS old_coverage_members
FOR EACH STATEMENT EXECUTE FUNCTION noosphere_hybrid_c.coverage_member_delete_counter();

CREATE TRIGGER profile_coverage_member_update_counter
AFTER UPDATE ON noosphere_hybrid_c.profile_coverage_member
REFERENCING OLD TABLE AS old_coverage_members NEW TABLE AS new_coverage_members
FOR EACH STATEMENT EXECUTE FUNCTION noosphere_hybrid_c.coverage_member_update_counter();

CREATE FUNCTION noosphere_hybrid_c.refresh_profile_article_coverage(
  target_profile_id uuid,
  target_article_id text
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  DELETE FROM noosphere_hybrid_c.profile_coverage_member
  WHERE profile_id = target_profile_id AND article_id = target_article_id;

  INSERT INTO noosphere_hybrid_c.profile_coverage_member (profile_id, article_id, ready)
  SELECT
    profile.id,
    article.id,
    EXISTS (
      SELECT 1
      FROM noosphere_hybrid.article_embedding AS embedding
      WHERE embedding.profile_id = profile.id
        AND embedding.article_id = article.id
        AND embedding.revision = state.revision
        AND embedding.content_hash = noosphere_hybrid.canonical_hash(
          article.title, article.excerpt, article.content, profile.max_input_bytes
        )
        AND (
          profile.distance_metric <> 'cosine'
          OR noosphere_vector.vector_norm(embedding.embedding) > 0
        )
    )
  FROM noosphere_hybrid.embedding_profile AS profile
  JOIN public."Article" AS article ON article.id = target_article_id
  JOIN noosphere_hybrid.article_embedding_state AS state ON state.article_id = article.id
  WHERE profile.id = target_profile_id
    AND noosphere_hybrid_b.profile_article_is_eligible(
      profile.locality,
      article."deletedAt",
      article."recallQuarantinedAt",
      article."restrictedTags"
    );
END;
$function$;

CREATE FUNCTION noosphere_hybrid_c.refresh_article_coverage(target_article_id text)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  profile record;
BEGIN
  FOR profile IN SELECT id FROM noosphere_hybrid.embedding_profile ORDER BY id LOOP
    PERFORM noosphere_hybrid_c.refresh_profile_article_coverage(
      profile.id, target_article_id
    );
  END LOOP;
END;
$function$;

CREATE FUNCTION noosphere_hybrid_c.refresh_profile_coverage(target_profile_id uuid)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  INSERT INTO noosphere_hybrid_c.profile_coverage_snapshot (
    profile_id, eligible_count, ready_count
  )
  SELECT id, 0, 0 FROM noosphere_hybrid.embedding_profile
  WHERE id = target_profile_id
  ON CONFLICT (profile_id) DO NOTHING;

  DELETE FROM noosphere_hybrid_c.profile_coverage_member
  WHERE profile_id = target_profile_id;

  INSERT INTO noosphere_hybrid_c.profile_coverage_member (profile_id, article_id, ready)
  SELECT
    profile.id,
    article.id,
    EXISTS (
      SELECT 1
      FROM noosphere_hybrid.article_embedding AS embedding
      WHERE embedding.profile_id = profile.id
        AND embedding.article_id = article.id
        AND embedding.revision = state.revision
        AND embedding.content_hash = noosphere_hybrid.canonical_hash(
          article.title, article.excerpt, article.content, profile.max_input_bytes
        )
        AND (
          profile.distance_metric <> 'cosine'
          OR noosphere_vector.vector_norm(embedding.embedding) > 0
        )
    )
  FROM noosphere_hybrid.embedding_profile AS profile
  JOIN public."Article" AS article ON true
  JOIN noosphere_hybrid.article_embedding_state AS state ON state.article_id = article.id
  WHERE profile.id = target_profile_id
    AND noosphere_hybrid_b.profile_article_is_eligible(
      profile.locality,
      article."deletedAt",
      article."recallQuarantinedAt",
      article."restrictedTags"
    );
END;
$function$;

CREATE FUNCTION noosphere_hybrid_c.refresh_all_profile_coverage()
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  profile record;
BEGIN
  FOR profile IN SELECT id FROM noosphere_hybrid.embedding_profile ORDER BY id LOOP
    PERFORM noosphere_hybrid_c.refresh_profile_coverage(profile.id);
  END LOOP;
END;
$function$;

CREATE FUNCTION noosphere_hybrid_c.article_coverage_trigger()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM noosphere_hybrid_c.profile_coverage_member WHERE article_id = OLD.id;
    RETURN OLD;
  END IF;
  PERFORM noosphere_hybrid_c.refresh_article_coverage(NEW.id);
  RETURN NEW;
END;
$function$;

CREATE FUNCTION noosphere_hybrid_c.embedding_coverage_trigger()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM noosphere_hybrid_c.refresh_profile_article_coverage(
      OLD.profile_id, OLD.article_id
    );
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND (
    NEW.profile_id IS DISTINCT FROM OLD.profile_id
    OR NEW.article_id IS DISTINCT FROM OLD.article_id
  ) THEN
    PERFORM noosphere_hybrid_c.refresh_profile_article_coverage(
      OLD.profile_id, OLD.article_id
    );
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    PERFORM noosphere_hybrid_c.refresh_profile_article_coverage(
      NEW.profile_id, NEW.article_id
    );
  END IF;
  RETURN NEW;
END;
$function$;

CREATE FUNCTION noosphere_hybrid_c.profile_coverage_trigger()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  PERFORM noosphere_hybrid_c.refresh_profile_coverage(NEW.id);
  RETURN NEW;
END;
$function$;

CREATE FUNCTION noosphere_hybrid_c.consent_coverage_trigger()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  profile record;
BEGIN
  FOR profile IN
    SELECT id FROM noosphere_hybrid.embedding_profile
    WHERE locality = 'remote'
    ORDER BY id
  LOOP
    PERFORM noosphere_hybrid_c.refresh_profile_coverage(profile.id);
  END LOOP;
  RETURN NULL;
END;
$function$;

CREATE FUNCTION noosphere_hybrid_c.query_profile_snapshot(target_profile_id uuid)
RETURNS TABLE (
  profile_id uuid,
  provider_protocol text,
  locality text,
  model_identifier text,
  model_revision text,
  dimensions integer,
  distance_metric text,
  normalization_policy text,
  document_schema_version text,
  document_normalization text,
  max_input_bytes integer,
  endpoint_identity_sha256 text,
  profile_state text,
  cache_epoch bigint,
  eligible_count bigint,
  ready_count bigint,
  coverage numeric,
  remote_egress boolean,
  restricted_remote_egress boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT
    profile.id,
    profile.provider_protocol,
    profile.locality::text,
    profile.model_identifier,
    profile.model_revision,
    profile.dimensions,
    profile.distance_metric::text,
    profile.normalization_policy::text,
    profile.document_schema_version,
    profile.document_normalization,
    profile.max_input_bytes,
    pg_catalog.encode(profile.endpoint_identity_sha256, 'hex'),
    profile.state::text,
    epoch.epoch,
    coverage_snapshot.eligible_count,
    coverage_snapshot.ready_count,
    coverage_snapshot.coverage,
    consent.remote_egress,
    consent.restricted_remote_egress
  FROM noosphere_hybrid.embedding_profile AS profile
  CROSS JOIN noosphere_hybrid.search_cache_epoch AS epoch
  CROSS JOIN noosphere_hybrid_b.embedding_consent AS consent
  JOIN noosphere_hybrid_c.profile_coverage_snapshot AS coverage_snapshot
    ON coverage_snapshot.profile_id = profile.id
  WHERE profile.id = target_profile_id
    AND epoch.singleton
    AND consent.singleton
$function$;

CREATE FUNCTION noosphere_hybrid_c.vector_candidates(
  target_profile_id uuid,
  query_embedding_text text,
  candidate_article_ids text[]
)
RETURNS TABLE (article_id text, distance double precision)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  profile noosphere_hybrid.embedding_profile%ROWTYPE;
  query_embedding noosphere_vector.vector;
BEGIN
  IF query_embedding_text IS NULL
    OR pg_catalog.octet_length(query_embedding_text) > 1048576
  THEN
    RAISE EXCEPTION 'Phase C query embedding text is invalid or too large'
      USING ERRCODE = '22023';
  END IF;
  IF candidate_article_ids IS NULL
    OR pg_catalog.cardinality(candidate_article_ids) > 1000
  THEN
    RAISE EXCEPTION 'Phase C candidate article set is invalid or too large'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO STRICT profile
  FROM noosphere_hybrid.embedding_profile
  WHERE id = target_profile_id;

  -- The application role deliberately lacks USAGE on noosphere_vector. Keep
  -- the private extension type behind this SECURITY DEFINER boundary.
  query_embedding := query_embedding_text::noosphere_vector.vector;

  IF profile.state <> 'serving' THEN
    RAISE EXCEPTION 'Phase C query profile is not serving'
      USING ERRCODE = '55000';
  END IF;
  IF noosphere_vector.vector_dims(query_embedding) <> profile.dimensions THEN
    RAISE EXCEPTION 'Phase C query embedding dimension does not match profile'
      USING ERRCODE = '22023';
  END IF;
  IF NOT noosphere_hybrid.vector_is_finite(query_embedding) THEN
    RAISE EXCEPTION 'Phase C query embedding contains a non-finite component'
      USING ERRCODE = '22023';
  END IF;
  IF profile.distance_metric = 'cosine'
    AND noosphere_vector.vector_norm(query_embedding) = 0
  THEN
    RAISE EXCEPTION 'Phase C cosine query embedding has zero norm'
      USING ERRCODE = '22023';
  END IF;
  IF profile.normalization_policy = 'l2'
    AND pg_catalog.abs(noosphere_vector.vector_norm(query_embedding) - 1.0) > 0.00001
  THEN
    RAISE EXCEPTION 'Phase C query embedding is not L2 normalized'
      USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  SELECT
    embedding.article_id,
    CASE profile.distance_metric
      WHEN 'cosine' THEN embedding.embedding OPERATOR(noosphere_vector.<=>) query_embedding
      WHEN 'l2' THEN embedding.embedding OPERATOR(noosphere_vector.<->) query_embedding
      WHEN 'inner_product' THEN embedding.embedding OPERATOR(noosphere_vector.<#>) query_embedding
      ELSE NULL
    END::double precision AS distance
  FROM noosphere_hybrid.article_embedding AS embedding
  JOIN noosphere_hybrid.article_embedding_state AS state
    ON state.article_id = embedding.article_id
  JOIN public."Article" AS article
    ON article.id = embedding.article_id
  JOIN (
    SELECT DISTINCT pg_catalog.unnest(candidate_article_ids) AS id
  ) AS candidate ON candidate.id = embedding.article_id
  WHERE embedding.profile_id = profile.id
    AND embedding.dimensions = profile.dimensions
    AND embedding.revision = state.revision
    AND embedding.content_hash = noosphere_hybrid.canonical_hash(
      article.title, article.excerpt, article.content, profile.max_input_bytes
    )
    AND (
      profile.distance_metric <> 'cosine'
      OR noosphere_vector.vector_norm(embedding.embedding) > 0
    )
    AND noosphere_hybrid_b.profile_article_is_eligible(
      profile.locality,
      article."deletedAt",
      article."recallQuarantinedAt",
      article."restrictedTags"
    )
  -- Apply the same deterministic order as the application-side vector rank
  -- before truncation. Otherwise equal-distance rows beyond the fixed depth
  -- could be discarded by a different tie-break than the one assigning rank.
  ORDER BY 2 ASC, article."updatedAt" DESC, embedding.article_id ASC
  LIMIT 200;
END;
$function$;

CREATE FUNCTION noosphere_hybrid_c.current_vector_membership(
  target_profile_id uuid,
  candidate_article_ids text[]
)
RETURNS TABLE (article_id text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  profile noosphere_hybrid.embedding_profile%ROWTYPE;
BEGIN
  IF candidate_article_ids IS NULL
    OR pg_catalog.cardinality(candidate_article_ids) > 400
  THEN
    RAISE EXCEPTION 'Phase C cached candidate set is invalid or too large'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO STRICT profile
  FROM noosphere_hybrid.embedding_profile
  WHERE id = target_profile_id;
  IF profile.state <> 'serving' THEN
    RAISE EXCEPTION 'Phase C query profile is not serving'
      USING ERRCODE = '55000';
  END IF;

  RETURN QUERY
  SELECT embedding.article_id
  FROM noosphere_hybrid.article_embedding AS embedding
  JOIN noosphere_hybrid.article_embedding_state AS state
    ON state.article_id = embedding.article_id
  JOIN public."Article" AS article
    ON article.id = embedding.article_id
  JOIN (
    SELECT DISTINCT pg_catalog.unnest(candidate_article_ids) AS id
  ) AS candidate ON candidate.id = embedding.article_id
  WHERE embedding.profile_id = profile.id
    AND embedding.dimensions = profile.dimensions
    AND embedding.revision = state.revision
    AND embedding.content_hash = noosphere_hybrid.canonical_hash(
      article.title, article.excerpt, article.content, profile.max_input_bytes
    )
    AND (
      profile.distance_metric <> 'cosine'
      OR noosphere_vector.vector_norm(embedding.embedding) > 0
    )
    AND noosphere_hybrid_b.profile_article_is_eligible(
      profile.locality,
      article."deletedAt",
      article."recallQuarantinedAt",
      article."restrictedTags"
    )
  ORDER BY embedding.article_id;
END;
$function$;
