/**
 * Shared date-filter parsing logic for the activity log API.
 * Extracted as a pure function to enable unit testing without database dependencies.
 */

const MAX_DATE_STRING_LENGTH = 100;

export type DateFilterResult =
  | { ok: true; from: Date | undefined; to: Date | undefined }
  | { ok: false; error: string };

/**
 * Parse and validate `from` and `to` date filter parameters.
 * Returns a structured result so callers can build Prisma where clauses.
 *
 * Validation rules:
 * - Both params are optional; omitting both is valid (no date filter applied)
 * - Empty string "" is treated as missing (not an error)
 * - ISO 8601 strings are parsed; invalid strings return an error
 * - Unix epoch (0) is accepted as a valid date (1970-01-01T00:00:00Z)
 * - Strings exceeding MAX_DATE_STRING_LENGTH return an error
 */
export function parseDateFilter(
  from: string | null,
  to: string | null
): DateFilterResult {
  // Treat empty strings as missing (consistent with other optional params)
  const fromVal = from === "" ? null : from;
  const toVal = to === "" ? null : to;

  if (fromVal && fromVal.length > MAX_DATE_STRING_LENGTH) {
    return { ok: false, error: "from date string too long" };
  }
  if (toVal && toVal.length > MAX_DATE_STRING_LENGTH) {
    return { ok: false, error: "to date string too long" };
  }

  if (fromVal) {
    const parsed = new Date(fromVal);
    if (isNaN(parsed.getTime())) {
      return { ok: false, error: "Invalid 'from' date format" };
    }
  }
  if (toVal) {
    const parsed = new Date(toVal);
    if (isNaN(parsed.getTime())) {
      return { ok: false, error: "Invalid 'to' date format" };
    }
  }

  return {
    ok: true,
    from: fromVal ? new Date(fromVal) : undefined,
    to: toVal ? new Date(toVal) : undefined,
  };
}
