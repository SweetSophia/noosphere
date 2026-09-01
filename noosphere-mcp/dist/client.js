const MAX_RESPONSE_BODY_BYTES = 1_000_000;
const MAX_ERROR_MESSAGE_CHARS = 2_000;
export class NoosphereClientError extends Error {
    status;
    constructor(message, status) {
        super(message);
        this.status = status;
        this.name = "NoosphereClientError";
    }
}
export class NoosphereClient {
    config;
    fetchFn;
    constructor(config, fetchFn = globalThis.fetch) {
        this.config = config;
        this.fetchFn = fetchFn;
    }
    async searchArticles(input) {
        const url = new URL(`${this.config.baseUrl}/api/articles`);
        appendQuery(url, "q", input.query);
        appendQuery(url, "topic", input.topic);
        appendQuery(url, "tag", input.tag);
        appendQuery(url, "status", input.status);
        appendQuery(url, "confidence", input.confidence);
        appendQuery(url, "page", input.page);
        appendQuery(url, "limit", input.limit);
        return this.request(url.toString(), { method: "GET" });
    }
    async getArticle(input) {
        const body = "canonicalRef" in input
            ? { canonicalRef: input.canonicalRef }
            : { provider: "noosphere", id: input.articleId };
        return this.postJson("/api/memory/get", body);
    }
    async saveMemory(input) {
        return this.postJson("/api/memory/save", input);
    }
    async recallMemory(input) {
        return this.postJson("/api/memory/recall", input);
    }
    async createArticle(input) {
        return this.postJson("/api/articles", input);
    }
    async postJson(path, body) {
        return this.request(`${this.config.baseUrl}${path}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
        });
    }
    async request(url, init) {
        if (!this.config.apiKey) {
            throw new NoosphereClientError("Noosphere API key is not configured. Set CODEX_NOOSPHERE_API_KEY or NOOSPHERE_API_KEY before using Noosphere tools.");
        }
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
        const headers = new Headers(init.headers);
        headers.set("accept", "application/json");
        headers.set("authorization", `Bearer ${this.config.apiKey}`);
        try {
            const response = await this.fetchFn(url, {
                ...init,
                headers,
                redirect: "error",
                signal: controller.signal,
            });
            const payload = await parseResponseBody(response);
            if (!response.ok) {
                throw new NoosphereClientError(extractError(payload) ?? `Noosphere request failed with HTTP ${response.status}`, response.status);
            }
            if (!isRecord(payload)) {
                throw new NoosphereClientError("Noosphere returned an empty or non-object JSON response.", response.status);
            }
            return payload;
        }
        catch (error) {
            if (error instanceof NoosphereClientError)
                throw error;
            if (isAbortError(error)) {
                throw new NoosphereClientError(`Noosphere request timed out after ${this.config.timeoutMs}ms.`);
            }
            throw new NoosphereClientError(safeMessage(error));
        }
        finally {
            clearTimeout(timeout);
        }
    }
}
function appendQuery(url, name, value) {
    if (value === undefined || value === "")
        return;
    url.searchParams.set(name, String(value));
}
async function parseResponseBody(response) {
    const text = await readBoundedResponseText(response);
    if (!text)
        return null;
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.includes("application/json")) {
        if (!response.ok)
            return { error: truncate(text) };
        throw new NoosphereClientError("Noosphere returned a non-JSON response.", response.status);
    }
    try {
        return JSON.parse(text);
    }
    catch {
        if (!response.ok)
            return { error: truncate(text) };
        throw new NoosphereClientError("Noosphere returned invalid JSON.", response.status);
    }
}
async function readBoundedResponseText(response) {
    const contentLength = response.headers.get("content-length");
    if (contentLength) {
        const parsed = Number(contentLength);
        if (Number.isFinite(parsed) && parsed > MAX_RESPONSE_BODY_BYTES) {
            await cancelResponseBody(response);
            throw new NoosphereClientError("Noosphere response body is too large.", response.status);
        }
    }
    if (!response.body) {
        const text = await response.text();
        if (new TextEncoder().encode(text).length > MAX_RESPONSE_BODY_BYTES) {
            throw new NoosphereClientError("Noosphere response body is too large.", response.status);
        }
        return text;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let totalBytes = 0;
    let text = "";
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done)
                break;
            totalBytes += value.byteLength;
            if (totalBytes > MAX_RESPONSE_BODY_BYTES) {
                try {
                    await reader.cancel();
                }
                catch {
                    // Preserve the bounded-response error even if cancellation itself fails.
                }
                throw new NoosphereClientError("Noosphere response body is too large.", response.status);
            }
            text += decoder.decode(value, { stream: true });
        }
        return text + decoder.decode();
    }
    finally {
        reader.releaseLock();
    }
}
async function cancelResponseBody(response) {
    try {
        await response.body?.cancel();
    }
    catch {
        // A failed cancellation must not replace the body-size rejection.
    }
}
function extractError(payload) {
    if (!isRecord(payload))
        return undefined;
    for (const key of ["error", "message"]) {
        const value = payload[key];
        if (typeof value === "string" && value.trim())
            return truncate(value.trim());
    }
    return undefined;
}
function safeMessage(error) {
    return truncate(error instanceof Error ? error.message : String(error));
}
function truncate(value) {
    return value.length <= MAX_ERROR_MESSAGE_CHARS
        ? value
        : `${value.slice(0, MAX_ERROR_MESSAGE_CHARS)}…`;
}
function isAbortError(error) {
    return error instanceof Error && error.name === "AbortError";
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=client.js.map