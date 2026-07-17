\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned
SET TIME ZONE 'UTC';

-- Generate an independent SQL-side snapshot for every application table so a
-- future migration cannot silently fall outside this second integrity layer.
SELECT format(
  'SELECT %L || coalesce(jsonb_agg(to_jsonb(row_data) ORDER BY to_jsonb(row_data)::text)::text, ''[]'') FROM (SELECT * FROM public.%I) AS row_data;',
  'integrity_table:' || tablename || '|',
  tablename
)
FROM pg_tables
WHERE schemaname = 'public'
  AND tablename <> '_prisma_migrations'
ORDER BY tablename
\gexec

SELECT 'upgrade_sort|' || string_agg("id", ',' ORDER BY "sortKey" COLLATE "default", "id")
FROM "UpgradeRehearsalFixture";
