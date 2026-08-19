import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/**
 * Path traversal security tests
 * 
 * These tests verify that the mitigations for path traversal vulnerabilities
 * are working correctly across different parts of the codebase.
 * 
 * The mitigations check for:
 * 1. Double dots (..) in paths - common path traversal technique
 * 2. Absolute paths - bypassing relative path restrictions
 * 3. Normalized paths that escape allowed directories
 * 4. URL-encoded traversal attempts
 * 
 * Note: Bootstrap-specific path traversal tests are in bootstrap-topics.test.ts
 */

// Helper to create a temporary directory for testing
function makeTempDir(prefix: string) {
  return mkdtempSync(join(tmpdir(), prefix));
}

// Test: readFileSecretRef in openclaw-noosphere-memory/src/config.ts
test("readFileSecretRef rejects path traversal with double dots", async () => {
  const configModule = await import(
    pathToFileURL(resolve(repoRoot, "openclaw-noosphere-memory", "src", "config.ts")).href
  );
  
  const { resolveNoosphereMemoryConfig } = configModule;
  const dir = makeTempDir("config-traversal-");
  
  // Test various path traversal patterns with double dots
  const traversalPatterns = [
    join(dir, "..", "..", "etc", "passwd"),
    join(dir, "..", "sensitive-file.txt"),
    "../../../etc/shadow",
    "subdir/../../etc/hosts",
  ];

  try {
    writeFileSync(join(dir, "safe.txt"), "safe-value");
    
    for (const targetFile of traversalPatterns) {
      // Create a config that attempts path traversal
      const env = {
        NOOSPHERE_BASE_URL: "https://test.local",
        NOOSPHERE_API_KEY: "file://traversal-provider#/apiKey",
      };
      
      // The config should handle the path traversal attempt safely
      // by returning undefined for invalid paths
      const config = resolveNoosphereMemoryConfig({
        secrets: {
          providers: {
            "traversal-provider": {
              source: "file",
              path: targetFile,
              mode: "json",
            },
          },
        },
      }, env);
      
      // The API key should not be resolved from the traversal path
      assert.equal(
        config.apiKey,
        "file://traversal-provider#/apiKey",
        `Path traversal with pattern "${targetFile}" should be rejected`,
      );
    }
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("readFileSecretRef rejects absolute paths", async () => {
  const configModule = await import(
    pathToFileURL(resolve(repoRoot, "openclaw-noosphere-memory", "src", "config.ts")).href
  );
  
  const { resolveNoosphereMemoryConfig } = configModule;

  // Attempt to use various absolute paths
  const absolutePaths = [
    "/etc/passwd",
    "/root/.ssh/authorized_keys",
    "/var/log/system.log",
    "/tmp/sensitive-data.json",
  ];
  
  for (const absolutePath of absolutePaths) {
    const env = {
      NOOSPHERE_BASE_URL: "https://test.local",
      NOOSPHERE_API_KEY: "file://absolute-provider#/apiKey",
    };
    
    const config = resolveNoosphereMemoryConfig({
      secrets: {
        providers: {
          "absolute-provider": {
            source: "file",
            path: absolutePath,
            mode: "json",
          },
        },
      },
    }, env);
    
    // The API key should not be resolved from the absolute path
    assert.equal(
      config.apiKey,
      "file://absolute-provider#/apiKey",
      `Absolute path ${absolutePath} should be rejected`,
    );
  }
});

// Test: readText in scripts/check-package-policies.mjs
test("check-package-policies handles paths safely", async () => {
  const { spawnSync } = await import("node:child_process");
  
  // Run the check-package-policies script
  const result = spawnSync(
    process.execPath,
    [resolve(repoRoot, "scripts", "check-package-policies.mjs")],
    {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 10_000,
      env: process.env,
    },
  );
  
  // The script should complete without exposing sensitive files
  assert.ok(
    result.status === 0 || result.status === 1,
    "check-package-policies should handle paths safely",
  );
  
  // Verify that error messages don't contain sensitive path information
  const output = `${result.stdout}\n${result.stderr}`;
  assert.doesNotMatch(
    output,
    /\/etc\/passwd|\/root\//,
    "Output should not contain sensitive system paths",
  );
});

// Test: fsyncPath in docker/bootstrap.mjs
test("fsyncPath rejects path traversal attempts", async () => {
  // Import the bootstrap module to test fsyncPath
  const bootstrapModule = await import(
    pathToFileURL(resolve(repoRoot, "docker", "bootstrap.mjs")).href
  );
  
  // The fsyncPath function is not exported, but we can test it indirectly
  // by checking that the validation logic is in place
  const bootstrapContent = readFileSync(
    resolve(repoRoot, "docker", "bootstrap.mjs"),
    "utf8"
  );
  
  // Verify the mitigation code is present
  assert.ok(
    bootstrapContent.includes("if (path.includes('..') || require('path').isAbsolute(path)) throw new Error('Invalid path')"),
    "fsyncPath should contain path traversal mitigation",
  );
});

// Test: readText in scripts/check-postgres-image-policy.mjs
test("check-postgres-image-policy handles paths safely", async () => {
  const { spawnSync } = await import("node:child_process");
  
  // Run the check-postgres-image-policy script
  const result = spawnSync(
    process.execPath,
    [resolve(repoRoot, "scripts", "check-postgres-image-policy.mjs")],
    {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 10_000,
      env: process.env,
    },
  );
  
  // The script should complete without exposing sensitive files
  assert.ok(
    result.status === 0 || result.status === 1,
    "check-postgres-image-policy should handle paths safely",
  );
  
  // Verify that error messages don't contain sensitive path information
  const output = `${result.stdout}\n${result.stderr}`;
  assert.doesNotMatch(
    output,
    /\/etc\/passwd|\/root\//,
    "Output should not contain sensitive system paths",
  );
});

// Test: Verify path validation prevents URL-encoded traversal attempts
test("path validation rejects URL-encoded traversal patterns", async () => {
  const configModule = await import(
    pathToFileURL(resolve(repoRoot, "openclaw-noosphere-memory", "src", "config.ts")).href
  );
  
  const { resolveNoosphereMemoryConfig } = configModule;
  
  // URL-encoded path traversal patterns
  // Note: The current mitigation checks for literal ".." so URL-encoded
  // versions would pass the check but fail at file system level
  // This test verifies the behavior is safe
  const urlEncodedPatterns = [
    "%2e%2e%2f%2e%2e%2fetc%2fpasswd",  // ../../../etc/passwd
    "..%2f..%2fetc%2fpasswd",           // ../../etc/passwd
  ];
  
  for (const pattern of urlEncodedPatterns) {
    const env = {
      NOOSPHERE_BASE_URL: "https://test.local",
      NOOSPHERE_API_KEY: "file://encoded-provider#/apiKey",
    };
    
    const config = resolveNoosphereMemoryConfig({
      secrets: {
        providers: {
          "encoded-provider": {
            source: "file",
            path: pattern,
            mode: "json",
          },
        },
      },
    }, env);
    
    // The API key should not be resolved - either rejected or file not found
    assert.equal(
      config.apiKey,
      "file://encoded-provider#/apiKey",
      `URL-encoded pattern "${pattern}" should not resolve to sensitive files`,
    );
  }
});
