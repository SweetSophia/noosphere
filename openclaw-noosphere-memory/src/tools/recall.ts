import { NoosphereMemoryClient, NoosphereRecallRequest } from "../client.js";
import { resolveNoosphereMemoryConfig } from "../config.js";
import { errorResult, jsonResult } from "../format.js";

const RecallToolParameters = {
  type: "object",
  additionalProperties: false,
  required: ["query"],
  properties: {
    query: { type: "string", description: "Recall query string." },
    mode: { type: "string", enum: ["auto", "inspection"] },
    resultCap: { type: "number", minimum: 1, maximum: 10, description: "Maximum ranked results to return." },
    tokenBudget: { type: "number", minimum: 1, maximum: 2000, description: "Maximum prompt-injection token budget for auto mode." },
    scope: { type: "string", description: "Optional Noosphere scope hint." },
    providers: {
      type: "array",
      items: { type: "string" },
      description: "Optional provider IDs, for example [\"noosphere\"].",
    },
  },
} as const;

export function createNoosphereRecallTool(rawConfig: unknown) {
  return {
    name: "noosphere_recall",
    label: "Noosphere Recall",
    description: "Recall durable memories from Noosphere over HTTP. Use inspection mode for manual lookup and auto mode to request bounded prompt text.",
    parameters: RecallToolParameters,
    async execute(_toolCallId: string, rawParams: Record<string, unknown>) {
      const config = resolveNoosphereMemoryConfig(rawConfig);
      const client = new NoosphereMemoryClient(config);
      try {
        const params = normalizeRecallParams(rawParams);
        return jsonResult(await client.recall(params));
      } catch (error) {
        return errorResult(error, config);
      }
    },
  };
}

function normalizeRecallParams(rawParams: Record<string, unknown>): NoosphereRecallRequest {
  return {
    query: readRequiredString(rawParams.query, "query"),
    mode: rawParams.mode === "auto" ? "auto" : rawParams.mode === "inspection" ? "inspection" : undefined,
    resultCap: readOptionalNumber(rawParams.resultCap),
    tokenBudget: readOptionalNumber(rawParams.tokenBudget),
    scope: readOptionalString(rawParams.scope),
    providers: readOptionalStringArray(rawParams.providers),
  };
}

function readRequiredString(value: unknown, field: string): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  throw new Error(`${field} is required`);
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readOptionalStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value.filter((item): item is string => typeof item === "string" && !!item.trim()).map((item) => item.trim());
  return values.length > 0 ? values : undefined;
}
