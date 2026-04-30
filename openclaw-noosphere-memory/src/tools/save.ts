import { NoosphereSaveRequest } from "../client.js";
import { errorResult, jsonResult } from "../format.js";
import {
  createNoosphereClientContext,
  NoosphereClientContext,
} from "../shared-init.js";

const SAVE_TITLE_MAX_LENGTH = 160;
const SAVE_CONTENT_MAX_LENGTH = 50_000;
const SAVE_TOPIC_ID_MAX_LENGTH = 128;
const SAVE_TAG_MAX_COUNT = 12;
const SAVE_TAG_MAX_LENGTH = 64;

const SaveToolParameters = {
  type: "object",
  additionalProperties: false,
  required: ["title", "content", "topicId"],
  properties: {
    title: {
      type: "string",
      description: "Short title for the draft memory candidate.",
      maxLength: SAVE_TITLE_MAX_LENGTH,
    },
    content: {
      type: "string",
      description:
        "Durable memory content to save as a draft candidate. Injected recall blocks are stripped server-side.",
      maxLength: SAVE_CONTENT_MAX_LENGTH,
    },
    topicId: {
      type: "string",
      description:
        "Noosphere topic ID where the draft candidate should be filed.",
      maxLength: SAVE_TOPIC_ID_MAX_LENGTH,
    },
    excerpt: {
      type: "string",
      description: "Optional short summary/excerpt.",
    },
    tags: {
      type: "array",
      maxItems: SAVE_TAG_MAX_COUNT,
      items: { type: "string", maxLength: SAVE_TAG_MAX_LENGTH },
      description: "Optional tags. Duplicates are normalized server-side.",
    },
    source: {
      type: "string",
      description:
        "Optional source pointer, e.g. session key, URL, or canonical ref.",
    },
    authorName: {
      type: "string",
      description: "Optional display author name.",
    },
    confidence: {
      type: "string",
      enum: ["low", "medium", "high"],
      description: "Initial confidence for the draft candidate.",
    },
  },
} as const;

export function createNoosphereSaveTool(
  rawConfig: unknown,
  context?: NoosphereClientContext,
) {
  const { config, client } = context ?? createNoosphereClientContext(rawConfig);

  return {
    name: "noosphere_save",
    label: "Noosphere Save Candidate",
    description:
      "Save durable content to Noosphere as a draft memory candidate. This never publishes directly.",
    parameters: SaveToolParameters,
    async execute(_toolCallId: string, rawParams: unknown) {
      try {
        const params = normalizeSaveParams(rawParams);
        return jsonResult(await client.save(params));
      } catch (error) {
        return errorResult(error, config);
      }
    },
  };
}

function normalizeSaveParams(rawParams: unknown): NoosphereSaveRequest {
  const params = isRecord(rawParams) ? rawParams : {};
  return {
    title: readRequiredString(params.title, "title", SAVE_TITLE_MAX_LENGTH),
    content: readRequiredString(
      params.content,
      "content",
      SAVE_CONTENT_MAX_LENGTH,
    ),
    topicId: readRequiredString(
      params.topicId,
      "topicId",
      SAVE_TOPIC_ID_MAX_LENGTH,
    ),
    excerpt: readOptionalString(params.excerpt, "excerpt", 500),
    tags: readOptionalTags(params.tags),
    source: readOptionalString(params.source, "source", 500),
    authorName: readOptionalString(params.authorName, "authorName", 100),
    confidence: readOptionalConfidence(params.confidence),
  };
}

function readRequiredString(
  value: unknown,
  field: string,
  maxLength: number,
): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} is required`);
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) throw new Error(`${field} is too long`);
  return trimmed;
}

function readOptionalString(
  value: unknown,
  field: string,
  maxLength: number,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > maxLength) throw new Error(`${field} is too long`);
  return trimmed;
}

function readOptionalTags(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value))
    throw new Error("tags must be an array of strings");
  if (value.length > SAVE_TAG_MAX_COUNT) throw new Error("too many tags");
  const tags: string[] = [];
  for (const tag of value) {
    if (typeof tag !== "string")
      throw new Error("tags must be an array of strings");
    const normalized = tag.trim();
    if (!normalized) continue;
    if (normalized.length > SAVE_TAG_MAX_LENGTH)
      throw new Error("tag is too long");
    tags.push(normalized);
  }
  return tags.length ? tags : undefined;
}

function readOptionalConfidence(
  value: unknown,
): NoosphereSaveRequest["confidence"] {
  if (value === undefined || value === null || value === "") return undefined;
  if (value === "low" || value === "medium" || value === "high") return value;
  throw new Error("confidence must be low, medium, or high");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
