"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { generateApiKey } from "@/lib/api/keys";
import { cookies } from "next/headers";

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

  const { raw, hash, prefix } = generateApiKey(name);

  await prisma.apiKey.create({
    data: {
      name,
      keyHash: hash,
      keyPrefix: prefix,
      permissions: permissions as "READ" | "WRITE" | "ADMIN",
      allowedScopes: rawScopes,
    },
  });

  // Flash the raw key via HttpOnly cookie instead of URL query param
  // so it never appears in server logs, browser history, or Referer headers
  (await cookies()).set("api_key_flash", raw, {
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

  await prisma.apiKey.update({
    where: { id },
    data: { allowedScopes: rawScopes },
  });

  revalidatePath("/wiki/admin/keys");
  redirect("/wiki/admin/keys");
}

export async function revokeApiKeyAction(formData: FormData) {
  await requireAdmin();

  const id = String(formData.get("id") ?? "").trim();
  if (!id) {
    throw new Error("Key ID missing.");
  }

  await prisma.apiKey.update({
    where: { id },
    data: { revokedAt: new Date() },
  });

  revalidatePath("/wiki/admin/keys");
  redirect("/wiki/admin/keys");
}
