\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned
SET TIME ZONE 'UTC';

SELECT 'users|' || coalesce(jsonb_agg(to_jsonb(row_data) ORDER BY row_data."id")::text, '[]')
FROM (SELECT * FROM "User") AS row_data;

SELECT 'topics|' || coalesce(jsonb_agg(to_jsonb(row_data) ORDER BY row_data."id")::text, '[]')
FROM (SELECT * FROM "Topic") AS row_data;

SELECT 'articles|' || coalesce(jsonb_agg(to_jsonb(row_data) ORDER BY row_data."id")::text, '[]')
FROM (SELECT * FROM "Article") AS row_data;

SELECT 'api_keys|' || coalesce(jsonb_agg(to_jsonb(row_data) ORDER BY row_data."id")::text, '[]')
FROM (SELECT * FROM "ApiKey") AS row_data;

SELECT 'activity|' || coalesce(jsonb_agg(to_jsonb(row_data) ORDER BY row_data."id")::text, '[]')
FROM (SELECT * FROM "ActivityLog") AS row_data;

SELECT 'recall_settings|' || coalesce(jsonb_agg(to_jsonb(row_data) ORDER BY row_data."id")::text, '[]')
FROM (SELECT * FROM "RecallSettings") AS row_data;

SELECT 'memory_principals|' || coalesce(jsonb_agg(to_jsonb(row_data) ORDER BY row_data."id")::text, '[]')
FROM (SELECT * FROM "MemoryAgentPrincipal") AS row_data;

SELECT 'memory_captures|' || coalesce(jsonb_agg(to_jsonb(row_data) ORDER BY row_data."id")::text, '[]')
FROM (SELECT * FROM "MemoryCapture") AS row_data;

SELECT 'memory_candidates|' || coalesce(jsonb_agg(to_jsonb(row_data) ORDER BY row_data."id")::text, '[]')
FROM (SELECT * FROM "MemoryCandidate") AS row_data;

SELECT 'memory_stats|' || coalesce(jsonb_agg(to_jsonb(row_data) ORDER BY row_data."id")::text, '[]')
FROM (SELECT * FROM "MemoryRetrievalStat") AS row_data;

SELECT 'memory_lineage|' || coalesce(jsonb_agg(to_jsonb(row_data) ORDER BY row_data."id")::text, '[]')
FROM (SELECT * FROM "MemoryLineageState") AS row_data;

SELECT 'memory_provenance|' || coalesce(jsonb_agg(to_jsonb(row_data) ORDER BY row_data."id")::text, '[]')
FROM (SELECT * FROM "MemoryProvenanceEdge") AS row_data;

SELECT 'memory_jobs|' || coalesce(jsonb_agg(to_jsonb(row_data) ORDER BY row_data."id")::text, '[]')
FROM (SELECT * FROM "MemoryDurableJob") AS row_data;

SELECT 'upgrade_fixture|' || coalesce(jsonb_agg(to_jsonb(row_data) ORDER BY row_data."id")::text, '[]')
FROM (SELECT * FROM "UpgradeRehearsalFixture") AS row_data;

SELECT 'upgrade_sort|' || string_agg("id", ',' ORDER BY "sortKey" COLLATE "default", "id")
FROM "UpgradeRehearsalFixture";
