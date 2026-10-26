import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { ESLint } from "eslint";

const rootUrl = new URL("../../../", import.meta.url);
const eslint = new ESLint({ cwd: fileURLToPath(rootUrl) });

async function roleDiagnostics(source: string, relativePath: string) {
  const [result] = await eslint.lintText(source, {
    filePath: fileURLToPath(new URL(relativePath, rootUrl)),
  });
  assert.equal(result.fatalErrorCount, 0, "lint input must parse successfully");
  return result.messages.filter(({ ruleId }) => ruleId === "no-restricted-syntax");
}

for (const [name, expression] of [
  ["dot comparison", 'auth.role !== "ADMIN"'],
  ["bracket comparison", 'auth["role"] !== "ADMIN"'],
  ["reversed comparison", '"ADMIN" !== auth.role'],
  ["compound role-only check", 'auth.role !== "EDITOR" && auth.role !== "ADMIN"'],
]) {
  test(`route auth lint rejects ${name}`, async () => {
    const diagnostics = await roleDiagnostics(
      `export function canWrite(auth: { role?: string }) { return ${expression}; }`,
      "src/app/api/lint-policy-probe/route.ts",
    );
    assert.ok(diagnostics.length > 0, "role-only authorization must remain rejected");
  });
}

// Conservative route policy: reject extracting any statically named role from
// route-local values, rather than guessing which aliases originate in AuthResult.
for (const [name, body] of [
  ["truthiness", "return !!auth.role;"],
  ["unary", "return !auth.role;"],
  ["logical", "return auth.role && true;"],
  ["optional access", "return auth?.role;"],
  ["role alias", 'const level = auth.role; return level === "ADMIN";'],
  ["auth alias", 'const caller = auth; return caller.role === "ADMIN";'],
  ["bracket alias", 'const caller = auth; return caller["role"] === "ADMIN";'],
  ["destructuring", 'const { role } = auth; return role === "ADMIN";'],
  ["renamed destructuring", 'const { role: access } = auth; return access === "ADMIN";'],
  ["literal destructuring", 'const { "role": access } = auth; return access === "ADMIN";'],
  ["default destructuring", 'const { role = "VIEWER" } = auth; return role === "ADMIN";'],
  ["renamed source", 'const user = auth; const { role: access } = user; return access === "ADMIN";'],
  ["nested auth", 'const result = { auth }; return result.auth.role === "ADMIN";'],
]) {
  test(`route auth lint rejects ${name}`, async () => {
    assert.ok((await roleDiagnostics(
      `export function canWrite(auth: { role?: string }) { ${body} }`,
      "src/app/api/lint-policy-probe/route.ts",
    )).length > 0);
  });
}

test("route auth lint rejects parameter destructuring", async () => {
  assert.ok((await roleDiagnostics(
    'export function canWrite({ role: access }: { role?: string }) { return access === "ADMIN"; }',
    "src/app/api/lint-policy-probe/route.ts",
  )).length > 0);
});

test("route policy does not prohibit human-session role reads outside API routes", async () => {
  assert.equal((await roleDiagnostics(
    'export function canEdit(session: { role?: string }) { return session.role === "ADMIN"; }',
    "src/lib/lint-policy-probe.ts",
  )).length, 0);
});

test("route auth lint accepts shared permission helpers", async () => {
  const diagnostics = await roleDiagnostics(
    'import { hasPermission } from "@/lib/api/auth";\n' +
      'export function canWrite(auth: Parameters<typeof hasPermission>[0]) { return hasPermission(auth, ["WRITE"]); }',
    "src/app/api/lint-policy-probe/route.ts",
  );
  assert.equal(diagnostics.length, 0);
});

// These are narrowly documented policy exceptions, not route/file exclusions.
// Re-lint their real source to detect stale comments, wider suppressions, or a
// configuration change that silently disables the guard on either whole file.
for (const relativePath of [
  "src/app/api/import/route.ts",
  "src/app/api/memory/captures/[id]/route.ts",
]) {
  test(`${relativePath}: policy exception stays line-scoped`, async () => {
    const source = await readFile(new URL(relativePath, rootUrl), "utf8");
    const directives = source.match(/^\s*\/\/ eslint-disable-next-line no-restricted-syntax --[^\n]*\n/gm) ?? [];
    assert.equal(directives.length, 1, "exactly one justified exception is allowed");
    assert.equal((await roleDiagnostics(source, relativePath)).length, 0);

    const withoutException = source.replace(directives[0], "\n");
    assert.equal(
      (await roleDiagnostics(withoutException, relativePath)).length,
      1,
      "removing the exception must expose the intended policy comparison",
    );

    const withRegression = source +
      '\nexport function roleOnlyRegression(auth: { role?: string }) { return auth.role !== "ADMIN"; }\n';
    assert.equal(
      (await roleDiagnostics(withRegression, relativePath)).length,
      1,
      "the same real route must still reject a new role-only authorization check",
    );
  });
}
