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

  return prisma.syncConflictReview.upsert({
    where: { archivePath: input.archivePath },
    update: {
      articleId: input.articleId,
      direction: input.direction,
      status: "open",
      resolution: null,
      relativePath: input.relativePath,
      noosphereHash: input.noosphereHash,
      markdownHash: input.markdownHash,
      noosphereUpdatedAt: input.noosphereUpdatedAt,
      markdownUpdatedAt: input.markdownUpdatedAt,
      summary: input.summary as unknown as Prisma.InputJsonValue,
      resolvedAt: null,
      resolvedBy: null,
      updatedAt: now,
    },
    create: {
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
}

export async function resolveSyncConflictReview(args: {
  id: string;
  action: SyncConflictReviewAction;
  resolvedBy: string;
}) {
  const status = statusForSyncConflictReviewAction(args.action);
  const resolvedAt = new Date();

  const review = await prisma.syncConflictReview.update({
    where: { id: args.id },
    data: {
      status,
      resolution: args.action,
      resolvedAt,
      resolvedBy: args.resolvedBy,
    },
  });

  await prisma.activityLog.create({
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
}
