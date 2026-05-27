"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import {
  isSyncConflictReviewAction,
  SYNC_CONFLICT_REVIEW_STATUSES,
  type SyncConflictReviewAction,
  type SyncConflictReviewStatus,
} from "@/lib/markdown-sync/conflict-review";
import { resolveSyncConflictReview } from "@/lib/markdown-sync/api/conflict-review";

async function requireAdminName() {
  const session = await getServerSession(authOptions);

  if (!session?.user || session.user.role !== "ADMIN") {
    throw new Error("Admin access required.");
  }

  return session.user.name ?? session.user.email ?? "Admin";
}

export async function resolveSyncConflictAction(formData: FormData) {
  const resolvedBy = await requireAdminName();
  const id = formData.get("conflictId");
  const action = formData.get("action");
  const returnStatus = normalizeReturnStatus(formData.get("returnStatus"));

  if (typeof id !== "string" || !id) {
    throw new Error("Missing conflict id.");
  }

  if (!isSyncConflictReviewAction(action)) {
    throw new Error("Unsupported conflict action.");
  }

  await resolveSyncConflictReview({
    id,
    action: action as SyncConflictReviewAction,
    resolvedBy,
  });

  revalidatePath("/wiki/admin/sync-conflicts");
  redirect(`/wiki/admin/sync-conflicts?status=${returnStatus}`);
}

function normalizeReturnStatus(value: FormDataEntryValue | null): SyncConflictReviewStatus {
  return SYNC_CONFLICT_REVIEW_STATUSES.includes(value as SyncConflictReviewStatus)
    ? (value as SyncConflictReviewStatus)
    : "open";
}
