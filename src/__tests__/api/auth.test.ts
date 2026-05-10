import assert from "node:assert/strict";
import test from "node:test";
import { hasPermission, type AuthResult } from "@/lib/api/auth";
import type { Permissions, Role } from "@prisma/client";

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

test("hasPermission rejects unauthorized", () => {
  assert.equal(hasPermission({ authorized: false }, ["READ"]), false);
});

test("hasPermission rejects missing role/permissions", () => {
  assert.equal(hasPermission({ authorized: true }, ["READ"]), false);
});
