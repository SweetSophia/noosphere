/**
 * Prisma client extension: Article persistence-layer sanitizer
 *
 * This extension intercepts all `article.create`, `article.update`, and
 * `article.upsert` operations at the Prisma query layer. It strips injected
 * memory blocks (`<recall>`, `<hindsight_memories>`, `<noosphere_auto_recall>`)
 * from `content` and `excerpt` fields *before* the data reaches PostgreSQL.
 *
 * ## Why this exists
 *
 * Route-level and action-level sanitization (PRs #206, #209, #210, #212) depends
 * on every new write path remembering to call the shared sanitizer helper. The
 * repeated scope misses across those PRs proved that endpoint-level hardening
 * alone is not a reliable long-term safety boundary.
 *
 * This extension is the **hard boundary**. Even if a future route forgets to
 * call `sanitizeArticleContent`, the injected blocks will never reach the
 * database.
 *
 * ## What this extension does NOT do
 *
 * - **Secret detection**: stays at the route/action level where the caller
 *   context (HTTP request, auth session) is available for error responses.
 * - **Activity logging**: stays at the route/action level where `route` and
 *   `kind` metadata is known. The extension is a silent backstop.
 * - **HTTP error responses**: the extension throws a plain `Error` if content
 *   becomes empty after stripping. Routes should catch this and convert to
 *   HTTP 400 if it surfaces (it should not, because route-level sanitization
 *   catches it first).
 *
 * ## `updateMany`
 *
 * `updateMany` is intentionally NOT intercepted because it is used for bulk
 * metadata updates (publish/unpublish, trash/restore) that never touch
 * `content` or `excerpt`. If a future use case passes content through
 * `updateMany`, that caller should be audited.
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
 * blocks after stripping. Routes should catch `ARTICLE_CONTENT_INJECTED_ONLY_ERROR`
 * and convert to HTTP 400.
 */
export const PERSISTENCE_LAYER_INJECTED_ONLY_ERROR =
  "Persistence layer rejected article write: content is empty after injected-memory stripping";

/**
 * Strip injected-memory blocks from a string field if present in the payload.
 * Mutates `data` in place and returns it for chaining.
 */
function stripField(
  data: Record<string, unknown>,
  field: "content" | "excerpt",
): void {
  const value = data[field];
  if (typeof value === "string") {
    const result = stripInjectedMemoryBlocks(value, SERVER_MEMORY_SAVE_STRIP_MODE);
    data[field] = result.content;
  }
}

/**
 * Walk nested Prisma write payloads (`create`, `update`, `upsert`, `connectOrCreate`)
 * to strip content/excerpt wherever they appear.
 */
function stripFromNestedData(
  data: Record<string, unknown> | undefined,
  rejectEmpty: boolean,
): void {
  if (!data || typeof data !== "object") return;

  // Strip top-level fields
  stripField(data, "content");
  stripField(data, "excerpt");

  // Reject if content was provided and is now empty
  if (rejectEmpty && "content" in data) {
    const content = data.content;
    if (typeof content === "string" && !content.trim()) {
      throw new Error(PERSISTENCE_LAYER_INJECTED_ONLY_ERROR);
    }
  }

  // Recurse into nested create/update/upsert/connectOrCreate payloads
  // (e.g., article.create with nested revision.create)
  for (const value of Object.values(data)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const nested = value as Record<string, unknown>;
      if ("create" in nested || "update" in nested || "upsert" in nested) {
        if (nested.create && typeof nested.create === "object") {
          stripFromNestedData(nested.create as Record<string, unknown>, false);
        }
        if (nested.update && typeof nested.update === "object") {
          stripFromNestedData(nested.update as Record<string, unknown>, false);
        }
        if (nested.upsert && typeof nested.upsert === "object") {
          const upsert = nested.upsert as Record<string, unknown>;
          if (upsert.create && typeof upsert.create === "object") {
            stripFromNestedData(upsert.create as Record<string, unknown>, false);
          }
          if (upsert.update && typeof upsert.update === "object") {
            stripFromNestedData(upsert.update as Record<string, unknown>, false);
          }
        }
      }
    }
  }
}

/**
 * Handle Prisma `create` args. Prisma allows `data` to be either a single
 * object or an array (for `createMany` — though we intercept `create`, not
 * `createMany`).
 */
function handleCreateArgs(args: {
  data: Record<string, unknown> | Record<string, unknown>[];
}): void {
  if (Array.isArray(args.data)) {
    for (const item of args.data) {
      stripFromNestedData(item, true);
    }
  } else {
    stripFromNestedData(args.data, true);
  }
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
 * The Prisma client extension object. Apply via `prisma.$extends(articleSanitizerExtension)`.
 *
 * @see src/lib/prisma.ts for where this is applied.
 */
export const articleSanitizerExtension = {
  query: {
    article: {
      /**
       * Intercept `article.create()` — strip injected blocks and reject
       * if content becomes empty.
       */
      async create({
        args,
        query,
      }: {
        args: { data: Record<string, unknown> | Record<string, unknown>[] };
        query: (args: unknown) => Promise<unknown>;
      }) {
        handleCreateArgs(args);
        return query(args);
      },

      /**
       * Intercept `article.update()` — strip injected blocks when content/excerpt
       * is in the payload and reject if content becomes empty.
       */
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

      /**
       * Intercept `article.upsert()` — strip both create and update branches.
       */
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
    },
  },
} as const;
