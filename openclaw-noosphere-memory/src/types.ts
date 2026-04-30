export interface NoosphereMemoryResult {
  id: string;
  provider: string;
  sourceType: string;
  title?: string;
  content: string;
  summary?: string;
  relevanceScore?: number;
  confidenceScore?: number;
  recencyScore?: number;
  curationLevel?: "ephemeral" | "managed" | "curated";
  createdAt?: string;
  updatedAt?: string;
  tokenEstimate?: number;
  canonicalRef?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export interface NoosphereMemoryGetProviderMeta {
  providerId: string;
  enabled: boolean;
  found: boolean;
  error?: string;
  durationMs?: number;
}
