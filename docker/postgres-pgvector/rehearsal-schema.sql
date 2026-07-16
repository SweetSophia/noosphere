\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

SELECT 'column|' || c.relname || '|' || a.attnum || '|' || a.attname || '|' ||
       format_type(a.atttypid, a.atttypmod) || '|' || a.attnotnull || '|' ||
       coalesce(pg_get_expr(d.adbin, d.adrelid), '<null>') || '|' ||
       coalesce(coll.collname, '<default>')
FROM pg_class AS c
JOIN pg_namespace AS n ON n.oid = c.relnamespace
JOIN pg_attribute AS a ON a.attrelid = c.oid
LEFT JOIN pg_attrdef AS d ON d.adrelid = c.oid AND d.adnum = a.attnum
LEFT JOIN pg_collation AS coll ON coll.oid = a.attcollation AND a.attcollation <> 0
WHERE n.nspname = 'public'
  AND c.relkind IN ('r', 'p')
  AND a.attnum > 0
  AND NOT a.attisdropped
ORDER BY c.relname, a.attnum;

SELECT 'constraint|' || c.relname || '|' || con.conname || '|' || con.contype::text || '|' ||
       con.convalidated || '|' || pg_get_constraintdef(con.oid, true)
FROM pg_constraint AS con
JOIN pg_class AS c ON c.oid = con.conrelid
JOIN pg_namespace AS n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
ORDER BY c.relname, con.conname;

SELECT 'index|' || table_class.relname || '|' || index_class.relname || '|' ||
       pg_get_indexdef(index_class.oid)
FROM pg_index AS idx
JOIN pg_class AS table_class ON table_class.oid = idx.indrelid
JOIN pg_class AS index_class ON index_class.oid = idx.indexrelid
JOIN pg_namespace AS n ON n.oid = table_class.relnamespace
WHERE n.nspname = 'public'
ORDER BY table_class.relname, index_class.relname;

SELECT 'trigger|' || c.relname || '|' || t.tgname || '|' || pg_get_triggerdef(t.oid, true)
FROM pg_trigger AS t
JOIN pg_class AS c ON c.oid = t.tgrelid
JOIN pg_namespace AS n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND NOT t.tgisinternal
ORDER BY c.relname, t.tgname;

SELECT 'function|' || p.proname || '|' || pg_get_function_identity_arguments(p.oid) || '|' ||
       pg_get_functiondef(p.oid)
FROM pg_proc AS p
JOIN pg_namespace AS n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
ORDER BY p.proname, pg_get_function_identity_arguments(p.oid);

SELECT 'enum|' || t.typname || '|' || e.enumsortorder || '|' || e.enumlabel
FROM pg_type AS t
JOIN pg_namespace AS n ON n.oid = t.typnamespace
JOIN pg_enum AS e ON e.enumtypid = t.oid
WHERE n.nspname = 'public'
ORDER BY t.typname, e.enumsortorder;
