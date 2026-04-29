import { NoosphereRecallRequest } from "../client.js";
import { errorResult, jsonResult } from "../format.js";
import { createNoosphereClientContext, NoosphereClientContext } from "../shared-init.js";

const QUERY_MAX_LENGTH = 1000;
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

export function createNoosphereRecallTool(rawConfig: unknown, context?: NoosphereClientContext) {
  const { config, client } = context ?? createNoosphereClientContext(rawConfig);

  return {
    name: "noosphere_recall",
    label: "Noosphere Recall",
    description: "Recall durable memories from Noosphere over HTTP. Use inspection mode for manual lookup and auto mode to request bounded prompt text.",
    parameters: RecallToolParameters,
    async execute(_toolCallId: string, rawParams: unknown) {
      try {
        const params = normalizeRecallParams(rawParams);
        return jsonResult(await client.recall(params));
      } catch (error) {
        return errorResult(error, config);
      }
    },
  };
}

function normalizeRecallParams(rawParams: unknown): NoosphereRecallRequest {
  const params = isRecord(rawParams) ? rawParams : {};

  return {
    query: readRequiredString(params.query, "query", QUERY_MAX_LENGTH),
    mode: readOptionalMode(params.mode) ?? "inspection",
    resultCap: readOptionalNumber(params.resultCap, RESULT_CAP_MIN, RESULT_CAP_MAX),
    tokenBudget: readOptionalNumber(params.tokenBudget, TOKEN_BUDGET_MIN, TOKEN_BUDGET_MAX),
    scope: readOptionalString(params.scope),
    providers: readOptionalStringArray(params.providers),
  };
}

function readRequiredString(value: unknown, field: string, maxLength?: number): string {
  if (typeof value === "string" && value.trim()) {
    const trimmed = value.trim();
    if (maxLength !== undefined && trimmed.length > maxLength) {
      throw new Error(`${field} is too long (max ${maxLength} characters)`);
    }
    return trimmed;
  }
  throw new Error(`${field} is required`);
}

function readOptionalMode(value: unknown): NoosphereRecallRequest["mode"] {
  if (value === undefined) return undefined;
  if (value === "auto" || value === "inspection") return value;
  throw new Error("mode must be auto or inspection");
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readOptionalNumber(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.min(max, Math.max(min, value));
}

function readOptionalStringArray(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("providers must be an array of provider ID strings");
  if (value.some((item) => typeof item !== "string")) {
    throw new Error("providers must be an array of provider ID strings");
  }
  const values = value.filter((item): item is string => typeof item === "string" && !!item.trim()).map((item) => item.trim());
  if (values.length === 0) throw new Error("providers must contain at least one non-empty provider ID");
  return values;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
