"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { generateApiKey } from "@/lib/api/keys";

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

  const { raw, hash, prefix } = generateApiKey(name);

  await prisma.apiKey.create({
    data: {
      name,
      keyHash: hash,
      keyPrefix: prefix,
      permissions: permissions as "READ" | "WRITE" | "ADMIN",
    },
  });

  revalidatePath("/wiki/admin/keys");
  redirect(`/wiki/admin/keys?created=${encodeURIComponent(raw)}&name=${encodeURIComponent(name)}`);
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
