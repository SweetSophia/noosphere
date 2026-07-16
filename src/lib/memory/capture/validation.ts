import { detectSecretInInputs, stripInjectedMemoryBlocks } from "@/lib/memory/api/save";

export const MEMORY_CAPTURE_LIMITS = {
  maxIdentifierBytes: 512,
  maxTextBytes: 12_000,
  maxCombinedTextBytes: 20_000,
  minCombinedTextLength: 40,
} as const;

const ALLOWED_FIELDS = new Set([
  "sourceSessionId",
  "sourceRunId",
  "userText",
  "assistantText",
]);

const TRANSIENT_ONLY = /^(?:thanks?|thank you|ok(?:ay)?|done|yes|no|sure|great|nice|cool)[.!\s]*$/i;

export type ValidatedMemoryCaptureInput = {
  sourceSessionId: string;
  sourceRunId?: string;
  userText: string;
  assistantText: string;
  strippedBlocks: string[];
};

export type MemoryCaptureValidationResult =
  | { ok: true; input: ValidatedMemoryCaptureInput }
  | { ok: false; status: 400; error: string };

export function validateMemoryCaptureRequest(
  input: unknown,
): MemoryCaptureValidationResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, status: 400, error: "Request body must be an object" };
  }

  const body = input as Record<string, unknown>;
  const unknownFields = Object.keys(body).filter((field) => !ALLOWED_FIELDS.has(field));
  if (unknownFields.length > 0) {
    return {
      ok: false,
      status: 400,
      error: `Unknown field(s): ${unknownFields.sort().join(", ")}`,
    };
  }

  const sourceSessionId = readRequiredString(
    body.sourceSessionId,
    "sourceSessionId",
    MEMORY_CAPTURE_LIMITS.maxIdentifierBytes,
  );
  if (!sourceSessionId.ok) return sourceSessionId;
  const sourceRunId = readOptionalString(
    body.sourceRunId,
    "sourceRunId",
    MEMORY_CAPTURE_LIMITS.maxIdentifierBytes,
  );
  if (!sourceRunId.ok) return sourceRunId;
  const userText = readRequiredString(
    body.userText,
    "userText",
    MEMORY_CAPTURE_LIMITS.maxTextBytes,
  );
  if (!userText.ok) return userText;
  const assistantText = readRequiredString(
    body.assistantText,
    "assistantText",
    MEMORY_CAPTURE_LIMITS.maxTextBytes,
  );
  if (!assistantText.ok) return assistantText;

  const strippedUser = stripInjectedMemoryBlocks(userText.value);
  const strippedAssistant = stripInjectedMemoryBlocks(assistantText.value);
  const normalizedUser = normalizeText(strippedUser.content);
  const normalizedAssistant = normalizeText(strippedAssistant.content);
  if (!normalizedUser || !normalizedAssistant) {
    return {
      ok: false,
      status: 400,
      error: "userText and assistantText must contain non-memory content",
    };
  }

  const combined = `${normalizedUser}\n${normalizedAssistant}`;
  if (utf8ByteLength(combined) > MEMORY_CAPTURE_LIMITS.maxCombinedTextBytes) {
    return { ok: false, status: 400, error: "Combined turn text is too long" };
  }
  if (
    combined.length < MEMORY_CAPTURE_LIMITS.minCombinedTextLength ||
    !/[A-Za-z]{12,}/.test(combined.replace(/\s+/g, "")) ||
    (TRANSIENT_ONLY.test(normalizedUser) && TRANSIENT_ONLY.test(normalizedAssistant))
  ) {
    return {
      ok: false,
      status: 400,
      error: "Turn does not contain durable memory evidence",
    };
  }

  const secretError = detectSecretInInputs([
    { field: "userText", value: normalizedUser },
    { field: "assistantText", value: normalizedAssistant },
  ]);
  if (secretError) {
    return { ok: false, status: 400, error: secretError.error };
  }

  return {
    ok: true,
    input: {
      sourceSessionId: sourceSessionId.value,
      sourceRunId: sourceRunId.value,
      userText: normalizedUser,
      assistantText: normalizedAssistant,
      strippedBlocks: [
        ...strippedUser.strippedBlocks,
        ...strippedAssistant.strippedBlocks,
      ],
    },
  };
}

function readRequiredString(
  value: unknown,
  field: string,
  maxBytes: number,
): { ok: true; value: string } | Extract<MemoryCaptureValidationResult, { ok: false }> {
  if (typeof value !== "string" || !value.trim()) {
    return { ok: false, status: 400, error: `${field} is required` };
  }
  const normalized = value.trim();
  if (utf8ByteLength(normalized) > maxBytes) {
    return { ok: false, status: 400, error: `${field} is too long` };
  }
  return { ok: true, value: normalized };
}

function readOptionalString(
  value: unknown,
  field: string,
  maxBytes: number,
): { ok: true; value?: string } | Extract<MemoryCaptureValidationResult, { ok: false }> {
  if (value === undefined || value === null || value === "") return { ok: true };
  if (typeof value !== "string") {
    return { ok: false, status: 400, error: `${field} must be a string` };
  }
  const normalized = value.trim();
  if (!normalized) return { ok: true };
  if (utf8ByteLength(normalized) > maxBytes) {
    return { ok: false, status: 400, error: `${field} is too long` };
  }
  return { ok: true, value: normalized };
}

function normalizeText(value: string): string {
  return value
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
