const DEFAULT_BASE_URL = "http://127.0.0.1:6578";
export function resolveConfig(options, env = process.env) {
    const raw = isRecord(options) ? options : {};
    const explicitBaseUrl = readString(raw.baseUrl) ||
        readString(env.KILOCODE_NOOSPHERE_BASE_URL) ||
        readString(env.KILOCODE_NOOSPHERE_URL) ||
        readString(env.NOOSPHERE_BASE_URL) ||
        readString(env.NOOSPHERE_URL);
    return {
        baseUrl: explicitBaseUrl
            ? normalizeBaseUrl(explicitBaseUrl)
            : DEFAULT_BASE_URL,
        apiKey: readString(raw.apiKey) ||
            readString(env.KILOCODE_NOOSPHERE_API_KEY) ||
            readString(env.NOOSPHERE_API_KEY),
        timeoutMs: readInteger(raw.timeoutMs, firstEnv(env.KILOCODE_NOOSPHERE_TIMEOUT_MS, env.NOOSPHERE_TIMEOUT_MS), 5_000, 500, 30_000),
        autoRecall: readBoolean(raw.autoRecall, firstEnv(env.KILOCODE_NOOSPHERE_AUTO_RECALL, env.NOOSPHERE_AUTO_RECALL), true),
        autoRecallInjectOn: readInjectOn(raw.autoRecallInjectOn, firstEnv(env.KILOCODE_NOOSPHERE_AUTO_RECALL_INJECT_ON, env.NOOSPHERE_AUTO_RECALL_INJECT_ON)),
        autoRecallMax: readInteger(raw.autoRecallMax, firstEnv(env.KILOCODE_NOOSPHERE_AUTO_RECALL_MAX, env.NOOSPHERE_AUTO_RECALL_MAX), 5, 1, 10),
        autoRecallTokenBudget: readInteger(raw.autoRecallTokenBudget, firstEnv(env.KILOCODE_NOOSPHERE_AUTO_RECALL_TOKEN_BUDGET, env.NOOSPHERE_AUTO_RECALL_TOKEN_BUDGET), 1_200, 100, 2_000),
        autoSave: readBoolean(raw.autoSave, firstEnv(env.KILOCODE_NOOSPHERE_AUTO_SAVE, env.NOOSPHERE_AUTO_SAVE), false),
        autoSaveDebounceMs: readInteger(raw.autoSaveDebounceMs, firstEnv(env.KILOCODE_NOOSPHERE_AUTO_SAVE_DEBOUNCE_MS, env.NOOSPHERE_AUTO_SAVE_DEBOUNCE_MS), 10_000, 1_000, 120_000),
        autoSaveTopicId: readString(raw.autoSaveTopicId) ||
            readString(env.KILOCODE_NOOSPHERE_AUTO_SAVE_TOPIC_ID) ||
            readString(env.KILOCODE_NOOSPHERE_TOPIC_ID) ||
            readString(env.NOOSPHERE_AUTO_SAVE_TOPIC_ID) ||
            readString(env.NOOSPHERE_TOPIC_ID),
        authorName: readString(raw.authorName) ||
            readString(env.KILOCODE_NOOSPHERE_AUTHOR_NAME) ||
            readString(env.NOOSPHERE_AUTHOR_NAME) ||
            "Kilo Code",
    };
}
export function redactSecret(value) {
    if (!value)
        return undefined;
    if (value.length <= 8)
        return "[redacted]";
    return `${value.slice(0, 4)}...${value.slice(-4)}`;
}
function normalizeBaseUrl(value) {
    const trimmed = value.trim();
    if (!trimmed) {
        throw new Error("Noosphere baseUrl is required");
    }
    let url;
    try {
        url = new URL(trimmed);
    }
    catch {
        throw new Error("Noosphere baseUrl must be a valid URL");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error("Noosphere baseUrl must use http or https");
    }
    if (url.username || url.password) {
        throw new Error("Noosphere baseUrl must not include credentials");
    }
    if (isBlockedInternalHost(url.hostname)) {
        throw new Error("Noosphere baseUrl must not target private or reserved networks");
    }
    if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) {
        throw new Error("Noosphere http baseUrl is allowed only for loopback hosts");
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
function readInjectOn(value, envValue) {
    const raw = readString(value) || readString(envValue);
    return raw === "always" ? "always" : "first";
}
function readString(value) {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function readBoolean(optionValue, envValue, fallback) {
    const parsedOption = parseBoolean(optionValue);
    if (parsedOption !== undefined)
        return parsedOption;
    const parsedEnv = parseBoolean(envValue);
    return parsedEnv ?? fallback;
}
function parseBoolean(value) {
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
function readInteger(optionValue, envValue, fallback, min, max) {
    const parsedOption = parseInteger(optionValue);
    const parsedEnv = parseInteger(envValue);
    const value = parsedOption ?? parsedEnv ?? fallback;
    return Math.min(max, Math.max(min, value));
}
function parseInteger(value) {
    if (typeof value === "number" && Number.isFinite(value))
        return Math.floor(value);
    if (typeof value !== "string" || !value.trim())
        return undefined;
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
}
function firstEnv(...values) {
    for (const value of values) {
        const parsed = readString(value);
        if (parsed !== undefined)
            return parsed;
    }
    return undefined;
}
function isRecord(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
}
//# sourceMappingURL=config.js.map