import { NoosphereClientError } from "./client.js";
export function jsonResult(payload) {
    return {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        details: payload,
    };
}
export function errorResult(error, config) {
    const payload = formatError(error, config);
    return {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        details: payload,
        isError: true,
    };
}
export function formatError(error, config) {
    void config;
    if (error instanceof NoosphereClientError) {
        return {
            ok: false,
            error: error.message,
            status: error.status,
        };
    }
    return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
    };
}
