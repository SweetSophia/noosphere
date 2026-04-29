import { NoosphereMemoryClient, NoosphereRecallRequest } from "../client.js";
import { resolveNoosphereMemoryConfig } from "../config.js";
import { errorResult, jsonResult } from "../format.js";

const RESULT_CAP_MIN = 1;
const RESULT_CAP_MAX = 10;
const TOKEN_BUDGET_MIN = 1;
const TOKEN_BUDGET_MAX = 2000;

const RecallToolParameters = {
  type: "object",
  additionalProperties: false,
  required: ["query"],
  properties: {
    query: { type: "string", description: "Recall query string." },
    mode: { type: "string", enum: ["auto", "inspection"] },
    resultCap: { type: "number", minimum: RESULT_CAP_MIN, maximum: RESULT_CAP_MAX, description: "Maximum ranked results to return." },
    tokenBudget: { type: "number", minimum: TOKEN_BUDGET_MIN, maximum: TOKEN_BUDGET_MAX, description: "Maximum prompt-injection token budget for auto mode." },
    scope: { type: "string", description: "Optional Noosphere scope hint." },
    providers: {
      type: "array",
      items: { type: "string" },
      description: "Optional provider IDs, for example [\"noosphere\"].",
    },
  },
} as const;

export function createNoosphereRecallTool(rawConfig: unknown) {
  const config = resolveNoosphereMemoryConfig(rawConfig);
  const client = new NoosphereMemoryClient(config);

  return {
    name: "noosphere_recall",
    label: "Noosphere Recall",
    description: "Recall durable memories from Noosphere over HTTP. Use inspection mode for manual lookup and auto mode to request bounded prompt text.",
    parameters: RecallToolParameters,
    async execute(_toolCallId: string, rawParams: Record<string, unknown>) {
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
    resultCap: readOptionalNumber(rawParams.resultCap, RESULT_CAP_MIN, RESULT_CAP_MAX),
    tokenBudget: readOptionalNumber(rawParams.tokenBudget, TOKEN_BUDGET_MIN, TOKEN_BUDGET_MAX),
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

function readOptionalNumber(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.min(max, Math.max(min, value));
}

function readOptionalStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value.filter((item): item is string => typeof item === "string" && !!item.trim()).map((item) => item.trim());
  return values.length > 0 ? values : undefined;
}
