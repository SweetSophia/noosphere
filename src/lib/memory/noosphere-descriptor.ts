import type { MemoryProviderDescriptor } from "./provider";

export const NOOSPHERE_PROVIDER_ID = "noosphere";
export const DEFAULT_NOOSPHERE_MAX_RESULTS = 10;

/**
 * DB-free descriptor for the built-in Noosphere article provider.
 *
 * Keep provider identity, defaults, and capabilities here so API status routes
 * can report safe metadata without instantiating Prisma-backed providers.
 */
export const NOOSPHERE_PROVIDER_DESCRIPTOR: MemoryProviderDescriptor = {
  id: NOOSPHERE_PROVIDER_ID,
  displayName: "Noosphere",
  sourceType: "noosphere",
  defaultConfig: {
    enabled: true,
    priorityWeight: 1.25,
    maxResults: DEFAULT_NOOSPHERE_MAX_RESULTS,
    allowAutoRecall: true,
  },
  capabilities: {
    search: true,
    getById: true,
    score: true,
    autoRecall: true,
  },
  metadata: {
    contentType: "article",
  },
};
