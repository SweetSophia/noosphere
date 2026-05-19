const DEFAULT_BASE_URL = "http://127.0.0.1:6578";
export function resolveConfig(options, env = process.env) {
    const raw = isRecord(options) ? options : {};
    return {
        baseUrl: normalizeBaseUrl(readString(raw.baseUrl) ||
            readString(env.NOOSPHERE_BASE_URL) ||
            readString(env.NOOSPHERE_URL) ||
            DEFAULT_BASE_URL),
        apiKey: readString(raw.apiKey) || readString(env.NOOSPHERE_API_KEY),
        timeoutMs: readInteger(raw.timeoutMs, env.NOOSPHERE_TIMEOUT_MS, 5_000, 500, 30_000),
        autoRecall: readBoolean(raw.autoRecall, env.NOOSPHERE_AUTO_RECALL, true),
        autoRecallInjectOn: readInjectOn(raw.autoRecallInjectOn, env.NOOSPHERE_AUTO_RECALL_INJECT_ON),
        autoRecallMax: readInteger(raw.autoRecallMax, env.NOOSPHERE_AUTO_RECALL_MAX, 5, 1, 10),
        autoRecallTokenBudget: readInteger(raw.autoRecallTokenBudget, env.NOOSPHERE_AUTO_RECALL_TOKEN_BUDGET, 1_200, 100, 2_000),
        autoSave: readBoolean(raw.autoSave, env.NOOSPHERE_AUTO_SAVE, false),
        autoSaveDebounceMs: readInteger(raw.autoSaveDebounceMs, env.NOOSPHERE_AUTO_SAVE_DEBOUNCE_MS, 10_000, 1_000, 120_000),
        autoSaveTopicId: readString(raw.autoSaveTopicId) ||
            readString(env.NOOSPHERE_AUTO_SAVE_TOPIC_ID) ||
            readString(env.NOOSPHERE_TOPIC_ID),
        authorName: readString(raw.authorName) ||
            readString(env.NOOSPHERE_AUTHOR_NAME) ||
            "Opencode",
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
    // Strip trailing slashes without regex to avoid CodeQL js/polynomial-redos
    // on pathological inputs (many repetitions of '/' from user/environment values).
    let end = trimmed.length;
    while (end > 0 && trimmed[end - 1] === "/")
        end -= 1;
    return (end > 0 ? trimmed.slice(0, end) : DEFAULT_BASE_URL) || DEFAULT_BASE_URL;
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
function isRecord(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
}
//# sourceMappingURL=config.js.map