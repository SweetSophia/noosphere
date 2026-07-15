"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { cookies } from "next/headers";
import {
  createApiKeyRecord,
  deleteRevokedApiKey,
  revokeApiKeyCredential,
  rotateApiKeyCredential,
  updateApiKeyRecord,
} from "@/lib/api/key-mutations";

async function requireAdmin() {
  const session = await getServerSession(authOptions);

  if (!session?.user || session.user.role !== "ADMIN") {
    throw new Error("Admin access required.");
  }

  return session;
}

export async function createApiKeyAction(formData: FormData) {
  await requireAdmin();

  const name = String(formData.get("name") ?? "").trim();
  const permissions = String(formData.get("permissions") ?? "WRITE").trim();
  const agentPrincipalId = String(formData.get("agentPrincipalId") ?? "").trim();

  if (!name) {
    throw new Error("Key name is required.");
  }

  if (!["READ", "WRITE", "ADMIN"].includes(permissions)) {
    throw new Error("Invalid permissions.");
  }

  // Collect scopes from checkbox fields
  const rawScopes: string[] = [];
  formData.forEach((value, key) => {
    if (key === "scopes" && typeof value === "string") {
      rawScopes.push(value);
    }
  });

  // Validate scopes exist
  if (rawScopes.length > 0) {
    const validScopes = await prisma.restrictedScope.findMany({
      where: { tag: { in: rawScopes } },
      select: { tag: true },
    });
    const validSet = new Set(validScopes.map((s) => s.tag));
    const invalid = rawScopes.filter((s) => !validSet.has(s) && s !== "*");
    if (invalid.length > 0) {
      throw new Error(`Unknown scope(s): ${invalid.join(", ")}`);
    }
  }

  const created = await createApiKeyRecord({
    name,
    permissions: permissions as "READ" | "WRITE" | "ADMIN",
    allowedScopes: rawScopes,
    agentPrincipalId: agentPrincipalId || null,
  });

  // Flash the raw key via HttpOnly cookie instead of URL query param
  // so it never appears in server logs, browser history, or Referer headers
  (await cookies()).set("api_key_flash", created.raw, {
    httpOnly: true,
    secure: true,
    maxAge: 60,
    path: "/wiki/admin/keys",
    sameSite: "lax",
  });

  revalidatePath("/wiki/admin/keys");
  redirect(`/wiki/admin/keys?flash=1&name=${encodeURIComponent(name)}`);
}

export async function updateApiKeyScopesAction(formData: FormData) {
  await requireAdmin();

  const id = String(formData.get("id") ?? "").trim();
  if (!id) {
    throw new Error("Key ID missing.");
  }

  const key = await prisma.apiKey.findUnique({ where: { id } });
  if (!key) {
    throw new Error("Key not found.");
  }
  if (key.revokedAt) {
    throw new Error("Cannot update scopes on a revoked key.");
  }

  // Collect scopes from checkbox fields
  const rawScopes: string[] = [];
  formData.forEach((value, key) => {
    if (key === "scopes" && typeof value === "string") {
      rawScopes.push(value);
    }
  });

  // Validate scopes exist
  if (rawScopes.length > 0) {
    const validScopes = await prisma.restrictedScope.findMany({
      where: { tag: { in: rawScopes } },
      select: { tag: true },
    });
    const validSet = new Set(validScopes.map((s) => s.tag));
    const invalid = rawScopes.filter((s) => !validSet.has(s) && s !== "*");
    if (invalid.length > 0) {
      throw new Error(`Unknown scope(s): ${invalid.join(", ")}`);
    }
  }

  await updateApiKeyRecord(id, { allowedScopes: rawScopes });

  revalidatePath("/wiki/admin/keys");
  redirect("/wiki/admin/keys");
}

export async function revokeApiKeyAction(formData: FormData) {
  await requireAdmin();

  const id = String(formData.get("id") ?? "").trim();
  if (!id) {
    throw new Error("Key ID missing.");
  }

  await revokeApiKeyCredential(id);

  revalidatePath("/wiki/admin/keys");
  redirect("/wiki/admin/keys");
}

export async function rotateApiKeyAction(formData: FormData) {
  await requireAdmin();

  const id = String(formData.get("id") ?? "").trim();
  if (!id) {
    throw new Error("Key ID missing.");
  }

  const rotated = await rotateApiKeyCredential(id);

  // Flash the new raw key so it can be shown to the user
  (await cookies()).set("api_key_flash", rotated.raw, {
    httpOnly: true,
    secure: true,
    maxAge: 60,
    path: "/wiki/admin/keys",
    sameSite: "lax",
  });

  revalidatePath("/wiki/admin/keys");
  redirect(`/wiki/admin/keys?flash=1&name=${encodeURIComponent(rotated.key.name)}`);
}

export async function deleteApiKeyAction(formData: FormData) {
  await requireAdmin();

  const id = String(formData.get("id") ?? "").trim();
  if (!id) {
    throw new Error("Key ID missing.");
  }

  const key = await prisma.apiKey.findUnique({ where: { id } });
  if (!key) {
    throw new Error("Key not found.");
  }
  if (!key.revokedAt) {
    throw new Error("Only revoked keys can be permanently deleted.");
  }

  await deleteRevokedApiKey(id);

  revalidatePath("/wiki/admin/keys");
  redirect("/wiki/admin/keys");
}
