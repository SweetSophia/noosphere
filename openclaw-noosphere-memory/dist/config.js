export class NoosphereConfigError extends Error {
    constructor(message) {
        super(message);
        this.name = "NoosphereConfigError";
    }
}
export const DEFAULT_NOOSPHERE_BASE_URL = "http://localhost:3000";
export const DEFAULT_NOOSPHERE_TIMEOUT_MS = 5_000;
export const MAX_NOOSPHERE_TIMEOUT_MS = 30_000;
export const DEFAULT_AUTO_RECALL_TIMEOUT_MS = 1_500;
export const MAX_AUTO_RECALL_TIMEOUT_MS = 5_000;
export function resolveNoosphereMemoryConfig(rawConfig, env = process.env, rootConfig) {
    // Retained for call-site compatibility only. OpenClaw hydrates manifest-declared
    // secretInputs before plugin execution; rereading source providers here would
    // bypass the host's ownership, permission, size, and timeout policy.
    void rootConfig;
    const config = isRecord(rawConfig) ? rawConfig : {};
    const baseUrl = normalizeBaseUrl(readString(config.baseUrl) ||
        readString(env.OPENCLAW_NOOSPHERE_BASE_URL) ||
        readString(env.NOOSPHERE_BASE_URL) ||
        DEFAULT_NOOSPHERE_BASE_URL);
    assertTrustedRemoteOrigin(baseUrl, env);
    const defaultApiKey = readSecret(config.apiKey) ||
        readString(env.OPENCLAW_NOOSPHERE_API_KEY) ||
        readString(env.NOOSPHERE_API_KEY);
    const timeoutMs = clampTimeout(config.timeoutMs ??
        readNumber(env.OPENCLAW_NOOSPHERE_TIMEOUT_MS) ??
        readNumber(env.NOOSPHERE_TIMEOUT_MS), DEFAULT_NOOSPHERE_TIMEOUT_MS);
    return {
        baseUrl,
        apiKey: defaultApiKey,
        apiKeys: isRecord(config.apiKeys) ? config.apiKeys : undefined,
        timeoutMs,
    };
}
/**
 * Resolve the API key for a specific agent.
 * Priority:
 *   1. NOOSPHERE_API_KEY_<AGENT_ID> env var (e.g. NOOSPHERE_API_KEY_SHODAN)
 *   2. apiKeys[agentId] from plugin config (plain text, for multi-agent setups)
 *   3. Default apiKey (host-resolved runtime value, legacy value wrapper,
 *      env.OPENCLAW_NOOSPHERE_API_KEY, or env.NOOSPHERE_API_KEY)
 */
export function resolveApiKeyForAgent(rawConfig, env = process.env, rootConfig, agentId) {
    // See resolveNoosphereMemoryConfig: source provider configuration is not a
    // runtime credential authority inside the plugin.
    void rootConfig;
    const config = isRecord(rawConfig) ? rawConfig : {};
    // 1. Per-agent env var (highest priority, keeps keys secret)
    if (agentId) {
        const envKey = `NOOSPHERE_API_KEY_${agentId.toUpperCase().replace(/-/g, "_")}`;
        const envValue = readString(env[envKey]);
        if (envValue)
            return envValue;
    }
    // 2. Per-agent key from config.apiKeys (direct map, no secret resolution)
    if (agentId && config.apiKeys && typeof config.apiKeys === "object") {
        const perAgentKey = config.apiKeys[agentId];
        if (typeof perAgentKey === "string" && perAgentKey.trim()) {
            return perAgentKey.trim();
        }
    }
    // 3. Default key (host-resolved runtime value, legacy wrapper, or env fallback)
    return (readSecret(config.apiKey) ||
        readString(env.OPENCLAW_NOOSPHERE_API_KEY) ||
        readString(env.NOOSPHERE_API_KEY));
}
export function redactSecret(value) {
    if (!value)
        return undefined;
    if (value.length <= 8)
        return "[redacted]";
    return `${value.slice(0, 4)}…${value.slice(-4)}`;
}
function normalizeBaseUrl(value) {
    const trimmed = value.trim();
    if (!trimmed)
        return DEFAULT_NOOSPHERE_BASE_URL;
    let url;
    try {
        url = new URL(trimmed);
    }
    catch {
        throw new NoosphereConfigError("Noosphere base URL must be a valid HTTP or HTTPS URL.");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new NoosphereConfigError("Noosphere base URL must be a valid HTTP or HTTPS URL.");
    }
    if (url.username || url.password) {
        throw new NoosphereConfigError("Noosphere base URL must not contain credentials.");
    }
    if (trimmed.includes("?") || trimmed.includes("#")) {
        throw new NoosphereConfigError("Noosphere base URL must not contain a query string or fragment.");
    }
    if (isBlockedInternalHost(url.hostname)) {
        throw new NoosphereConfigError("Noosphere base URL must use a loopback or public host.");
    }
    if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) {
        throw new NoosphereConfigError("Noosphere base URL must use HTTPS unless the host is loopback.");
    }
    while (url.pathname.length > 1 && url.pathname.endsWith("/")) {
        url.pathname = url.pathname.slice(0, -1);
    }
    url.search = "";
    url.hash = "";
    const normalized = url.toString();
    return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}
function assertTrustedRemoteOrigin(baseUrl, env) {
    const base = new URL(baseUrl);
    if (isLoopbackHost(base.hostname))
        return;
    // Deliberately environment-only: plugin config is not an independent trust
    // source when config.baseUrl itself may be attacker-controlled.
    const rawTrustedOrigin = readString(env.OPENCLAW_NOOSPHERE_TRUSTED_ORIGIN) ||
        readString(env.NOOSPHERE_TRUSTED_ORIGIN);
    if (!rawTrustedOrigin) {
        throw new NoosphereConfigError("Remote Noosphere base URL requires OPENCLAW_NOOSPHERE_TRUSTED_ORIGIN (or NOOSPHERE_TRUSTED_ORIGIN) in the protected process environment.");
    }
    const trustedOrigin = normalizeTrustedOrigin(rawTrustedOrigin);
    if (base.origin !== trustedOrigin) {
        throw new NoosphereConfigError("Noosphere base URL origin does not match the protected trusted origin.");
    }
}
function normalizeTrustedOrigin(value) {
    let url;
    try {
        url = new URL(value);
    }
    catch {
        throw invalidTrustedOriginError();
    }
    if (url.protocol !== "https:" ||
        !!url.username ||
        !!url.password ||
        url.pathname !== "/" ||
        !!url.search ||
        !!url.hash ||
        isBlockedInternalHost(url.hostname) ||
        isLoopbackHost(url.hostname)) {
        throw invalidTrustedOriginError();
    }
    return url.origin;
}
function invalidTrustedOriginError() {
    return new NoosphereConfigError("Noosphere trusted origin must be a public HTTPS origin without credentials, path, query, or fragment.");
}
function isLoopbackHost(hostname) {
    const withoutBrackets = stripIpv6Brackets(hostname.toLowerCase());
    const normalized = withoutBrackets.endsWith(".")
        ? withoutBrackets.slice(0, -1)
        : withoutBrackets;
    const ipv4 = parseIpv4(normalized) ?? parseIpv4MappedIpv6(normalized);
    return (normalized === "localhost" ||
        normalized === "::1" ||
        ipv4?.[0] === 127);
}
function isBlockedInternalHost(hostname) {
    const normalized = stripIpv6Brackets(hostname.toLowerCase());
    if (isLoopbackHost(normalized))
        return false;
    const ipv4 = parseIpv4(normalized);
    if (ipv4)
        return isPrivateOrReservedIpv4(ipv4);
    const mappedIpv4 = parseIpv4MappedIpv6(normalized);
    if (mappedIpv4)
        return isPrivateOrReservedIpv4(mappedIpv4);
    return isPrivateOrReservedIpv6(normalized);
}
function stripIpv6Brackets(hostname) {
    return hostname.startsWith("[") && hostname.endsWith("]")
        ? hostname.slice(1, -1)
        : hostname;
}
function parseIpv4(hostname) {
    const parts = hostname.split(".");
    if (parts.length !== 4)
        return undefined;
    const octets = parts.map((part) => {
        if (!/^\d{1,3}$/.test(part))
            return Number.NaN;
        const parsed = Number(part);
        return parsed >= 0 && parsed <= 255 ? parsed : Number.NaN;
    });
    return octets.every((part) => Number.isInteger(part))
        ? octets
        : undefined;
}
function parseIpv4MappedIpv6(hostname) {
    const prefix = "::ffff:";
    if (!hostname.startsWith(prefix))
        return undefined;
    const suffix = hostname.slice(prefix.length);
    const dotted = parseIpv4(suffix);
    if (dotted)
        return dotted;
    const match = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(suffix);
    if (!match)
        return undefined;
    const high = Number.parseInt(match[1], 16);
    const low = Number.parseInt(match[2], 16);
    return [high >> 8, high & 0xff, low >> 8, low & 0xff];
}
function isPrivateOrReservedIpv4([a, b, c]) {
    return (a === 0 ||
        a === 10 ||
        (a === 100 && b >= 64 && b <= 127) ||
        (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) ||
        (a === 192 && b === 0 && c === 0) ||
        (a === 192 && b === 0 && c === 2) ||
        (a === 198 && (b === 18 || b === 19)) ||
        (a === 198 && b === 51 && c === 100) ||
        (a === 203 && b === 0 && c === 113) ||
        a >= 224);
}
function parseIpv6Hextets(hostname) {
    if (!hostname.includes(":"))
        return undefined;
    const halves = hostname.split("::");
    if (halves.length > 2)
        return undefined;
    const parseHalf = (value) => {
        if (!value)
            return [];
        const parts = value.split(":");
        if (parts.some((part) => !/^[0-9a-f]{1,4}$/.test(part)))
            return undefined;
        return parts.map((part) => Number.parseInt(part, 16));
    };
    const left = parseHalf(halves[0]);
    const right = parseHalf(halves[1] ?? "");
    if (!left || !right)
        return undefined;
    if (halves.length === 1)
        return left.length === 8 ? left : undefined;
    const omitted = 8 - left.length - right.length;
    if (omitted < 1)
        return undefined;
    return [...left, ...Array(omitted).fill(0), ...right];
}
function isPrivateOrReservedIpv6(hostname) {
    const hextets = parseIpv6Hextets(hostname);
    if (!hextets)
        return false;
    const first = hextets[0];
    const unspecifiedOrIpv4Compatible = hextets.slice(0, 6).every((part) => part === 0);
    const uniqueLocal = (first & 0xfe00) === 0xfc00;
    const linkLocal = (first & 0xffc0) === 0xfe80;
    const deprecatedSiteLocal = (first & 0xffc0) === 0xfec0;
    const multicast = (first & 0xff00) === 0xff00;
    const discardOnly = first === 0x0100 &&
        hextets[1] === 0 &&
        hextets[2] === 0 &&
        hextets[3] === 0;
    const documentation = first === 0x2001 && hextets[1] === 0x0db8;
    return (unspecifiedOrIpv4Compatible ||
        uniqueLocal ||
        linkLocal ||
        deprecatedSiteLocal ||
        multicast ||
        discardOnly ||
        documentation);
}
function readSecret(value) {
    if (typeof value === "string" && value.trim())
        return value.trim();
    if (!isRecord(value))
        return undefined;
    if ("source" in value || "provider" in value || "id" in value) {
        throw new NoosphereConfigError("Noosphere API key SecretRefs must be resolved by OpenClaw before plugin initialization.");
    }
    if (typeof value.value === "string" && value.value.trim()) {
        return value.value.trim();
    }
    return undefined;
}
export function readString(value) {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
export function readNumber(value) {
    if (typeof value === "number")
        return value;
    if (typeof value !== "string" || !value.trim())
        return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}
export function clampTimeout(value, fallback, max = MAX_NOOSPHERE_TIMEOUT_MS) {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
        return fallback;
    }
    return Math.min(Math.floor(value), max);
}
export function readBoolean(value) {
    if (typeof value === "boolean")
        return value;
    if (typeof value !== "string")
        return undefined;
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized))
        return true;
    if (["false", "0", "no", "off"].includes(normalized))
        return false;
    return undefined;
}
export function readStringArray(value) {
    if (!Array.isArray(value))
        return undefined;
    const values = value
        .filter((item) => typeof item === "string" && !!item.trim())
        .map((item) => item.trim());
    return values.length > 0 ? values : undefined;
}
export function isRecord(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
}
//# sourceMappingURL=config.js.map