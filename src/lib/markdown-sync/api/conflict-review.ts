/**
 * Sync conflict review persistence helpers.
 *
 * These helpers intentionally record review decisions without applying markdown
 * back into Noosphere yet. Reverse scan/import/apply is handled by later phases.
 */

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  statusForSyncConflictReviewAction,
  type SyncConflictReviewAction,
  type SyncConflictReviewCreateInput,
} from "@/lib/markdown-sync/conflict-review";

export async function recordSyncConflictReview(input: SyncConflictReviewCreateInput) {
  const now = new Date();

  try {
    return await prisma.syncConflictReview.create({
      data: {
        articleId: input.articleId,
        direction: input.direction,
        relativePath: input.relativePath,
        archivePath: input.archivePath,
        noosphereHash: input.noosphereHash,
        markdownHash: input.markdownHash,
        noosphereUpdatedAt: input.noosphereUpdatedAt,
        markdownUpdatedAt: input.markdownUpdatedAt,
        summary: input.summary as unknown as Prisma.InputJsonValue,
        updatedAt: now,
      },
    });
  } catch (error) {
    if (!isPrismaUniqueConstraintError(error)) {
      throw error;
    }

    // Archive paths include a timestamp, so a duplicate should be rare. If it
    // does happen, preserve the existing review state rather than reopening a
    // conflict that an admin may already have resolved.
    const existing = await prisma.syncConflictReview.findUnique({
      where: { archivePath: input.archivePath },
    });
    if (existing) return existing;
    throw error;
  }
}

export async function resolveSyncConflictReview(args: {
  id: string;
  action: SyncConflictReviewAction;
  resolvedBy: string;
}) {
  const status = statusForSyncConflictReviewAction(args.action);
  const resolvedAt = new Date();

  return prisma.$transaction(async (tx) => {
    const review = await tx.syncConflictReview.update({
      where: { id: args.id },
      data: {
        status,
        resolution: args.action,
        resolvedAt,
        resolvedBy: args.resolvedBy,
      },
    });

    await tx.activityLog.create({
      data: {
        type: "sync-conflict",
        title: `Sync conflict ${status} — ${review.relativePath}`,
        authorName: args.resolvedBy,
        details: {
          conflictId: review.id,
          action: args.action,
          status,
          archivePath: review.archivePath,
          articleId: review.articleId,
        },
      },
    });

    return review;
  });
}

function isPrismaUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}
