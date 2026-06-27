import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";
import { NextRequest } from "next/server";
import { checkRouteAuth, hasPermission, type AuthResult } from "@/lib/api/auth";
import { hashApiKey } from "@/lib/api/keys";
import { prisma } from "@/lib/prisma";
import type { Permissions, Role } from "@prisma/client";

after(async () => {
  await prisma.$disconnect();
});

function authWithPermissions(permissions: Permissions): AuthResult {
  return { authorized: true, permissions, keyId: "key-1" };
}

function authWithRole(role: Role): AuthResult {
  return { authorized: true, role, userId: "user-1" };
}

test("hasPermission allows empty required array for any authenticated user", () => {
  assert.equal(hasPermission(authWithPermissions("READ"), []), true);
  assert.equal(hasPermission(authWithRole("VIEWER"), []), true);
});

test("hasPermission checks API key hierarchy", () => {
  const admin = authWithPermissions("ADMIN");
  const write = authWithPermissions("WRITE");
  const read = authWithPermissions("READ");

  assert.equal(hasPermission(admin, ["READ"]), true);
  assert.equal(hasPermission(admin, ["WRITE"]), true);
  assert.equal(hasPermission(admin, ["ADMIN"]), true);

  assert.equal(hasPermission(write, ["READ"]), true);
  assert.equal(hasPermission(write, ["WRITE"]), true);
  assert.equal(hasPermission(write, ["ADMIN"]), false);

  assert.equal(hasPermission(read, ["READ"]), true);
  assert.equal(hasPermission(read, ["WRITE"]), false);
  assert.equal(hasPermission(read, ["ADMIN"]), false);
});

test("hasPermission checks session role hierarchy", () => {
  const admin = authWithRole("ADMIN");
  const editor = authWithRole("EDITOR");
  const viewer = authWithRole("VIEWER");

  assert.equal(hasPermission(admin, ["READ"]), true);
  assert.equal(hasPermission(admin, ["WRITE"]), true);
  assert.equal(hasPermission(admin, ["ADMIN"]), true);

  assert.equal(hasPermission(editor, ["READ"]), true);
  assert.equal(hasPermission(editor, ["WRITE"]), true);
  assert.equal(hasPermission(editor, ["ADMIN"]), false);

  assert.equal(hasPermission(viewer, ["READ"]), true);
  assert.equal(hasPermission(viewer, ["WRITE"]), false);
  assert.equal(hasPermission(viewer, ["ADMIN"]), false);
});

test("topic creation policy can preserve editor sessions while requiring admin API keys", () => {
  const adminKey = authWithPermissions("ADMIN");
  const writeKey = authWithPermissions("WRITE");
  const editorSession = authWithRole("EDITOR");
  const viewerSession = authWithRole("VIEWER");

  assert.equal(hasPermission(adminKey, ["ADMIN"]), true);
  assert.equal(hasPermission(writeKey, ["ADMIN"]), false);
  assert.equal(hasPermission(editorSession, ["WRITE"]), true);
  assert.equal(hasPermission(viewerSession, ["WRITE"]), false);
});

test("hasPermission rejects unauthorized", () => {
  assert.equal(hasPermission({ authorized: false }, ["READ"]), false);
});

test("hasPermission rejects missing role/permissions", () => {
  assert.equal(hasPermission({ authorized: true }, ["READ"]), false);
});

test(
  "checkRouteAuth includes API key names for audit authors",
  { skip: !process.env.DATABASE_URL },
  async () => {
    const runId = crypto.randomUUID();
    const rawKey = `noo_${crypto.randomBytes(32).toString("base64url")}`;
    const keyName = `test-auth-name-${runId}`;
    const apiKey = await prisma.apiKey.create({
      data: {
        name: keyName,
        keyHash: hashApiKey(rawKey),
        keyPrefix: rawKey.slice(0, 8),
        permissions: "WRITE",
        allowedScopes: ["*"],
      },
    });

    try {
      const request = new NextRequest("http://localhost/api/lint", {
        headers: { Authorization: `Bearer ${rawKey}` },
      });

      const auth = await checkRouteAuth(request);

      assert.equal(auth.authorized, true);
      assert.equal(auth.keyId, apiKey.id);
      assert.equal(auth.name, keyName);
      assert.equal(auth.permissions, "WRITE");
    } finally {
      await prisma.apiKey.delete({ where: { id: apiKey.id } }).catch(() => undefined);
    }
  },
);
