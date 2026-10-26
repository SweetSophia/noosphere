import { Prisma, type PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export class TaxonomyConflict extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
  }
}

type TopicPatch = {
  name?: string;
  slug?: string;
  parentId?: string | null;
  description?: unknown;
};

/**
 * Serializable reads of the proposed ancestor chain prevent write-skew between
 * opposing moves, even when they update different rows. Retry the WHOLE read /
 * validation / write operation, never just the failed write. Both application
 * entry points use this helper; omitted parentId is not written back stale.
 */
type TransactionClient = Prisma.TransactionClient;

/**
 * Create or update a child and attach it in one serializable transaction. Seed
 * data must never expose a detached topic if validation or the attach write
 * fails. A concurrent creator can win the unique-slug race; the whole operation
 * is then retried so the loser observes and updates the committed row.
 */
export async function upsertTopicWithParentSafely(
  data: { name: string; slug: string; description?: string | null; parentId: string },
  client: Pick<PrismaClient, "$transaction"> = prisma,
) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await client.$transaction(async (tx) => {
        const existing = await tx.topic.findUnique({ where: { slug: data.slug } });
        if (existing) {
          await assertValidParent(tx, existing.id, data.parentId);
          return tx.topic.update({
            where: { id: existing.id },
            data: {
              name: data.name.trim(),
              description: data.description ?? null,
              parentId: data.parentId,
            },
          });
        }
        await assertValidParent(tx, null, data.parentId);
        return tx.topic.create({
          data: {
            name: data.name.trim(),
            slug: data.slug,
            description: data.description ?? null,
            parentId: data.parentId,
          },
        });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if ((isTransactionConflict(error) || isPrismaCode(error, "P2002") || isPrismaCode(error, "P2025"))
        && attempt < 2) continue;
      if (isPrismaCode(error, "P2002")) {
        throw new TaxonomyConflict("Slug already in use by another topic", 409);
      }
      throw error;
    }
  }
  throw new TaxonomyConflict("Topic hierarchy changed concurrently; retry the operation", 409);
}

export async function updateTopicSafely(
  id: string,
  patch: TopicPatch,
  client: Pick<PrismaClient, "$transaction"> = prisma,
) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await client.$transaction(async (tx) => {
        const existing = await tx.topic.findUnique({ where: { id } });
        if (!existing) throw new TaxonomyConflict("Topic not found", 404);
        if (patch.parentId !== undefined) {
          await assertValidParent(tx, id, patch.parentId);
        }
        const slug = patch.slug ?? existing.slug;
        if (slug !== existing.slug && await tx.topic.findUnique({ where: { slug } })) {
          throw new TaxonomyConflict("Slug already in use by another topic", 409);
        }
        return tx.topic.update({
          where: { id },
          data: {
            ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
            ...(patch.slug !== undefined ? { slug } : {}),
            ...(patch.parentId !== undefined ? { parentId: patch.parentId } : {}),
            ...(patch.description !== undefined ? {
              description: typeof patch.description === "string" ? patch.description.trim() || null : null,
            } : {}),
          },
        });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (isTransactionConflict(error)) {
        if (attempt < 2) continue;
        throw new TaxonomyConflict("Topic hierarchy changed concurrently; retry the operation", 409);
      }
      if (isPrismaCode(error, "P2002")) {
        throw new TaxonomyConflict("Slug already in use by another topic", 409);
      }
      throw error;
    }
  }
  throw new TaxonomyConflict("Topic hierarchy changed concurrently; retry the operation", 409);
}

async function assertValidParent(
  tx: TransactionClient,
  topicId: string | null,
  parentId: string | null,
): Promise<void> {
  const visited = new Set(topicId ? [topicId] : []);
  let ancestor: string | null = parentId;
  while (ancestor !== null) {
    if (visited.has(ancestor)) {
      throw new TaxonomyConflict("Cannot set a descendant or cyclic hierarchy as the parent (cycle)", 400);
    }
    visited.add(ancestor);
    const parent = await tx.topic.findUnique({ where: { id: ancestor } });
    if (!parent) throw new TaxonomyConflict("Parent topic not found", 400);
    ancestor = parent.parentId;
  }
}

export function isPrismaCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}


function isTransactionConflict(error: unknown): boolean {
  if (isPrismaCode(error, "P2034")) return true;
  if (isPrismaCode(error, "P2010")) {
    const known = error as {
      message?: unknown;
      meta?: { code?: unknown; driverAdapterError?: unknown; cause?: unknown };
      cause?: unknown;
    };
    return [known.meta?.code, known.meta?.driverAdapterError, known.meta?.cause, known.cause, known.message]
      .some((detail) => hasSerializationConflict(detail));
  }
  // Prisma's pg adapter can surface commit-time SSI failures directly instead
  // of wrapping them in P2034. Do not retry arbitrary driver/application errors.
  if (!(error instanceof Error) || error.name !== "DriverAdapterError") return false;
  return hasSerializationConflict(error.cause);
}

function hasSerializationConflict(detail: unknown, depth = 0): boolean {
  if (depth > 3) return false;
  if (typeof detail === "string") return /\b(?:40001|40P01)\b/.test(detail);
  if (typeof detail !== "object" || detail === null) return false;
  const record = detail as Record<string, unknown>;
  return ["code", "originalCode", "sqlState", "message", "kind", "cause", "driverAdapterError", "originalError"]
    .some((key) => hasSerializationConflict(record[key], depth + 1));
}
