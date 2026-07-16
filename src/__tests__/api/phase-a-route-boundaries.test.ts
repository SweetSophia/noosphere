import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { NextRequest } from "next/server";
import { Permissions } from "@prisma/client";
import {
  DELETE as deleteKey,
  PATCH as updateKey,
} from "@/app/api/keys/[id]/route";
import { POST as createKey } from "@/app/api/keys/route";
import {
  DELETE as deleteCapture,
  GET as getCapture,
} from "@/app/api/memory/captures/[id]/route";
import {
  DELETE as deletePrincipal,
  GET as getPrincipal,
} from "@/app/api/memory/principals/[id]/route";
import {
  GET as listPrincipals,
  POST as createPrincipal,
} from "@/app/api/memory/principals/route";
import { POST as createRevocation } from "@/app/api/memory/revocations/route";
import { DELETE as deleteScope } from "@/app/api/scopes/[tag]/route";
import { generateApiKey } from "@/lib/api/keys";
import { prisma } from "@/lib/prisma";

type RouteHandler = (
  request: NextRequest,
  context?: unknown,
) => Promise<Response>;

const handlers: Array<{
  name: string;
  handler: RouteHandler;
  context?: unknown;
}> = [
  { name: "key creation", handler: createKey as RouteHandler },
  {
    name: "key update",
    handler: updateKey as RouteHandler,
    context: { params: Promise.resolve({ id: "missing-key" }) },
  },
  {
    name: "key deletion",
    handler: deleteKey as RouteHandler,
    context: { params: Promise.resolve({ id: "missing-key" }) },
  },
  {
    name: "capture detail",
    handler: getCapture as RouteHandler,
    context: { params: Promise.resolve({ id: "missing-capture" }) },
  },
  {
    name: "capture deletion",
    handler: deleteCapture as RouteHandler,
    context: { params: Promise.resolve({ id: "missing-capture" }) },
  },
  {
    name: "principal detail",
    handler: getPrincipal as RouteHandler,
    context: { params: Promise.resolve({ id: "missing-principal" }) },
  },
  {
    name: "principal deletion",
    handler: deletePrincipal as RouteHandler,
    context: { params: Promise.resolve({ id: "missing-principal" }) },
  },
  { name: "principal listing", handler: listPrincipals as RouteHandler },
  { name: "principal creation", handler: createPrincipal as RouteHandler },
  { name: "session revocation", handler: createRevocation as RouteHandler },
  {
    name: "scope deletion",
    handler: deleteScope as RouteHandler,
    context: { params: Promise.resolve({ tag: "missing-scope" }) },
  },
];

test("Phase A routes bound failures before rate limiting or auth", async () => {
  const secret = "noo_route-boundary-secret";
  const calls: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => calls.push(args);

  try {
    for (const { name, handler, context } of handlers) {
      const request = Object.create(null) as NextRequest;
      Object.defineProperty(request, "headers", {
        get() {
          throw new Error(`${secret}-${name}`);
        },
      });

      const response = await handler(request, context);
      assert.equal(response.status, 500, name);
      assert.deepEqual(await response.json(), { error: "Internal server error" }, name);
    }

    const serializedLogs = JSON.stringify(calls);
    assert.doesNotMatch(serializedLogs, new RegExp(secret));
    assert.equal(calls.length, handlers.length);
  } finally {
    console.error = original;
  }
});

function adminRequest(
  rawKey: string,
  pathname: string,
  method: "POST" | "DELETE",
  body?: unknown,
): NextRequest {
  return new NextRequest(`http://localhost${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${rawKey}`,
      "Content-Type": "application/json",
      "x-forwarded-for": "127.0.0.1",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function rejectingParams<T>(message: string): Promise<T> {
  return {
    then() {
      throw new Error(message);
    },
  } as unknown as Promise<T>;
}

test("Phase A routes bound late failures and preserve domain error mappings", async () => {
  const suffix = crypto.randomUUID();
  const keyName = `phase-a-route-boundary-${suffix}`;
  const scopeTag = `phase-a-route-${suffix}`;
  const principalName = `Phase A route ${suffix}`;
  const generated = generateApiKey(keyName);
  const previousCaptureEnabled = process.env.NOOSPHERE_AUTO_MEMORY_CAPTURE_ENABLED;
  const previousHmacVersion = process.env.NOOSPHERE_MEMORY_CAPTURE_HMAC_ACTIVE_VERSION;
  const previousHmacKeys = process.env.NOOSPHERE_MEMORY_CAPTURE_HMAC_KEYS;

  await prisma.restrictedScope.create({ data: { tag: scopeTag } });
  const adminKey = await prisma.apiKey.create({
    data: {
      name: keyName,
      keyHash: generated.hash,
      keyPrefix: generated.prefix,
      permissions: Permissions.ADMIN,
      allowedScopes: ["*"],
    },
  });

  process.env.NOOSPHERE_AUTO_MEMORY_CAPTURE_ENABLED = "false";
  process.env.NOOSPHERE_MEMORY_CAPTURE_HMAC_ACTIVE_VERSION = "1";
  process.env.NOOSPHERE_MEMORY_CAPTURE_HMAC_KEYS = JSON.stringify({
    1: `base64:${Buffer.alloc(32, 0x41).toString("base64")}`,
  });

  const secret = "noo_late-route-secret";
  const calls: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => calls.push(args);

  try {
    const lateFailures: Array<{
      name: string;
      response: Promise<Response>;
    }> = [
      {
        name: "key params",
        response: deleteKey(
          adminRequest(generated.raw, "/api/keys/missing", "DELETE"),
          { params: rejectingParams(`${secret}-key`) },
        ),
      },
      {
        name: "capture params",
        response: deleteCapture(
          adminRequest(generated.raw, "/api/memory/captures/missing", "DELETE"),
          { params: rejectingParams(`${secret}-capture`) },
        ),
      },
      {
        name: "principal params",
        response: deletePrincipal(
          adminRequest(generated.raw, "/api/memory/principals/missing", "DELETE"),
          { params: rejectingParams(`${secret}-principal`) },
        ),
      },
      {
        name: "scope params",
        response: deleteScope(
          adminRequest(generated.raw, "/api/scopes/missing", "DELETE"),
          { params: rejectingParams(`${secret}-scope`) },
        ),
      },
    ];

    for (const { name, response } of lateFailures) {
      const resolved = await response;
      assert.equal(resolved.status, 500, name);
      assert.deepEqual(await resolved.json(), { error: "Internal server error" }, name);
    }
    assert.doesNotMatch(JSON.stringify(calls), new RegExp(secret));

    const createBody = { name: principalName, privateScopeTag: scopeTag };
    const firstCreate = await createPrincipal(
      adminRequest(generated.raw, "/api/memory/principals", "POST", createBody),
    );
    assert.equal(firstCreate.status, 201);
    assert.equal(firstCreate.headers.get("cache-control"), "private, no-store");
    const duplicateCreate = await createPrincipal(
      adminRequest(generated.raw, "/api/memory/principals", "POST", createBody),
    );
    assert.equal(duplicateCreate.status, 409);
    assert.deepEqual(await duplicateCreate.json(), {
      error: "Principal name already exists",
    });

    const deleteCreate = await createPrincipal(
      adminRequest(generated.raw, "/api/memory/principals", "POST", {
        ...createBody,
        name: `${principalName}-delete`,
      }),
    );
    assert.equal(deleteCreate.status, 201);
    const deletePrincipalId = (await deleteCreate.json()).principal.id as string;
    const deletedPrincipal = await deletePrincipal(
      adminRequest(
        generated.raw,
        `/api/memory/principals/${deletePrincipalId}`,
        "DELETE",
      ),
      { params: Promise.resolve({ id: deletePrincipalId }) },
    );
    assert.equal(deletedPrincipal.status, 200);
    assert.equal(
      deletedPrincipal.headers.get("cache-control"),
      "private, no-store",
    );

    const principalMissing = await deletePrincipal(
      adminRequest(generated.raw, "/api/memory/principals/missing", "DELETE"),
      { params: Promise.resolve({ id: "missing-principal" }) },
    );
    assert.equal(principalMissing.status, 404);
    assert.deepEqual(await principalMissing.json(), {
      error: "Memory principal not found",
    });

    const revocationMissing = await createRevocation(
      adminRequest(generated.raw, "/api/memory/revocations", "POST", {
        kind: "session",
        principalId: "missing-principal",
        sourceSessionId: "missing-session",
      }),
    );
    assert.equal(revocationMissing.status, 404);
    assert.deepEqual(await revocationMissing.json(), {
      error: "Memory principal not found",
    });

    const scopeMissing = await deleteScope(
      adminRequest(generated.raw, "/api/scopes/missing-scope", "DELETE"),
      { params: Promise.resolve({ tag: "missing-scope" }) },
    );
    assert.equal(scopeMissing.status, 404);
    assert.deepEqual(await scopeMissing.json(), {
      error: "Restricted scope not found",
    });
  } finally {
    console.error = original;
    const principals = await prisma.memoryAgentPrincipal.findMany({
      where: { name: { in: [principalName, `${principalName}-delete`] } },
      select: { id: true },
    });
    const principalIds = principals.map(({ id }) => id);
    if (principalIds.length > 0) {
      await prisma.memoryDurableJob.deleteMany({
        where: { agentPrincipalId: { in: principalIds } },
      });
      await prisma.memoryLineageState.deleteMany({
        where: { agentPrincipalId: { in: principalIds } },
      });
      await prisma.memoryAgentPrincipal.deleteMany({
        where: { id: { in: principalIds } },
      });
    }
    await prisma.memoryLineageState.deleteMany({
      where: { kind: "SCOPE", subjectHash: `scope:${scopeTag}` },
    });
    await prisma.apiKey.deleteMany({ where: { id: adminKey.id } });
    await prisma.restrictedScope.deleteMany({ where: { tag: scopeTag } });

    restoreEnv(
      "NOOSPHERE_AUTO_MEMORY_CAPTURE_ENABLED",
      previousCaptureEnabled,
    );
    restoreEnv(
      "NOOSPHERE_MEMORY_CAPTURE_HMAC_ACTIVE_VERSION",
      previousHmacVersion,
    );
    restoreEnv("NOOSPHERE_MEMORY_CAPTURE_HMAC_KEYS", previousHmacKeys);
  }
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
