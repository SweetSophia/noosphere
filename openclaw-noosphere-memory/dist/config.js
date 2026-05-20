import { readFileSync } from "node:fs";
import { homedir } from "node:os";
export const DEFAULT_NOOSPHERE_BASE_URL = "http://localhost:3000";
export const DEFAULT_NOOSPHERE_TIMEOUT_MS = 5_000;
export const MAX_NOOSPHERE_TIMEOUT_MS = 30_000;
export const DEFAULT_AUTO_RECALL_TIMEOUT_MS = 1_500;
export const MAX_AUTO_RECALL_TIMEOUT_MS = 5_000;
export function resolveNoosphereMemoryConfig(rawConfig, env = process.env, rootConfig) {
    const config = isRecord(rawConfig) ? rawConfig : {};
    const baseUrl = normalizeBaseUrl(readString(config.baseUrl) || env.NOOSPHERE_BASE_URL || DEFAULT_NOOSPHERE_BASE_URL);
    const defaultApiKey = readSecret(config.apiKey, rootConfig) || readString(env.NOOSPHERE_API_KEY);
    const timeoutMs = clampTimeout(config.timeoutMs ?? readNumber(env.NOOSPHERE_TIMEOUT_MS), DEFAULT_NOOSPHERE_TIMEOUT_MS);
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
 *   3. Default apiKey (resolved from string, secret ref, or env.NOOSPHERE_API_KEY)
 */
export function resolveApiKeyForAgent(rawConfig, env = process.env, rootConfig, agentId) {
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
    // 3. Default key (resolved from string, secret ref, or env.NOOSPHERE_API_KEY)
    return (readSecret(config.apiKey, rootConfig) || readString(env.NOOSPHERE_API_KEY));
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
        return DEFAULT_NOOSPHERE_BASE_URL;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        return DEFAULT_NOOSPHERE_BASE_URL;
    }
    if (url.username || url.password) {
        return DEFAULT_NOOSPHERE_BASE_URL;
    }
    if (isBlockedInternalHost(url.hostname)) {
        return DEFAULT_NOOSPHERE_BASE_URL;
    }
    if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) {
        return DEFAULT_NOOSPHERE_BASE_URL;
    }
    while (url.pathname.length > 1 && url.pathname.endsWith("/")) {
        url.pathname = url.pathname.slice(0, -1);
    }
    url.search = "";
    url.hash = "";
    const normalized = url.toString();
    return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}
function isLoopbackHost(hostname) {
    const normalized = stripIpv6Brackets(hostname.toLowerCase());
    return (normalized === "localhost" ||
        normalized === "::1" ||
        normalized.startsWith("127."));
}
function isBlockedInternalHost(hostname) {
    const normalized = stripIpv6Brackets(hostname.toLowerCase());
    if (isLoopbackHost(normalized))
        return false;
    const ipv4 = parseIpv4(normalized);
    if (ipv4)
        return isPrivateOrReservedIpv4(ipv4);
    if (normalized.startsWith("::ffff:")) {
        const mappedIpv4 = parseIpv4(normalized.slice("::ffff:".length));
        if (mappedIpv4)
            return isPrivateOrReservedIpv4(mappedIpv4);
    }
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
function isPrivateOrReservedIpv6(hostname) {
    if (!hostname.includes(":"))
        return false;
    return (hostname === "::" ||
        hostname.startsWith("fc") ||
        hostname.startsWith("fd") ||
        /^fe[89ab][0-9a-f]:/.test(hostname) ||
        hostname.startsWith("ff") ||
        hostname.startsWith("2001:db8:"));
}
function readSecret(value, rootConfig) {
    if (typeof value === "string" && value.trim())
        return value.trim();
    if (!isRecord(value))
        return undefined;
    if (typeof value.value === "string" && value.value.trim()) {
        return value.value.trim();
    }
    return readFileSecretRef(value, rootConfig);
}
function readFileSecretRef(value, rootConfig) {
    if (value.source !== "file")
        return undefined;
    const providerId = readString(value.provider);
    const secretId = readString(value.id);
    if (!providerId || !secretId || !isRecord(rootConfig))
        return undefined;
    const providers = getRecord(rootConfig, "secrets", "providers");
    const provider = providers ? providers[providerId] : undefined;
    if (!isRecord(provider) || provider.source !== "file")
        return undefined;
    const rawPath = readString(provider.path);
    if (!rawPath)
        return undefined;
    const filePath = expandHome(rawPath);
    const fileContent = readFileSync(filePath, "utf8");
    if (provider.mode === "json") {
        const parsed = JSON.parse(fileContent);
        const resolved = readJsonPointer(parsed, secretId);
        return typeof resolved === "string" && resolved.trim()
            ? resolved.trim()
            : undefined;
    }
    const trimmed = fileContent.trim();
    return trimmed || undefined;
}
function getRecord(value, ...path) {
    let current = value;
    for (const segment of path) {
        if (!isRecord(current))
            return undefined;
        current = current[segment];
    }
    return isRecord(current) ? current : undefined;
}
function expandHome(input) {
    if (input === "~")
        return homedir();
    if (input.startsWith("~/"))
        return `${homedir()}${input.slice(1)}`;
    return input;
}
function readJsonPointer(value, pointer) {
    if (!pointer || pointer === "/")
        return value;
    const parts = pointer
        .split("/")
        .slice(1)
        .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
    let current = value;
    for (const part of parts) {
        if (!isRecord(current))
            return undefined;
        current = current[part];
    }
    return current;
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