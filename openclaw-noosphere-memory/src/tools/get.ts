import { NoosphereGetRequest } from "../client.js";
import { errorResult, jsonResult } from "../format.js";
import {
  createNoosphereClientContext,
  NoosphereClientContext,
} from "../shared-init.js";

const GetToolParameters = {
  type: "object",
  additionalProperties: false,
  properties: {
    provider: {
      type: "string",
      description: "Provider ID, for example noosphere.",
    },
    id: { type: "string", description: "Provider-local ID." },
    canonicalRef: {
      type: "string",
      description:
        "Canonical memory reference, for example noosphere:article:<id>.",
    },
  },
  oneOf: [
    {
      required: ["canonicalRef"],
      not: { anyOf: [{ required: ["provider"] }, { required: ["id"] }] },
    },
    {
      required: ["provider", "id"],
      not: { required: ["canonicalRef"] },
    },
  ],
} as const;

export function createNoosphereGetTool(
  rawConfig: unknown,
  context?: NoosphereClientContext,
) {
  const { config, client } = context ?? createNoosphereClientContext(rawConfig);

  return {
    name: "noosphere_get",
    label: "Noosphere Get",
    description:
      "Fetch one normalized memory result. Provide either canonicalRef, or provider + id; do not mix both forms.",
    parameters: GetToolParameters,
    async execute(_toolCallId: string, rawParams: unknown) {
      try {
        const params = normalizeGetParams(rawParams);
        return jsonResult(await client.get(params));
      } catch (error) {
        return errorResult(error, config);
      }
    },
  };
}

function normalizeGetParams(rawParams: unknown): NoosphereGetRequest {
  const params = isRecord(rawParams) ? rawParams : {};
  const canonicalRef = readOptionalString(params.canonicalRef, "canonicalRef");
  const provider = readOptionalString(params.provider, "provider");
  const id = readOptionalString(params.id, "id");

  if (canonicalRef && (provider || id)) {
    throw new Error("Use either canonicalRef or provider + id, not both");
  }
  if (canonicalRef) return { canonicalRef };
  if (!provider) throw new Error("provider is required");
  if (!id) throw new Error("id is required");
  return { provider, id };
}

function readOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${field} must be a non-empty string`);
  return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
