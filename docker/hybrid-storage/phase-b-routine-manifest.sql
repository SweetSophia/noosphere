CREATE FUNCTION noosphere_hybrid_b.routine_manifest()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  WITH routine_evidence AS (
    SELECT
      pg_catalog.format(
        'routine:%I.%I(%s)',
        namespace.nspname,
        procedure.proname,
        COALESCE((
          SELECT pg_catalog.string_agg(
            pg_catalog.format_type(argument.type_oid, NULL),
            ',' ORDER BY argument.ordinality
          )
          FROM pg_catalog.unnest(procedure.proargtypes::pg_catalog.oid[])
            WITH ORDINALITY AS argument(type_oid, ordinality)
        ), '')
      ) AS identity,
      pg_catalog.format(
        'kind=%s|lang=%s|ret=%s|allargs=%s|modes=%s|names=%s|vol=%s|strict=%s|secdef=%s|leakproof=%s|parallel=%s|cost=%s|rows=%s|config=%s|bin=%s|src=%s',
        procedure.prokind,
        language.lanname,
        pg_catalog.format_type(procedure.prorettype, NULL),
        COALESCE((
          SELECT pg_catalog.string_agg(
            pg_catalog.format_type(argument.type_oid, NULL),
            ',' ORDER BY argument.ordinality
          )
          FROM pg_catalog.unnest(
            COALESCE(procedure.proallargtypes, procedure.proargtypes::pg_catalog.oid[])
          ) WITH ORDINALITY AS argument(type_oid, ordinality)
        ), ''),
        COALESCE(pg_catalog.array_to_string(procedure.proargmodes, ','), ''),
        COALESCE(pg_catalog.array_to_string(procedure.proargnames, ','), ''),
        procedure.provolatile,
        procedure.proisstrict,
        procedure.prosecdef,
        procedure.proleakproof,
        procedure.proparallel,
        procedure.procost,
        procedure.prorows,
        COALESCE((
          SELECT pg_catalog.string_agg(setting, ',' ORDER BY setting COLLATE "C")
          FROM pg_catalog.unnest(procedure.proconfig) AS configuration(setting)
        ), ''),
        COALESCE(procedure.probin, ''),
        procedure.prosrc
      ) AS definition
    FROM pg_catalog.pg_proc AS procedure
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
    JOIN pg_catalog.pg_language AS language ON language.oid = procedure.prolang
    WHERE namespace.nspname = 'noosphere_hybrid_b'
  ), trigger_evidence AS (
    SELECT
      pg_catalog.format(
        'trigger:%I.%I:%I', relation_namespace.nspname, relation.relname, trigger_record.tgname
      ) AS identity,
      pg_catalog.format(
        'enabled=%s|type=%s|columns=%s|args=%s|oldtable=%s|newtable=%s|function=%I.%I',
        trigger_record.tgenabled,
        trigger_record.tgtype,
        trigger_record.tgattr::text,
        pg_catalog.encode(trigger_record.tgargs, 'hex'),
        COALESCE(trigger_record.tgoldtable, ''),
        COALESCE(trigger_record.tgnewtable, ''),
        function_namespace.nspname,
        trigger_function.proname
      ) AS definition
    FROM pg_catalog.pg_trigger AS trigger_record
    JOIN pg_catalog.pg_class AS relation ON relation.oid = trigger_record.tgrelid
    JOIN pg_catalog.pg_namespace AS relation_namespace
      ON relation_namespace.oid = relation.relnamespace
    JOIN pg_catalog.pg_proc AS trigger_function ON trigger_function.oid = trigger_record.tgfoid
    JOIN pg_catalog.pg_namespace AS function_namespace
      ON function_namespace.oid = trigger_function.pronamespace
    WHERE NOT trigger_record.tgisinternal
      AND trigger_record.tgname IN (
        'noosphere_hybrid_b_article_guard',
        'zz_noosphere_hybrid_b_article_dirty'
      )
  ), evidence AS (
    SELECT identity, definition FROM routine_evidence
    UNION ALL
    SELECT identity, definition FROM trigger_evidence
  )
  SELECT pg_catalog.string_agg(
    evidence.identity || '|' || evidence.definition,
    E'\n' ORDER BY evidence.identity COLLATE "C"
  )
  FROM evidence
$function$;
