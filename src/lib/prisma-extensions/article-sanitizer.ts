/**
 * Prisma client extension: Article persistence-layer sanitizer
 *
 * This extension intercepts all `article.create`, `article.update`,
 * `article.upsert`, `article.createMany`, `article.updateMany`,
 * `articleRevision.create`, `articleRevision.update`, and
 * `articleRevision.upsert` operations at the Prisma query layer.
 * It strips injected memory blocks (`<recall>`, `<hindsight_memories>`,
 * `<noosphere_auto_recall>`) from `content` and `excerpt` fields *before*
 * the data reaches PostgreSQL.
 *
 * ## Why this exists
 *
 * Route-level and action-level sanitization (PRs #206, #209, #210, #212)
 * depends on every new write path remembering to call the shared sanitizer
 * helper. The repeated scope misses across those PRs proved that
 * endpoint-level hardening alone is not a reliable long-term safety boundary.
 *
 * This extension is a **hard boundary** for the `article` and
 * `articleRevision` tables. Even if a future route forgets to call
 * `sanitizeArticleContent`, injected blocks cannot reach those tables.
 *
 * ## What this extension does NOT do
 *
 * - **Secret detection**: stays at the route/action level where the caller
 *   context (HTTP request, auth session) is available for error responses.
 * - **Activity logging**: stays at the route/action level where `route` and
 *   `kind` metadata is known. The extension is a silent backstop.
 * - **HTTP error responses**: the extension throws a plain `Error` if content
 *   becomes empty after stripping. Routes should catch this and convert to
 *   HTTP 400 if it surfaces.
 *
 * ## `updateMany`
 *
 * `updateMany` and `createMany` reject writes that include `content` or
 * `excerpt` fields, because those bulk operations are typically metadata-only
 * (publish/unpublish, trash/restore). If a future use case needs to write
 * content through bulk operations, that caller should be audited and the
 * rejection lifted deliberately.
 *
 * @see https://www.prisma.io/docs/concepts/components/prisma-client/client-extensions/query
 * @see https://github.com/SweetSophia/noosphere/issues/213
 */

import {
  SERVER_MEMORY_SAVE_STRIP_MODE,
  stripInjectedMemoryBlocks,
} from "@sweetsophia/noosphere-injected-memory";

/**
 * Error thrown when a persistence-layer write contains only injected memory
 * blocks after stripping. Routes should catch this via the exported
 * `isPersistenceLayerInjectedOnlyError()` helper and convert to HTTP 400.
 */
export const PERSISTENCE_LAYER_INJECTED_ONLY_ERROR =
  "Persistence layer rejected article write: content is empty after injected-memory stripping";

/**
 * Type guard for the persistence-layer rejection error.
 * Use this instead of string matching to check for the error.
 */
export function isPersistenceLayerInjectedOnlyError(
  err: unknown,
): boolean {
  return err instanceof Error && err.message === PERSISTENCE_LAYER_INJECTED_ONLY_ERROR;
}

/**
 * Error prefix for bulk operations that include content/excerpt fields.
 */
export const PERSISTENCE_LAYER_BULK_CONTENT_ERROR_PREFIX =
  "Persistence layer rejected article.";

/**
 * Type guard for the bulk-rejection error.
 */
export function isPersistenceLayerBulkContentError(
  err: unknown,
): boolean {
  return (
    err instanceof Error &&
    err.message.startsWith(PERSISTENCE_LAYER_BULK_CONTENT_ERROR_PREFIX)
  );
}

/**
 * Type guard for any persistence-layer sanitizer error (injected-only or bulk).
 */
export function isPersistenceLayerSanitizerError(
  err: unknown,
): boolean {
  return (
    isPersistenceLayerInjectedOnlyError(err) ||
    isPersistenceLayerBulkContentError(err)
  );
}
/**
 * Prisma field-operation keys whose `.set` / `.push` values may contain
 * the actual string payload. When we encounter one of these as a wrapper
 * around `content` or `excerpt`, we unwrap and sanitize the inner value.
 *
 * @see https://www.prisma.io/docs/concepts/components/prisma-client/advanced-type-safety/operating-against-partial-structures-with-type-safety
 */
const PRISMA_FIELD_OPERATIONS = new Set([
  "set",
]);

/**
 * Strip injected-memory blocks from a string value.
 */
function stripString(value: string): string {
  return stripInjectedMemoryBlocks(value, SERVER_MEMORY_SAVE_STRIP_MODE).content;
}

/**
 * Strip injected-memory blocks from a `content` or `excerpt` field if present
 * in the payload. Handles raw strings and Prisma field-operation objects
 * (e.g., `{ set: "..." }`). Mutates `data` in place.
 */
function stripField(
  data: Record<string, unknown>,
  field: "content" | "excerpt",
): void {
  const value = data[field];
  if (typeof value === "string") {
    data[field] = stripString(value);
  } else if (value && typeof value === "object" && !Array.isArray(value)) {
    // Prisma field-operation object, e.g. { set: "content..." }
    const fieldOp = value as Record<string, unknown>;
    for (const opKey of PRISMA_FIELD_OPERATIONS) {
      const opValue = fieldOp[opKey];
      if (typeof opValue === "string") {
        fieldOp[opKey] = stripString(opValue);
      }
    }
  }
}

/**
 * Recursively walk a Prisma write payload, stripping `content` and `excerpt`
 * fields wherever they appear. This simplified full-recursion approach handles
 * all Prisma nested write shapes including:
 *
 * - Single objects: `data: { content: "..." }`
 * - Nested arrays: `revisions: { create: [{ content: "..." }] }`
 * - `connectOrCreate`: `foo: { connectOrCreate: { create: { content: "..." } } }`
 * - Update wrappers: `revisions: { update: [{ where: ..., data: { content: "..." } }] }`
 * - Field operations: `data: { content: { set: "..." } }`
 *
 * By walking every nested object and array unconditionally, we avoid the
 * fragility of enumerating Prisma's many payload shapes.
 */
function stripFromNestedData(
  data: unknown,
  rejectEmpty: boolean,
): void {
  if (!data || typeof data !== "object") return;

  if (Array.isArray(data)) {
    for (const item of data) {
      stripFromNestedData(item, rejectEmpty);
    }
    return;
  }

  const record = data as Record<string, unknown>;

  // Strip content/excerpt fields at this level
  stripField(record, "content");
  stripField(record, "excerpt");

  // Reject if content was provided and is now empty
  if (rejectEmpty && "content" in record) {
    const content = record.content;
    if (typeof content === "string" && !content.trim()) {
      throw new Error(PERSISTENCE_LAYER_INJECTED_ONLY_ERROR);
    }
  }

  // Recurse into nested properties to handle Prisma nested write structures
  // (create, update, upsert, connectOrCreate, data wrappers, etc.).
  // Skip `where` keys — they are query conditions, not write payloads.
  // Stripping `where.content` would corrupt the query, not protect stored data.
  for (const [key, value] of Object.entries(record)) {
    if (key === "where") continue;
    if (value && typeof value === "object") {
      stripFromNestedData(value, rejectEmpty);
    }
  }
}

/**
 * Reject bulk writes (`createMany`, `updateMany`) that include `content` or
 * `excerpt` fields. Bulk operations are metadata-only; content writes must go
 * through `create`/`update`/`upsert` where the sanitizer runs.
 */
function rejectBulkContentFields(
  args: {
    data: Record<string, unknown> | Record<string, unknown>[];
  },
  operation: string,
): void {
  const items = Array.isArray(args.data) ? args.data : [args.data];
  for (const item of items) {
    if (item && typeof item === "object") {
      const record = item as Record<string, unknown>;
      if ("content" in record || "excerpt" in record) {
        throw new Error(
          `${PERSISTENCE_LAYER_BULK_CONTENT_ERROR_PREFIX}${operation} with content/excerpt fields. Use create/update/upsert for content writes.`,
        );
      }
    }
  }
}

/**
 * Handle Prisma `create` args. For `create`, `data` is always a single object.
 */
function handleCreateArgs(args: {
  data: Record<string, unknown>;
}): void {
  stripFromNestedData(args.data, true);
}

/**
 * Handle Prisma `update` args. `data` is always a single object.
 */
function handleUpdateArgs(args: {
  data: Record<string, unknown>;
}): void {
  stripFromNestedData(args.data, true);
}

/**
 * Handle Prisma `upsert` args. Has `create` and `update` sub-objects.
 */
function handleUpsertArgs(args: {
  create: Record<string, unknown>;
  update: Record<string, unknown>;
}): void {
  stripFromNestedData(args.create, true);
  stripFromNestedData(args.update, true);
}

/**
 * Build a query interceptor for a single model with create/update/upsert
 * sanitization and createMany/updateMany content rejection.
 */
function buildModelInterceptors() {
  return {
    async create({
      args,
      query,
    }: {
      args: { data: Record<string, unknown> };
      query: (args: unknown) => Promise<unknown>;
    }) {
      handleCreateArgs(args);
      return query(args);
    },

    async update({
      args,
      query,
    }: {
      args: { data: Record<string, unknown> };
      query: (args: unknown) => Promise<unknown>;
    }) {
      handleUpdateArgs(args);
      return query(args);
    },

    async upsert({
      args,
      query,
    }: {
      args: {
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      };
      query: (args: unknown) => Promise<unknown>;
    }) {
      handleUpsertArgs(args);
      return query(args);
    },

    async createMany({
      args,
      query,
    }: {
      args: { data: Record<string, unknown> | Record<string, unknown>[] };
      query: (args: unknown) => Promise<unknown>;
    }) {
      rejectBulkContentFields(args, "createMany");
      return query(args);
    },

    async updateMany({
      args,
      query,
    }: {
      args: { data: Record<string, unknown> };
      query: (args: unknown) => Promise<unknown>;
    }) {
      rejectBulkContentFields(args, "updateMany");
      return query(args);
    },
  };
}

/**
 * The Prisma client extension object. Apply via `prisma.$extends(articleSanitizerExtension)`.
 *
 * @see src/lib/prisma.ts for where this is applied.
 */
export const articleSanitizerExtension = {
  query: {
    article: buildModelInterceptors(),
    articleRevision: buildModelInterceptors(),
  },
};
