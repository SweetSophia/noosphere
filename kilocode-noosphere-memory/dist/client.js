const MAX_ERROR_BODY_LENGTH = 2_000;
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
    constructor(config) {
        this.config = config;
    }
    async status() {
        return this.requestJson("GET", "/api/memory/status");
    }
    async health() {
        return this.requestJson("GET", "/api/health");
    }
    async topics() {
        return this.requestJson("GET", "/api/topics");
    }
    async recall(request) {
        return this.requestJson("POST", "/api/memory/recall", request);
    }
    async save(request) {
        return this.requestJson("POST", "/api/memory/save", request);
    }
    async requestJson(method, path, body) {
        if (!this.config.apiKey) {
            throw new NoosphereClientError("Set KILOCODE_NOOSPHERE_API_KEY for Kilo Code Noosphere memory requests, or NOOSPHERE_API_KEY as a compatibility fallback");
        }
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
        try {
            const response = await fetch(`${this.config.baseUrl}${path}`, {
                method,
                signal: controller.signal,
                headers: {
                    Accept: "application/json",
                    Authorization: `Bearer ${this.config.apiKey}`,
                    ...(body === undefined ? {} : { "Content-Type": "application/json" }),
                },
                body: body === undefined ? undefined : JSON.stringify(body),
            });
            if (!response.ok) {
                throw new NoosphereClientError(await readErrorMessage(response), response.status);
            }
            return (await response.json());
        }
        catch (error) {
            if (error instanceof NoosphereClientError)
                throw error;
            if (error instanceof Error && error.name === "AbortError") {
                throw new NoosphereClientError("Noosphere request timed out");
            }
            throw new NoosphereClientError(error instanceof Error ? error.message : String(error));
        }
        finally {
            clearTimeout(timeout);
        }
    }
}
async function readErrorMessage(response) {
    const text = await response.text();
    if (!text)
        return `Noosphere HTTP ${response.status}`;
    try {
        const parsed = JSON.parse(text);
        if (isRecord(parsed)) {
            const message = parsed.error || parsed.message;
            if (typeof message === "string" && message.trim()) {
                return message.trim();
            }
        }
    }
    catch {
        // Fall through to bounded text.
    }
    return text.slice(0, MAX_ERROR_BODY_LENGTH);
}
function isRecord(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
}
//# sourceMappingURL=client.js.map