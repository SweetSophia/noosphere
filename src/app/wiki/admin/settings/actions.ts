"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { upsertRecallSettings } from "@/lib/memory/api/settings";
import type { RecallSettings } from "@/lib/memory/settings";
import { cookies } from "next/headers";

async function requireAdmin() {
  const session = await getServerSession(authOptions);

  if (!session?.user || session.user.role !== "ADMIN") {
    throw new Error("Admin access required.");
  }

  return session;
}

export async function updateSettingsAction(formData: FormData) {
  await requireAdmin();

  // Parse form data into partial RecallSettings
  const updates: Partial<RecallSettings> = {};

  const autoRecallEnabled = formData.get("autoRecallEnabled");
  if (autoRecallEnabled !== null) {
    updates.autoRecallEnabled = autoRecallEnabled === "true" || autoRecallEnabled === "1";
  }

  const maxInjectedMemories = formData.get("maxInjectedMemories");
  if (maxInjectedMemories !== null && maxInjectedMemories !== "") {
    const n = parseInt(String(maxInjectedMemories), 10);
    if (!isNaN(n)) updates.maxInjectedMemories = n;
  }

  const maxInjectedTokens = formData.get("maxInjectedTokens");
  if (maxInjectedTokens !== null && maxInjectedTokens !== "") {
    const n = parseInt(String(maxInjectedTokens), 10);
    if (!isNaN(n)) updates.maxInjectedTokens = n;
  }

  const recallVerbosity = formData.get("recallVerbosity");
  if (typeof recallVerbosity === "string" && recallVerbosity !== "") {
    updates.recallVerbosity = recallVerbosity as RecallSettings["recallVerbosity"];
  }

  const summaryFirst = formData.get("summaryFirst");
  if (summaryFirst !== null) {
    updates.summaryFirst = summaryFirst === "true" || summaryFirst === "1";
  }

  const deduplicationStrategy = formData.get("deduplicationStrategy");
  if (typeof deduplicationStrategy === "string" && deduplicationStrategy !== "") {
    updates.deduplicationStrategy = deduplicationStrategy as RecallSettings["deduplicationStrategy"];
  }

  const conflictStrategy = formData.get("conflictStrategy");
  if (typeof conflictStrategy === "string" && conflictStrategy !== "") {
    updates.conflictStrategy = conflictStrategy as RecallSettings["conflictStrategy"];
  }

  const conflictThreshold = formData.get("conflictThreshold");
  if (conflictThreshold !== null && conflictThreshold !== "") {
    const n = parseFloat(String(conflictThreshold));
    if (!isNaN(n)) updates.conflictThreshold = n;
  }

  // enabledProviders is an array of checkboxes - collect all checked values
  const enabledProviders = formData.getAll("enabledProviders").map(String).filter(Boolean);
  updates.enabledProviders = enabledProviders;

  // providerPriorityWeights is a JSON string
  const providerPriorityWeightsRaw = formData.get("providerPriorityWeights");
  if (typeof providerPriorityWeightsRaw === "string" && providerPriorityWeightsRaw.trim() !== "") {
    try {
      const parsed = JSON.parse(providerPriorityWeightsRaw);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        updates.providerPriorityWeights = parsed;
      }
    } catch {
      // Ignore invalid JSON - keep existing value
    }
  }

  await upsertRecallSettings(updates);

  // Set flash cookie
  (await cookies()).set("settings_flash", "Settings updated successfully.", {
    httpOnly: true,
    secure: true,
    maxAge: 30,
    path: "/wiki/admin/settings",
    sameSite: "lax",
  });

  revalidatePath("/wiki/admin/settings");
  redirect("/wiki/admin/settings");
}
