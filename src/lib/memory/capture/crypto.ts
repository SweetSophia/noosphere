import crypto from "node:crypto";

export const CAPTURE_HMAC_ALGORITHM = "HMAC-SHA-256";
export const MAX_CAPTURE_HMAC_KEYS = 3;

export type CaptureHmacKey = {
  version: number;
  key: Buffer;
};

export type CaptureHmacKeyring = {
  activeVersion: number;
  keys: readonly CaptureHmacKey[];
};

export type VersionedDigest = {
  algorithm: typeof CAPTURE_HMAC_ALGORITHM;
  keyVersion: number;
  digest: string;
};

export type CaptureDigestDomain =
  | "capture-dedupe"
  | "candidate-dedupe"
  | "session"
  | "run"
  | "query-correlation";

const DOMAIN_PREFIX = "noosphere-auto-memory-v1";

export function parseCaptureHmacKeyring(
  env: Record<string, string | undefined> = process.env,
): CaptureHmacKeyring {
  const activeRaw = env.NOOSPHERE_MEMORY_CAPTURE_HMAC_ACTIVE_VERSION;
  const keysRaw = env.NOOSPHERE_MEMORY_CAPTURE_HMAC_KEYS;

  if (!keysRaw) {
    throw new Error("NOOSPHERE_MEMORY_CAPTURE_HMAC_KEYS is required");
  }

  const activeVersion = Number(activeRaw);
  if (!Number.isSafeInteger(activeVersion) || activeVersion <= 0) {
    throw new Error(
      "NOOSPHERE_MEMORY_CAPTURE_HMAC_ACTIVE_VERSION must be a positive integer",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(keysRaw);
  } catch {
    throw new Error("NOOSPHERE_MEMORY_CAPTURE_HMAC_KEYS must be valid JSON");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      "NOOSPHERE_MEMORY_CAPTURE_HMAC_KEYS must be an object keyed by version",
    );
  }

  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length === 0 || entries.length > MAX_CAPTURE_HMAC_KEYS) {
    throw new Error(
      `NOOSPHERE_MEMORY_CAPTURE_HMAC_KEYS must contain 1-${MAX_CAPTURE_HMAC_KEYS} keys`,
    );
  }

  const keys = entries.map(([versionRaw, encoded]) => {
    const version = Number(versionRaw);
    if (!Number.isSafeInteger(version) || version <= 0) {
      throw new Error("Capture HMAC key versions must be positive integers");
    }
    if (typeof encoded !== "string" || !encoded.startsWith("base64:")) {
      throw new Error("Capture HMAC keys must use the base64:<value> format");
    }

    const base64 = encoded.slice("base64:".length);
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
      throw new Error("Capture HMAC keys must contain canonical base64 data");
    }
    const key = Buffer.from(base64, "base64");
    if (key.length < 32 || key.toString("base64").replace(/=+$/, "") !== base64.replace(/=+$/, "")) {
      throw new Error("Capture HMAC keys must decode to at least 32 bytes");
    }
    return { version, key };
  });

  const versions = new Set(keys.map((entry) => entry.version));
  if (versions.size !== keys.length || !versions.has(activeVersion)) {
    throw new Error(
      "Capture HMAC key versions must be unique and include the active version",
    );
  }

  keys.sort((left, right) => right.version - left.version);
  return { activeVersion, keys };
}

export function digestWithActiveKey(
  keyring: CaptureHmacKeyring,
  domain: CaptureDigestDomain,
  principalId: string,
  parts: readonly string[],
): VersionedDigest {
  const active = keyring.keys.find(
    (entry) => entry.version === keyring.activeVersion,
  );
  if (!active) throw new Error("Active capture HMAC key is unavailable");
  return digestWithKey(active, domain, principalId, parts);
}

export function digestWithAllKeys(
  keyring: CaptureHmacKeyring,
  domain: CaptureDigestDomain,
  principalId: string,
  parts: readonly string[],
): VersionedDigest[] {
  return keyring.keys.map((key) => digestWithKey(key, domain, principalId, parts));
}

function digestWithKey(
  entry: CaptureHmacKey,
  domain: CaptureDigestDomain,
  principalId: string,
  parts: readonly string[],
): VersionedDigest {
  if (!principalId.trim()) throw new Error("principalId is required for capture HMACs");

  const hmac = crypto.createHmac("sha256", entry.key);
  appendPart(hmac, `${DOMAIN_PREFIX}/${domain}`);
  appendPart(hmac, principalId);
  for (const part of parts) appendPart(hmac, part);

  return {
    algorithm: CAPTURE_HMAC_ALGORITHM,
    keyVersion: entry.version,
    digest: `v${entry.version}:${hmac.digest("base64url")}`,
  };
}

function appendPart(hmac: ReturnType<typeof crypto.createHmac>, value: string): void {
  const bytes = Buffer.from(value, "utf8");
  hmac.update(String(bytes.length));
  hmac.update(":");
  hmac.update(bytes);
  hmac.update(";");
}
