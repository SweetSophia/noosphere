import process from "node:process";
import pg from "pg";

const { Pool } = pg;
const MIGRATOR_ROLE = "noosphere_migrator";
const APP_ROLE = "noosphere_app";
const HYBRID_ADMIN_LOGIN = "noosphere_hybrid_admin_login";
const HYBRID_WORKER_LOGIN = "noosphere_hybrid_worker_login";
// This exact regprocedure list is the migration path for application-callable
// public routines. A migration that adds or changes such a routine must update
// this list; the post-migration provision pass revokes every other EXECUTE.
const APPLICATION_FUNCTION_ALLOWLIST = [
  "public.prevent_api_key_agent_principal_rebind()",
  "public.prevent_memory_principal_scope_rebind()",
  "public.validate_memory_capture_identity_scope()",
  "public.validate_memory_candidate_identity_scope()",
  "public.prevent_active_memory_capture_delete()",
  "public.assert_memory_capture_has_source(text)",
  "public.validate_memory_capture_source()",
  "public.memory_candidate_source_is_valid(text)",
  "public.assert_memory_candidate_has_source(text)",
  "public.validate_memory_candidate_source()",
  "public.assert_memory_capture_group_candidates_have_source(text,text,text,integer)",
  "public.validate_memory_candidate_source_edge()",
];

function requireDatabaseUrl(name) {
  const raw = process.env[name];
  if (!raw) throw new Error(`${name} is required`);

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${name} must be a valid PostgreSQL URL`);
  }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
    throw new Error(`${name} must use postgresql://`);
  }
  if (!parsed.username || !parsed.password) {
    throw new Error(`${name} must include a username and password`);
  }
  return { raw, parsed };
}

function decoded(value, label) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new Error(`${label} contains invalid percent encoding`);
  }
}

async function formattedRolePasswordSql(client, roleName, password) {
  const result = await client.query(
    "SELECT pg_catalog.format('ALTER ROLE %I PASSWORD %L', $1::text, $2::text) AS sql",
    [roleName, password],
  );
  const sql = result.rows[0]?.sql;
  if (typeof sql !== "string" || !sql.startsWith("ALTER ROLE ")) {
    throw new Error("PostgreSQL did not produce a safe role-password statement");
  }
  return sql;
}

async function formattedRoleAttributeSql(client, action, roleName) {
  const templates = {
    CREATE:
      "CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS",
    ALTER:
      "ALTER ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS",
  };
  const template = templates[action];
  if (!template) throw new Error(`unsupported role attribute action ${action}`);

  const result = await client.query(
    "SELECT pg_catalog.format($1::text, $2::text) AS sql",
    [template, roleName],
  );
  const sql = result.rows[0]?.sql;
  if (typeof sql !== "string" || !sql.startsWith(`${action} ROLE `)) {
    throw new Error("PostgreSQL did not produce a safe role-attribute statement");
  }
  return sql;
}

async function ensureRole(client, roleName, password) {
  const existing = await client.query(
    `
      SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole,
             rolinherit, rolreplication, rolbypassrls
      FROM pg_catalog.pg_roles
      WHERE rolname = $1::text
    `,
    [roleName],
  );
  if (
    existing.rowCount === 1 &&
    (
      !existing.rows[0].rolcanlogin ||
      existing.rows[0].rolsuper ||
      existing.rows[0].rolcreatedb ||
      existing.rows[0].rolcreaterole ||
      !existing.rows[0].rolinherit ||
      existing.rows[0].rolreplication ||
      existing.rows[0].rolbypassrls
    )
  ) {
    throw new Error(`refusing to repair unsafe pre-existing database role ${roleName}`);
  }

  if (existing.rowCount === 0) {
    await client.query(await formattedRoleAttributeSql(client, "CREATE", roleName));
  }
  await client.query(await formattedRoleAttributeSql(client, "ALTER", roleName));
  await client.query(await formattedRolePasswordSql(client, roleName, password));
}

async function grantApplicationFunctionAllowlist(client) {
  for (const signature of APPLICATION_FUNCTION_ALLOWLIST) {
    const result = await client.query(
      `
        SELECT
          pg_catalog.to_regprocedure($1::text) AS oid,
          pg_catalog.format(
            'GRANT EXECUTE ON FUNCTION %s TO noosphere_app',
            pg_catalog.to_regprocedure($1::text)
          ) AS sql
      `,
      [signature],
    );
    if (result.rows[0]?.oid) {
      await client.query(result.rows[0].sql);
    }
  }
}

async function transferApplicationOwnership(client, bootstrapUser) {
  const statements = await client.query(
    `
      WITH owned AS (
        SELECT pg_catalog.format(
          CASE relation.relkind
            WHEN 'S' THEN 'ALTER SEQUENCE %I.%I OWNER TO %I'
            WHEN 'v' THEN 'ALTER VIEW %I.%I OWNER TO %I'
            WHEN 'm' THEN 'ALTER MATERIALIZED VIEW %I.%I OWNER TO %I'
            WHEN 'f' THEN 'ALTER FOREIGN TABLE %I.%I OWNER TO %I'
            ELSE 'ALTER TABLE %I.%I OWNER TO %I'
          END,
          namespace.nspname,
          relation.relname,
          $2::text
        ) AS sql,
        10 AS ordering
        FROM pg_catalog.pg_class AS relation
        JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
        JOIN pg_catalog.pg_roles AS owner ON owner.oid = relation.relowner
        WHERE namespace.nspname = 'public'
          AND owner.rolname = $1::text
          AND relation.relkind IN ('r', 'p', 'S', 'v', 'm', 'f')

        UNION ALL

        SELECT pg_catalog.format(
          'ALTER %s %I.%I(%s) OWNER TO %I',
          CASE procedure.prokind WHEN 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END,
          namespace.nspname,
          procedure.proname,
          pg_catalog.pg_get_function_identity_arguments(procedure.oid),
          $2::text
        ),
        20
        FROM pg_catalog.pg_proc AS procedure
        JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
        JOIN pg_catalog.pg_roles AS owner ON owner.oid = procedure.proowner
        WHERE namespace.nspname = 'public'
          AND owner.rolname = $1::text

        UNION ALL

        SELECT pg_catalog.format(
          'ALTER TYPE %I.%I OWNER TO %I',
          namespace.nspname,
          type.typname,
          $2::text
        ),
        30
        FROM pg_catalog.pg_type AS type
        JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = type.typnamespace
        JOIN pg_catalog.pg_roles AS owner ON owner.oid = type.typowner
        WHERE namespace.nspname = 'public'
          AND owner.rolname = $1::text
          AND type.typtype IN ('d', 'e', 'm', 'r')
      )
      SELECT sql FROM owned ORDER BY ordering, sql
    `,
    [bootstrapUser, MIGRATOR_ROLE],
  );

  for (const { sql } of statements.rows) {
    await client.query(sql);
  }

  const databaseOwner = await client.query(
    "SELECT pg_catalog.format('ALTER DATABASE %I OWNER TO %I', pg_catalog.current_database(), $1::text) AS sql",
    [MIGRATOR_ROLE],
  );
  await client.query(databaseOwner.rows[0].sql);

  const publicOwner = await client.query(
    "SELECT pg_catalog.format('ALTER SCHEMA public OWNER TO %I', $1::text) AS sql",
    [MIGRATOR_ROLE],
  );
  await client.query(publicOwner.rows[0].sql);
}

async function main() {
  const bootstrap = requireDatabaseUrl("NOOSPHERE_BOOTSTRAP_DATABASE_URL");
  const migrator = requireDatabaseUrl("DATABASE_URL");
  const app = requireDatabaseUrl("NOOSPHERE_APP_DATABASE_URL");
  const hybridAdmin = process.env.NOOSPHERE_HYBRID_ADMIN_DATABASE_URL
    ? requireDatabaseUrl("NOOSPHERE_HYBRID_ADMIN_DATABASE_URL")
    : null;
  const hybridWorker = process.env.NOOSPHERE_HYBRID_WORKER_DATABASE_URL
    ? requireDatabaseUrl("NOOSPHERE_HYBRID_WORKER_DATABASE_URL")
    : null;

  const bootstrapUser = decoded(bootstrap.parsed.username, "NOOSPHERE_BOOTSTRAP_DATABASE_URL");
  const bootstrapPassword = decoded(bootstrap.parsed.password, "NOOSPHERE_BOOTSTRAP_DATABASE_URL");
  const migratorUser = decoded(migrator.parsed.username, "DATABASE_URL");
  const appUser = decoded(app.parsed.username, "NOOSPHERE_APP_DATABASE_URL");
  const migratorPassword = decoded(migrator.parsed.password, "DATABASE_URL");
  const appPassword = decoded(app.parsed.password, "NOOSPHERE_APP_DATABASE_URL");
  if (Boolean(hybridAdmin) !== Boolean(hybridWorker)) {
    throw new Error("hybrid administration and worker database URLs must be supplied together");
  }

  if (migratorUser !== MIGRATOR_ROLE || appUser !== APP_ROLE) {
    throw new Error(
      `DATABASE_URL must use ${MIGRATOR_ROLE} and NOOSPHERE_APP_DATABASE_URL must use ${APP_ROLE}`,
    );
  }
  if (new Set([bootstrapUser, migratorUser, appUser]).size !== 3) {
    throw new Error("bootstrap, migration, and application database identities must be distinct");
  }
  if (new Set([bootstrapPassword, migratorPassword, appPassword]).size !== 3) {
    throw new Error("bootstrap, migration, and application database passwords must be distinct");
  }

  const hybridIdentities = hybridAdmin && hybridWorker
    ? {
        adminUser: decoded(
          hybridAdmin.parsed.username,
          "NOOSPHERE_HYBRID_ADMIN_DATABASE_URL",
        ),
        adminPassword: decoded(
          hybridAdmin.parsed.password,
          "NOOSPHERE_HYBRID_ADMIN_DATABASE_URL",
        ),
        workerUser: decoded(
          hybridWorker.parsed.username,
          "NOOSPHERE_HYBRID_WORKER_DATABASE_URL",
        ),
        workerPassword: decoded(
          hybridWorker.parsed.password,
          "NOOSPHERE_HYBRID_WORKER_DATABASE_URL",
        ),
      }
    : null;
  if (
    hybridIdentities &&
    (
      hybridIdentities.adminUser !== HYBRID_ADMIN_LOGIN ||
      hybridIdentities.workerUser !== HYBRID_WORKER_LOGIN
    )
  ) {
    throw new Error(
      `hybrid URLs must use ${HYBRID_ADMIN_LOGIN} and ${HYBRID_WORKER_LOGIN}`,
    );
  }
  if (hybridIdentities) {
    const users = [
      bootstrapUser,
      migratorUser,
      appUser,
      hybridIdentities.adminUser,
      hybridIdentities.workerUser,
    ];
    const passwords = [
      bootstrapPassword,
      migratorPassword,
      appPassword,
      hybridIdentities.adminPassword,
      hybridIdentities.workerPassword,
    ];
    if (new Set(users).size !== users.length || new Set(passwords).size !== passwords.length) {
      throw new Error("all database runtime identities and passwords must be distinct");
    }
  }

  const pool = new Pool({ connectionString: bootstrap.raw, max: 1 });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))",
      ["noosphere-database-role-provision-v1"],
    );

    const authority = await client.query(`
      SELECT rolsuper
      FROM pg_catalog.pg_roles
      WHERE rolname = current_user
    `);
    if (!authority.rows[0]?.rolsuper) {
      throw new Error("NOOSPHERE_BOOTSTRAP_DATABASE_URL must authenticate as a PostgreSQL superuser");
    }

    await ensureRole(client, MIGRATOR_ROLE, migratorPassword);
    await ensureRole(client, APP_ROLE, appPassword);
    if (hybridIdentities) {
      await ensureRole(
        client,
        HYBRID_ADMIN_LOGIN,
        hybridIdentities.adminPassword,
      );
      await ensureRole(
        client,
        HYBRID_WORKER_LOGIN,
        hybridIdentities.workerPassword,
      );
    }

    // POSTGRES_USER owns PostgreSQL's bootstrap catalogs as well as the target
    // database, so REASSIGN OWNED would try to mutate system-required objects.
    // Transfer only this database and Noosphere's public-schema objects.
    await transferApplicationOwnership(client, bootstrapUser);

    await client.query(`
      REVOKE CREATE ON SCHEMA public FROM PUBLIC;
      REVOKE ALL ON SCHEMA public FROM noosphere_app;
      GRANT USAGE ON SCHEMA public TO noosphere_app;
      REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;

      GRANT SELECT, INSERT, UPDATE, DELETE
        ON ALL TABLES IN SCHEMA public TO noosphere_app;
      GRANT USAGE, SELECT
        ON ALL SEQUENCES IN SCHEMA public TO noosphere_app;

      -- Prisma's migration ledger is deployment authority, not application
      -- data. Keep it completely outside the compromised-runtime boundary.
      DO $block$
      BEGIN
        IF pg_catalog.to_regclass('public._prisma_migrations') IS NOT NULL THEN
          REVOKE ALL ON TABLE public._prisma_migrations FROM noosphere_app;
        END IF;
      END;
      $block$;
      REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM noosphere_app;

      ALTER DEFAULT PRIVILEGES FOR ROLE noosphere_migrator IN SCHEMA public
        REVOKE ALL ON TABLES FROM PUBLIC;
      ALTER DEFAULT PRIVILEGES FOR ROLE noosphere_migrator IN SCHEMA public
        REVOKE ALL ON SEQUENCES FROM PUBLIC;
      ALTER DEFAULT PRIVILEGES FOR ROLE noosphere_migrator
        REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
    `);
    await grantApplicationFunctionAllowlist(client);

    const runtimePrivilegeAudit = await client.query(`
      SELECT
        CASE
          WHEN pg_catalog.to_regclass('public._prisma_migrations') IS NULL THEN false
          ELSE pg_catalog.has_table_privilege(
            'noosphere_app', 'public._prisma_migrations',
            'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
          )
        END AS migration_ledger_access,
        EXISTS (
          SELECT 1
          FROM pg_catalog.pg_proc AS procedure
          JOIN pg_catalog.pg_namespace AS namespace
            ON namespace.oid = procedure.pronamespace
          WHERE namespace.nspname = 'public'
            AND pg_catalog.has_function_privilege(
              'noosphere_app', procedure.oid, 'EXECUTE'
            )
            AND procedure.oid <> ALL (
              ARRAY(
                SELECT pg_catalog.to_regprocedure(signature)
                FROM pg_catalog.unnest($1::text[]) AS allowed(signature)
                WHERE pg_catalog.to_regprocedure(signature) IS NOT NULL
              )
            )
        ) AS unexpected_public_function_execute
    `, [APPLICATION_FUNCTION_ALLOWLIST]);
    if (
      runtimePrivilegeAudit.rows[0]?.migration_ledger_access ||
      runtimePrivilegeAudit.rows[0]?.unexpected_public_function_execute
    ) {
      throw new Error("application runtime retained deployment-ledger or public-function authority");
    }

    const roleAudit = await client.query(`
      SELECT rolname
      FROM pg_catalog.pg_roles
      WHERE rolname IN (
        'noosphere_migrator',
        'noosphere_app',
        'noosphere_hybrid_admin_login',
        'noosphere_hybrid_worker_login'
      )
        AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)
    `);
    if (roleAudit.rowCount !== 0) {
      throw new Error(`unsafe database role attributes remain on ${roleAudit.rows[0].rolname}`);
    }

    {
      const unexpectedMembership = await client.query(`
        SELECT member.rolname AS member_name, granted.rolname AS granted_name
        FROM pg_catalog.pg_auth_members AS membership
        JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
        JOIN pg_catalog.pg_roles AS granted ON granted.oid = membership.roleid
        WHERE (
          member.rolname IN (
            'noosphere_migrator',
            'noosphere_app',
            'noosphere_hybrid_admin_login',
            'noosphere_hybrid_worker_login'
          )
          OR pg_catalog.starts_with(member.rolname, 'noosphere_hybrid_')
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
      `);
      if (unexpectedMembership.rowCount !== 0) {
        throw new Error(
          `database runtime login has unexpected membership: ${unexpectedMembership.rows[0].member_name}->${unexpectedMembership.rows[0].granted_name}`,
        );
      }

      // Before optional activation neither capability role exists. After
      // activation both must exist and both login memberships must be present.
      // Reject a partial/pre-created phase instead of treating the first
      // provision pass as a vacuous membership success.
      const hybridPhaseAudit = await client.query(`
        SELECT
          (
            SELECT pg_catalog.count(*)::integer
            FROM pg_catalog.pg_namespace
            WHERE nspname = 'noosphere_hybrid'
          ) AS feature_schema_count,
          (
            SELECT pg_catalog.count(*)::integer
            FROM pg_catalog.pg_roles
            WHERE rolname IN (
              'noosphere_hybrid_extension_owner',
              'noosphere_hybrid_owner',
              'noosphere_hybrid_activator',
              'noosphere_hybrid_admin',
              'noosphere_hybrid_worker'
            )
          ) AS named_capability_role_count,
          (
            SELECT pg_catalog.count(*)::integer
            FROM pg_catalog.pg_roles
            WHERE pg_catalog.starts_with(rolname, 'noosphere_hybrid_')
              AND NOT rolcanlogin
          ) AS hybrid_nonlogin_role_count,
          (
            SELECT pg_catalog.count(*)::integer
            FROM pg_catalog.pg_roles
            WHERE rolname IN (
                'noosphere_hybrid_extension_owner',
                'noosphere_hybrid_owner',
                'noosphere_hybrid_activator',
                'noosphere_hybrid_admin',
                'noosphere_hybrid_worker'
              )
              AND (
                rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR
                rolinherit OR rolreplication OR rolbypassrls
              )
          ) AS unsafe_capability_role_count,
          (
            SELECT pg_catalog.count(*)::integer
            FROM pg_catalog.pg_auth_members AS membership
            JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
            JOIN pg_catalog.pg_roles AS granted ON granted.oid = membership.roleid
            WHERE (member.rolname, granted.rolname) IN (
              ('noosphere_hybrid_admin_login', 'noosphere_hybrid_admin'),
              ('noosphere_hybrid_worker_login', 'noosphere_hybrid_worker')
            )
          ) AS expected_membership_count
      `);
      const featureSchemaCount = hybridPhaseAudit.rows[0]?.feature_schema_count;
      const namedCapabilityRoleCount = hybridPhaseAudit.rows[0]?.named_capability_role_count;
      const hybridNonloginRoleCount = hybridPhaseAudit.rows[0]?.hybrid_nonlogin_role_count;
      const unsafeCapabilityRoleCount = hybridPhaseAudit.rows[0]?.unsafe_capability_role_count;
      const expectedMembershipCount = hybridPhaseAudit.rows[0]?.expected_membership_count;
      if (
        !(
          (
            featureSchemaCount === 0 &&
            namedCapabilityRoleCount === 0 &&
            hybridNonloginRoleCount === 0 &&
            unsafeCapabilityRoleCount === 0 &&
            expectedMembershipCount === 0
          ) ||
          (
            featureSchemaCount === 1 &&
            namedCapabilityRoleCount === 5 &&
            hybridNonloginRoleCount === 5 &&
            unsafeCapabilityRoleCount === 0 &&
            expectedMembershipCount === 2
          )
        )
      ) {
        throw new Error(
          `hybrid capability phase is partial or unsafe: schemas=${featureSchemaCount}, namedRoles=${namedCapabilityRoleCount}, nonloginRoles=${hybridNonloginRoleCount}, unsafeRoles=${unsafeCapabilityRoleCount}, memberships=${expectedMembershipCount}`,
        );
      }
    }

    await client.query("COMMIT");
    console.log("[database-roles] Provisioned separate migration and application runtime identities.");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(
    `[database-roles] Failed to provision database roles: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
