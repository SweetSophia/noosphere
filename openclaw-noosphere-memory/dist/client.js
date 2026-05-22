const MAX_RESPONSE_BODY_BYTES = 1_000_000;
export class NoosphereClientError extends Error {
    status;
    details;
    constructor(message, status, details) {
        super(message);
        this.status = status;
        this.details = details;
        this.name = "NoosphereClientError";
    }
}
export class NoosphereMemoryClient {
    config;
    constructor(config) {
        this.config = config;
    }
    async status() {
        return this.request("/api/memory/status", {
            method: "GET",
        });
    }
    async settings(options = {}) {
        return this.request("/api/memory/settings", {
            method: "GET",
        }, options);
    }
    async get(request) {
        return this.request("/api/memory/get", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(request),
        });
    }
    async save(request) {
        return this.request("/api/memory/save", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(request),
        });
    }
    async topics() {
        return this.request("/api/topics", {
            method: "GET",
        });
    }
    async articleCreate(request) {
        return this.request("/api/articles", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(request),
        });
    }
    async recall(request, options = {}) {
        return this.request("/api/memory/recall", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(request),
        }, options);
    }
    async request(path, init, options = {}) {
        if (!this.config.apiKey) {
            throw new NoosphereClientError("Noosphere API key is not configured. Set OPENCLAW_NOOSPHERE_API_KEY for OpenClaw Noosphere memory requests, or NOOSPHERE_API_KEY as a compatibility fallback.");
        }
        const requestTimeoutMs = options.timeoutMs ?? this.config.timeoutMs;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
        try {
            const response = await fetch(`${this.config.baseUrl}${path}`, {
                ...init,
                signal: controller.signal,
                headers: {
                    authorization: `Bearer ${this.config.apiKey}`,
                    accept: "application/json",
                    ...init.headers,
                },
            });
            const payload = await parseResponseBody(response);
            if (!response.ok) {
                throw new NoosphereClientError(extractError(payload) ??
                    `Noosphere request failed with HTTP ${response.status}`, response.status, payload);
            }
            if (payload === null) {
                throw new NoosphereClientError("Noosphere returned an empty response body", response.status);
            }
            return payload;
        }
        catch (error) {
            if (error instanceof NoosphereClientError)
                throw error;
            if (isAbortError(error)) {
                throw new NoosphereClientError(`Noosphere request timed out after ${requestTimeoutMs}ms`);
            }
            throw new NoosphereClientError(error instanceof Error ? error.message : String(error));
        }
        finally {
            clearTimeout(timeout);
        }
    }
}
async function parseResponseBody(response) {
    const text = await readBoundedResponseText(response);
    if (!text)
        return null;
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("application/json")) {
        if (!response.ok)
            return { rawBody: text };
        throw new NoosphereClientError("Noosphere returned a non-JSON response", response.status, { rawBody: text });
    }
    try {
        return JSON.parse(text);
    }
    catch {
        if (!response.ok)
            return { rawBody: text };
        throw new NoosphereClientError("Noosphere returned invalid JSON", response.status);
    }
}
async function readBoundedResponseText(response) {
    const contentLength = response.headers.get("content-length");
    if (contentLength) {
        const parsedLength = Number(contentLength);
        if (Number.isFinite(parsedLength) && parsedLength > MAX_RESPONSE_BODY_BYTES) {
            throw new NoosphereClientError("Noosphere response body is too large", response.status);
        }
    }
    if (!response.body) {
        const text = await response.text();
        if (text.length > MAX_RESPONSE_BODY_BYTES) {
            throw new NoosphereClientError("Noosphere response body is too large", response.status);
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
                await reader.cancel();
                throw new NoosphereClientError("Noosphere response body is too large", response.status);
            }
            text += decoder.decode(value, { stream: true });
        }
        text += decoder.decode();
        return text;
    }
    finally {
        reader.releaseLock();
    }
}
function extractError(payload) {
    if (!payload || typeof payload !== "object")
        return undefined;
    if ("error" in payload) {
        const error = payload.error;
        if (typeof error === "string")
            return error;
    }
    if ("rawBody" in payload) {
        const rawBody = payload.rawBody;
        if (typeof rawBody === "string" && rawBody.trim())
            return rawBody.trim();
    }
    return undefined;
}
function isAbortError(error) {
    if (!(error instanceof Error))
        return false;
    return error.name === "AbortError" || /abort/i.test(error.message);
}
//# sourceMappingURL=client.js.map